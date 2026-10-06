import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

/** Other test files run concurrently and also take the global writer mutex — wait it out. */
async function withWriter<T>(fn: () => T | Promise<T>): Promise<T> {
  for (let tries = 50; ; tries--) {
    const r = await fn();
    if (r !== null) return r;
    if (tries <= 0) throw new Error('writer mutex stayed busy');
    await sleep(200);
  }
}

// Env must be set before the implementation modules are imported (they read it at load),
// hence the dynamic imports inside the test.
const base = mkdtempSync(join(tmpdir(), 'chm-purge-')).replaceAll('\\', '/');
const SRC = `${base}/src`;
const DATA = `${base}/archive`;
const BACKUP = `${base}/backup`;
process.env.CHAT_ARCHIVE_DIR = DATA;
process.env.CHAT_BACKUP_DIR = BACKUP;
process.env.CHAT_SOURCE_ROOTS_JSON = JSON.stringify([
  { rootId: 'claude:test', app: 'claude', rootPath: SRC, label: 'purge-test' },
]);

const CONV_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const CONV_B = 'bbbbbbbb-2222-2222-2222-222222222222';
const BIG_A = 'purgemarkerunique секретный вывод\n' + 'A'.repeat(8000);
const BIG_B = 'keepmarkerunique обычный вывод\n' + 'B'.repeat(8000);
const BIG_SHARED = 'sharedbigmarker общий вывод\n' + 'S'.repeat(8000);

function rec(o: Record<string, unknown>): string {
  return JSON.stringify(o) + '\n';
}
function userMsg(uuid: string, parent: string | null, ts: string, text: string) {
  return rec({ type: 'user', uuid, parentUuid: parent, timestamp: ts, cwd: 'F:/tmp/proj', message: { role: 'user', content: text } });
}
function assistantMsg(uuid: string, parent: string, ts: string, text: string, callId: string) {
  return rec({ type: 'assistant', uuid, parentUuid: parent, timestamp: ts, message: { model: 'claude-test', content: [
    { type: 'text', text }, { type: 'tool_use', id: callId, name: 'Bash', input: { command: 'run' } },
  ] } });
}
function toolResult(uuid: string, parent: string, ts: string, callId: string, output: string) {
  return rec({ type: 'user', uuid, parentUuid: parent, timestamp: ts, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: callId, content: [{ type: 'text', text: output }] },
  ] } });
}

function writeSources() {
  const dir = join(SRC, 'projects', 'testproj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${CONV_A}.jsonl`),
    userMsg('a-u1', null, '2026-08-01T10:00:00Z', 'почини баг purgequestion') +
    assistantMsg('a-a1', 'a-u1', '2026-08-01T10:00:05Z', 'смотрю логи', 'call-a1') +
    toolResult('a-u2', 'a-a1', '2026-08-01T10:00:10Z', 'call-a1', BIG_A) +
    toolResult('a-u3', 'a-a1', '2026-08-01T10:00:15Z', 'call-a1', BIG_SHARED));
  writeFileSync(join(dir, `${CONV_B}.jsonl`),
    userMsg('b-u1', null, '2026-08-02T10:00:00Z', 'обычный вопрос keepquestion') +
    assistantMsg('b-a1', 'b-u1', '2026-08-02T10:00:05Z', 'делаю', 'call-b1') +
    toolResult('b-u2', 'b-a1', '2026-08-02T10:00:10Z', 'call-b1', BIG_B) +
    toolResult('b-u3', 'b-a1', '2026-08-02T10:00:15Z', 'call-b1', BIG_SHARED));
}

function readRange(path: string, offset: number, len: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}

test('purge removes a conversation everywhere and it never resurrects', { timeout: 120000 }, async () => {
  writeSources();
  mkdirSync(BACKUP, { recursive: true });
  writeFileSync(join(BACKUP, 'gen-20250101.db.zst'), 'old-backup-with-purged-content');

  const { ensureFresh } = await import('../ingest/pipeline.ts');
  const { purgeConversation } = await import('../ops/purge.ts');
  const { convPublicId, contentHash } = await import('../core/ids.ts');
  const { openArchive, openIndex, archiveUuid } = await import('../core/db.ts');
  const { readFullBody } = await import('../search/bodies.ts');
  const { searchDocs } = await import('../search/engine.ts');
  const { paths } = await import('../core/config.ts');

  const first = await withWriter(() => ensureFresh());
  assert.ok(first.itemsUpserted >= 10, `ingest looks too small: ${JSON.stringify(first)}`);

  const pidA = convPublicId('claude', 'claude:test', CONV_A);
  const pidB = convPublicId('claude', 'claude:test', CONV_B);
  const rawA = join(paths.rawDir, 'claude_test', 'projects', 'testproj', `${CONV_A}.jsonl.zst`);
  const rawB = join(paths.rawDir, 'claude_test', 'projects', 'testproj', `${CONV_B}.jsonl.zst`);
  assert.ok(existsSync(rawA) && existsSync(rawB), 'both raw mirrors must exist after ingest');

  const pre = new DatabaseSync(`${DATA}/archive.db`, { readOnly: true });
  const frameA = pre.prepare(`SELECT frame_id, file, offset, clen FROM tool_frame ORDER BY frame_id LIMIT 1`).get() as
    { frame_id: number; file: string; offset: number; clen: number };
  pre.close();

  // seed the backup mirror before purge: purge must clean the mirror copies too
  const { backupArchive } = await import('../ops/backup.ts');
  backupArchive();
  const mirrorRawA = join(BACKUP, 'raw', 'claude_test', 'projects', 'testproj', `${CONV_A}.jsonl.zst`);
  assert.ok(existsSync(mirrorRawA), 'mirror must hold the raw copy before purge');
  assert.ok(existsSync(join(BACKUP, 'blobs', frameA.file)), 'mirror must hold the blob file before purge');

  const result = await withWriter(() => purgeConversation(`c:${pidA}`, { reason: 'test' }));
  assert.equal(result.verified, true, 'purge self-verification must pass');

  const db = new DatabaseSync(`${DATA}/archive.db`, { readOnly: true });
  try {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM conversation WHERE public_id = ?`).get(pidA) as { n: number }).n, 0, 'conversation A must be gone');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM conversation WHERE public_id = ?`).get(pidB) as { n: number }).n, 1, 'conversation B must survive');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM body WHERE content_hash = ?`).get(contentHash('tool', BIG_A)) as { n: number }).n, 0, 'exclusive body must be deleted');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM body WHERE content_hash = ?`).get(contentHash('tool', BIG_SHARED)) as { n: number }).n, 1, 'shared body must survive');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM body WHERE frame_id IS NOT NULL AND frame_id NOT IN (SELECT frame_id FROM tool_frame)`).get() as { n: number }).n, 0, 'no dangling frame refs');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tool_frame WHERE frame_id = ?`).get(frameA.frame_id) as { n: number }).n, 0, 'old frame row must be gone');

    const survived = db.prepare(`SELECT body_id FROM body WHERE content_hash = ?`).get(contentHash('tool', BIG_SHARED)) as { body_id: number };
    assert.equal(readFullBody(db, survived.body_id), BIG_SHARED, 'shared body must be readable from its new frame');

    const log = db.prepare(`SELECT verified FROM purge_log ORDER BY id DESC LIMIT 1`).get() as { verified: number };
    assert.equal(log.verified, 1);
  } finally {
    db.close();
  }

  const zeroed = readRange(join(paths.blobsDir, frameA.file), frameA.offset, frameA.clen);
  assert.ok(zeroed.every((b) => b === 0), 'old frame bytes must be zeroed on disk');
  const mirrorZeroed = readRange(join(BACKUP, 'blobs', frameA.file), frameA.offset, frameA.clen);
  assert.ok(mirrorZeroed.every((b) => b === 0), 'mirrored frame bytes must be zeroed too');

  assert.ok(!existsSync(rawA), 'raw mirror of purged conversation must be deleted');
  assert.ok(existsSync(rawB), 'raw mirror of kept conversation must remain');
  assert.ok(!existsSync(mirrorRawA), 'backup mirror of the purged raw file must be deleted');

  assert.ok(!existsSync(join(BACKUP, 'gen-20250101.db.zst')), 'old backup generations must be regenerated');
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  assert.ok(existsSync(join(BACKUP, `gen-${today}.db.zst`)), 'a fresh backup generation must exist');

  // index: purged content unfindable, kept content findable
  {
    const archive = openArchive(paths.archiveDb, { readonly: true });
    const { db: index, needsRebuild } = openIndex(paths.indexDb, archiveUuid(archive), { readonly: true });
    try {
      assert.equal(needsRebuild, false);
      assert.equal(searchDocs(index, archive, { query: 'purgemarkerunique', k: 10 }).hits.length, 0, 'purged content must not be searchable');
      assert.ok(searchDocs(index, archive, { query: 'keepmarkerunique', k: 10 }).hits.length >= 1, 'kept content must stay searchable');
      assert.ok(searchDocs(index, archive, { query: 'sharedbigmarker', k: 10 }).hits.length >= 1, 'shared content must stay searchable via conversation B');
    } finally {
      index.close();
      archive.close();
    }
  }

  // resurrection guard: the source file lives on and even grows — ingest must not bring the chat back
  appendFileSync(join(SRC, 'projects', 'testproj', `${CONV_A}.jsonl`),
    userMsg('a-u9', 'a-u3', '2026-08-03T10:00:00Z', 'новое сообщение после purge'));
  const again = await withWriter(() => ensureFresh());
  assert.ok(again, 'second ingest must run');
  const post = new DatabaseSync(`${DATA}/archive.db`, { readOnly: true });
  try {
    assert.equal((post.prepare(`SELECT COUNT(*) AS n FROM conversation WHERE public_id = ?`).get(pidA) as { n: number }).n, 0, 'purged conversation must not resurrect');
  } finally {
    post.close();
  }
  assert.ok(!existsSync(rawA), 'raw mirror must not resurrect either');

  rmSync(base, { recursive: true, force: true });
});
