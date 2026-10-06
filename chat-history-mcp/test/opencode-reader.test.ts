import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { discoverOpencodeGenerations, readOpencodeBatch } from '../readers/opencode.ts';
import { sourceRoots, ingestPolicy, type SourceRootDef } from '../core/config.ts';
import type { ChangeBatch, GenerationInfo, ItemUpsert } from '../readers/types.ts';

const T0 = 1_770_000_000_000;

function rootDef(dir: string): SourceRootDef {
  return { rootId: 'opencode:test', app: 'opencode', rootPath: dir, label: 'test' };
}

/** Same DDL subset as the real store (extra live-only columns are irrelevant to the reader). */
function createStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  return db;
}

function addSession(db: DatabaseSync, o: { id: string; parent?: string; title?: string; tc?: number; tu?: number }) {
  db.prepare(`INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?,?)`)
    .run(o.id, 'proj', o.parent ?? null, 'F:/proj/demo', o.title ?? 'Fixture session', o.tc ?? T0, o.tu ?? (o.tc ?? T0) + 500);
}

function addMsg(db: DatabaseSync, o: { id: string; ses: string; tc: number; tu?: number; data: Record<string, unknown> }) {
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)`)
    .run(o.id, o.ses, o.tc, o.tu ?? o.tc, JSON.stringify(o.data));
}

function addPart(db: DatabaseSync, o: { id: string; msg: string; ses: string; tc: number; tu?: number; data: Record<string, unknown> | string }) {
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`)
    .run(o.id, o.msg, o.ses, o.tc, o.tu ?? o.tc, typeof o.data === 'string' ? o.data : JSON.stringify(o.data));
}

function userMsgData(tc: number): Record<string, unknown> {
  return { role: 'user', time: { created: tc }, agent: 'build', model: { providerID: 'p', modelID: 'm-user' } };
}

function asstMsgData(tc: number, parentID: string): Record<string, unknown> {
  return {
    role: 'assistant', parentID, mode: 'build', agent: 'build', modelID: 'm-asst', providerID: 'p',
    path: { cwd: 'F:/proj/demo', root: 'F:/proj/demo' },
    tokens: { total: 15, input: 10, output: 5, reasoning: 0, cache: { write: 0, read: 0 } },
    time: { created: tc },
  };
}

function readToEof(gen: GenerationInfo, budget = { maxItems: 10_000, maxBytes: 64 * 1024 * 1024 }, startCursor?: string): ChangeBatch[] {
  const batches: ChangeBatch[] = [];
  let cursor = startCursor;
  while (true) {
    const b = readOpencodeBatch(gen, cursor, budget);
    batches.push(b);
    if (b.eof) return batches;
    assert.notEqual(b.cursorAfter, cursor, 'cursor must advance between batches');
    cursor = b.cursorAfter;
    assert.ok(batches.length < 1000, 'runaway batch loop');
  }
}

function allItems(batches: ChangeBatch[]): ItemUpsert[] {
  return batches.flatMap((b) => b.items);
}

function keySet(batches: ChangeBatch[]): Set<string> {
  return new Set(allItems(batches).map((i) => i.sourceKey));
}

test('opencode discover: three eras under one root, newest store owns each session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-'));
  try {
    const live = createStore(join(dir, 'opencode.db'));
    addSession(live, { id: 'ses_aaa', tc: T0, tu: T0 + 50 });
    addMsg(live, { id: 'msg_a1', ses: 'ses_aaa', tc: T0 + 10, tu: T0 + 100, data: userMsgData(T0 + 10) });
    addPart(live, { id: 'prt_a1', msg: 'msg_a1', ses: 'ses_aaa', tc: T0 + 11, tu: T0 + 300, data: { type: 'text', text: 'hi' } });
    live.close();

    const bak = createStore(join(dir, 'opencode.db.bak-1.2.12'));
    addSession(bak, { id: 'ses_aaa' }); // stale copy of the live session
    addSession(bak, { id: 'ses_bbb' });
    addMsg(bak, { id: 'msg_b1', ses: 'ses_bbb', tc: T0 + 20, data: userMsgData(T0 + 20) });
    addPart(bak, { id: 'prt_b1', msg: 'msg_b1', ses: 'ses_bbb', tc: T0 + 21, data: { type: 'text', text: 'bak' } });
    bak.close();

    mkdirSync(join(dir, 'storage', 'session', 'hash1'), { recursive: true });
    const sesJson = (id: string) => JSON.stringify({
      id, slug: 's', version: '1.1.60', projectID: 'hash1', directory: 'f:\\proj\\demo',
      title: 'Legacy session', time: { created: T0, updated: T0 + 900 },
    });
    writeFileSync(join(dir, 'storage', 'session', 'hash1', 'ses_bbb.json'), sesJson('ses_bbb')); // migrated copy
    writeFileSync(join(dir, 'storage', 'session', 'hash1', 'ses_ccc.json'), sesJson('ses_ccc')); // json-only session
    mkdirSync(join(dir, 'storage', 'message', 'ses_ccc'), { recursive: true });
    writeFileSync(join(dir, 'storage', 'message', 'ses_ccc', 'msg_c1.json'),
      JSON.stringify({ id: 'msg_c1', sessionID: 'ses_ccc', ...userMsgData(T0 + 30) }));

    const gens = discoverOpencodeGenerations(rootDef(dir));
    const locators = gens.map((g) => g.locator).sort();
    assert.deepEqual(locators, [
      'opencode.db#ses_aaa',
      'opencode.db.bak-1.2.12#ses_bbb',
      'storage/session/hash1/ses_ccc.json',
    ]);
    const liveGen = gens.find((g) => g.locator === 'opencode.db#ses_aaa')!;
    assert.equal(liveGen.kind, 'sqlite_table');
    // change signal is the max row time_updated, not session.time_updated (which lags)
    assert.equal(liveGen.sizeBytes, T0 + 300);
    assert.equal(gens.find((g) => g.locator.endsWith('ses_ccc.json'))!.kind, 'json_file');

    // fingerprints are content-derived → genKeys are stable across rescans
    const again = discoverOpencodeGenerations(rootDef(dir));
    assert.deepEqual(again.map((g) => g.genKey).sort(), gens.map((g) => g.genKey).sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode db session: parts normalize into items, unknown types quarantine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-'));
  try {
    const db = createStore(join(dir, 'opencode.db'));
    addSession(db, { id: 'ses_norm', parent: 'ses_par', title: 'Разбор эрозии', tc: T0, tu: T0 + 500 });
    addMsg(db, { id: 'msg_u1', ses: 'ses_norm', tc: T0 + 10, data: userMsgData(T0 + 10) });
    addPart(db, { id: 'prt_u1', msg: 'msg_u1', ses: 'ses_norm', tc: T0 + 11, data: { type: 'text', text: 'Find the bug in erosion' } });
    addMsg(db, { id: 'msg_a1', ses: 'ses_norm', tc: T0 + 20, tu: T0 + 400, data: asstMsgData(T0 + 20, 'msg_u1') });
    addPart(db, { id: 'prt_r1', msg: 'msg_a1', ses: 'ses_norm', tc: T0 + 21, data: { type: 'reasoning', text: 'thinking hard', time: { start: T0 + 21 } } });
    addPart(db, { id: 'prt_t1', msg: 'msg_a1', ses: 'ses_norm', tc: T0 + 22, data: { type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'completed', input: { filePath: 'F:/proj/demo/a.ts' }, output: 'file body', title: 'a.ts', metadata: {}, time: { start: T0 + 22, end: T0 + 23 } } } });
    addPart(db, { id: 'prt_t2', msg: 'msg_a1', ses: 'ses_norm', tc: T0 + 23, data: { type: 'tool', tool: 'bash', callID: 'call_2', state: { status: 'error', input: { command: 'boom.exe' }, error: 'boom failed', time: { start: T0 + 23 } } } });
    addPart(db, { id: 'prt_t3', msg: 'msg_a1', ses: 'ses_norm', tc: T0 + 24, data: { type: 'tool', tool: 'edit', callID: 'call_3', state: { status: 'pending', input: { filePath: 'F:/proj/demo/b.ts' } } } });
    addPart(db, { id: 'prt_x1', msg: 'msg_a1', ses: 'ses_norm', tc: T0 + 25, data: { type: 'text', text: 'All done' } });
    addPart(db, { id: 'prt_p1', msg: 'msg_a1', ses: 'ses_norm', tc: T0 + 26, data: { type: 'patch', hash: 'abc', files: ['F:/proj/demo/b.ts'] } });
    addPart(db, { id: 'prt_s1', msg: 'msg_a1', ses: 'ses_norm', tc: T0 + 27, data: { type: 'step-start', snapshot: 'h' } });
    addPart(db, { id: 'prt_z1', msg: 'msg_a1', ses: 'ses_norm', tc: T0 + 28, data: { type: 'wobble', x: 1 } });
    db.close();

    const [gen] = discoverOpencodeGenerations(rootDef(dir));
    const [batch] = readToEof(gen);
    const conv = batch.conversation;
    assert.equal(conv.kind, 'subagent');
    assert.equal(conv.logicalId, 'ses_norm');
    assert.equal(conv.cwdDisplay, 'F:/proj/demo');
    assert.deepEqual(conv.title, { text: 'Разбор эрозии', revision: T0 + 500, source: 'ai' });
    assert.equal(conv.startedAt, T0);
    assert.equal(conv.lastActivityAt, T0 + 500);
    assert.equal(conv.headExtId, 'msg_a1');
    assert.deepEqual(batch.edges, [{ extId: 'msg_u1' }, { extId: 'msg_a1', parentExtId: 'msg_u1' }]);

    const byKind = new Map<string, ItemUpsert[]>();
    for (const i of batch.items) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);
    assert.deepEqual(
      Object.fromEntries([...byKind].map(([k, v]) => [k, v.length])),
      { user: 1, reasoning: 1, tool_call: 3, tool_result: 2, assistant: 1, system: 1 },
    );

    const user = byKind.get('user')![0];
    assert.equal(user.logicalId, 'msg_u1');
    assert.equal(user.parentExtId, undefined);
    assert.equal(user.ordinal, T0 + 11);

    const readCall = byKind.get('tool_call')!.find((i) => i.toolName === 'read')!;
    assert.equal(readCall.callId, 'call_1');
    assert.ok(readCall.text.startsWith('read {"filePath"'));
    assert.deepEqual(readCall.files, [{ pathDisplay: 'F:/proj/demo/a.ts', op: 'read' }]);
    assert.equal(readCall.parentExtId, 'msg_u1'); // linear chain, not the parentID star

    const results = byKind.get('tool_result')!;
    assert.equal(results.find((i) => i.callId === 'call_1')!.text, 'file body');
    const errRes = results.find((i) => i.callId === 'call_2')!;
    assert.equal(errRes.isError, true);
    assert.equal(errRes.text, 'boom failed');
    assert.ok(!batch.items.some((i) => i.sourceKey.endsWith('prt_t3#r')), 'pending tool must not emit a result');

    assert.deepEqual(byKind.get('assistant')![0].meta, { model: 'm-asst', in: 10, out: 5 });
    const patch = byKind.get('system')![0];
    assert.deepEqual(patch.files, [{ pathDisplay: 'F:/proj/demo/b.ts', op: 'write' }]);
    assert.deepEqual(patch.meta, { hash: 'abc' });

    assert.equal(batch.quarantine.length, 1);
    assert.equal(batch.quarantine[0].position, 'prt_z1');
    assert.equal(batch.quarantine[0].reason, 'unknown_part_type: wobble');

    // eof cursor carries the pipeline skip signal: sizeBytes <= byte_offset → skipped
    const cur = JSON.parse(batch.cursorAfter);
    assert.ok(cur.byte_offset >= gen.sizeBytes);

    // re-read with the eof cursor: overlap window re-emits only already-known keys
    const again = readOpencodeBatch(gen, batch.cursorAfter, { maxItems: 10_000, maxBytes: 64 * 1024 * 1024 });
    assert.equal(again.eof, true);
    const known = keySet([batch]);
    for (const i of again.items) assert.ok(known.has(i.sourceKey), `new key on re-read: ${i.sourceKey}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode db session: overlap window and row updates after the watermark', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-'));
  try {
    const db = createStore(join(dir, 'opencode.db'));
    addSession(db, { id: 'ses_ov', tc: T0, tu: T0 + 500 });
    addMsg(db, { id: 'msg_m1', ses: 'ses_ov', tc: T0 + 10, data: userMsgData(T0 + 10) });
    addPart(db, { id: 'prt_1', msg: 'msg_m1', ses: 'ses_ov', tc: T0 + 100, data: { type: 'text', text: 'one' } });
    addPart(db, { id: 'prt_2', msg: 'msg_m1', ses: 'ses_ov', tc: T0 + 2600, data: { type: 'text', text: 'two' } });
    addPart(db, { id: 'prt_3', msg: 'msg_m1', ses: 'ses_ov', tc: T0 + 3100, data: { type: 'text', text: 'three' } });

    const [gen] = discoverOpencodeGenerations(rootDef(dir));
    const [first] = readToEof(gen);
    assert.equal(first.items.length, 3);
    assert.equal(JSON.parse(first.cursorAfter).ts, T0 + 3100);

    // idle re-scan: only rows inside (wm-2000, wm] come back, older ones stay consumed
    const rescan = readOpencodeBatch(gen, first.cursorAfter, { maxItems: 10_000, maxBytes: 64 * 1024 * 1024 });
    const rescanIds = rescan.items.map((i) => i.sourceKey.split(':')[1]).sort();
    assert.deepEqual(rescanIds, ['prt_2', 'prt_3']);

    // a later rewrite of an old row bumps its time_updated past the watermark
    db.prepare(`UPDATE part SET data = ?, time_updated = ? WHERE id = 'prt_1'`)
      .run(JSON.stringify({ type: 'text', text: 'one-updated' }), T0 + 9000);
    db.close();

    const [genAfter] = discoverOpencodeGenerations(rootDef(dir));
    assert.equal(genAfter.sizeBytes, T0 + 9000);
    assert.ok(JSON.parse(rescan.cursorAfter).byte_offset < genAfter.sizeBytes, 'pipeline must not skip after the update');
    const updated = readOpencodeBatch(genAfter, rescan.cursorAfter, { maxItems: 10_000, maxBytes: 64 * 1024 * 1024 });
    const p1 = updated.items.find((i) => i.sourceKey.endsWith(':prt_1'))!;
    assert.equal(p1.text, 'one-updated');
    assert.equal(p1.revision, T0 + 9000); // higher revision → upsert overwrites the old body
    assert.equal(JSON.parse(updated.cursorAfter).ts, T0 + 9000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode db session: budget splits batches without loss or duplication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-'));
  try {
    const db = createStore(join(dir, 'opencode.db'));
    addSession(db, { id: 'ses_bud', tc: T0 });
    addMsg(db, { id: 'msg_m1', ses: 'ses_bud', tc: T0 + 10, data: userMsgData(T0 + 10) });
    for (let i = 1; i <= 12; i++) {
      addPart(db, { id: `prt_${String(i).padStart(2, '0')}`, msg: 'msg_m1', ses: 'ses_bud', tc: T0 + 100 + i, data: { type: 'text', text: `part text ${i}` } });
    }
    db.close();

    const [gen] = discoverOpencodeGenerations(rootDef(dir));
    const full = keySet(readToEof(gen));
    assert.equal(full.size, 12);

    const batches = readToEof(gen, { maxItems: 5, maxBytes: 64 * 1024 * 1024 });
    assert.equal(batches.length, 3);
    assert.deepEqual(batches.map((b) => b.items.length), [5, 5, 2]);
    const seen = new Set<string>();
    for (const b of batches) {
      for (const i of b.items) {
        assert.ok(!seen.has(i.sourceKey), `duplicate across mid-read batches: ${i.sourceKey}`);
        seen.add(i.sourceKey);
      }
    }
    assert.deepEqual([...seen].sort(), [...full].sort());

    // byte budget alone must also make progress and terminate
    const tiny = readToEof(gen, { maxItems: 10_000, maxBytes: 10 });
    assert.equal(keySet(tiny).size, 12);
    assert.ok(tiny.length >= 12, 'one oversized item per batch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode legacy json session: parse, budget resume, quarantine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-'));
  try {
    mkdirSync(join(dir, 'storage', 'session', 'aabb'), { recursive: true });
    writeFileSync(join(dir, 'storage', 'session', 'aabb', 'ses_jjj.json'), JSON.stringify({
      id: 'ses_jjj', slug: 's', version: '1.1.60', projectID: 'aabb', directory: 'f:\\proj\\demo',
      title: 'Legacy title', time: { created: T0, updated: T0 + 900 },
    }));
    const msgDir = join(dir, 'storage', 'message', 'ses_jjj');
    mkdirSync(msgDir, { recursive: true });
    writeFileSync(join(msgDir, 'msg_j1.json'), JSON.stringify({ id: 'msg_j1', sessionID: 'ses_jjj', ...userMsgData(T0 + 10) }));
    writeFileSync(join(msgDir, 'msg_j2.json'), JSON.stringify({ id: 'msg_j2', sessionID: 'ses_jjj', ...asstMsgData(T0 + 20, 'msg_j1'), modelID: 'gpt' }));
    writeFileSync(join(msgDir, 'msg_j3.json'), ''); // zero-byte files exist in the real store
    mkdirSync(join(dir, 'storage', 'part', 'msg_j1'), { recursive: true });
    writeFileSync(join(dir, 'storage', 'part', 'msg_j1', 'prt_j1.json'),
      JSON.stringify({ id: 'prt_j1', sessionID: 'ses_jjj', messageID: 'msg_j1', type: 'text', text: 'legacy question' }));
    mkdirSync(join(dir, 'storage', 'part', 'msg_j2'), { recursive: true });
    writeFileSync(join(dir, 'storage', 'part', 'msg_j2', 'prt_j2.json'),
      JSON.stringify({ id: 'prt_j2', sessionID: 'ses_jjj', messageID: 'msg_j2', type: 'reasoning', text: 'legacy thinking' }));
    writeFileSync(join(dir, 'storage', 'part', 'msg_j2', 'prt_j3.json'),
      JSON.stringify({ id: 'prt_j3', sessionID: 'ses_jjj', messageID: 'msg_j2', type: 'tool', callID: 'call_9', tool: 'read', state: { status: 'completed', input: { filePath: 'F:\\proj\\demo\\x.ts' }, output: 'legacy output', title: 'x.ts', metadata: {}, time: { start: T0 + 21, end: T0 + 22 } } }));
    writeFileSync(join(dir, 'storage', 'part', 'msg_j2', 'prt_j4.json'),
      JSON.stringify({ id: 'prt_j4', sessionID: 'ses_jjj', messageID: 'msg_j2', type: 'zorp' }));
    writeFileSync(join(dir, 'storage', 'part', 'msg_j2', 'prt_j5.json'), '{oops');

    const gens = discoverOpencodeGenerations(rootDef(dir));
    assert.equal(gens.length, 1);
    assert.equal(gens[0].kind, 'json_file');
    const gen = gens[0];

    const [batch] = readToEof(gen);
    const conv = batch.conversation;
    assert.deepEqual(conv.title, { text: 'Legacy title', revision: T0 + 900, source: 'ai' });
    assert.equal(conv.cwdDisplay, 'f:\\proj\\demo');
    assert.equal(conv.kind, 'main');
    assert.deepEqual(batch.edges, [{ extId: 'msg_j1' }, { extId: 'msg_j2', parentExtId: 'msg_j1' }]);
    assert.deepEqual(batch.items.map((i) => i.kind), ['user', 'reasoning', 'tool_call', 'tool_result']);
    const call = batch.items.find((i) => i.kind === 'tool_call')!;
    assert.equal(call.callId, 'call_9');
    assert.deepEqual(call.files, [{ pathDisplay: 'F:\\proj\\demo\\x.ts', op: 'read' }]);
    assert.deepEqual(batch.quarantine.map((q) => q.reason.split(':')[0]).sort(),
      ['message_json_parse', 'part_json_parse', 'unknown_part_type']);
    assert.equal(JSON.parse(batch.cursorAfter).byte_offset, gen.sizeBytes); // frozen store → skipped forever

    // budget split: positional cursor resumes exactly, corrupt-message entry logs once
    const split = readToEof(gen, { maxItems: 2, maxBytes: 64 * 1024 * 1024 });
    assert.ok(split.length >= 3);
    assert.deepEqual([...keySet(split)].sort(), [...keySet([batch])].sort());
    const msgParseEntries = split.flatMap((b) => b.quarantine).filter((q) => q.reason.startsWith('message_json_parse'));
    assert.equal(msgParseEntries.length, 1);
    const seen = new Set<string>();
    for (const b of split) for (const i of b.items) {
      assert.ok(!seen.has(i.sourceKey), `duplicate across batches: ${i.sourceKey}`);
      seen.add(i.sourceKey);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const realRoot = sourceRoots.find((r) => r.app === 'opencode')!;

test('opencode smoke: full read of the real store', { skip: !process.env.CHAT_SMOKE ? 'reads your real OpenCode store — opt in with CHAT_SMOKE=1' : !existsSync(realRoot.rootPath) }, () => {
  const started = Date.now();
  const gens = discoverOpencodeGenerations(realRoot);
  assert.ok(gens.length > 0, 'real store must yield generations');
  assert.equal(new Set(gens.map((g) => g.genKey)).size, gens.length, 'genKeys must be unique');

  const budget = { maxItems: ingestPolicy.batchMaxItems, maxBytes: ingestPolicy.batchMaxBytes };
  const byStore = new Map<string, number>();
  const byKind = new Map<string, number>();
  const reasons = new Map<string, number>();
  let items = 0;
  let quarantined = 0;
  let batches = 0;
  let callsWithoutId = 0;
  let best: { gen: GenerationInfo; keys: Set<string>; cursor: string } | undefined;

  for (const gen of gens) {
    const store = gen.kind === 'json_file' ? 'legacy-json' : gen.locator.split('#')[0];
    byStore.set(store, (byStore.get(store) ?? 0) + 1);
    const keys = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const b = readOpencodeBatch(gen, cursor, budget);
      batches++;
      assert.equal(b.conversation.logicalId, gen.locator.includes('#') ? gen.locator.split('#')[1] : b.conversation.logicalId);
      for (const i of b.items) {
        byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
        keys.add(i.sourceKey);
        if (i.kind === 'tool_call' && !i.callId) callsWithoutId++;
      }
      items += b.items.length;
      quarantined += b.quarantine.length;
      for (const q of b.quarantine) reasons.set(q.reason, (reasons.get(q.reason) ?? 0) + 1);
      if (b.eof) {
        if (!best || keys.size > best.keys.size) best = { gen, keys, cursor: b.cursorAfter };
        break;
      }
      assert.notEqual(b.cursorAfter, cursor, `stalled on ${gen.locator}`);
      cursor = b.cursorAfter;
      assert.ok(batches < 100_000, 'runaway');
    }
  }

  // idempotency on real data: re-reading the biggest session from its eof cursor
  // must only re-emit keys the first pass already produced
  const again = readOpencodeBatch(best!.gen, best!.cursor, budget);
  for (const i of again.items) assert.ok(best!.keys.has(i.sourceKey), `new key on re-read: ${i.sourceKey}`);

  const ratio = quarantined / Math.max(items + quarantined, 1);
  console.log(`  smoke: ${gens.length} sessions (${[...byStore].map(([s, n]) => `${s}: ${n}`).join(', ')})`);
  console.log(`  smoke: ${items} items in ${batches} batches, ${Date.now() - started} ms`);
  console.log(`  smoke: kinds ${JSON.stringify(Object.fromEntries([...byKind].sort((a, b) => b[1] - a[1])))}`);
  console.log(`  smoke: tool_calls without callId: ${callsWithoutId}`);
  console.log(`  smoke: quarantined ${quarantined} (${(ratio * 100).toFixed(3)}%)${reasons.size ? ' top: ' + [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `${r} ×${n}`).join('; ') : ''}`);
  assert.ok(items > 1000, 'expected a non-trivial corpus on this machine');
  assert.ok(ratio <= 0.01, `quarantine ratio ${(ratio * 100).toFixed(2)}% exceeds 1%`);
});
