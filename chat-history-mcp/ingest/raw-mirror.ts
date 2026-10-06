import { zstdCompressSync } from 'node:zlib';
import { appendFileSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function rawMirrorPath(rawDir: string, rootId: string, locator: string): string {
  return join(rawDir, rootId.replace(':', '_'), `${locator}.zst`);
}

/** One mirrored file can be arbitrarily large (codex rollouts reach hundreds of MB);
 *  bounded chunks keep peak memory flat — the price of compressing a whole backlog
 *  in one buffer was a zstd allocation failure on the first full production run. */
const MIRROR_CHUNK = 32 * 1024 * 1024;

/** Mirrors new source bytes BEFORE parsing, as concatenated zstd frames.
 *  Insurance against source rotation and reader bugs: reparse is always possible. */
export function mirrorBytes(rawDir: string, rootId: string, locator: string, absPath: string, fromOffset: number, toOffset: number): number {
  if (toOffset <= fromOffset) return fromOffset;
  const target = rawMirrorPath(rawDir, rootId, locator);
  mkdirSync(dirname(target), { recursive: true });

  const fd = openSync(absPath, 'r');
  try {
    let from = fromOffset;
    while (from < toOffset) {
      const len = Math.min(MIRROR_CHUNK, toOffset - from);
      const buf = Buffer.allocUnsafe(len);
      let done = 0;
      while (done < len) {
        const n = readSync(fd, buf, done, len - done, from + done);
        if (n <= 0) break;
        done += n;
      }
      if (done === 0) break;
      appendFileSync(target, zstdCompressSync(buf.subarray(0, done)));
      from += done;
    }
    return from;
  } finally {
    closeSync(fd);
  }
}
