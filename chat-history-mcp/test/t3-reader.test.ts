import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { discoverT3Generations, readT3Batch } from '../readers/t3.ts';
import { ingestPolicy, type SourceRootDef } from '../core/config.ts';
import type { ChangeBatch } from '../readers/types.ts';

/** Schema copied from the real state.sqlite (only the columns the reader touches matter). */
const SCHEMA = `
CREATE TABLE orchestration_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL,
  event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, command_id TEXT,
  causation_event_id TEXT, correlation_id TEXT, actor_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, metadata_json TEXT NOT NULL);
CREATE TABLE projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  branch TEXT, worktree_path TEXT, latest_turn_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, archived_at TEXT);
CREATE TABLE projection_thread_messages (
  message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL,
  text TEXT NOT NULL, is_streaming INTEGER NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, attachments_json TEXT);
CREATE TABLE projection_thread_activities (
  activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, tone TEXT NOT NULL,
  kind TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL, sequence INTEGER);
CREATE TABLE projection_projects (
  project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL,
  scripts_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
`;

const T0 = '2026-08-27T10:00:00.000Z';
const at = (s: number) => `2026-08-27T10:00:${String(s).padStart(2, '0')}.000Z`;

let evCounter = 0;
function ev(db: DatabaseSync, streamId: string, type: string, payload: unknown, occurredAt: string): void {
  evCounter++;
  db.prepare(`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (?, 'thread', ?, ?, ?, ?, 'test', ?, '{}')`)
    .run(`e-${evCounter}`, streamId, evCounter, type, occurredAt, JSON.stringify(payload));
}

function msgRow(db: DatabaseSync, id: string, threadId: string, role: string, text: string,
  opts: { streaming?: boolean; attachments?: string } = {}): void {
  db.prepare(`INSERT OR REPLACE INTO projection_thread_messages
      (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at, attachments_json)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(id, threadId, role, text, opts.streaming ? 1 : 0, T0, T0, opts.attachments ?? null);
}

function actRow(db: DatabaseSync, id: string, threadId: string, kind: string, payload: unknown, summary = ''): void {
  db.prepare(`INSERT OR REPLACE INTO projection_thread_activities
      (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
      VALUES (?, ?, NULL, 'tool', ?, ?, ?, ?, NULL)`)
    .run(id, threadId, kind, summary, JSON.stringify(payload), T0);
}

function newDb(dir: string): DatabaseSync {
  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO projection_projects VALUES ('p1', 'demo', 'f:\\proj\\demo', '[]', ?, ?, NULL)`).run(T0, T0);
  return db;
}

function addThread(db: DatabaseSync, id: string, title: string): void {
  db.prepare(`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at) VALUES (?, 'p1', ?, ?, ?)`)
    .run(id, title, T0, at(59));
}

const T = 't-aaa';

/** 15 events covering every item-producing path plus skips and quarantine. */
function seedThreadA(db: DatabaseSync): void {
  addThread(db, T, 'Demo thread');
  ev(db, T, 'thread.created', { threadId: T, projectId: 'p1', title: 'seed' }, at(1));
  ev(db, T, 'thread.turn-start-requested', { threadId: T, messageId: 'm-u1' }, at(2));
  msgRow(db, 'm-u1', T, 'user', 'привет, почини баг в parser.ts',
    { attachments: JSON.stringify([{ type: 'image', id: 'img-1', name: 'image.png', mimeType: 'image/png', sizeBytes: 10 }]) });
  ev(db, T, 'thread.message-sent', { threadId: T, messageId: 'm-u1', role: 'user', streaming: false }, at(3));
  actRow(db, 'act-s1', T, 'tool.started', { itemType: 'dynamic_tool_call', toolCallId: 'toolu_1', status: 'inProgress' });
  ev(db, T, 'thread.activity-appended', { threadId: T, activity: { id: 'act-s1', kind: 'tool.started' } }, at(4));
  actRow(db, 'act-p1', T, 'tool.updated', { itemType: 'dynamic_tool_call', toolCallId: 'toolu_1', status: 'inProgress' });
  ev(db, T, 'thread.activity-appended', { threadId: T, activity: { id: 'act-p1', kind: 'tool.updated' } }, at(5));
  actRow(db, 'act-1', T, 'tool.completed', {
    itemType: 'dynamic_tool_call', toolCallId: 'toolu_1', status: 'completed',
    detail: 'Read: {"file_path":"f:\\proj\\demo\\a.ts"}',
    data: {
      toolName: 'Read', input: { file_path: 'f:\\proj\\demo\\a.ts' },
      result: { tool_use_id: 'toolu_1', type: 'tool_result', content: 'file text', is_error: false },
    },
  });
  ev(db, T, 'thread.activity-appended', { threadId: T, activity: { id: 'act-1', kind: 'tool.completed' } }, at(6));
  actRow(db, 'act-d1', T, 'tool.denied', { toolName: 'Bash', toolUseId: 'toolu_d' }, 'Tool call denied');
  ev(db, T, 'thread.activity-appended', { threadId: T, activity: { id: 'act-d1', kind: 'tool.denied' } }, at(7));
  msgRow(db, 'assistant:m-a0', T, 'assistant', ''); // interrupted before any text
  ev(db, T, 'thread.message-sent', { threadId: T, messageId: 'assistant:m-a0', role: 'assistant', streaming: false }, at(8));
  msgRow(db, 'assistant:m-a1', T, 'assistant', 'Починил, смотри дифф.');
  ev(db, T, 'thread.message-sent', { threadId: T, messageId: 'assistant:m-a1', role: 'assistant', streaming: true }, at(9));
  ev(db, T, 'thread.message-sent', { threadId: T, messageId: 'assistant:m-a1', role: 'assistant', streaming: false }, at(10));
  actRow(db, 'act-2', T, 'task.completed', {
    taskId: 'tsk1', status: 'completed', title: 'Проверить кэш', summary: 'Кэш проверен', detail: 'Кэш проверен',
    agentKind: 'agent', taskType: 'local_agent', model: 'claude-opus-5', toolUseId: 'toolu_2',
  });
  ev(db, T, 'thread.activity-appended', { threadId: T, activity: { id: 'act-2', kind: 'task.completed' } }, at(11));
  ev(db, T, 'thread.activity-appended', { threadId: T, activity: { id: 'act-x', kind: 'planning.vibe' } }, at(12));
  ev(db, T, 'thread.zzz-unknown', { threadId: T }, at(13));
  ev(db, T, 'thread.reverted', { threadId: T, turnCount: 2 }, at(14));
  actRow(db, 'act-cw', T, 'context-window.updated', { usedTokens: 5 });
  ev(db, T, 'thread.activity-appended', { threadId: T, activity: { id: 'act-cw', kind: 'context-window.updated' } }, at(15));
}

function testRoot(dir: string): SourceRootDef {
  return { rootId: 't3:test', app: 't3', rootPath: dir, label: 't3 test' };
}

const bigBudget = { maxItems: 10_000, maxBytes: 64 * 1024 * 1024 };

test('discover: one generation per thread, stable keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chm-t3-'));
  try {
    assert.deepEqual(discoverT3Generations(testRoot(join(dir, 'nope'))), []);
    const db = newDb(dir);
    addThread(db, 't-one', 'One');
    addThread(db, 't-two', 'Two');
    db.close();
    const gens = discoverT3Generations(testRoot(dir));
    assert.equal(gens.length, 2);
    const again = discoverT3Generations(testRoot(dir));
    assert.deepEqual(gens.map((g) => g.genKey).sort(), again.map((g) => g.genKey).sort(), 'genKey must be stable');
    assert.notEqual(gens[0].genKey, gens[1].genKey);
    assert.ok(gens.every((g) => g.kind === 'sqlite_table' && g.app === 't3' && g.absPath.endsWith('state.sqlite')));
    assert.ok(gens.some((g) => g.locator === 'state.sqlite#thread/t-one'));
    assert.equal(gens[0].mtimeMs, Date.parse(at(59)), 'mtime is the thread updated_at');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('roles, tool calls, tasks, rollback, quarantine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chm-t3-'));
  try {
    const db = newDb(dir);
    seedThreadA(db);
    db.close();
    const [gen] = discoverT3Generations(testRoot(dir));
    const batch = readT3Batch(gen, undefined, bigBudget);

    assert.equal(batch.eof, true);
    assert.deepEqual(batch.items.map((i) => i.kind), ['user', 'tool_call', 'tool_call', 'assistant', 'tool_call', 'rollback']);

    const [user, tool, denied, assistant, task, rollback] = batch.items;
    assert.equal(user.text, 'привет, почини баг в parser.ts');
    assert.equal(user.role, 'user');
    assert.ok(user.files?.[0].pathDisplay.endsWith('img-1.png'), 'attachment resolves into attachments/');
    assert.equal(user.ts, Date.parse(T0));

    assert.equal(tool.toolName, 'Read');
    assert.equal(tool.callId, 'toolu_1');
    assert.equal(tool.text, `Read ${JSON.stringify({ file_path: 'f:\\proj\\demo\\a.ts' })}\nfile text`);
    assert.deepEqual(tool.files, [{ pathDisplay: 'f:\\proj\\demo\\a.ts', op: 'read' }]);
    assert.equal(tool.isError, false);
    assert.equal(tool.meta?.itemType, 'dynamic_tool_call');

    assert.equal(denied.toolName, 'Bash');
    assert.equal(denied.callId, 'toolu_d');
    assert.equal(denied.isError, true);

    assert.equal(assistant.text, 'Починил, смотри дифф.');
    assert.equal(assistant.logicalId, 'assistant:m-a1');

    assert.equal(task.toolName, 'task:local_agent');
    assert.equal(task.callId, 'toolu_2');
    assert.equal(task.text, 'Проверить кэш\nКэш проверен');
    assert.equal(task.meta?.taskId, 'tsk1');

    assert.equal(rollback.kind, 'rollback');
    assert.equal(rollback.meta?.turnCount, 2);

    // one assistant item despite two message-sent events; empty m-a0 dropped
    assert.equal(batch.items.filter((i) => i.kind === 'assistant').length, 1);
    // linear chain over emitted messages+tools; rollback marker is not chained
    assert.deepEqual(batch.edges, [
      { extId: 'm-u1' },
      { extId: 'act-1', parentExtId: 'm-u1' },
      { extId: 'act-d1', parentExtId: 'act-1' },
      { extId: 'assistant:m-a1', parentExtId: 'act-d1' },
      { extId: 'act-2', parentExtId: 'assistant:m-a1' },
    ]);
    assert.equal(batch.conversation.headExtId, 'act-2');

    assert.deepEqual(batch.quarantine.map((q) => q.reason), ['unknown_activity_kind: planning.vibe', 'unknown_type: thread.zzz-unknown']);
    assert.equal(batch.conversation.title?.text, 'Demo thread');
    assert.equal(batch.conversation.title?.source, 'ai');
    assert.equal(batch.conversation.cwdDisplay, 'f:\\proj\\demo');
    assert.equal(batch.conversation.startedAt, Date.parse(T0));
    assert.equal(batch.conversation.lastActivityAt, Date.parse(at(59)));
    assert.equal(batch.maxEventTs, Date.parse(at(15)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('streaming message stays pending until its final event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chm-t3-'));
  try {
    let db = newDb(dir);
    addThread(db, 't-str', 'Streamy');
    msgRow(db, 'assistant:m-s1', 't-str', 'assistant', 'полов', { streaming: true });
    ev(db, 't-str', 'thread.message-sent', { threadId: 't-str', messageId: 'assistant:m-s1', role: 'assistant', streaming: true }, at(1));
    db.close();
    const [gen] = discoverT3Generations(testRoot(dir));

    const first = readT3Batch(gen, undefined, bigBudget);
    assert.equal(first.items.length, 0, 'streaming row must not be emitted');
    assert.equal(first.eof, true);

    // the app finishes the message: projection row finalized + final event appended
    db = new DatabaseSync(join(dir, 'state.sqlite'));
    msgRow(db, 'assistant:m-s1', 't-str', 'assistant', 'половина стала целым');
    ev(db, 't-str', 'thread.message-sent', { threadId: 't-str', messageId: 'assistant:m-s1', role: 'assistant', streaming: false }, at(2));
    db.close();

    const second = readT3Batch(gen, first.cursorAfter, bigBudget);
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].text, 'половина стала целым');
    assert.equal(second.eof, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor survives batch boundaries without duplicates inside a batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chm-t3-'));
  try {
    const db = newDb(dir);
    seedThreadA(db);
    db.close();
    const [gen] = discoverT3Generations(testRoot(dir));
    const budget = { maxItems: 2, maxBytes: 64 * 1024 * 1024 };

    const batches: ChangeBatch[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const b = readT3Batch(gen, cursor, budget);
      batches.push(b);
      cursor = b.cursorAfter;
      if (b.eof) break;
    }
    assert.ok(batches.at(-1)!.eof, 'must reach eof');
    assert.ok(batches.length >= 3, 'small budget must split the read');

    assert.deepEqual(JSON.parse(batches[0].cursorAfter), { seq: 6, last_ext_id: 'act-1' });
    // the chain continues across the boundary through the cursor
    assert.deepEqual(batches[1].edges[0], { extId: 'act-d1', parentExtId: 'act-1' });

    for (const b of batches) {
      const keys = b.items.map((i) => i.sourceKey);
      assert.equal(new Set(keys).size, keys.length, 'no duplicates inside one batch');
      assert.ok(b.items.length <= budget.maxItems);
    }
    const union = new Set(batches.flatMap((b) => b.items.map((i) => i.sourceKey)));
    const full = readT3Batch(gen, undefined, bigBudget);
    assert.deepEqual([...union].sort(), full.items.map((i) => i.sourceKey).sort(), 'batched read covers exactly the full read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed data is quarantined or skipped, never thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chm-t3-'));
  try {
    const db = newDb(dir);
    addThread(db, 't-bad', 'Broken bits');
    // event payload is not JSON
    evCounter++;
    db.prepare(`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
        VALUES (?, 'thread', 't-bad', ?, 'thread.message-sent', ?, 'test', 'not json', '{}')`)
      .run(`e-${evCounter}`, evCounter, at(1));
    // activity row with broken payload_json
    db.prepare(`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
        VALUES ('act-bad', 't-bad', NULL, 'tool', 'tool.completed', '', '{oops', ?, NULL)`).run(T0);
    ev(db, 't-bad', 'thread.activity-appended', { threadId: 't-bad', activity: { id: 'act-bad', kind: 'tool.completed' } }, at(2));
    // message-sent pointing at a row pruned by revert
    ev(db, 't-bad', 'thread.message-sent', { threadId: 't-bad', messageId: 'm-gone', role: 'user', streaming: false }, at(3));
    // role the reader does not know
    msgRow(db, 'm-sys', 't-bad', 'system', 'служебное сообщение');
    ev(db, 't-bad', 'thread.message-sent', { threadId: 't-bad', messageId: 'm-sys', role: 'system', streaming: false }, at(4));
    // broken attachments_json and unparseable created_at: item still emitted, without files/ts
    msgRow(db, 'm-ok', 't-bad', 'user', 'живое сообщение', { attachments: '{broken' });
    db.prepare(`UPDATE projection_thread_messages SET created_at = 'когда-то' WHERE message_id = 'm-ok'`).run();
    ev(db, 't-bad', 'thread.message-sent', { threadId: 't-bad', messageId: 'm-ok', role: 'user', streaming: false }, at(5));
    db.close();

    const [gen] = discoverT3Generations(testRoot(dir));
    const batch = readT3Batch(gen, undefined, bigBudget);
    assert.equal(batch.eof, true);
    assert.equal(batch.items.length, 1);
    assert.equal(batch.items[0].text, 'живое сообщение');
    assert.equal(batch.items[0].ts, undefined);
    assert.equal(batch.items[0].files, undefined);
    assert.deepEqual(batch.quarantine.map((q) => q.reason.split(':')[0]).sort(),
      ['activity_json_parse', 'json_parse', 'unknown_role']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maxBytes budget stops a batch early', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chm-t3-'));
  try {
    const db = newDb(dir);
    seedThreadA(db);
    db.close();
    const [gen] = discoverT3Generations(testRoot(dir));
    const batch = readT3Batch(gen, undefined, { maxItems: 999, maxBytes: 1 });
    assert.equal(batch.items.length, 1);
    assert.equal(batch.eof, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Smoke over the real live database: read everything in production-sized
// batches, print the shape of the data, fail on quarantine noise.
const realRoot: SourceRootDef = { rootId: 't3:state', app: 't3', rootPath: join(homedir(), '.t3/userdata'), label: 't3 code' };

test('smoke: full batched read of the real t3 database', { skip: !process.env.CHAT_SMOKE ? 'reads your real t3 database — opt in with CHAT_SMOKE=1' : !existsSync(join(realRoot.rootPath, 'state.sqlite')) }, () => {
  const budget = { maxItems: ingestPolicy.batchMaxItems, maxBytes: ingestPolicy.batchMaxBytes };
  const t0 = Date.now();
  const gens = discoverT3Generations(realRoot);
  assert.ok(gens.length > 0, 'threads must be discovered');

  const byKind = new Map<string, number>();
  const reasons = new Map<string, number>();
  const sourceKeys = new Set<string>();
  let batches = 0;
  let itemsTotal = 0;
  let quarantineTotal = 0;
  let titled = 0;
  let maxTs = 0;

  for (const gen of gens) {
    let cursor: string | undefined;
    let prevSeq = -1;
    let batch: ChangeBatch;
    let guard = 0;
    do {
      batch = readT3Batch(gen, cursor, budget);
      batches++;
      const seq = JSON.parse(batch.cursorAfter).seq as number;
      assert.ok(batch.eof || seq > prevSeq, 'cursor must advance until eof');
      prevSeq = seq;
      cursor = batch.cursorAfter;
      itemsTotal += batch.items.length;
      quarantineTotal += batch.quarantine.length;
      for (const it of batch.items) {
        byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
        sourceKeys.add(it.sourceKey);
      }
      for (const q of batch.quarantine) {
        const key = q.reason.slice(0, 60);
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
      if (batch.maxEventTs) maxTs = Math.max(maxTs, batch.maxEventTs);
      assert.ok(++guard < 2000, 'runaway batch loop for one thread');
    } while (!batch.eof);
    if (batch.conversation.title) titled++;
  }

  const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}=${c}`).join(' ');
  const topReasons = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, c]) => `${c}× ${r}`).join(' | ') || 'none';
  console.log(`t3 smoke: threads=${gens.length} batches=${batches} items=${itemsTotal} unique=${sourceKeys.size} ` +
    `quarantine=${quarantineTotal} titled=${titled} newest=${new Date(maxTs).toISOString()} in ${Date.now() - t0}ms`);
  console.log(`t3 smoke kinds: ${kinds}`);
  console.log(`t3 smoke quarantine top: ${topReasons}`);

  assert.ok(itemsTotal > 1000, 'a real archive yields thousands of items');
  assert.ok(byKind.get('user')! > 0 && byKind.get('assistant')! > 0 && byKind.get('tool_call')! > 0);
  assert.ok(titled / gens.length > 0.9, 'nearly every thread has a title');
  const ratio = quarantineTotal / Math.max(1, itemsTotal + quarantineTotal);
  assert.ok(ratio < 0.01, `quarantine ${(ratio * 100).toFixed(2)}% (${topReasons})`);
});
