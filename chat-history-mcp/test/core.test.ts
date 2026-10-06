import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openArchive, openIndex, archiveUuid } from '../core/db.ts';
import { genKey, sourceKey, publicId, pathKey, contentHash } from '../core/ids.ts';

// Own mutex name: this test checks the mechanics, not machine-wide arbitration,
// and concurrent suite files legitimately hold the production mutex.
// Must be set before ingest/mutex.ts (→ core/config.ts) loads — hence the dynamic import below.
process.env.CHAT_MUTEX_NAME = `Local\\chat-history-mcp-test-${process.pid}`;

test('archive and index create, uuid binding, fts works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chm-'));
  try {
    const archive = openArchive(join(dir, 'archive.db'));
    const uuid = archiveUuid(archive);

    const { db: index, needsRebuild } = openIndex(join(dir, 'index.db'), uuid);
    assert.equal(needsRebuild, false);

    index.prepare(`INSERT INTO fts(rowid, text, text_stem, paths) VALUES (1, 'привет индексация мира', '', '')`).run();
    const hits = index.prepare(`SELECT rowid FROM fts WHERE fts MATCH 'индексация'`).all();
    assert.equal(hits.length, 1);

    index.close();
    // writer-side open with a foreign uuid self-heals: wipes the projection in place
    const reopened = openIndex(join(dir, 'index.db'), 'another-archive-uuid');
    assert.equal(reopened.needsRebuild, false);
    const wiped = reopened.db.prepare(`SELECT rowid FROM fts WHERE fts MATCH 'индексация'`).all();
    assert.equal(wiped.length, 0, 'foreign projection content must be wiped');
    reopened.db.close();
    // readonly consumers only detect staleness, never touch the file
    const ro = openIndex(join(dir, 'index.db'), uuid, { readonly: true });
    assert.equal(ro.needsRebuild, true, 'readonly open with another uuid must report stale');
    ro.db.close();
    archive.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ids are stable and derived from source', () => {
  const g = genKey('claude:main', 'projects/x/abc.jsonl', 'ff00');
  assert.equal(g.length, 16);
  assert.equal(g, genKey('claude:main', 'projects/x/abc.jsonl', 'ff00'));
  const sk = sourceKey(g, '1024');
  assert.equal(publicId(sk).length, 12);
  assert.equal(publicId(sk), publicId(sk));
  assert.notEqual(publicId(sourceKey(g, '1025')), publicId(sk));
  assert.equal(contentHash('user', 'hi'), contentHash('user', 'hi'));
});

test('pathKey canonicalization', () => {
  assert.equal(pathKey('\\\\?\\F:\\Work\\Demo\\file.TS'), 'f:/work/demo/file.ts');
  assert.equal(pathKey('F:/work/demo/'), 'f:/work/demo');
});

test('writer mutex is exclusive across processes and released cleanly', async () => {
  const { tryAcquireWriter } = await import('../ingest/mutex.ts');
  const helper = join(import.meta.dirname, 'helpers', 'try-mutex.ts');
  const run = () => execFileSync(process.execPath, ['--no-warnings', helper]).toString().trim();

  const lock = tryAcquireWriter();
  assert.ok(lock, 'first acquire must succeed');
  assert.equal(run(), 'BLOCKED', 'second process must not acquire while held');
  lock!.release();
  assert.equal(run(), 'ACQUIRED', 'after release the mutex must be free');
});
