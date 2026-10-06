import { createHash } from 'node:crypto';

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha1hex(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Content-derived generation key: survives rebuilds, changes when the file is truncated/rewritten. */
export function genKey(rootId: string, locator: string, fingerprint: string): string {
  return sha256hex(`${rootId}|${locator}|${fingerprint}`).slice(0, 16);
}

/** Stable idempotency key of one item occurrence within a generation. */
export function sourceKey(gen: string, position: string): string {
  return `${gen}:${position}`;
}

/** Externally visible id: derived from the source, stable across any rebuild. */
export function publicId(srcKey: string): string {
  return sha256hex(srcKey).slice(0, 12);
}

export function convPublicId(app: string, rootId: string, logicalId: string): string {
  return sha256hex(`${app}|${rootId}|${logicalId}`).slice(0, 12);
}

/** One physical body per identical content; occurrences reference it. */
export function contentHash(role: string, normalizedText: string): string {
  return sha1hex(`${role}|${normalizedText}`);
}

/** Path canonicalization: lower case, forward slashes, no trailing slash, no \\?\ prefix. */
export function pathKey(p: string): string {
  let s = p.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase();
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
