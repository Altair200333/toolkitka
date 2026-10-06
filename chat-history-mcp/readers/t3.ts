import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { genKey, sourceKey, sha256hex } from '../core/ids.ts';
import type { SourceRootDef } from '../core/config.ts';
import type { ChangeBatch, ConversationUpsert, GenerationInfo, ItemUpsert, QuarantineEntry, ReadBudget } from './types.ts';

export const READER_VERSION = 1;

/** Events fetched per SELECT — keeps read transactions short on the live DB;
 *  the budget check between events is what actually bounds the batch. */
const EVENT_CHUNK = 500;

/** Thread events with no message content: lifecycle, telemetry, UI state.
 *  Deliberately consumed without producing items. */
const SKIP_EVENT_TYPES = new Set([
  'thread.created', 'thread.turn-start-requested', 'thread.session-set', 'thread.meta-updated',
  'thread.turn-diff-completed', 'thread.settled', 'thread.unsettled', 'thread.session-stop-requested',
  'thread.turn-interrupt-requested', 'thread.pinned', 'thread.unpinned', 'thread.pin-reordered',
  'thread.snoozed', 'thread.unsnoozed', 'thread.deleted', 'thread.archived',
  'thread.checkpoint-revert-requested', 'thread.user-input-response-requested', 'thread.proposed-plan-upserted',
]);

/** Streaming partials and telemetry activities. Each state transition is a separate
 *  row (tool.started → tool.updated×N → tool.completed share only payload.toolCallId),
 *  so pending states are simply skipped: the final row carries call AND result. */
const SKIP_ACTIVITY_KINDS = new Set([
  'tool.started', 'tool.updated', 'task.started', 'task.updated', 'task.progress',
  'context-window.updated', 'checkpoint.captured', 'checkpoint.capture.failed',
  'turn.plan.updated', 'context-compaction', 'runtime.warning', 'runtime.error',
  'user-input.requested', 'user-input.resolved',
]);

const PATH_INPUT_KEYS = ['file_path', 'path', 'notebook_path'];

/** SQLite header fields that move on every write (change counter, page count,
 *  freelist, schema cookie block, version stamps) are zeroed; what remains —
 *  header constants + page-1 body (sqlite_master root) — only changes when the
 *  database is recreated or migrated. */
function fingerprintDbPrefix(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const n = readSync(fd, buf, 0, 1024, 0);
    buf.fill(0, 24, 56);
    buf.fill(0, 92, 100);
    return sha256hex(buf.subarray(0, Math.max(n, 0)));
  } finally {
    closeSync(fd);
  }
}

/** state.sqlite belongs to a live t3; readonly + busy_timeout, never a single write. */
function openRo(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout=2000');
  return db;
}

interface ThreadListRow {
  thread_id: string;
  created_at: string | null;
  updated_at: string | null;
}

/** One generation per thread: the ChangeBatch contract carries exactly one
 *  conversation, and orchestration_events.sequence is monotonic per stream too
 *  (index on aggregate_kind, stream_id, sequence). Deleted/archived threads are
 *  soft-deleted upstream and stay discoverable. */
export function discoverT3Generations(root: SourceRootDef): GenerationInfo[] {
  const dbPath = join(root.rootPath, 'state.sqlite');
  if (!existsSync(dbPath)) return [];
  const st = statSync(dbPath);
  if (st.size === 0) return [];
  const dbFp = fingerprintDbPrefix(dbPath);
  const out: GenerationInfo[] = [];
  const db = openRo(dbPath);
  try {
    const rows = db.prepare('SELECT thread_id, created_at, updated_at FROM projection_threads').all() as unknown as ThreadListRow[];
    for (const t of rows) {
      const locator = `state.sqlite#thread/${t.thread_id}`;
      // created_at guards against a rebuilt DB reusing thread ids
      const fp = sha256hex(`${dbFp}|${t.created_at ?? ''}`);
      const mtime = Date.parse(t.updated_at ?? '');
      out.push({
        genKey: genKey(root.rootId, locator, fp),
        rootId: root.rootId,
        app: 't3',
        kind: 'sqlite_table',
        locator,
        fingerprint: fp,
        absPath: dbPath,
        sizeBytes: st.size,
        mtimeMs: Number.isNaN(mtime) ? st.mtimeMs : mtime,
      });
    }
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
  return out;
}

interface T3Cursor {
  /** Last consumed orchestration_events.sequence for this thread. */
  seq: number;
  /** Tail of the synthetic linear chain — t3 threads have no parent links. */
  last_ext_id?: string;
}

interface EventRow { sequence: number; event_type: string; occurred_at: string; payload_json: string }
interface MessageRow { message_id: string; role: string; text: string; is_streaming: number; created_at: string; attachments_json: string | null }
interface ActivityRow { activity_id: string; kind: string; summary: string | null; payload_json: string; created_at: string }
interface ThreadRow { title: string | null; project_id: string | null; created_at: string | null; updated_at: string | null }

function compactJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? '' : s;
  } catch {
    return '';
  }
}

function extractCallFiles(name: string, input: Record<string, unknown> | undefined): { pathDisplay: string; op?: string }[] {
  if (!input) return [];
  const op = name === 'Read' || name === 'Grep' || name === 'Glob' ? 'read' : name === 'Edit' || name === 'Write' || name === 'NotebookEdit' ? 'write' : undefined;
  const files: { pathDisplay: string; op?: string }[] = [];
  for (const key of PATH_INPUT_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 1) files.push({ pathDisplay: v, op });
  }
  return files;
}

/** result.content is a string for most tools; MCP-style results are block arrays. */
function resultText(result: unknown): { text: string; isError: boolean } {
  if (!result || typeof result !== 'object') return { text: '', isError: false };
  const r = result as { content?: unknown; is_error?: unknown };
  let text = '';
  if (typeof r.content === 'string') {
    text = r.content;
  } else if (Array.isArray(r.content)) {
    const parts: string[] = [];
    for (const b of r.content) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
        const t = (b as { text?: string }).text;
        if (t) parts.push(t);
      }
    }
    text = parts.join('\n');
  }
  return { text, isError: r.is_error === true };
}

/** Attachment entries reference PNGs in <userdata>/attachments/<id>.<ext>. */
function attachmentFiles(attachmentsJson: string | null, attachmentsDir: string): { pathDisplay: string; op?: string }[] {
  if (!attachmentsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(attachmentsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const files: { pathDisplay: string; op?: string }[] = [];
  for (const a of parsed.slice(0, 50)) {
    const e = a as { id?: unknown; name?: unknown };
    if (typeof e?.id !== 'string' || !e.id) continue;
    const ext = extname(typeof e.name === 'string' ? e.name : '') || '.png';
    files.push({ pathDisplay: join(attachmentsDir, `${e.id}${ext}`) });
  }
  return files;
}

/** Reads one generation (one t3 thread inside state.sqlite) from its sequence cursor.
 *  Events only mark which projection rows changed; content is re-read from the
 *  projections so streaming partials collapse into the final row.
 *  Reasoning never reaches state.sqlite — it lives in logs/provider/events.*.log, so this reader emits none. */
export function readT3Batch(gen: GenerationInfo, cursorJson: string | undefined, budget: ReadBudget): ChangeBatch {
  const parsedCursor = cursorJson ? JSON.parse(cursorJson) : {};
  const cursor: T3Cursor = {
    seq: typeof parsedCursor.seq === 'number' ? parsedCursor.seq : 0,
    last_ext_id: typeof parsedCursor.last_ext_id === 'string' ? parsedCursor.last_ext_id : undefined,
  };
  const threadId = gen.locator.match(/#thread\/(.+)$/)?.[1] ?? gen.locator;
  const items: ItemUpsert[] = [];
  const edges: { extId: string; parentExtId?: string }[] = [];
  const quarantine: QuarantineEntry[] = [];

  const conversation: ConversationUpsert = {
    app: 't3',
    rootId: gen.rootId,
    logicalId: threadId,
    kind: 'main',
    genKey: gen.genKey,
  };

  let itemBytes = 0;
  let maxEventTs: number | undefined;
  let lastSeq = cursor.seq;
  let prevExtId = cursor.last_ext_id;
  let eof = false;

  const push = (item: ItemUpsert) => {
    items.push(item);
    itemBytes += item.text.length;
  };
  const addEdge = (extId: string) => {
    if (extId === prevExtId) return; // same row re-read at a batch head: no self-edge
    edges.push(prevExtId ? { extId, parentExtId: prevExtId } : { extId });
    prevExtId = extId;
    conversation.headExtId = extId;
  };

  const db = openRo(gen.absPath);
  try {
    const evStmt = db.prepare(
      `SELECT sequence, event_type, occurred_at, payload_json FROM orchestration_events
       WHERE aggregate_kind = 'thread' AND stream_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`);
    const msgStmt = db.prepare(
      'SELECT message_id, role, text, is_streaming, created_at, attachments_json FROM projection_thread_messages WHERE message_id = ?');
    const actStmt = db.prepare(
      'SELECT activity_id, kind, summary, payload_json, created_at FROM projection_thread_activities WHERE activity_id = ?');
    const attachmentsDir = join(dirname(gen.absPath), 'attachments');
    const seen = new Set<string>();

    const emitMessage = (id: string, seq: number) => {
      if (seen.has(id)) return;
      const row = msgStmt.get(id) as unknown as MessageRow | undefined;
      if (!row) return; // projection row gone: thread revert/delete pruned it; nothing left to index
      if (row.is_streaming) return; // pending; unmarked, so the final message-sent event re-emits it
      seen.add(id);
      const text = row.text;
      if (!text) return;
      const ts = Date.parse(row.created_at);
      const files = attachmentFiles(row.attachments_json, attachmentsDir);
      if (row.role !== 'user' && row.role !== 'assistant') {
        quarantine.push({ position: id, reason: `unknown_role: ${row.role}`, excerpt: text.slice(0, 300) });
        return;
      }
      const role = row.role as 'user' | 'assistant';
      addEdge(id);
      push({
        sourceKey: sourceKey(gen.genKey, id), kind: role, role, text,
        logicalId: id, ordinal: seq, ts: Number.isNaN(ts) ? undefined : ts, revision: seq,
        files: files.length ? files : undefined,
      });
    };

    /** tool.completed rows hold call AND result in one payload → one item. */
    const emitActivity = (id: string, seq: number) => {
      if (seen.has(id)) return;
      const row = actStmt.get(id) as unknown as ActivityRow | undefined;
      if (!row) return;
      seen.add(id);
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(row.payload_json);
      } catch (e) {
        quarantine.push({ position: id, reason: `activity_json_parse: ${String(e).slice(0, 100)}`, excerpt: row.payload_json.slice(0, 300) });
        return;
      }
      const ts = Date.parse(row.created_at);
      const base = { logicalId: id, ordinal: seq, ts: Number.isNaN(ts) ? undefined : ts, revision: seq };

      if (row.kind === 'task.completed') {
        // subagent/background task summary; the transcript lives in the provider's own files
        const dedup = new Set<string>();
        const parts: string[] = [];
        for (const v of [p.title, p.summary, p.detail]) {
          if (typeof v === 'string' && v && !dedup.has(v)) { dedup.add(v); parts.push(v); }
        }
        const meta: Record<string, unknown> = {};
        for (const k of ['taskId', 'taskType', 'agentKind', 'status', 'model', 'role'] as const) {
          if (typeof p[k] === 'string' && p[k]) meta[k] = p[k];
        }
        addEdge(id);
        push({
          sourceKey: sourceKey(gen.genKey, id), kind: 'tool_call', role: 'tool', text: parts.join('\n'),
          callId: typeof p.toolUseId === 'string' ? p.toolUseId : undefined,
          toolName: `task:${typeof p.taskType === 'string' ? p.taskType : 'unknown'}`,
          isError: p.status === 'failed', meta, ...base,
        });
        return;
      }

      if (row.kind === 'tool.denied') {
        const name = typeof p.toolName === 'string' && p.toolName ? p.toolName : 'tool';
        addEdge(id);
        push({
          sourceKey: sourceKey(gen.genKey, id), kind: 'tool_call', role: 'tool',
          text: `${name} ${row.summary ?? 'denied'}`.trim(),
          callId: typeof p.toolUseId === 'string' ? p.toolUseId : undefined,
          toolName: name, isError: true, meta: { status: 'denied' }, ...base,
        });
        return;
      }

      // tool.completed
      const data = (p.data && typeof p.data === 'object' ? p.data : {}) as Record<string, unknown>;
      const detail = typeof p.detail === 'string' ? p.detail : '';
      let name = typeof data.toolName === 'string' && data.toolName ? data.toolName : undefined;
      let args: string | undefined;
      if ('input' in data) args = compactJson(data.input);
      if (!name) {
        // detail is "ToolName: {json args}" for tool calls, free text otherwise
        const colon = detail.indexOf(':');
        if (colon > 0 && colon <= 64 && !detail.slice(0, colon).includes(' ')) {
          name = detail.slice(0, colon);
          args ??= detail.slice(colon + 1).trim();
        }
      }
      name ??= typeof p.itemType === 'string' ? p.itemType : 'tool';
      args ??= detail;
      const result = resultText((data as { result?: unknown }).result);
      const meta: Record<string, unknown> = {};
      if (typeof p.itemType === 'string') meta.itemType = p.itemType;
      if (typeof p.status === 'string' && p.status !== 'completed') meta.status = p.status;
      addEdge(id);
      push({
        sourceKey: sourceKey(gen.genKey, id), kind: 'tool_call', role: 'tool',
        text: result.text ? `${name} ${args}\n${result.text}` : `${name} ${args}`,
        callId: typeof p.toolCallId === 'string' ? p.toolCallId : undefined,
        toolName: name, isError: result.isError || p.status === 'failed',
        files: extractCallFiles(name, 'input' in data && data.input && typeof data.input === 'object' ? data.input as Record<string, unknown> : undefined),
        meta, ...base,
      });
    };

    outer: while (true) {
      const chunk = evStmt.all(threadId, lastSeq, EVENT_CHUNK) as unknown as EventRow[];
      for (const ev of chunk) {
        if (items.length >= budget.maxItems || itemBytes >= budget.maxBytes) break outer;
        const ts = Date.parse(ev.occurred_at);
        if (!Number.isNaN(ts)) maxEventTs = Math.max(maxEventTs ?? 0, ts);

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(ev.payload_json);
        } catch (e) {
          quarantine.push({ position: `ev/${ev.sequence}`, reason: `json_parse: ${String(e).slice(0, 100)}`, excerpt: ev.payload_json.slice(0, 300) });
          lastSeq = ev.sequence;
          continue;
        }

        if (ev.event_type === 'thread.message-sent') {
          if (typeof payload.messageId === 'string' && payload.messageId) emitMessage(payload.messageId, ev.sequence);
        } else if (ev.event_type === 'thread.activity-appended') {
          const a = (payload.activity && typeof payload.activity === 'object' ? payload.activity : {}) as Record<string, unknown>;
          const kind = typeof a.kind === 'string' ? a.kind : '';
          if (typeof a.id === 'string' && a.id && (kind === 'tool.completed' || kind === 'tool.denied' || kind === 'task.completed')) {
            emitActivity(a.id, ev.sequence);
          } else if (!SKIP_ACTIVITY_KINDS.has(kind) && !kind.startsWith('provider.')) {
            quarantine.push({ position: `ev/${ev.sequence}`, reason: `unknown_activity_kind: ${kind}`, excerpt: ev.payload_json.slice(0, 300) });
          }
        } else if (ev.event_type === 'thread.reverted') {
          // marker only; abandoning the reverted turns is pipeline work
          push({
            sourceKey: sourceKey(gen.genKey, `ev/${ev.sequence}`), kind: 'rollback', role: 'system',
            text: '', ordinal: ev.sequence, ts: Number.isNaN(ts) ? undefined : ts, revision: ev.sequence,
            meta: { turnCount: typeof payload.turnCount === 'number' ? payload.turnCount : undefined },
          });
        } else if (!SKIP_EVENT_TYPES.has(ev.event_type)) {
          quarantine.push({ position: `ev/${ev.sequence}`, reason: `unknown_type: ${ev.event_type}`, excerpt: ev.payload_json.slice(0, 300) });
        }
        lastSeq = ev.sequence;
      }
      if (chunk.length < EVENT_CHUNK) {
        eof = true;
        break;
      }
    }

    // Title and lifetime from t3's own projection; title is model-generated
    // ("ai") — user renames are indistinguishable in the schema. Revision =
    // sequence ceiling keeps later reads winning.
    const trow = db.prepare('SELECT title, project_id, created_at, updated_at FROM projection_threads WHERE thread_id = ?')
      .get(threadId) as unknown as ThreadRow | undefined;
    if (trow) {
      const title = trow.title?.trim();
      if (title) conversation.title = { text: title.slice(0, 200), revision: lastSeq, source: 'ai' };
      const started = Date.parse(trow.created_at ?? '');
      if (!Number.isNaN(started)) conversation.startedAt = started;
      const updated = Date.parse(trow.updated_at ?? '');
      if (!Number.isNaN(updated)) conversation.lastActivityAt = updated;
      if (trow.project_id) {
        const prow = db.prepare('SELECT workspace_root FROM projection_projects WHERE project_id = ?')
          .get(trow.project_id) as unknown as { workspace_root: string | null } | undefined;
        if (prow?.workspace_root) conversation.cwdDisplay = prow.workspace_root;
      }
    }
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }

  return {
    conversation,
    items,
    edges,
    quarantine,
    cursorAfter: JSON.stringify({ seq: lastSeq, last_ext_id: prevExtId } satisfies T3Cursor),
    maxEventTs,
    eof,
  };
}
