import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, existsSync, statSync, copyFileSync, openSync, readSync, closeSync, appendFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { paths } from '../core/config.ts';

export interface BackupResult {
  generation: string;
  bytes: number;
  vacuumMs: number;
  verifyMs: number;
  compressMs: number;
  mirrorFiles: number;
  mirrorBytes: number;
}

/** Daily cycle: VACUUM INTO → integrity_check of the copy → zstd → atomic rename.
 *  index.db is not backed up — it is a disposable projection. */
export function backupArchive(now = new Date()): BackupResult {
  mkdirSync(paths.backupDir, { recursive: true });
  const stamp = now.toISOString().slice(0, 10).replaceAll('-', '');
  const tmpDb = join(paths.backupDir, 'tmp-gen.db');
  const target = join(paths.backupDir, `gen-${stamp}.db.zst`);
  if (existsSync(tmpDb)) rmSync(tmpDb);

  const t0 = Date.now();
  const src = new DatabaseSync(paths.archiveDb, { readOnly: true });
  try {
    src.prepare(`VACUUM INTO ?`).run(tmpDb);
  } finally {
    src.close();
  }
  const t1 = Date.now();

  const copy = new DatabaseSync(tmpDb, { readOnly: true });
  try {
    const check = copy.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string };
    if (check.integrity_check !== 'ok') throw new Error(`integrity_check failed on backup copy: ${check.integrity_check}`);
  } finally {
    copy.close();
  }
  const t2 = Date.now();

  rmSync(target + '.part', { force: true });
  const compressedBytes = compressFileTo(tmpDb, target + '.part');
  renameSync(target + '.part', target);
  rmSync(tmpDb);
  const t3 = Date.now();

  const readme = join(paths.backupDir, 'README.txt');
  if (!existsSync(readme)) {
    writeFileSync(readme, 'Единственный бэкап архива истории чатов (chat-history-mcp). Не удалять.\nВосстановление: zstd -d gen-YYYYMMDD.db.zst, положить как archive.db, затем node ops/cli.ts rebuild.\n');
  }

  rotate();
  const mirror = mirrorStores();
  return { generation: target, bytes: compressedBytes, vacuumMs: t1 - t0, verifyMs: t2 - t1, compressMs: t3 - t2, mirrorFiles: mirror.files, mirrorBytes: mirror.bytes };
}

/** Chunked zstd (concatenated frames, `zstd -d` decodes them as one stream):
 *  an archive past 2 GiB cannot even be loaded by readFileSync, let alone compressed. */
function compressFileTo(src: string, dst: string): number {
  const CHUNK = 64 * 1024 * 1024;
  const fd = openSync(src, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    let total = 0;
    while (true) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      const compressed = zstdCompressSync(buf.subarray(0, n));
      appendFileSync(dst, compressed);
      total += compressed.length;
      pos += n;
    }
    return total;
  } finally {
    closeSync(fd);
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/** Mirror of raw/ and blobs/ next to the db generations. Both stores are append-only,
 *  so each run copies just the new tail bytes — cheap enough to run with every backup
 *  (daily deltas are simpler and fresher than weekly ones).
 *  Purge edits/deletes both copies itself: append-only sync would never propagate that. */
export function mirrorStores(): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const [srcDir, name] of [[paths.rawDir, 'raw'], [paths.blobsDir, 'blobs']] as const) {
    if (!existsSync(srcDir)) continue;
    for (const abs of walkFiles(srcDir)) {
      const dst = join(paths.backupDir, name, relative(srcDir, abs));
      const srcSize = statSync(abs).size;
      const dstSize = existsSync(dst) ? statSync(dst).size : -1;
      if (dstSize === srcSize) continue;
      mkdirSync(dirname(dst), { recursive: true });
      if (dstSize < 0 || dstSize > srcSize) {
        copyFileSync(abs, dst);
        bytes += srcSize;
      } else {
        const fd = openSync(abs, 'r');
        try {
          const tail = Buffer.allocUnsafe(srcSize - dstSize);
          let done = 0;
          while (done < tail.length) {
            const n = readSync(fd, tail, done, tail.length - done, dstSize + done);
            if (n <= 0) break;
            done += n;
          }
          appendFileSync(dst, tail.subarray(0, done));
          bytes += done;
        } finally {
          closeSync(fd);
        }
      }
      files++;
    }
  }
  return { files, bytes };
}

/** Keeps 4 daily generations + 3 monthly (first seen per month). */
function rotate() {
  const gens = readdirSync(paths.backupDir)
    .filter((f) => /^gen-\d{8}\.db\.zst$/.test(f))
    .sort()
    .reverse();
  const keep = new Set<string>(gens.slice(0, 4));
  const monthly = new Map<string, string>();
  for (const g of [...gens].reverse()) {
    const month = g.slice(4, 10);
    if (!monthly.has(month)) monthly.set(month, g);
  }
  for (const g of [...monthly.values()].slice(-3)) keep.add(g);
  for (const g of gens) {
    if (!keep.has(g)) rmSync(join(paths.backupDir, g));
  }
}
