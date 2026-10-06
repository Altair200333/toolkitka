import { zstdDecompressSync } from 'node:zlib';
import { openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { paths } from '../core/config.ts';

export interface DeepSearchParams {
  pattern: string;
  regex?: boolean;
  chat?: string;
  src?: string;
  after?: number;
  before?: number;
  maxHits?: number;
  /** Epoch ms: past it the scan stops and returns what it has found so far. */
  deadline?: number;
}

export interface DeepHit {
  itemPublicId: string;
  convPublicId: string;
  convTitle: string | null;
  src: string;
  ts: number | null;
  toolName: string | null;
  context: string;
}

export interface DeepSearchResult {
  hits: DeepHit[];
  scannedBodies: number;
  /** Every body in scope was looked at. False when max_hits or the deadline stopped the scan. */
  exhausted: boolean;
  timedOut: boolean;
}

interface Matcher {
  test(text: string): number;
}

function makeMatcher(pattern: string, regex: boolean): Matcher {
  if (regex) {
    const re = new RegExp(pattern, 'i');
    return { test: (t) => t.match(re)?.index ?? -1 };
  }
  const needle = pattern.toLowerCase();
  return { test: (t) => t.toLowerCase().indexOf(needle) };
}

function context(text: string, at: number, span = 240): string {
  const start = Math.max(0, at - Math.floor(span / 3));
  return (start > 0 ? '…' : '') + text.slice(start, start + span).replaceAll('\n', ' ').trim() + '…';
}

interface CandidateRow {
  body_id: number;
  truncated: number;
  frame_id: number | null;
  frame_off: number | null;
  frame_len: number | null;
  /** Full text of a short body; NULL for truncated ones, whose full text is in the frame. */
  text: string | null;
}

/** Frames kept decompressed: average frame ≈ 130 KB, the largest ≈ 3 MB. */
const FRAME_CACHE = 64;
const FRAME_CACHE_BYTES = 32 * 1024 * 1024;

/** Honest fallback for the truncation policy: linear scan of FULL tool bodies —
 *  zstd frames for long ones plus the archive text of short ones, newest first.
 *  Whole archive ≈ 2.5 GB of text ≈ 20-30 s (2026-10-05); chat/after/before narrow the scan. */
export function deepSearch(archive: DatabaseSync, params: DeepSearchParams): DeepSearchResult {
  const matcher = makeMatcher(params.pattern, params.regex ?? false);
  const maxHits = params.maxHits ?? 20;
  const late = () => params.deadline !== undefined && Date.now() > params.deadline;
  const hits: DeepHit[] = [];
  // An unparseable date arrives as NaN (SQLite would bind it as NULL and match nothing): ignore it.
  const after = params.after || undefined;
  const before = params.before || undefined;

  const occFilters: string[] = [`i.state = 'active'`];
  const occArgs: (string | number)[] = [];
  if (params.chat) { occFilters.push(`c.public_id = ?`); occArgs.push(params.chat.replace(/^c:/, '')); }
  if (params.src) { occFilters.push(`c.app = ?`); occArgs.push(params.src); }
  if (after) { occFilters.push(`i.ts >= ?`); occArgs.push(after); }
  if (before) { occFilters.push(`i.ts <= ?`); occArgs.push(before); }
  const occSql = `
    SELECT i.public_id AS item_pid, i.ts, i.tool_name, c.public_id AS conv_pid, c.title, c.app
    FROM item i JOIN conversation c ON c.conv_id = i.conv_id
    WHERE i.body_id = ? AND ${occFilters.join(' AND ')}
    ORDER BY (i.branch_state = 'active') DESC, COALESCE(i.ts, 0) DESC LIMIT 1`;
  const pickOcc = archive.prepare(occSql);

  const emit = (bodyId: number, text: string, at: number): boolean => {
    const occ = pickOcc.get(bodyId, ...occArgs) as { item_pid: string; ts: number | null; tool_name: string | null; conv_pid: string; title: string | null; app: string } | undefined;
    if (!occ) return false;
    hits.push({
      itemPublicId: occ.item_pid,
      convPublicId: occ.conv_pid,
      convTitle: occ.title,
      src: occ.app,
      ts: occ.ts,
      toolName: occ.tool_name,
      context: context(text, at),
    });
    return hits.length >= maxHits;
  };

  // Long bodies live in zstd frames; neighbours in the scan order mostly share a frame,
  // so a small LRU decompresses each frame about once. null = unreadable frame, skip its bodies.
  const frameRow = archive.prepare(`SELECT file, offset, clen FROM tool_frame WHERE frame_id = ?`);
  const frames = new Map<number, Buffer | null>();
  let frameBytes = 0;
  const loadFrame = (frameId: number): Buffer | null => {
    const cached = frames.get(frameId);
    if (cached !== undefined) {
      frames.delete(frameId);
      frames.set(frameId, cached);
      return cached;
    }
    let raw: Buffer | null = null;
    const fr = frameRow.get(frameId) as { file: string; offset: number; clen: number } | undefined;
    if (fr) {
      try {
        const fd = openSync(join(paths.blobsDir, fr.file), 'r');
        try {
          const compressed = Buffer.allocUnsafe(fr.clen);
          let got = 0;
          while (got < fr.clen) {
            const n = readSync(fd, compressed, got, fr.clen - got, fr.offset + got);
            if (n <= 0) break;
            got += n;
          }
          raw = zstdDecompressSync(compressed.subarray(0, got));
        } finally {
          closeSync(fd);
        }
      } catch {
        raw = null;
      }
    }
    frames.set(frameId, raw);
    frameBytes += raw?.length ?? 0;
    while (frames.size > 1 && (frames.size > FRAME_CACHE || frameBytes > FRAME_CACHE_BYTES)) {
      const [oldId, old] = frames.entries().next().value!;
      frames.delete(oldId);
      frameBytes -= old?.length ?? 0;
    }
    return raw;
  };

  // Candidates come newest first in one streamed query, so the deadline is checked on every row
  // and no single statement runs long: chat → its items by ordinal, after/before → items by ts,
  // otherwise every tool body by body_id (≈ ingest order). CROSS JOIN keeps item as the outer loop,
  // so the index yields the order without a sort over the whole range. The remaining filters
  // (src, dates inside a chat) are applied per hit by pickOcc.
  const cols = `b.body_id, b.truncated, b.frame_id, b.frame_off, b.frame_len, CASE WHEN b.truncated = 0 THEN b.text_index END AS text`;
  let sql: string;
  let args: (string | number)[] = [];
  if (params.chat) {
    sql = `SELECT ${cols} FROM item i CROSS JOIN body b ON b.body_id = i.body_id
      WHERE i.conv_id = (SELECT conv_id FROM conversation WHERE public_id = ?) AND b.role = 'tool'
      ORDER BY i.ordinal DESC`;
    args = [params.chat.replace(/^c:/, '')];
  } else if (after || before) {
    sql = `SELECT ${cols} FROM item i CROSS JOIN body b ON b.body_id = i.body_id
      WHERE i.ts >= ? AND i.ts <= ? AND b.role = 'tool'
      ORDER BY i.ts DESC`;
    args = [after ?? 0, before ?? Number.MAX_SAFE_INTEGER];
  } else {
    sql = `SELECT ${cols} FROM body b WHERE b.role = 'tool' ORDER BY b.body_id DESC`;
  }
  // Through item the same body can come many times (re-sent outputs); body_id order is unique.
  const seen = params.chat || after || before ? new Set<number>() : null;

  let scanned = 0;
  let done = false;
  let timedOut = false;
  for (const row of archive.prepare(sql).iterate(...args) as Iterable<CandidateRow>) {
    if (late()) { timedOut = true; break; }
    if (seen) {
      if (seen.has(row.body_id)) continue;
      seen.add(row.body_id);
    }
    let text = row.text;
    if (row.truncated) {
      if (row.frame_id === null) continue;
      const raw = loadFrame(row.frame_id);
      if (!raw) continue;
      text = raw.subarray(row.frame_off!, row.frame_off! + row.frame_len!).toString('utf8');
    }
    if (text === null) continue;
    scanned++;
    const at = matcher.test(text);
    if (at >= 0 && emit(row.body_id, text, at)) {
      done = true;
      break;
    }
  }

  return { hits, scannedBodies: scanned, exhausted: !done && !timedOut, timedOut };
}
