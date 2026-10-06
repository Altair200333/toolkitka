import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { genKey, sourceKey, sha256hex } from '../core/ids.ts';
import { readJsonlLines } from './jsonl.ts';
import { ingestPolicy, type SourceRootDef } from '../core/config.ts';
import type { ChangeBatch, ConversationUpsert, GenerationInfo, ItemUpsert, QuarantineEntry, ReadBudget } from './types.ts';

export const READER_VERSION = 1;

/** token_count is 47% of all rollout lines; the compact-JSON marker lets us drop
 *  them before JSON.parse. Escaped quotes in quoted user text do not match. */
const TOKEN_COUNT_MARK = '"type":"token_count"';

/** Injected context blocks inside response_item user messages:
 *  filter per block — the human text is often block 2+ of the same message. */
const INJECTED_BLOCK_RE = /^<(environment_context|user_instructions|recommended_plugins|subagent_notification|goal_context|turn_aborted|codex_internal_context|skill)\b|^# (AGENTS\.md instructions|Files mentioned by the)/;

/** Explicit path fields in tool arguments (view_image.path etc.); shell command
 *  strings are deliberately not parsed. Edited files come from patch_apply_end. */
const PATH_ARG_KEYS = ['path', 'file_path', 'workdir'];

/** Fernet ciphertext prefix — encrypted payloads carry no indexable text. */
const FERNET_PREFIX = 'gAAAAAB';

/** event_msg types that are progress/telemetry or verbatim re-renders of a
 *  response_item we already index. Listed explicitly so a new Codex event type
 *  lands in quarantine (a visible signal) instead of disappearing silently. */
const TELEMETRY_EVENTS = new Set([
  // live progress / deltas
  'agent_reasoning_delta', 'agent_reasoning_raw_content', 'agent_reasoning_raw_content_delta',
  'agent_reasoning_section_break', 'agent_message_delta', 'task_started', 'task_complete',
  'turn_started', 'turn_complete', 'turn_aborted', 'turn_diff', 'stream_error', 'error',
  'background_event', 'notification', 'shutdown_complete', 'session_configured',
  // tool lifecycle: the response_item pair carries the same call_id, args and output
  'exec_command_begin', 'exec_command_end', 'exec_command_output_delta',
  'exec_approval_request', 'apply_patch_approval_request', 'patch_apply_begin',
  'mcp_tool_call_begin', 'mcp_tool_call_end', 'mcp_list_tools_response',
  'web_search_begin', 'web_search_end', 'image_generation_begin', 'image_generation_end',
  'view_image_tool_call', 'tool_search_begin', 'tool_search_end',
  // thread/session bookkeeping mirrored by session_meta, turn_context or state_5.sqlite
  'thread_goal_updated', 'thread_settings_applied', 'thread_started', 'thread_archived',
  'thread_forked', 'thread_compaction_started', 'context_compacted', 'context_window_updated',
  'sub_agent_activity', 'item_started', 'item_updated', 'item_completed', 'plan_update',
  'entered_review_mode', 'exited_review_mode', 'conversation_path', 'get_history_entry_response',
  'user_info', 'list_custom_prompts_response', 'memory_updated',
]);

function fingerprintFile(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024);
    const n = readSync(fd, buf, 0, 1024, 0);
    return sha256hex(buf.subarray(0, Math.max(n, 0)));
  } finally {
    closeSync(fd);
  }
}

export function discoverCodexGenerations(root: SourceRootDef): GenerationInfo[] {
  const out: GenerationInfo[] = [];

  const addFile = (absPath: string, locator: string) => {
    const st = statSync(absPath);
    if (st.size === 0) return;
    const fp = fingerprintFile(absPath);
    out.push({
      genKey: genKey(root.rootId, locator, fp),
      rootId: root.rootId,
      app: 'codex',
      kind: 'jsonl_file',
      locator,
      fingerprint: fp,
      absPath,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    });
  };

  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // never descend into dot-dirs: ~/.codex/.tmp holds ~88k non-transcript files
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, `${rel}/${entry.name}`);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) addFile(abs, `${rel}/${entry.name}`);
    }
  };

  for (const top of ['sessions', 'archived_sessions']) {
    const dir = join(root.rootPath, top);
    if (existsSync(dir)) walk(dir, top);
  }
  return out;
}

/** Kind of record that the very next record may repeat verbatim (see dedupe note
 *  in readCodexBatch); survives batch boundaries through the cursor. */
type DupKind = 'agent_msg' | 'user_ri';

interface CodexCursor {
  byte_offset: number;
  /** Tail of the synthetic linear chain — rollouts have no parent uuids, so the
   *  chain must survive batch boundaries through the cursor. */
  last_ext_id?: string;
  /** Thread id once session_meta has been seen (filename uuid is the fallback). */
  thread_id?: string;
  /** The file's own session_meta is already consumed; later ones are replayed history. */
  meta_seen?: boolean;
  prev_dup_kind?: DupKind;
  prev_dup_hash?: string;
}

interface ThreadRow {
  title?: string | null;
  name?: string | null;
  threadSource?: string | null;
}

/** state_5.sqlite belongs to a live Codex: readonly, busy_timeout, one SELECT per
 *  generation. The handle is cached — a full pass opens ~2500 generations and
 *  reopening the DB each time costs more than the query. */
let threadDb: { path: string; db: DatabaseSync } | null | undefined;

function threadStore(codexRoot: string): DatabaseSync | undefined {
  const dbPath = join(codexRoot, 'state_5.sqlite');
  if (threadDb && threadDb.path === dbPath) return threadDb.db;
  if (threadDb) { try { threadDb.db.close(); } catch { /* already gone */ } }
  threadDb = null;
  if (!existsSync(dbPath)) return undefined;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout=2000');
    threadDb = { path: dbPath, db };
    return db;
  } catch {
    return undefined;
  }
}

/** Releases the cached state_5.sqlite handle (tests, writer shutdown). */
export function closeCodexThreadStore(): void {
  if (threadDb) { try { threadDb.db.close(); } catch { /* already gone */ } }
  threadDb = undefined;
}

function readThreadRow(codexRoot: string, threadId: string): ThreadRow | undefined {
  const db = threadStore(codexRoot);
  if (!db) return undefined;
  try {
    return db.prepare('SELECT title, name, thread_source AS threadSource FROM threads WHERE id = ?')
      .get(threadId) as ThreadRow | undefined;
  } catch {
    // locked, schema drift or a half-written DB: titles are a nice-to-have
    return undefined;
  }
}

function joinBlocks(content: unknown, opts?: { filterInjected?: boolean; counters?: { dataUris: number } }): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as { type?: string; text?: string };
    if (block.type === 'input_image') {
      // phantom data-URI images: count only, never touch the bytes
      if (opts?.counters) opts.counters.dataUris++;
      continue;
    }
    // dynamic_tool_call_response.content_items spells the same blocks in camelCase
    if (block.type !== 'input_text' && block.type !== 'output_text' && block.type !== 'text'
      && block.type !== 'inputText' && block.type !== 'outputText') continue;
    const text = block.text ?? '';
    if (!text) continue;
    if (opts?.filterInjected && INJECTED_BLOCK_RE.test(text.trimStart())) continue;
    parts.push(text);
  }
  return parts.join('\n');
}

function compactJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? '' : s;
  } catch {
    return '';
  }
}

function extractArgFiles(argsJson: unknown): { pathDisplay: string; op?: string }[] {
  if (typeof argsJson !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const rec = parsed as Record<string, unknown>;
  const files: { pathDisplay: string; op?: string }[] = [];
  for (const key of PATH_ARG_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 1) files.push({ pathDisplay: v, op: key === 'workdir' ? undefined : 'read' });
  }
  return files;
}

function dupHash(text: string): string {
  return sha256hex(text.trim()).slice(0, 16);
}

/** Reads one generation (one rollout .jsonl) from its cursor and normalizes records.
 *
 *  Verbatim duplicates (measured on the real corpus, 150-file sample):
 *    event_msg/agent_message  →  response_item/message(assistant)  — 3403/3403 pairs
 *          adjacent, event always first; 6918 further events (phase=commentary in
 *          Codex ≥ 0.144) never become a response_item, so the event is the source.
 *    response_item/message(user)  →  event_msg/user_message  — 869/897 pairs adjacent,
 *          response_item first; it keeps the payload id that compacted.replacement_history
 *          dedupes against, so the event is the copy that gets dropped.
 *  Both are suppressed by comparing against the previous record only; the hash rides
 *  the cursor so a batch boundary between the two does not resurrect the duplicate. */
export function readCodexBatch(gen: GenerationInfo, cursorJson: string | undefined, budget: ReadBudget): ChangeBatch {
  const parsed = cursorJson ? JSON.parse(cursorJson) : {};
  const cursor: CodexCursor = {
    byte_offset: typeof parsed.byte_offset === 'number' ? parsed.byte_offset : 0,
    last_ext_id: typeof parsed.last_ext_id === 'string' ? parsed.last_ext_id : undefined,
    thread_id: typeof parsed.thread_id === 'string' ? parsed.thread_id : undefined,
    meta_seen: parsed.meta_seen === true,
    prev_dup_kind: parsed.prev_dup_kind,
    prev_dup_hash: typeof parsed.prev_dup_hash === 'string' ? parsed.prev_dup_hash : undefined,
  };
  const items: ItemUpsert[] = [];
  const edges: { extId: string; parentExtId?: string }[] = [];
  const quarantine: QuarantineEntry[] = [];

  // The filename uuid IS the thread id and survives the move to archived_sessions/,
  // so both locations resolve to the same logical conversation (generations conflict,
  // pipeline supersedes one). session_meta.payload.id overrides when seen.
  const idMatch = gen.locator.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  const conversation: ConversationUpsert = {
    app: 'codex',
    rootId: gen.rootId,
    logicalId: cursor.thread_id ?? (idMatch ? idMatch[1] : gen.locator),
    kind: 'main',
    genKey: gen.genKey,
  };

  let itemBytes = 0;
  let maxEventTs: number | undefined;
  let endOffset = cursor.byte_offset;
  let eof = false;
  let metaSeen = cursor.meta_seen === true;
  let prevExtId = cursor.last_ext_id;
  let prevDup: { kind: DupKind; hash: string } | undefined =
    cursor.prev_dup_kind && cursor.prev_dup_hash
      ? { kind: cursor.prev_dup_kind, hash: cursor.prev_dup_hash }
      : undefined;

  const push = (item: ItemUpsert) => {
    items.push(item);
    itemBytes += item.text.length;
  };
  const addEdge = (extId: string) => {
    edges.push(prevExtId ? { extId, parentExtId: prevExtId } : { extId });
    prevExtId = extId;
    conversation.headExtId = extId;
  };

  /** Shared for live response_item lines and compacted.replacement_history copies.
   *  Copies are keyed by payload.id with revision 0: re-embeds of already indexed
   *  records become no-ops, while fork-inherited history still gets ingested.
   *  `dupIn` is the previous record's duplicate marker (live lines only). */
  const handleResponseItem = (
    p: Record<string, unknown>,
    offset: number,
    ts: number | undefined,
    copy: boolean,
    histIndex: number,
    dupIn?: { kind: DupKind; hash: string },
  ): { kind: DupKind; hash: string } | undefined => {
    const ptype = String(p.type ?? '');
    const id = typeof p.id === 'string' && p.id ? p.id : undefined;
    if (!copy && id) addEdge(id);
    const pos = copy ? id! : (id ?? String(offset));
    const key = sourceKey(gen.genKey, pos);
    const revision = copy ? 0 : offset;
    const callId = typeof p.call_id === 'string' ? p.call_id : undefined;
    // copies share the compacted line's offset; +index keeps the inherited history
    // in order and still lands below the next line's offset (the line is kilobytes).
    // logical_id stays empty on copies: they carry no edge, and recomputeBranchState
    // abandons every logical_id that is missing from the chain.
    const base = { logicalId: copy ? undefined : id, ordinal: offset + histIndex, ts, tsIsCopy: copy || undefined, revision };

    if (ptype === 'message') {
      if (p.role === 'user') {
        const counters = { dataUris: 0 };
        const text = joinBlocks(p.content, { filterInjected: true, counters });
        if (!text) return undefined;
        if (!copy && !conversation.title && !text.startsWith('<')) {
          conversation.title = { text: text.slice(0, 120), revision: offset, source: 'first_user' };
        }
        push({ sourceKey: key, kind: 'user', role: 'user', text, ...base, meta: counters.dataUris ? { dataUris: counters.dataUris } : undefined });
        return copy ? undefined : { kind: 'user_ri', hash: dupHash(text) };
      }
      if (p.role === 'assistant') {
        const text = joinBlocks(p.content);
        if (!text) return undefined;
        // the agent_message event one line above already carries this text
        if (dupIn?.kind === 'agent_msg' && dupIn.hash === dupHash(text)) return undefined;
        push({ sourceKey: key, kind: 'assistant', role: 'assistant', text, ...base, meta: typeof p.phase === 'string' ? { phase: p.phase } : undefined });
      }
      // role=developer: injected instructions, not a message
      return undefined;
    }
    // reasoning holds only encrypted_content and
    // compaction only the encrypted pre-compaction transcript; readable reasoning
    // is indexed from event_msg/agent_reasoning instead
    if (ptype === 'reasoning' || ptype === 'compaction') return undefined;

    if (ptype === 'function_call' || ptype === 'custom_tool_call') {
      const name = String(p.name ?? ptype);
      // function_call.arguments is a JSON string; custom_tool_call.input is raw code
      const args = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : compactJson(p.arguments ?? p.input);
      push({
        sourceKey: key, kind: 'tool_call', role: 'tool', text: `${name} ${args}`,
        callId, toolName: name, files: extractArgFiles(p.arguments), ...base,
      });
      return undefined;
    }
    if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
      const text = typeof p.output === 'string' ? p.output : joinBlocks(p.output);
      push({ sourceKey: key, kind: 'tool_result', role: 'tool', text, callId, ...base });
      return undefined;
    }
    if (ptype === 'agent_message') {
      const text = typeof p.content === 'string' ? p.content : joinBlocks(p.content);
      if (!text || text.startsWith(FERNET_PREFIX)) return undefined; // encrypted inter-agent traffic
      const meta: Record<string, unknown> = {};
      if (typeof p.author === 'string') meta.author = p.author;
      if (typeof p.recipient === 'string') meta.recipient = p.recipient;
      push({ sourceKey: key, kind: 'assistant', role: 'assistant', text, ...base, meta });
      return undefined;
    }
    // rare typed calls: tool_search_call, web_search_call, image_generation_call, ...
    if (ptype.endsWith('_call')) {
      push({ sourceKey: key, kind: 'tool_call', role: 'tool', text: `${ptype} ${compactJson(p)}`, callId, toolName: ptype, ...base });
      return undefined;
    }
    if (ptype.endsWith('_output')) {
      // tool_search_output and friends keep the payload under their own key, not `output`
      const text = typeof p.output === 'string' ? p.output : joinBlocks(p.output) || compactJson(p);
      push({ sourceKey: key, kind: 'tool_result', role: 'tool', text, callId, ...base });
      return undefined;
    }
    if (!copy) quarantine.push({ position: String(offset), reason: `unknown_response_item: ${ptype}`, excerpt: compactJson(p).slice(0, 300) });
    return undefined;
  };

  const generator = readJsonlLines(gen.absPath, cursor.byte_offset, { lineCap: ingestPolicy.lineCapBytes });
  try {
    while (true) {
      const step = generator.next();
      if (step.done) {
        endOffset = step.value.endOffset;
        eof = true;
        break;
      }
      const line = step.value;
      if (items.length >= budget.maxItems || itemBytes >= budget.maxBytes) {
        endOffset = line.offset;
        break;
      }
      endOffset = line.offset + line.byteLength;
      if (line.overlong) {
        quarantine.push({ position: String(line.offset), reason: 'line_over_cap', excerpt: line.text.slice(0, 500) });
        continue;
      }
      if (line.text.trim() === '') continue;
      if (line.text.includes(TOKEN_COUNT_MARK)) continue;

      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line.text);
      } catch (e) {
        quarantine.push({ position: String(line.offset), reason: `json_parse: ${String(e).slice(0, 100)}`, excerpt: line.text.slice(0, 500) });
        continue;
      }

      const offset = line.offset;
      const type = String(rec.type ?? '');
      const payload = (rec.payload && typeof rec.payload === 'object' ? rec.payload : {}) as Record<string, unknown>;
      const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : undefined;
      if (ts !== undefined && !Number.isNaN(ts)) {
        maxEventTs = Math.max(maxEventTs ?? 0, ts);
        conversation.startedAt = Math.min(conversation.startedAt ?? Infinity, ts);
        conversation.lastActivityAt = Math.max(conversation.lastActivityAt ?? 0, ts);
      }
      // every branch below either declares a fresh duplicate marker or clears it
      const dupIn = prevDup;
      prevDup = undefined;

      if (type === 'session_meta') {
        // Only the first record describes this rollout (its id equals the file uuid in
        // all 2524 rollouts on disk). A resumed or forked thread replays the parent's
        // session_meta right after it, and a resume-in-place appends one per resume —
        // letting those win renamed 1113 of 2524 conversations onto foreign thread ids.
        if (metaSeen) continue;
        metaSeen = true;
        if (typeof payload.id === 'string' && payload.id) conversation.logicalId = payload.id;
        if (typeof payload.cwd === 'string' && !conversation.cwdDisplay) conversation.cwdDisplay = payload.cwd;
        if (payload.thread_source === 'subagent' || typeof payload.parent_thread_id === 'string') {
          conversation.kind = 'subagent';
          // parent_thread_id has no home in the contract; the spawn graph stays in state_5.sqlite
          const label = [payload.agent_nickname, payload.agent_role].filter((v) => typeof v === 'string' && v).join(' · ');
          if (label && !conversation.title) conversation.title = { text: label.slice(0, 200), revision: offset, source: 'ai' };
        }
        continue;
      }

      if (type === 'response_item') {
        prevDup = handleResponseItem(payload, offset, ts, false, 0, dupIn);
        continue;
      }

      if (type === 'event_msg') {
        const et = String(payload.type ?? '');
        if (et === 'agent_reasoning') {
          const text = typeof payload.text === 'string' ? payload.text : '';
          if (!text || text.startsWith(FERNET_PREFIX)) continue;
          push({ sourceKey: sourceKey(gen.genKey, String(offset)), kind: 'reasoning', role: 'reasoning', text, ordinal: offset, ts, revision: offset });
          continue;
        }
        if (et === 'agent_message') {
          // the assistant turn as rendered; in Codex >= 0.144 the phase=commentary
          // messages exist only here, so this is the primary assistant source
          const text = typeof payload.message === 'string' ? payload.message : '';
          if (!text || text.startsWith(FERNET_PREFIX)) continue;
          push({
            sourceKey: sourceKey(gen.genKey, String(offset)), kind: 'assistant', role: 'assistant', text,
            ordinal: offset, ts, revision: offset,
            meta: typeof payload.phase === 'string' ? { phase: payload.phase } : undefined,
          });
          prevDup = { kind: 'agent_msg', hash: dupHash(text) };
          continue;
        }
        if (et === 'user_message') {
          // rendered user turn, no injected-context wrappers — best title source
          const text = typeof payload.message === 'string' ? payload.message : '';
          if (!text) continue;
          if (!conversation.title && !text.startsWith('<')) {
            conversation.title = { text: text.slice(0, 120), revision: offset, source: 'first_user' };
          }
          // the response_item one line above already carries this text, id and all
          if (dupIn?.kind === 'user_ri' && dupIn.hash === dupHash(text)) continue;
          push({ sourceKey: sourceKey(gen.genKey, String(offset)), kind: 'user', role: 'user', text, ordinal: offset, ts, revision: offset });
          continue;
        }
        if (et === 'patch_apply_end') {
          // changes is a map keyed by absolute path — the authoritative edit source
          const changes = payload.changes && typeof payload.changes === 'object' ? payload.changes as Record<string, unknown> : {};
          const text = [payload.stdout, payload.stderr].filter((v) => typeof v === 'string' && v).join('\n');
          push({
            sourceKey: sourceKey(gen.genKey, String(offset)), kind: 'tool_result', role: 'tool', text,
            callId: typeof payload.call_id === 'string' ? payload.call_id : undefined,
            toolName: 'apply_patch', isError: payload.success === false,
            files: Object.keys(changes).slice(0, 200).map((p) => {
              const kindOfChange = (changes[p] as { type?: unknown } | undefined)?.type;
              return { pathDisplay: p, op: kindOfChange === 'delete' ? 'delete' : 'write' };
            }),
            ordinal: offset, ts, revision: offset,
          });
          continue;
        }
        if (et === 'thread_name_updated' && typeof payload.thread_name === 'string' && payload.thread_name) {
          conversation.title = { text: payload.thread_name.slice(0, 200), revision: offset, source: 'custom' };
          continue;
        }
        if (et === 'thread_rolled_back') {
          // marker only; marking the rolled-back turns as abandoned is pipeline work
          push({
            sourceKey: sourceKey(gen.genKey, String(offset)), kind: 'rollback', role: 'system',
            text: '', ordinal: offset, ts, revision: offset,
            meta: { numTurns: typeof payload.num_turns === 'number' ? payload.num_turns : undefined },
          });
          continue;
        }
        // multi-agent collaboration: the spawn/handoff prompt is real human-readable
        // work, the completion status carries the other agent's answer
        if (et === 'collab_agent_spawn_end' || et === 'collab_agent_interaction_end') {
          const text = typeof payload.prompt === 'string' ? payload.prompt : '';
          if (!text) continue;
          const meta: Record<string, unknown> = {};
          for (const k of ['new_thread_id', 'receiver_thread_id', 'new_agent_nickname', 'receiver_agent_nickname', 'new_agent_role', 'receiver_agent_role']) {
            if (typeof payload[k] === 'string') meta[k] = payload[k];
          }
          push({
            sourceKey: sourceKey(gen.genKey, String(offset)), kind: 'tool_call', role: 'tool', text,
            callId: typeof payload.call_id === 'string' ? payload.call_id : undefined,
            toolName: et.slice(0, -4), ordinal: offset, ts, revision: offset, meta,
          });
          continue;
        }
        if (et === 'collab_resume_end' || et === 'collab_close_end' || et === 'collab_waiting_end') {
          // status is either a bare state word or an object holding the agent's reply
          const text = payload.status && typeof payload.status === 'object' ? compactJson(payload.status) : '';
          if (!text || text === '{}') continue;
          push({
            sourceKey: sourceKey(gen.genKey, String(offset)), kind: 'tool_result', role: 'tool', text,
            callId: typeof payload.call_id === 'string' ? payload.call_id : undefined,
            toolName: et.slice(0, -4), ordinal: offset, ts, revision: offset,
          });
          continue;
        }
        if (et === 'dynamic_tool_call_request') {
          const name = typeof payload.tool === 'string' ? payload.tool : et;
          push({
            sourceKey: sourceKey(gen.genKey, String(offset)), kind: 'tool_call', role: 'tool',
            text: `${name} ${compactJson(payload.arguments)}`,
            callId: typeof payload.callId === 'string' ? payload.callId : undefined,
            toolName: name, ordinal: offset, ts, revision: offset,
          });
          continue;
        }
        if (et === 'dynamic_tool_call_response') {
          push({
            sourceKey: sourceKey(gen.genKey, String(offset)), kind: 'tool_result', role: 'tool',
            text: joinBlocks(payload.content_items) || String(payload.error ?? ''),
            callId: typeof payload.call_id === 'string' ? payload.call_id : undefined,
            toolName: typeof payload.tool === 'string' ? payload.tool : undefined,
            isError: payload.success === false, ordinal: offset, ts, revision: offset,
          });
          continue;
        }
        if (TELEMETRY_EVENTS.has(et)) continue;
        quarantine.push({ position: String(offset), reason: `unknown_event: ${et}`, excerpt: line.text.slice(0, 300) });
        continue;
      }

      if (type === 'compacted') {
        const msg = typeof payload.message === 'string' ? payload.message.trim() : '';
        if (msg) {
          push({ sourceKey: sourceKey(gen.genKey, String(offset)), kind: 'compact_summary', role: 'user', text: msg, ordinal: offset, ts, revision: offset });
        }
        const hist = Array.isArray(payload.replacement_history) ? payload.replacement_history : [];
        hist.forEach((entry, i) => {
          // id-less entries (user messages) are verbatim re-embeds — dedupe is impossible, drop
          if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' && (entry as { id: string }).id) {
            handleResponseItem(entry as Record<string, unknown>, offset, ts, true, Math.min(i, 999));
          }
        });
        continue;
      }

      if (type === 'turn_context') {
        if (typeof payload.cwd === 'string' && !conversation.cwdDisplay) conversation.cwdDisplay = payload.cwd;
        continue;
      }
      if (type === 'world_state' || type === 'inter_agent_communication_metadata') continue;

      quarantine.push({ position: String(offset), reason: `unknown_type: ${type}`, excerpt: line.text.slice(0, 300) });
    }
  } finally {
    // a budget break abandons the generator; return() runs its finally and closes the fd
    generator.return({ endOffset });
  }

  // Title and subagent flag from Codex's own index; falls back to in-file derivation
  // when the DB is locked or the row is missing. endOffset as revision keeps the DB
  // title winning over first_user and following later renames.
  const threadRow = readThreadRow(
    gen.absPath.slice(0, gen.absPath.length - gen.locator.length - 1),
    conversation.logicalId,
  );
  if (threadRow) {
    if (threadRow.threadSource === 'subagent') conversation.kind = 'subagent';
    const custom = threadRow.name?.trim();
    const derived = threadRow.title?.trim();
    if (custom) {
      conversation.title = { text: custom.slice(0, 200), revision: endOffset, source: 'custom' };
    } else if (derived && conversation.title?.source !== 'custom') {
      conversation.title = { text: derived.slice(0, 200), revision: endOffset, source: 'ai' };
    }
  }

  return {
    conversation,
    items,
    edges,
    quarantine,
    cursorAfter: JSON.stringify({
      byte_offset: endOffset,
      last_ext_id: prevExtId,
      thread_id: conversation.logicalId,
      meta_seen: metaSeen,
      prev_dup_kind: prevDup?.kind,
      prev_dup_hash: prevDup?.hash,
    } satisfies CodexCursor),
    maxEventTs,
    eof,
  };
}
