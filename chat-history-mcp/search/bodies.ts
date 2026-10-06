import { zstdDecompressSync } from 'node:zlib';
import { openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { paths } from '../core/config.ts';

/** Full body text: from the zstd frame for truncated tool outputs, else text_index (already full). */
export function readFullBody(archive: DatabaseSync, bodyId: number): string | null {
  const body = archive.prepare(`SELECT text_index, truncated, frame_id, frame_off, frame_len FROM body WHERE body_id = ?`)
    .get(bodyId) as { text_index: string; truncated: number; frame_id: number | null; frame_off: number | null; frame_len: number | null } | undefined;
  if (!body) return null;
  if (!body.truncated || body.frame_id === null) return body.text_index;

  const frame = archive.prepare(`SELECT file, offset, clen FROM tool_frame WHERE frame_id = ?`)
    .get(body.frame_id) as { file: string; offset: number; clen: number } | undefined;
  if (!frame) return body.text_index;

  const fd = openSync(join(paths.blobsDir, frame.file), 'r');
  try {
    const compressed = Buffer.allocUnsafe(frame.clen);
    let done = 0;
    while (done < frame.clen) {
      const n = readSync(fd, compressed, done, frame.clen - done, frame.offset + done);
      if (n <= 0) break;
      done += n;
    }
    const raw = zstdDecompressSync(compressed.subarray(0, done));
    return raw.subarray(body.frame_off!, body.frame_off! + body.frame_len!).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
