import { openSync, readSync, closeSync } from 'node:fs';

export interface JsonlLine {
  /** Byte offset of the first byte of this line in the file. */
  offset: number;
  /** Raw line without the trailing newline. */
  text: string;
  /** True when the line exceeded the cap and text holds only a prefix. */
  overlong: boolean;
  byteLength: number;
}

/** Streams complete lines from `fromOffset`, tracking byte offsets exactly.
 *  A live writer may leave a partial last line — it is never yielded; resume
 *  from the returned `endOffset` next cycle. Lines above `lineCap` are yielded
 *  with `overlong=true` and a truncated prefix so the caller can quarantine. */
export function* readJsonlLines(
  path: string,
  fromOffset: number,
  opts: { lineCap: number; chunkSize?: number },
): Generator<JsonlLine, { endOffset: number }, void> {
  const chunkSize = opts.chunkSize ?? 1 << 20;
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(chunkSize);
    let filePos = fromOffset;
    let lineStart = fromOffset;
    let parts: Buffer[] = [];
    let pendingBytes = 0;
    let capped = false;

    while (true) {
      const n = readSync(fd, chunk, 0, chunkSize, filePos);
      if (n <= 0) break;
      let sliceStart = 0;
      for (let i = 0; i < n; i++) {
        if (chunk[i] !== 0x0a) continue;
        const piece = chunk.subarray(sliceStart, i);
        const lineBytes = pendingBytes + piece.length;
        let buf: Buffer;
        if (capped) {
          buf = Buffer.concat(parts);
        } else if (parts.length) {
          buf = Buffer.concat([...parts, piece]);
        } else {
          buf = piece;
        }
        let text = buf.toString('utf8');
        if (text.endsWith('\r')) text = text.slice(0, -1);
        yield { offset: lineStart, text, overlong: capped, byteLength: lineBytes + 1 };
        lineStart = filePos + i + 1;
        parts = [];
        pendingBytes = 0;
        capped = false;
        sliceStart = i + 1;
      }
      if (sliceStart < n) {
        const piece = chunk.subarray(sliceStart, n);
        pendingBytes += piece.length;
        if (!capped) {
          parts.push(Buffer.from(piece));
          if (pendingBytes > opts.lineCap) {
            parts = [Buffer.concat(parts).subarray(0, opts.lineCap)];
            capped = true;
          }
        }
      }
      filePos += n;
    }
    return { endOffset: lineStart };
  } finally {
    closeSync(fd);
  }
}
