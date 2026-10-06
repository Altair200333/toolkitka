import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { discoverCodexGenerations, readCodexBatch, closeCodexThreadStore } from '../readers/codex.ts';
import type { ChangeBatch, GenerationInfo, ItemUpsert, ReadBudget } from '../readers/types.ts';
import type { SourceRootDef } from '../core/config.ts';

const THREAD_ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';
const FILE_UUID = '0199ffff-eeee-7ddd-8ccc-bbbbaaaa1111';

/** Writes records as JSONL and returns the byte offset of every line. */
function writeJsonl(path: string, records: unknown[]): number[] {
  const offsets: number[] = [];
  const chunks: Buffer[] = [];
  let off = 0;
  for (const r of records) {
    offsets.push(off);
    const b = Buffer.from(`${JSON.stringify(r)}\n`, 'utf8');
    chunks.push(b);
    off += b.length;
  }
  writeFileSync(path, Buffer.concat(chunks));
  return offsets;
}

function ev(type: string, payload: Record<string, unknown>, ts: string) {
  return { timestamp: ts, type: 'event_msg', payload: { type, ...payload } };
}
function ri(payload: Record<string, unknown>, ts: string) {
  return { timestamp: ts, type: 'response_item', payload };
}

/** The synthetic rollout used by the unit tests; mirrors the shapes seen in the
 *  real corpus (adjacent duplicate pairs, injected blocks, compaction copies). */
function synthRecords() {
  const t = (n: number) => `2026-08-27T10:0${n}:00.000Z`;
  return [
    { timestamp: t(0), type: 'session_meta', payload: { id: THREAD_ID, cwd: 'F:/projects/demo', cli_version: '0.144.2' } },
    ri({
      type: 'message', role: 'user', id: 'um_1',
      content: [
        { type: 'input_text', text: '<environment_context>\n  <cwd>F:/projects/demo</cwd>\n</environment_context>' },
        { type: 'input_text', text: 'привет, почини ридер' },
      ],
    }, t(1)),
    ev('user_message', { message: 'привет, почини ридер', images: null }, t(1)),
    ev('agent_reasoning', { text: 'смотрю на формат роллаутов' }, t(2)),
    ev('agent_message', { message: 'сейчас посмотрю', phase: 'commentary' }, t(3)),
    ri({ type: 'message', role: 'assistant', id: 'msg_1', phase: 'commentary', content: [{ type: 'output_text', text: 'сейчас посмотрю' }] }, t(3)),
    ri({ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{"path":"F:/projects/demo/a.ts"}' }, t(4)),
    ri({ type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'ok' }, t(4)),
    ev('patch_apply_end', {
      call_id: 'call_1', stdout: 'Success. Updated the following files:\nM a.ts', stderr: '', success: true,
      changes: { 'F:/projects/demo/a.ts': { type: 'update', unified_diff: '@@' }, 'F:/projects/demo/old.ts': { type: 'delete' } },
    }, t(5)),
    ev('token_count', { info: { total_token_usage: { input_tokens: 1 } } }, t(5)),
    {
      timestamp: t(6), type: 'compacted',
      payload: {
        message: '',
        replacement_history: [
          { type: 'message', role: 'user', id: 'm_old', content: [{ type: 'input_text', text: 'старое сообщение' }] },
          { type: 'compaction', id: 'c_1', encrypted_content: 'gAAAAABmZZZ' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'копия без id' }] },
        ],
      },
    },
    ev('agent_message', { message: 'готово', phase: 'final_answer' }, t(7)),
    ri({ type: 'message', role: 'assistant', id: 'msg_2', phase: 'final_answer', content: [{ type: 'output_text', text: 'готово' }] }, t(7)),
    { timestamp: t(8), type: 'zzz_unknown_record', payload: { a: 1 } },
    ev('brand_new_event_type', { whatever: 1 }, t(8)),
  ];
}

function makeGen(): { dir: string; gen: GenerationInfo; offsets: number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'chm-codex-'));
  const day = join(dir, 'sessions', '2026', '08', '27');
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-08-27T10-00-00-${FILE_UUID}.jsonl`);
  const offsets = writeJsonl(file, synthRecords());
  const root: SourceRootDef = { rootId: 'codex:test', app: 'codex', rootPath: dir, label: 'test' };
  const gens = discoverCodexGenerations(root);
  assert.equal(gens.length, 1, 'discovery must find exactly the one rollout');
  return { dir, gen: gens[0], offsets };
}

const BIG: ReadBudget = { maxItems: 100000, maxBytes: 64 * 1024 * 1024 };

/** Drains a generation from scratch and returns every batch. */
function readAll(gen: GenerationInfo, budget: ReadBudget): ChangeBatch[] {
  const batches: ChangeBatch[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10000; guard++) {
    const b = readCodexBatch(gen, cursor, budget);
    batches.push(b);
    cursor = b.cursorAfter;
    if (b.eof) return batches;
  }
  throw new Error('readAll did not reach eof');
}

const shape = (items: ItemUpsert[]) => items.map((i) => `${i.kind}|${i.sourceKey}|${i.text.slice(0, 40)}`);

test('codex: discovery, conversation identity and record semantics', () => {
  const { dir, gen, offsets } = makeGen();
  try {
    assert.equal(gen.app, 'codex');
    assert.equal(gen.kind, 'jsonl_file');
    assert.ok(gen.locator.startsWith('sessions/2026/08/27/rollout-'), gen.locator);

    const b = readCodexBatch(gen, undefined, BIG);
    assert.equal(b.eof, true);

    // session_meta.payload.id wins over the uuid in the file name
    assert.equal(b.conversation.logicalId, THREAD_ID);
    assert.equal(b.conversation.cwdDisplay, 'F:/projects/demo');
    assert.equal(b.conversation.kind, 'main');
    assert.deepEqual(b.conversation.title, { text: 'привет, почини ридер', revision: offsets[1], source: 'first_user' });
    assert.equal(b.conversation.headExtId, 'msg_2');
    assert.equal(b.conversation.startedAt, Date.parse('2026-08-27T10:00:00.000Z'));
    assert.equal(b.conversation.lastActivityAt, Date.parse('2026-08-27T10:08:00.000Z'));
    assert.equal(b.maxEventTs, Date.parse('2026-08-27T10:08:00.000Z'));

    // the synthetic linear chain covers every id-bearing response_item, in file order
    assert.deepEqual(b.edges, [
      { extId: 'um_1' },
      { extId: 'msg_1', parentExtId: 'um_1' },
      { extId: 'fc_1', parentExtId: 'msg_1' },
      { extId: 'fco_1', parentExtId: 'fc_1' },
      { extId: 'msg_2', parentExtId: 'fco_1' },
    ]);

    const kinds = b.items.map((i) => i.kind);
    assert.deepEqual(kinds, ['user', 'reasoning', 'assistant', 'tool_call', 'tool_result', 'tool_result', 'user', 'assistant']);

    // injected blocks are dropped per block, the human text of the same message stays
    const user = b.items[0];
    assert.equal(user.text, 'привет, почини ридер');
    assert.equal(user.sourceKey, `${gen.genKey}:um_1`);
    assert.equal(user.revision, offsets[1]);
    assert.equal(user.tsIsCopy, undefined);

    assert.equal(b.items[1].role, 'reasoning');
    assert.equal(b.items[1].text, 'смотрю на формат роллаутов');

    // agent_message event and the response_item right after it are one message
    assert.equal(b.items[2].text, 'сейчас посмотрю');
    assert.equal(b.items[2].sourceKey, `${gen.genKey}:${offsets[4]}`);
    assert.deepEqual(b.items[2].meta, { phase: 'commentary' });

    const call = b.items[3];
    assert.equal(call.callId, 'call_1');
    assert.equal(call.toolName, 'shell');
    assert.deepEqual(call.files, [{ pathDisplay: 'F:/projects/demo/a.ts', op: 'read' }]);
    assert.equal(b.items[4].callId, 'call_1');
    assert.equal(b.items[4].text, 'ok');

    const patch = b.items[5];
    assert.equal(patch.toolName, 'apply_patch');
    assert.equal(patch.isError, false);
    assert.deepEqual(patch.files, [
      { pathDisplay: 'F:/projects/demo/a.ts', op: 'write' },
      { pathDisplay: 'F:/projects/demo/old.ts', op: 'delete' },
    ]);

    // replacement_history: only id-bearing entries, keyed by id, revision 0, ts marked as a copy
    const copy = b.items[6];
    assert.equal(copy.text, 'старое сообщение');
    assert.equal(copy.sourceKey, `${gen.genKey}:m_old`);
    assert.equal(copy.revision, 0);
    assert.equal(copy.tsIsCopy, true);
    assert.equal(copy.ordinal, offsets[10]);
    // no logical_id on copies: they carry no chain edge, and the branch walk abandons
    // every logical_id it cannot reach from the head
    assert.equal(copy.logicalId, undefined);
    assert.equal(user.logicalId, 'um_1');
    assert.ok(!b.items.some((i) => i.text === 'копия без id'), 'id-less copies are not dedupable and must be dropped');
    assert.ok(!b.items.some((i) => i.text.includes('gAAAAAB')), 'encrypted compaction payloads are never indexed');

    assert.equal(b.items[7].text, 'готово');

    // token_count is prefiltered, unknown records are visible in quarantine
    assert.deepEqual(b.quarantine.map((q) => q.reason).sort(), [
      'unknown_event: brand_new_event_type',
      'unknown_type: zzz_unknown_record',
    ]);
    assert.equal(b.quarantine[0].position, String(offsets[13]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex: cursor is idempotent and never replays items', () => {
  const { dir, gen } = makeGen();
  try {
    const first = readCodexBatch(gen, undefined, BIG);
    const second = readCodexBatch(gen, first.cursorAfter, BIG);

    assert.equal(second.items.length, 0, 'a second pass over an unchanged file yields nothing');
    assert.equal(second.edges.length, 0);
    assert.equal(second.quarantine.length, 0);
    assert.equal(second.eof, true);
    assert.equal(JSON.parse(second.cursorAfter).byte_offset, JSON.parse(first.cursorAfter).byte_offset);
    // identity and chain tail survive the boundary
    assert.equal(second.conversation.logicalId, THREAD_ID);
    assert.equal(JSON.parse(second.cursorAfter).last_ext_id, 'msg_2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex: budget stops on a line boundary and batching loses nothing', () => {
  const { dir, gen, offsets } = makeGen();
  try {
    // three items land before the agent_message/response_item duplicate pair splits
    const small: ReadBudget = { maxItems: 3, maxBytes: 64 * 1024 * 1024 };
    const first = readCodexBatch(gen, undefined, small);
    assert.equal(first.eof, false);
    assert.equal(first.items.length, 3);
    // the cursor points at the first byte of the first unread line
    assert.equal(JSON.parse(first.cursorAfter).byte_offset, offsets[5]);
    assert.ok(offsets.includes(JSON.parse(first.cursorAfter).byte_offset));

    const whole = readCodexBatch(gen, undefined, BIG);
    const chunked = readAll(gen, small);
    assert.ok(chunked.length > 2, 'the small budget must actually split the file');
    assert.equal(chunked[chunked.length - 1].eof, true);

    const flat = chunked.flatMap((b) => b.items);
    // the dedupe of the pair split across the batch boundary holds: same items, same keys
    assert.deepEqual(shape(flat), shape(whole.items));
    assert.deepEqual(chunked.flatMap((b) => b.edges), whole.edges);
    assert.equal(JSON.parse(chunked[chunked.length - 1].cursorAfter).byte_offset, JSON.parse(whole.cursorAfter).byte_offset);

    // a maxBytes budget stops on a line boundary too
    const byBytes = readAll(gen, { maxItems: 100000, maxBytes: 8 });
    assert.deepEqual(shape(byBytes.flatMap((b) => b.items)), shape(whole.items));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex: growing file resumes from the cursor and picks up only the tail', () => {
  const { dir, gen } = makeGen();
  try {
    const first = readCodexBatch(gen, undefined, BIG);
    const path = gen.absPath;
    const extra = [
      ev('agent_message', { message: 'дописал хвост', phase: 'final_answer' }, '2026-08-27T10:09:00.000Z'),
      ri({ type: 'message', role: 'assistant', id: 'msg_3', content: [{ type: 'output_text', text: 'дописал хвост' }] }, '2026-08-27T10:09:00.000Z'),
    ];
    appendFileSync(path, extra.map((r) => `${JSON.stringify(r)}\n`).join(''));

    const second = readCodexBatch(gen, first.cursorAfter, BIG);
    assert.equal(second.items.length, 1, 'the appended duplicate pair is one assistant message');
    assert.equal(second.items[0].text, 'дописал хвост');
    assert.deepEqual(second.edges, [{ extId: 'msg_3', parentExtId: 'msg_2' }]);
    assert.equal(second.eof, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex: subagent rollouts are flagged from session_meta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chm-codex-sub-'));
  try {
    const day = join(dir, 'sessions', '2026', '08', '27');
    mkdirSync(day, { recursive: true });
    writeJsonl(join(day, `rollout-2026-08-27T11-00-00-${THREAD_ID}.jsonl`), [
      {
        timestamp: '2026-08-27T11:00:00.000Z', type: 'session_meta',
        payload: { id: THREAD_ID, cwd: 'F:/x', thread_source: 'subagent', parent_thread_id: FILE_UUID, agent_nickname: 'Скаут', agent_role: 'explore' },
      },
      ev('agent_message', { message: 'нашёл', phase: 'final_answer' }, '2026-08-27T11:00:01.000Z'),
    ]);
    const gens = discoverCodexGenerations({ rootId: 'codex:test', app: 'codex', rootPath: dir, label: 'test' });
    const b = readCodexBatch(gens[0], undefined, BIG);
    assert.equal(b.conversation.kind, 'subagent');
    assert.deepEqual(b.conversation.title, { text: 'Скаут · explore', revision: 0, source: 'ai' });
    assert.equal(b.items.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex: replayed session_meta never steals identity, collab events are indexed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chm-codex-meta-'));
  const OWN = '0199cccc-1111-7222-8333-444455556666';
  const PARENT = '0199dddd-2222-7333-8444-555566667777';
  try {
    const day = join(dir, 'sessions', '2026', '08', '27');
    mkdirSync(day, { recursive: true });
    const t = (n: number) => `2026-08-27T12:0${n}:00.000Z`;
    writeJsonl(join(day, `rollout-2026-08-27T12-00-00-${OWN}.jsonl`), [
      {
        timestamp: t(0), type: 'session_meta',
        payload: { id: OWN, cwd: 'F:/own', thread_source: 'subagent', parent_thread_id: PARENT, agent_nickname: 'Скаут', agent_role: 'explore' },
      },
      // a forked rollout replays the parent's session_meta right after its own
      { timestamp: t(0), type: 'session_meta', payload: { id: PARENT, cwd: 'F:/parent' } },
      ev('user_message', { message: 'первый вопрос' }, t(1)),
      // resume-in-place appends yet another one, mid-file
      { timestamp: t(2), type: 'session_meta', payload: { id: '0199eeee-3333-7444-8555-666677778888', cwd: 'F:/other' } },
      ev('agent_message', { message: 'ответ', phase: 'final_answer' }, t(3)),
      ev('collab_agent_spawn_end', {
        call_id: 'call_s', new_thread_id: PARENT, new_agent_nickname: 'Fermat', new_agent_role: 'explorer',
        prompt: 'посмотри модуль X', status: 'ok',
      }, t(4)),
      ev('collab_resume_end', { call_id: 'call_s', receiver_thread_id: PARENT, status: { completed: 'нашёл проблему' } }, t(5)),
      ev('collab_close_end', { call_id: 'call_s', receiver_thread_id: PARENT, status: 'running' }, t(6)),
      ev('dynamic_tool_call_request', { callId: 'call_d', tool: 'load_workspace_dependencies', arguments: {} }, t(7)),
      ev('dynamic_tool_call_response', {
        call_id: 'call_d', tool: 'load_workspace_dependencies', success: true,
        content_items: [{ type: 'inputText', text: 'зависимости готовы' }],
      }, t(8)),
    ]);
    const gen = discoverCodexGenerations({ rootId: 'codex:test', app: 'codex', rootPath: dir, label: 'test' })[0];

    const b = readCodexBatch(gen, undefined, BIG);
    assert.equal(b.conversation.logicalId, OWN, 'the first session_meta owns the file');
    assert.equal(b.conversation.cwdDisplay, 'F:/own');
    assert.equal(b.conversation.kind, 'subagent');
    assert.deepEqual(b.conversation.title, { text: 'Скаут · explore', revision: 0, source: 'ai' });
    assert.deepEqual(b.quarantine, []);

    assert.deepEqual(b.items.map((i) => [i.kind, i.toolName ?? null, i.text]), [
      ['user', null, 'первый вопрос'],
      ['assistant', null, 'ответ'],
      ['tool_call', 'collab_agent_spawn', 'посмотри модуль X'],
      ['tool_result', 'collab_resume', '{"completed":"нашёл проблему"}'],
      ['tool_call', 'load_workspace_dependencies', 'load_workspace_dependencies {}'],
      ['tool_result', 'load_workspace_dependencies', 'зависимости готовы'],
    ]);
    assert.equal(b.items[2].callId, 'call_s');
    assert.equal(b.items[4].callId, 'call_d');
    assert.equal(b.items[5].isError, false);

    // the flag rides the cursor: a session_meta in a later batch is ignored too
    const chunked = readAll(gen, { maxItems: 1, maxBytes: 64 * 1024 * 1024 });
    assert.ok(chunked.length > 3);
    for (const batch of chunked) assert.equal(batch.conversation.logicalId, OWN);
    assert.deepEqual(shape(chunked.flatMap((x) => x.items)), shape(b.items));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex: real corpus smoke — every generation reads clean', { timeout: 30 * 60 * 1000 }, (t) => {
  const root: SourceRootDef = { rootId: 'codex:main', app: 'codex', rootPath: join(homedir(), '.codex'), label: 'Codex CLI' };
  if (!process.env.CHAT_SMOKE) {
    t.skip('reads your real ~/.codex — opt in with CHAT_SMOKE=1');
    return;
  }
  if (!existsSync(join(root.rootPath, 'sessions'))) {
    t.skip('no ~/.codex on this machine');
    return;
  }
  const started = Date.now();
  const gens = discoverCodexGenerations(root);
  // every Nth generation when CODEX_SMOKE_SAMPLE is set; full corpus otherwise
  const step = Number(process.env.CODEX_SMOKE_SAMPLE ?? '1') || 1;
  const targets = gens.filter((_, i) => i % step === 0);

  const budget: ReadBudget = { maxItems: 2000, maxBytes: 8 * 1024 * 1024 };
  const byKind: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const convs = new Set<string>();
  const subagents = new Set<string>();
  let items = 0, quarantined = 0, batches = 0, bytes = 0, liveKeyCollisions = 0, emptyText = 0, titled = 0;

  for (const [n, gen] of targets.entries()) {
    let cursor: string | undefined;
    const liveKeys = new Set<string>();
    for (let guard = 0; ; guard++) {
      assert.ok(guard < 100000, `runaway batch loop on ${gen.locator}`);
      const b = readCodexBatch(gen, cursor, budget);
      batches++;
      for (const it of b.items) {
        items++;
        byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
        if (!it.text) emptyText++;
        if (!it.tsIsCopy && !liveKeys.add(it.sourceKey)) liveKeyCollisions++;
      }
      for (const q of b.quarantine) {
        quarantined++;
        const reason = q.reason.split(':').slice(0, 2).join(':').slice(0, 60);
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
      const next = JSON.parse(b.cursorAfter).byte_offset;
      assert.ok(typeof next === 'number' && next >= (cursor ? JSON.parse(cursor).byte_offset : 0), `cursor went backwards on ${gen.locator}`);
      cursor = b.cursorAfter;
      if (b.eof) {
        convs.add(`${b.conversation.rootId}|${b.conversation.logicalId}`);
        if (b.conversation.kind === 'subagent') subagents.add(b.conversation.logicalId);
        if (b.conversation.title) titled++;
        bytes += next;
        break;
      }
    }
    if ((n + 1) % 250 === 0) process.stderr.write(`  ...${n + 1}/${targets.length} files, ${items} items\n`);
  }
  closeCodexThreadStore();

  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const pct = items ? (quarantined / items) * 100 : 0;
  console.log('--- codex smoke ---');
  console.log(`generations   ${targets.length} of ${gens.length} (step ${step})`);
  console.log(`bytes read    ${(bytes / 1048576).toFixed(1)} MB in ${batches} batches, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  console.log(`conversations ${convs.size} (subagents ${subagents.size}, titled ${titled})`);
  console.log(`items         ${items}`);
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(15)} ${v}`);
  console.log(`empty text    ${emptyText}`);
  console.log(`live sourceKey collisions ${liveKeyCollisions}`);
  console.log(`quarantine    ${quarantined} (${pct.toFixed(3)}% of items)`);
  for (const [r, c] of top) console.log(`  ${String(c).padStart(7)}  ${r}`);

  assert.ok(items > 0, 'the corpus must yield items');
  assert.equal(liveKeyCollisions, 0, 'two live records must never share a source_key');
  assert.ok(pct < 1, `quarantine ${pct.toFixed(3)}% exceeds the 1% budget: ${JSON.stringify(top)}`);
});
