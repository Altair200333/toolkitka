import { readdirSync, statSync, openSync, readSync, closeSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { genKey, sourceKey, sha256hex } from '../core/ids.ts';
import { ingestPolicy, type SourceRootDef } from '../core/config.ts';
import type { ChangeBatch, ConversationUpsert, GenerationInfo, ItemUpsert, QuarantineEntry, ReadBudget } from './types.ts';

export const READER_VERSION = 1;

/** OpenCode keeps three storage eras under one root: the live sqlite WAL (current),
 *  frozen `opencode.db.bak-*` copies left behind by migrations, and the pre-sqlite
 *  JSON tree under storage/. Session ids are stable across eras (the sqlite migration
 *  imported the JSON tree verbatim), so
 *  the newest store that has a session owns it and older copies are never emitted —
 *  emitting both would double-ingest the same items under different gen keys. */
const LIVE_DB = 'opencode.db';

/** Step telemetry parts: no content of their own (tokens already live on the message). */
const SKIP_PART_TYPES = new Set(['step-start', 'step-finish']);

/** Explicit path fields in tool inputs (read/edit/write use filePath, glob/grep use path).
 *  bash command strings are deliberately not parsed; edited files come from patch parts. */
const PATH_INPUT_KEYS = ['filePath', 'path'];
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'list']);
const WRITE_TOOLS = new Set(['edit', 'write', 'patch']);

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

export function discoverOpencodeGenerations(root: SourceRootDef): GenerationInfo[] {
  if (!existsSync(root.rootPath)) return [];
  const out: GenerationInfo[] = [];
  const seen = new Set<string>();

  const dbFiles: string[] = [];
  if (existsSync(join(root.rootPath, LIVE_DB))) dbFiles.push(LIVE_DB);
  dbFiles.push(...readdirSync(root.rootPath)
    .filter((n) => n.startsWith('opencode.db.bak') && !n.endsWith('-wal') && !n.endsWith('-shm'))
    .sort().reverse()); // newest migration first; only matters if a session ever appears twice

  for (const file of dbFiles) {
    const absPath = join(root.rootPath, file);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(absPath, { readOnly: true });
    } catch (e) {
      if (file === LIVE_DB) throw e; // live must open; an unreadable .bak is just skipped
      continue;
    }
    try {
      db.exec('PRAGMA busy_timeout=2000');
      // Change signal per session: session.time_updated lags the actual row writes
      // (measured up to 166 s behind max part.time_updated), so take the row max.
      const signal = new Map<string, number>();
      for (const table of ['message', 'part']) {
        const rows = db.prepare(`SELECT session_id AS sid, MAX(time_updated) AS tu FROM ${table} GROUP BY session_id`)
          .all() as { sid: string; tu: number }[];
        for (const r of rows) signal.set(r.sid, Math.max(signal.get(r.sid) ?? 0, r.tu));
      }
      const st = statSync(absPath);
      const sessions = db.prepare(`SELECT id, time_created, time_updated FROM session`)
        .all() as { id: string; time_created: number; time_updated: number }[];
      for (const s of sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const locator = `${file}#${s.id}`;
        // time_created never changes for a session id → genKey is stable across appends
        // and the cursor keeps advancing instead of superseding the generation.
        const fp = sha256hex(`${s.id}|${s.time_created}`);
        out.push({
          genKey: genKey(root.rootId, locator, fp),
          rootId: root.rootId,
          app: 'opencode',
          kind: 'sqlite_table',
          locator,
          fingerprint: fp,
          absPath,
          // ms watermark doubles as the pipeline's "grew?" signal: it skips the
          // generation when sizeBytes <= cursor.byte_offset (see readDbSessionBatch)
          sizeBytes: Math.max(signal.get(s.id) ?? 0, s.time_updated),
          mtimeMs: st.mtimeMs,
        });
      }
    } finally {
      db.close();
    }
  }

  // Pre-sqlite JSON era: storage/session/<projectID>/ses_*.json is the descriptor,
  // messages and parts live in sibling trees. Frozen since the sqlite migration.
  const sesRoot = join(root.rootPath, 'storage', 'session');
  if (existsSync(sesRoot)) {
    for (const proj of readdirSync(sesRoot, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      for (const f of readdirSync(join(sesRoot, proj.name))) {
        if (!f.startsWith('ses_') || !f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        if (seen.has(id)) continue; // migrated into a sqlite era; the db copy owns it
        seen.add(id);
        const absPath = join(sesRoot, proj.name, f);
        const st = statSync(absPath);
        if (st.size === 0) continue;
        const locator = `storage/session/${proj.name}/${f}`;
        const fp = fingerprintFile(absPath);
        out.push({
          genKey: genKey(root.rootId, locator, fp),
          rootId: root.rootId,
          app: 'opencode',
          kind: 'json_file',
          locator,
          fingerprint: fp,
          absPath,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
  }
  return out;
}

/** Message context shared by every part of that message. */
interface MsgCtx {
  id: string;
  role: string;
  /** Synthetic linear-chain parent. data.parentID is a star onto the user message
   *  (36 assistant messages can share one parent) — useless for the branch walk. */
  parent?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}

function buildMsgCtx(id: string, data: Record<string, unknown>, parent: string | undefined): MsgCtx {
  const tokens = (data.tokens && typeof data.tokens === 'object' ? data.tokens : {}) as Record<string, unknown>;
  const modelObj = (data.model && typeof data.model === 'object' ? data.model : {}) as Record<string, unknown>;
  const model = typeof data.modelID === 'string' ? data.modelID
    : typeof modelObj.modelID === 'string' ? modelObj.modelID : undefined;
  return {
    id,
    role: String(data.role ?? ''),
    parent,
    model,
    tokensIn: typeof tokens.input === 'number' ? tokens.input : undefined,
    tokensOut: typeof tokens.output === 'number' ? tokens.output : undefined,
  };
}

function compactJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? '' : s;
  } catch {
    return '';
  }
}

function extractToolFiles(name: string, input: unknown): { pathDisplay: string; op?: string }[] {
  if (!input || typeof input !== 'object') return [];
  const rec = input as Record<string, unknown>;
  const op = READ_TOOLS.has(name) ? 'read' : WRITE_TOOLS.has(name) ? 'write' : undefined;
  const files: { pathDisplay: string; op?: string }[] = [];
  for (const key of PATH_INPUT_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 1) files.push({ pathDisplay: v, op });
  }
  return files;
}

/** One part → 0..2 items; a string result is a quarantine reason. Shapes are identical
 *  between the sqlite eras and the JSON era, so both readers share this. */
function partToItems(
  genKeyStr: string, prtId: string, part: Record<string, unknown>, ctx: MsgCtx,
  ordinal: number, ts: number | undefined, revision: number,
): ItemUpsert[] | string {
  const type = String(part.type ?? '');
  if (SKIP_PART_TYPES.has(type)) return [];
  const base = { logicalId: ctx.id, parentExtId: ctx.parent, ordinal, ts, revision };
  const key = (suffix?: string) => sourceKey(genKeyStr, suffix ? `${prtId}#${suffix}` : prtId);

  if (type === 'text') {
    const text = typeof part.text === 'string' ? part.text : '';
    if (!text) return [];
    if (ctx.role === 'user') {
      return [{ sourceKey: key(), kind: 'user', role: 'user', text, ...base }];
    }
    if (ctx.role === 'assistant') {
      const meta: Record<string, unknown> = {};
      if (ctx.model) meta.model = ctx.model;
      if (ctx.tokensIn !== undefined) meta.in = ctx.tokensIn;
      if (ctx.tokensOut !== undefined) meta.out = ctx.tokensOut;
      return [{ sourceKey: key(), kind: 'assistant', role: 'assistant', text, ...base, meta }];
    }
    return `text_part_on_role: ${ctx.role || '?'}`;
  }
  if (type === 'reasoning') {
    const text = typeof part.text === 'string' ? part.text : '';
    if (!text) return [];
    return [{ sourceKey: key(), kind: 'reasoning', role: 'reasoning', text, ...base }];
  }
  if (type === 'tool') {
    const state = (part.state && typeof part.state === 'object' ? part.state : {}) as Record<string, unknown>;
    const name = String(part.tool ?? 'tool');
    const callId = typeof part.callID === 'string' ? part.callID : undefined;
    const status = String(state.status ?? '');
    const items: ItemUpsert[] = [{
      sourceKey: key(), kind: 'tool_call', role: 'tool',
      text: `${name} ${compactJson(state.input ?? {})}`,
      callId, toolName: name, files: extractToolFiles(name, state.input), ...base,
    }];
    // pending/running parts have no output yet; the completed rewrite of the same row
    // bumps time_updated, so the result item appears on a later pass of the cursor
    if (status === 'completed' || status === 'error') {
      const text = status === 'error'
        ? (typeof state.error === 'string' ? state.error : compactJson(state.error))
        : (typeof state.output === 'string' ? state.output : '');
      items.push({
        sourceKey: key('r'), kind: 'tool_result', role: 'tool', text,
        callId, toolName: name, isError: status === 'error', ...base,
      });
    }
    return items;
  }
  if (type === 'patch') {
    // commit-like snapshot of the files this turn edited — the authoritative edit list
    const files = Array.isArray(part.files)
      ? (part.files.slice(0, 200).filter((f) => typeof f === 'string') as string[])
      : [];
    return [{
      sourceKey: key(), kind: 'system', role: 'system', text: '', ...base,
      files: files.map((p) => ({ pathDisplay: p, op: 'write' })),
      meta: typeof part.hash === 'string' ? { hash: part.hash } : undefined,
    }];
  }
  return `unknown_part_type: ${type || '?'}`;
}

function maybeFirstUserTitle(conversation: ConversationUpsert, item: ItemUpsert, revision: number) {
  if (item.kind === 'user' && !conversation.title && !item.text.startsWith('<')) {
    conversation.title = { text: item.text.slice(0, 120), revision, source: 'first_user' };
  }
}

interface DbCursor {
  /** Watermark ms doubling as the pipeline skip signal (skip when sizeBytes <= byte_offset).
   *  Present only after eof — a mid-backfill cursor must not suppress the next read. */
  byte_offset?: number;
  /** Committed watermark: everything with MAX(part.tu, msg.tu) <= ts has been consumed. */
  ts?: number;
  /** Exact resume point while one backfill is split across budget-sized batches. */
  pos_ts?: number;
  pos_id?: string;
}

interface PartRow { id: string; time_created: number; time_updated: number; data: string; message_id: string; eff: number }
interface MsgRow { id: string; time_created: number; time_updated: number; data: string }

/** Reads one sqlite-era session from its cursor. Live DB is a WAL another process is
 *  writing: readonly connection, busy_timeout, short SELECTs, nothing held open.
 *  Cursor: time_updated watermark with a 2000 ms overlap window —
 *  when the session's signal advances we re-read from ts-overlap and the idempotent
 *  upsert by source_key swallows the duplicate-millisecond rows. A row rewritten in
 *  the same ms as the watermark with no later session activity at all is the one
 *  accepted blind spot (the terminal write of a turn always bumps time_updated). */
function readDbSessionBatch(gen: GenerationInfo, cursorJson: string | undefined, budget: ReadBudget): ChangeBatch {
  const parsed = cursorJson ? JSON.parse(cursorJson) : {};
  const cursor: DbCursor = {
    ts: typeof parsed.ts === 'number' ? parsed.ts : undefined,
    pos_ts: typeof parsed.pos_ts === 'number' ? parsed.pos_ts : undefined,
    pos_id: typeof parsed.pos_id === 'string' ? parsed.pos_id : undefined,
  };
  const sesId = gen.locator.slice(gen.locator.indexOf('#') + 1);
  const items: ItemUpsert[] = [];
  const edges: { extId: string; parentExtId?: string }[] = [];
  const quarantine: QuarantineEntry[] = [];
  const conversation: ConversationUpsert = {
    app: 'opencode', rootId: gen.rootId, logicalId: sesId, kind: 'main', genKey: gen.genKey,
  };

  const db = new DatabaseSync(gen.absPath, { readOnly: true });
  let maxEventTs: number | undefined;
  let wm = cursor.ts ?? 0;
  let stopped = false;
  let fetched = 0;
  let fetchCap = 0;
  let lastEff: number | undefined;
  let lastId: string | undefined;
  try {
    db.exec('PRAGMA busy_timeout=2000');
    const ses = db.prepare(`SELECT parent_id, directory, title, time_created, time_updated FROM session WHERE id = ?`)
      .get(sesId) as { parent_id: string | null; directory: string | null; title: string | null; time_created: number; time_updated: number } | undefined;
    if (!ses) {
      // deleted between discover and read; nothing to report beyond an empty eof batch
      return { conversation, items, edges, quarantine, cursorAfter: cursorJson ?? '{}', eof: true };
    }
    if (ses.parent_id) conversation.kind = 'subagent';
    if (ses.directory) conversation.cwdDisplay = ses.directory;
    conversation.startedAt = ses.time_created;
    conversation.lastActivityAt = ses.time_updated;
    if (ses.title) conversation.title = { text: ses.title.slice(0, 200), revision: ses.time_updated, source: 'ai' };

    // Full message list every batch: it is the record chain (edges) and the per-part
    // context. Sessions are hundreds of messages — this stays cheap, and re-emitting
    // edges is idempotent. History inside a session is linear (forks are new sessions).
    const ctxById = new Map<string, MsgCtx>();
    const msgLower = cursor.ts !== undefined ? cursor.ts - ingestPolicy.opencodeOverlapMs : -1;
    let prevId: string | undefined;
    const msgs = db.prepare(`SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id`)
      .all(sesId) as MsgRow[];
    for (const m of msgs) {
      edges.push(prevId ? { extId: m.id, parentExtId: prevId } : { extId: m.id });
      conversation.headExtId = m.id;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(m.data);
      } catch (e) {
        // only inside the read window, else an idle corrupt row would re-log every scan
        if (m.time_updated > msgLower) {
          quarantine.push({ position: m.id, reason: `message_json_parse: ${String(e).slice(0, 100)}`, excerpt: m.data.slice(0, 300) });
        }
        prevId = m.id;
        continue;
      }
      ctxById.set(m.id, buildMsgCtx(m.id, data, prevId));
      prevId = m.id;
    }

    const eff = `MAX(p.time_updated, m.time_updated)`;
    let where = `p.session_id = ?`;
    const args: (string | number)[] = [sesId];
    if (cursor.pos_ts !== undefined && cursor.pos_id !== undefined) {
      where += ` AND (${eff} > ? OR (${eff} = ? AND p.id > ?))`;
      args.push(cursor.pos_ts, cursor.pos_ts, cursor.pos_id);
    } else if (cursor.ts !== undefined) {
      where += ` AND ${eff} > ?`;
      args.push(cursor.ts - ingestPolicy.opencodeOverlapMs);
    }
    // one part → up to 2 items, so maxItems+1 rows always over-covers the budget check
    fetchCap = budget.maxItems + 1;
    const rows = db.prepare(
      `SELECT p.id, p.time_created, p.time_updated, p.data, p.message_id, ${eff} AS eff
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE ${where} ORDER BY eff, p.id LIMIT ?`,
    ).all(...args, fetchCap) as PartRow[];
    fetched = rows.length;

    let itemBytes = 0;
    for (const row of rows) {
      if (items.length >= budget.maxItems || itemBytes >= budget.maxBytes) {
        stopped = true;
        break;
      }
      lastEff = row.eff;
      lastId = row.id;
      maxEventTs = Math.max(maxEventTs ?? 0, row.eff);
      let part: Record<string, unknown>;
      try {
        part = JSON.parse(row.data);
      } catch (e) {
        quarantine.push({ position: row.id, reason: `part_json_parse: ${String(e).slice(0, 100)}`, excerpt: row.data.slice(0, 300) });
        continue;
      }
      const ctx = ctxById.get(row.message_id);
      if (!ctx) {
        quarantine.push({ position: row.id, reason: 'part_without_message', excerpt: row.data.slice(0, 300) });
        continue;
      }
      const produced = partToItems(gen.genKey, row.id, part, ctx, row.time_created, row.time_created, row.eff);
      if (typeof produced === 'string') {
        quarantine.push({ position: row.id, reason: produced, excerpt: row.data.slice(0, 300) });
        continue;
      }
      for (const item of produced) {
        maybeFirstUserTitle(conversation, item, row.eff);
        items.push(item);
        itemBytes += item.text.length;
      }
    }
  } finally {
    db.close();
  }

  // a full fetch window means rows beyond the LIMIT may exist even if no budget tripped
  const eof = !stopped && fetched < fetchCap;
  if (lastEff !== undefined) wm = Math.max(wm, lastEff);
  const cursorAfter: DbCursor = eof
    // gen.sizeBytes folded in so empty/quiet sessions get skipped too
    ? { byte_offset: Math.max(wm, gen.sizeBytes), ts: wm }
    : { ts: cursor.ts, pos_ts: lastEff ?? cursor.pos_ts, pos_id: lastId ?? cursor.pos_id };
  return { conversation, items, edges, quarantine, cursorAfter: JSON.stringify(cursorAfter), maxEventTs, eof };
}

interface JsonCursor {
  /** Set to the descriptor file size at eof: the store is frozen, so the pipeline's
   *  sizeBytes <= byte_offset check skips the generation forever after one full read. */
  byte_offset?: number;
  /** Last consumed position while a read is split across batches. */
  msg?: string;
  prt?: string;
}

/** Reads one JSON-era session: <root>/storage/message/<sesId>/msg_*.json holds the
 *  messages, <root>/storage/part/<msgId>/prt_*.json the parts. The tree is frozen
 *  (dead since the sqlite migration), so this is a one-shot snapshot ingest with a
 *  purely positional cursor. */
function readJsonSessionBatch(gen: GenerationInfo, cursorJson: string | undefined, budget: ReadBudget): ChangeBatch {
  const parsed = cursorJson ? JSON.parse(cursorJson) : {};
  const cursor: JsonCursor = {
    msg: typeof parsed.msg === 'string' ? parsed.msg : undefined,
    prt: typeof parsed.prt === 'string' ? parsed.prt : undefined,
  };
  const firstBatch = cursor.msg === undefined;
  const sesId = basename(gen.absPath, '.json');
  const storageDir = dirname(dirname(dirname(gen.absPath))); // <root>/storage
  const items: ItemUpsert[] = [];
  const edges: { extId: string; parentExtId?: string }[] = [];
  const quarantine: QuarantineEntry[] = [];
  const conversation: ConversationUpsert = {
    app: 'opencode', rootId: gen.rootId, logicalId: sesId, kind: 'main', genKey: gen.genKey,
  };

  let ses: Record<string, unknown>;
  try {
    ses = JSON.parse(readFileSync(gen.absPath, 'utf8'));
  } catch (e) {
    // unreadable descriptor of a frozen store: record it once and never come back
    quarantine.push({ position: sesId, reason: `session_json_parse: ${String(e).slice(0, 100)}`, excerpt: '' });
    return { conversation, items, edges, quarantine, cursorAfter: JSON.stringify({ byte_offset: gen.sizeBytes }), eof: true };
  }
  const sesTime = (ses.time && typeof ses.time === 'object' ? ses.time : {}) as Record<string, unknown>;
  const sesUpdated = typeof sesTime.updated === 'number' ? sesTime.updated : 0;
  if (typeof ses.parentID === 'string' && ses.parentID) conversation.kind = 'subagent';
  if (typeof ses.directory === 'string') conversation.cwdDisplay = ses.directory;
  if (typeof sesTime.created === 'number') conversation.startedAt = sesTime.created;
  if (sesUpdated) conversation.lastActivityAt = sesUpdated;
  if (typeof ses.title === 'string' && ses.title) {
    conversation.title = { text: ses.title.slice(0, 200), revision: sesUpdated, source: 'ai' };
  }

  const msgDir = join(storageDir, 'message', sesId);
  const msgs: { id: string; tc: number; data: Record<string, unknown> }[] = [];
  if (existsSync(msgDir)) {
    for (const f of readdirSync(msgDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      try {
        const data = JSON.parse(readFileSync(join(msgDir, f), 'utf8')) as Record<string, unknown>;
        const time = (data.time && typeof data.time === 'object' ? data.time : {}) as Record<string, unknown>;
        msgs.push({ id, tc: typeof time.created === 'number' ? time.created : 0, data });
      } catch (e) {
        // its parts are unreachable without a role; one quarantine entry on the first batch
        if (firstBatch) quarantine.push({ position: id, reason: `message_json_parse: ${String(e).slice(0, 100)}`, excerpt: '' });
      }
    }
  }
  // ids are time-sortable within one era, but the encoding changed between versions —
  // the recorded creation time is the only order that holds across the whole store
  msgs.sort((a, b) => a.tc - b.tc || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const ctxById = new Map<string, MsgCtx>();
  let prevId: string | undefined;
  for (const m of msgs) {
    edges.push(prevId ? { extId: m.id, parentExtId: prevId } : { extId: m.id });
    conversation.headExtId = m.id;
    ctxById.set(m.id, buildMsgCtx(m.id, m.data, prevId));
    prevId = m.id;
  }

  let itemBytes = 0;
  let stopped = false;
  let started = cursor.msg === undefined;
  let lastMsg: string | undefined;
  let lastPrt: string | undefined;
  let maxEventTs: number | undefined;
  outer: for (const m of msgs) {
    if (!started) {
      if (m.id !== cursor.msg) continue;
      started = true;
    }
    const partDir = join(storageDir, 'part', m.id);
    const partFiles = existsSync(partDir) ? readdirSync(partDir).filter((f) => f.endsWith('.json')).sort() : [];
    for (const pf of partFiles) {
      const prtId = pf.slice(0, -5);
      if (m.id === cursor.msg && cursor.prt !== undefined && prtId <= cursor.prt) continue; // consumed in a previous batch
      if (items.length >= budget.maxItems || itemBytes >= budget.maxBytes) {
        stopped = true;
        break outer;
      }
      lastMsg = m.id;
      lastPrt = prtId;
      maxEventTs = Math.max(maxEventTs ?? 0, m.tc);
      let part: Record<string, unknown>;
      const raw = readFileSync(join(partDir, pf), 'utf8');
      try {
        part = JSON.parse(raw);
      } catch (e) {
        quarantine.push({ position: prtId, reason: `part_json_parse: ${String(e).slice(0, 100)}`, excerpt: raw.slice(0, 300) });
        continue;
      }
      const ctx = ctxById.get(m.id)!;
      // legacy parts carry no timestamps of their own; the message creation time is
      // the closest truth, and insertion order preserves the in-message part order
      const produced = partToItems(gen.genKey, prtId, part, ctx, m.tc, m.tc, m.tc);
      if (typeof produced === 'string') {
        quarantine.push({ position: prtId, reason: produced, excerpt: raw.slice(0, 300) });
        continue;
      }
      for (const item of produced) {
        maybeFirstUserTitle(conversation, item, m.tc);
        items.push(item);
        itemBytes += item.text.length;
      }
    }
  }

  const eof = !stopped;
  const cursorAfter: JsonCursor = eof
    ? { byte_offset: gen.sizeBytes }
    : { msg: lastMsg ?? cursor.msg, prt: lastPrt ?? cursor.prt };
  return { conversation, items, edges, quarantine, cursorAfter: JSON.stringify(cursorAfter), maxEventTs, eof };
}

/** Reads one generation (one session, sqlite or JSON era) from its cursor. */
export function readOpencodeBatch(gen: GenerationInfo, cursorJson: string | undefined, budget: ReadBudget): ChangeBatch {
  return gen.kind === 'sqlite_table'
    ? readDbSessionBatch(gen, cursorJson, budget)
    : readJsonSessionBatch(gen, cursorJson, budget);
}
