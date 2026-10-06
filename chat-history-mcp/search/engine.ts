import type { DatabaseSync } from 'node:sqlite';
import { parseUserQuery, buildMatch } from './query.ts';

export interface SearchParams {
  query: string;
  src?: string;
  role?: string;
  after?: number;
  before?: number;
  project?: string;
  tool?: string;
  branch?: 'all' | 'active';
  sort?: 'rank' | 'time';
  k?: number;
  cursor?: SearchCursor;
}

export interface SearchCursor {
  lastRank: number;
  lastPid: string;
}

export interface SearchHit {
  itemPublicId: string;
  convPublicId: string;
  convTitle: string | null;
  src: string;
  rootId: string;
  kind: string;
  role: string;
  ts: number | null;
  branchState: string;
  truncated: boolean;
  occurrences: number;
  snippet: string;
  rank: number;
}

const OVERSAMPLE = 12;

function makeSnippet(text: string, terms: string[], stems: string[], windows = 2, windowChars = 240): string {
  const lower = text.toLowerCase();
  const needles = [...terms, ...stems].filter((t) => t.length >= 2);
  const spots: number[] = [];
  for (const n of needles) {
    const at = lower.indexOf(n);
    if (at >= 0) spots.push(at);
  }
  if (!spots.length) return text.slice(0, windowChars).replaceAll('\n', ' ');
  spots.sort((a, b) => a - b);
  const chosen: [number, number][] = [];
  for (const s of spots) {
    const start = Math.max(0, s - Math.floor(windowChars / 3));
    const end = Math.min(text.length, start + windowChars);
    if (chosen.length && start < chosen.at(-1)![1]) continue;
    chosen.push([start, end]);
    if (chosen.length >= windows) break;
  }
  return chosen
    .map(([s, e]) => (s > 0 ? '…' : '') + text.slice(s, e).replaceAll('\n', ' ').trim() + (e < text.length ? '…' : ''))
    .join(' … ');
}

/** Search over the projection with occurrence collapse: one physical body may occur in
 *  many sessions/forks — we show the best occurrence and the count. */
export function searchDocs(index: DatabaseSync, archive: DatabaseSync, params: SearchParams): { hits: SearchHit[]; nextCursor?: SearchCursor } {
  const parsed = parseUserQuery(params.query);
  const match = buildMatch(parsed);
  if (!match) return { hits: [] };
  const k = params.k ?? 10;

  const ftsRows = index
    .prepare(`SELECT rowid AS body_id, rank FROM fts WHERE fts MATCH ? ORDER BY rank, rowid LIMIT ?`)
    .all(match, k * OVERSAMPLE + 1) as { body_id: number; rank: number }[];
  if (!ftsRows.length) return { hits: [] };

  const filters: string[] = [`i.state = 'active'`];
  const filterArgs: (string | number)[] = [];
  if (params.src) { filters.push(`c.app = ?`); filterArgs.push(params.src); }
  if (params.after) { filters.push(`i.ts >= ?`); filterArgs.push(params.after); }
  if (params.before) { filters.push(`i.ts <= ?`); filterArgs.push(params.before); }
  if (params.project) { filters.push(`c.cwd_key LIKE ?`); filterArgs.push(`%${params.project.toLowerCase().replaceAll('\\', '/')}%`); }
  if (params.tool) { filters.push(`i.tool_name = ?`); filterArgs.push(params.tool); }
  if (params.branch === 'active') filters.push(`i.branch_state = 'active'`);

  const pickOccurrence = archive.prepare(`
    SELECT i.public_id AS item_pid, i.kind, i.ts, i.branch_state, i.tool_name,
           c.public_id AS conv_pid, c.title, c.app, c.root_id,
           (SELECT COUNT(*) FROM item i2 WHERE i2.body_id = i.body_id AND i2.state = 'active') AS occ
    FROM item i JOIN conversation c ON c.conv_id = i.conv_id
    WHERE i.body_id = ? AND ${filters.join(' AND ')}
    ORDER BY (i.branch_state = 'active') DESC, COALESCE(i.ts, 0) DESC
    LIMIT 1`);
  const getBody = archive.prepare(`SELECT text_index, role, truncated FROM body WHERE body_id = ?`);

  const hits: SearchHit[] = [];
  for (const row of ftsRows) {
    if (params.cursor) {
      if (row.rank < params.cursor.lastRank) continue;
    }
    const occ = pickOccurrence.get(row.body_id, ...filterArgs) as {
      item_pid: string; kind: string; ts: number | null; branch_state: string; tool_name: string | null;
      conv_pid: string; title: string | null; app: string; root_id: string; occ: number;
    } | undefined;
    if (!occ) continue;
    if (params.role) {
      const body = getBody.get(row.body_id) as { role: string } | undefined;
      if (body?.role !== params.role) continue;
    }
    if (params.cursor && row.rank === params.cursor.lastRank && occ.item_pid <= params.cursor.lastPid) continue;

    const body = getBody.get(row.body_id) as { text_index: string; role: string; truncated: number };
    hits.push({
      itemPublicId: occ.item_pid,
      convPublicId: occ.conv_pid,
      convTitle: occ.title,
      src: occ.app,
      rootId: occ.root_id,
      kind: occ.kind,
      role: body.role,
      ts: occ.ts,
      branchState: occ.branch_state,
      truncated: body.truncated === 1,
      occurrences: occ.occ,
      snippet: makeSnippet(body.text_index, parsed.terms, parsed.stems),
      rank: row.rank,
    });
    if (hits.length >= k + 1) break;
  }

  if (params.sort === 'time') hits.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  let nextCursor: SearchCursor | undefined;
  if (hits.length > k) {
    hits.length = k;
    const last = hits.at(-1)!;
    nextCursor = { lastRank: last.rank, lastPid: last.itemPublicId };
  }
  return { hits, nextCursor };
}

export interface ChatLine {
  itemPublicId: string;
  kind: string;
  role: string;
  ts: number | null;
  text: string;
  toolName: string | null;
  meta: Record<string, unknown> | null;
  branchState: string;
}

export interface ChatPage {
  convPublicId: string;
  title: string | null;
  src: string;
  rootId: string;
  cwd: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  totalItems: number;
  lines: ChatLine[];
  nextOrdinal?: number;
}

/** Reads a chat page: dialog text only (user/assistant/compact summaries); tool bodies and
 *  reasoning are counted in metadata and served by chat_details, never inlined. */
export function readChat(archive: DatabaseSync, convPid: string, opts: { fromOrdinal?: number; maxChars?: number; branch?: 'all' | 'active' } = {}): ChatPage | null {
  const conv = archive.prepare(`SELECT conv_id, public_id, title, app, root_id, cwd_display, started_at, last_activity_at FROM conversation WHERE public_id = ?`)
    .get(convPid) as { conv_id: number; public_id: string; title: string | null; app: string; root_id: string; cwd_display: string | null; started_at: number | null; last_activity_at: number | null } | undefined;
  if (!conv) return null;
  const branch = opts.branch ?? 'active';
  const maxChars = opts.maxChars ?? 12000;

  const branchCond = branch === 'active' ? `AND i.branch_state = 'active'` : '';
  const rows = archive.prepare(`
    SELECT i.public_id, i.kind, i.ordinal, i.ts, i.tool_name, i.meta_json, i.branch_state,
           b.role, b.text_index
    FROM item i LEFT JOIN body b ON b.body_id = i.body_id
    WHERE i.conv_id = ? AND i.state = 'active' AND i.ordinal >= ? ${branchCond}
      AND i.kind IN ('user','assistant','compact_summary')
    ORDER BY i.ordinal LIMIT 500`).all(conv.conv_id, opts.fromOrdinal ?? 0) as {
      public_id: string; kind: string; ordinal: number; ts: number | null; tool_name: string | null;
      meta_json: string | null; branch_state: string; role: string | null; text_index: string | null;
    }[];

  const total = (archive.prepare(`SELECT COUNT(*) AS n FROM item WHERE conv_id = ? AND state = 'active' AND kind IN ('user','assistant','compact_summary')`).get(conv.conv_id) as { n: number }).n;

  const lines: ChatLine[] = [];
  let used = 0;
  let nextOrdinal: number | undefined;
  for (const r of rows) {
    const text = r.text_index ?? '';
    if (lines.length && used + text.length > maxChars) {
      nextOrdinal = r.ordinal;
      break;
    }
    used += text.length;
    lines.push({
      itemPublicId: r.public_id,
      kind: r.kind,
      role: r.role ?? 'system',
      ts: r.ts,
      text,
      toolName: r.tool_name,
      meta: r.meta_json ? JSON.parse(r.meta_json) : null,
      branchState: r.branch_state,
    });
  }

  return {
    convPublicId: conv.public_id,
    title: conv.title,
    src: conv.app,
    rootId: conv.root_id,
    cwd: conv.cwd_display,
    startedAt: conv.started_at,
    lastActivityAt: conv.last_activity_at,
    totalItems: total,
    lines,
    nextOrdinal,
  };
}

export interface SourceFreshness {
  source: string;
  lastIngestedEventTs: number | null;
  lastScanAt: number | null;
  parseErrors: number;
  quarantined: number;
}

export function freshness(archive: DatabaseSync): { sources: SourceFreshness[]; heartbeat: { pid: number; beatAt: number } | null } {
  const sources = archive.prepare(`SELECT source, last_ingested_event_ts, last_scan_at, parse_errors, quarantined_count FROM source_state ORDER BY source`)
    .all() as { source: string; last_ingested_event_ts: number | null; last_scan_at: number | null; parse_errors: number; quarantined_count: number }[];
  const hb = archive.prepare(`SELECT pid, beat_at FROM writer_heartbeat WHERE id = 1`).get() as { pid: number; beat_at: number } | undefined;
  return {
    sources: sources.map((s) => ({
      source: s.source,
      lastIngestedEventTs: s.last_ingested_event_ts,
      lastScanAt: s.last_scan_at,
      parseErrors: s.parse_errors,
      quarantined: s.quarantined_count,
    })),
    heartbeat: hb ? { pid: hb.pid, beatAt: hb.beat_at } : null,
  };
}
