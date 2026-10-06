import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeClaudeFixture } from './helpers/claude-fixture.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// unique temp base: concurrent suite runs must not fight over the same fixture dirs
const BASE = mkdtempSync(join(tmpdir(), 'chm-crash-')).replaceAll('\\', '/');
const CLEAN_DIR = `${BASE}/ref`;
const CRASH_DIR = `${BASE}/run`;
const SNAP_DIR = `${BASE}/src`;

// Both runs must see identical source bytes: a generated fixture, written once.
// Big enough (~18k items, several seconds of ingest) for kills to land mid-run.
function snapshotSource() {
  rmSync(SNAP_DIR, { recursive: true, force: true });
  writeClaudeFixture(SNAP_DIR, { conversations: 60, turns: 60 });
}

// stdio must be piped: with 'ignore' the runtime aborts syncing the null stdout on exit (0xC0000409)
function spawnIngest(dir: string) {
  const child = spawn(process.execPath, ['--no-warnings', 'ops/cli.ts', 'ingest', '--root=claude:fixture'], {
    cwd: ROOT,
    env: {
      ...process.env,
      CHAT_ARCHIVE_DIR: dir,
      CHAT_SOURCE_ROOTS_JSON: JSON.stringify([
        { rootId: 'claude:fixture', app: 'claude', rootPath: SNAP_DIR, label: 'crash-test fixture' },
      ]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

function ingest(dir: string): Promise<{ code: number | null; killed: boolean }> {
  return new Promise((resolve) => {
    const child = spawnIngest(dir);
    child.on('exit', (code) => resolve({ code, killed: child.killed }));
  });
}

function ingestWithKill(dir: string, afterMs: number): Promise<{ finished: boolean; busy: boolean }> {
  return new Promise((resolve) => {
    const child = spawnIngest(dir);
    const timer = setTimeout(() => child.kill('SIGKILL'), afterMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ finished: code === 0 && !child.killed, busy: code === 3 });
    });
  });
}

/** Content digest of the logical archive state: independent of rowids and insert order. */
function digest(dir: string): { items: number; convs: number; hash: string } {
  const db = new DatabaseSync(`${dir}/archive.db`, { readOnly: true });
  try {
    const h = createHash('sha256');
    const rows = db.prepare(`
      SELECT i.source_key, i.revision, i.kind, COALESCE(b.content_hash, '') AS ch
      FROM item i LEFT JOIN body b ON b.body_id = i.body_id
      ORDER BY i.source_key`).all() as { source_key: string; revision: number; kind: string; ch: string }[];
    for (const r of rows) h.update(`${r.source_key}|${r.revision}|${r.kind}|${r.ch}\n`);
    const convs = (db.prepare(`SELECT COUNT(*) AS n FROM conversation`).get() as { n: number }).n;
    return { items: rows.length, convs, hash: h.digest('hex') };
  } finally {
    db.close();
  }
}

function invariants(dir: string) {
  const db = new DatabaseSync(`${dir}/archive.db`, { readOnly: true });
  try {
    const dangling = (db.prepare(`SELECT COUNT(*) AS n FROM item WHERE body_id IS NOT NULL AND body_id NOT IN (SELECT body_id FROM body)`).get() as { n: number }).n;
    assert.equal(dangling, 0, 'items must not reference missing bodies');
    const dupSk = (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT source_key FROM item GROUP BY source_key HAVING COUNT(*) > 1)`).get() as { n: number }).n;
    assert.equal(dupSk, 0, 'source_key must be unique');
    const orphanRef = (db.prepare(`SELECT COUNT(*) AS n FROM body WHERE frame_id IS NOT NULL AND frame_id NOT IN (SELECT frame_id FROM tool_frame)`).get() as { n: number }).n;
    assert.equal(orphanRef, 0, 'frame refs must resolve');
  } finally {
    db.close();
  }
}

test('crash-safety: random SIGKILL mid-ingest converges to the clean-run digest', { timeout: 600000 }, async () => {
  rmSync(CLEAN_DIR, { recursive: true, force: true });
  rmSync(CRASH_DIR, { recursive: true, force: true });
  snapshotSource();

  // exit 3 = another process held the writer mutex (concurrent tests/agents) — retry
  let clean = await ingest(CLEAN_DIR);
  for (let tries = 60; clean.code === 3 && tries > 0; tries--) {
    await sleep(1000);
    clean = await ingest(CLEAN_DIR);
  }
  assert.equal(clean.code, 0, 'reference run must succeed');
  const ref = digest(CLEAN_DIR);
  assert.ok(ref.items > 1000, `reference run looks too small: ${ref.items}`);

  let kills = 0;
  for (let i = 0; i < 25 && kills < 12; i++) {
    const r = await ingestWithKill(CRASH_DIR, 200 + Math.random() * 1300);
    if (r.finished) break;
    if (r.busy) await sleep(1000);
    else kills++;
    await sleep(50);
  }
  assert.ok(kills >= 3, `want at least a few real kills, got ${kills}`);
  // converge with one uninterrupted run — under suite load a full pass may never fit
  // between two kill timers, and that is not what this test is about
  let final = await ingest(CRASH_DIR);
  for (let tries = 60; final.code === 3 && tries > 0; tries--) {
    await sleep(1000);
    final = await ingest(CRASH_DIR);
  }
  assert.equal(final.code, 0, 'final convergence run must succeed');

  invariants(CRASH_DIR);
  const got = digest(CRASH_DIR);
  assert.equal(got.items, ref.items, 'item count after crashes must equal clean run');
  assert.equal(got.convs, ref.convs, 'conversation count must match');
  assert.equal(got.hash, ref.hash, 'logical archive digest must be identical');

  rmSync(BASE, { recursive: true, force: true });
});
