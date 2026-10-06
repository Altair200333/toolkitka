import { zstdCompressSync } from 'node:zlib';
import { appendFileSync, mkdirSync, readdirSync, statSync, truncateSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ingestPolicy } from '../core/config.ts';

interface PendingBody {
  contentHash: string;
  utf8: Buffer;
}

export interface FrameRef {
  frameId: number;
  frameOff: number;
  frameLen: number;
}

/** Append-only store of full tool bodies: zstd frames ~256 KB in rolling files.
 *  Frames are flushed to disk BEFORE the archive transaction commits, so committed
 *  rows always point at bytes that exist. An orphan tail (crash between append and
 *  COMMIT) is truncated on writer start. */
export class FrameStore {
  #dir: string;
  #archive: DatabaseSync;
  #pending: PendingBody[] = [];
  #pendingBytes = 0;
  #refs = new Map<string, FrameRef>();

  constructor(dir: string, archive: DatabaseSync) {
    this.#dir = dir;
    this.#archive = archive;
    mkdirSync(dir, { recursive: true });
  }

  /** Cuts committed-but-unreferenced tail bytes left by a crash. */
  reconcileOnStart() {
    const rows = this.#archive
      .prepare(`SELECT file, MAX(offset + clen) AS used FROM tool_frame GROUP BY file`)
      .all() as { file: string; used: number }[];
    const used = new Map(rows.map((r) => [r.file, r.used]));
    if (!existsSync(this.#dir)) return;
    for (const name of readdirSync(this.#dir)) {
      if (!name.endsWith('.zst')) continue;
      const path = join(this.#dir, name);
      const expect = used.get(name) ?? 0;
      const actual = statSync(path).size;
      if (actual > expect) truncateSync(path, expect);
    }
  }

  add(contentHash: string, text: string) {
    const utf8 = Buffer.from(text, 'utf8');
    this.#pending.push({ contentHash, utf8 });
    this.#pendingBytes += utf8.length;
    if (this.#pendingBytes >= ingestPolicy.frameTargetBytes) this.flush();
  }

  /** Returns and clears the frame refs accumulated since the last take. */
  takeRefs(): Map<string, FrameRef> {
    this.flush();
    const refs = this.#refs;
    this.#refs = new Map();
    return refs;
  }

  flush(meta?: { minTs?: number; maxTs?: number; srcs?: string }) {
    if (!this.#pending.length) return;
    const raw = Buffer.concat(this.#pending.map((p) => p.utf8));
    const compressed = zstdCompressSync(raw, { params: {} });
    const file = this.#currentFile();
    const offset = existsSync(join(this.#dir, file)) ? statSync(join(this.#dir, file)).size : 0;
    appendFileSync(join(this.#dir, file), compressed);
    const res = this.#archive
      .prepare(`INSERT INTO tool_frame (file, offset, clen, ulen, doc_count, min_ts, max_ts, srcs) VALUES (?,?,?,?,?,?,?,?)`)
      .run(file, offset, compressed.length, raw.length, this.#pending.length, meta?.minTs ?? null, meta?.maxTs ?? null, meta?.srcs ?? null);
    const frameId = Number(res.lastInsertRowid);
    let off = 0;
    for (const p of this.#pending) {
      this.#refs.set(p.contentHash, { frameId, frameOff: off, frameLen: p.utf8.length });
      off += p.utf8.length;
    }
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  #currentFile(): string {
    const files = existsSync(this.#dir) ? readdirSync(this.#dir).filter((f) => /^tools-\d{5}\.zst$/.test(f)).sort() : [];
    const last = files.at(-1);
    if (last && statSync(join(this.#dir, last)).size < 64 * 1024 * 1024) return last;
    const n = last ? Number(last.slice(6, 11)) + 1 : 1;
    return `tools-${String(n).padStart(5, '0')}.zst`;
  }
}
