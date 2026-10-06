// Synthetic Claude Code transcripts for tests: generated text only, no real chats.
// Deterministic — the same options always produce the same bytes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TOPICS = [
  'индексация чатов sqlite и полнотекстовый поиск fts5',
  'ошибка теста crash digest после аварийного завершения',
  'бэкап vacuum поколения и ротация архива',
  'refactor the reader cursor and the batch budget',
  'zstd frames for long tool outputs',
  'миграция схемы и пересборка индекса',
];

const WORDS = ('archive index cursor batch budget frame offset digest writer mutex reader session ' +
  'record schema query token stem snippet branch purge backup mirror vacuum heartbeat projection ' +
  'архив индекс курсор пачка бюджет фрейм смещение писатель мьютекс сессия запись схема запрос ' +
  'токен ветка бэкап зеркало проекция поиск ошибка тест сервер клиент файл строка').split(' ');

const TOOLS = ['Bash', 'Read', 'Grep', 'Edit'];

function uuid(kind: number, n: number): string {
  const h = n.toString(16).padStart(12, '0');
  return `${kind.toString(16).padStart(8, '0')}-0000-4000-8000-${h}`;
}

/** Writes `<rootPath>/projects/...` like a Claude Code config dir: main transcripts, one
 *  subagent transcript, long tool outputs (over the 6 KB index threshold → zstd frames). */
export function writeClaudeFixture(rootPath: string, opts: { conversations: number; turns: number }): void {
  let s = 0x9e3779b9;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const words = (n: number) => Array.from({ length: n }, () => WORDS[int(0, WORDS.length - 1)]).join(' ');
  const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';

  let rec = 0;
  for (let c = 0; c < opts.conversations; c++) {
    const project = `C--work-demo-${c % 3}`;
    const cwd = `C:\\work\\demo-${c % 3}`;
    const dir = join(rootPath, 'projects', project);
    mkdirSync(dir, { recursive: true });
    const convId = uuid(1, c);
    const t0 = Date.UTC(2026, 0, 1) + c * 86_400_000;
    let out = '';
    let parent: string | null = null;
    for (let j = 0; j < opts.turns; j++) {
      const ts = (k: number) => new Date(t0 + j * 60_000 + k * 1000).toISOString();
      const topic = TOPICS[(c + j) % TOPICS.length];
      const u = uuid(2, rec++);
      out += line({ type: 'user', uuid: u, parentUuid: parent, timestamp: ts(0), cwd, message: { role: 'user', content: `${topic}: ${words(int(10, 60))}` } });
      const a = uuid(2, rec++);
      const call = `toolu_${c}_${j}`;
      const tool = TOOLS[j % TOOLS.length];
      const input = tool === 'Bash' ? { command: `npm test -- ${words(3)}` } : { file_path: `${cwd}\\src\\file${j % 7}.ts` };
      out += line({ type: 'assistant', uuid: a, parentUuid: u, timestamp: ts(1), cwd, message: { model: 'claude-test', usage: { input_tokens: int(100, 9000), output_tokens: int(10, 900) }, content: [
        { type: 'thinking', thinking: words(int(20, 120)) },
        { type: 'text', text: `${topic} — ${words(int(20, 600))}` },
        { type: 'tool_use', id: call, name: tool, input },
      ] } });
      const r = uuid(2, rec++);
      // every third output is long enough to be cut for the index and stored in a frame
      const output = Array.from({ length: j % 3 === 0 ? int(120, 400) : int(2, 20) }, (_, i) => `${i + 1}: ${words(int(4, 12))}`).join('\n');
      out += line({ type: 'user', uuid: r, parentUuid: a, timestamp: ts(2), cwd, message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: call, is_error: j % 11 === 5, content: [{ type: 'text', text: output }] },
      ] } });
      parent = r;
    }
    out += line({ type: 'ai-title', aiTitle: TOPICS[c % TOPICS.length], sessionId: convId });
    writeFileSync(join(dir, `${convId}.jsonl`), out);

    if (c === 0) {
      const subDir = join(dir, convId, 'subagents');
      mkdirSync(subDir, { recursive: true });
      const su = uuid(3, 0);
      writeFileSync(join(subDir, 'agent-0a1b2c.jsonl'),
        line({ type: 'user', uuid: su, parentUuid: null, timestamp: new Date(t0).toISOString(), cwd, isSidechain: true, message: { role: 'user', content: `найди ${words(8)}` } }) +
        line({ type: 'assistant', uuid: uuid(3, 1), parentUuid: su, timestamp: new Date(t0 + 1000).toISOString(), cwd, isSidechain: true, message: { model: 'claude-test', content: [{ type: 'text', text: words(40) }] } }));
      writeFileSync(join(subDir, 'agent-0a1b2c.meta.json'), JSON.stringify({ description: 'fixture subagent' }));
    }
  }
}

export interface TestArchive {
  env: Record<string, string>;
  cleanup(): void;
}

/** Archive for tests that drive the MCP server. CHAT_SMOKE=1 with CHAT_ARCHIVE_DIR set → that
 *  archive as is (real-data runs; a CHAT_ARCHIVE_DIR set for everyday use alone does not count).
 *  Otherwise a fresh archive ingested from a fixture in a temp dir, with its own source list
 *  and writer mutex, so nothing outside the temp dir is touched. */
export function prepareTestArchive(): TestArchive {
  if (process.env.CHAT_SMOKE && process.env.CHAT_ARCHIVE_DIR) return { env: { CHAT_ARCHIVE_DIR: process.env.CHAT_ARCHIVE_DIR }, cleanup() {} };
  const base = mkdtempSync(join(tmpdir(), 'chm-fixture-'));
  const src = join(base, 'src');
  // more chats than chat_list(k=20) shows, so paging and the list budget see a full page
  writeClaudeFixture(src, { conversations: 24, turns: 8 });
  const env = {
    CHAT_ARCHIVE_DIR: join(base, 'archive').replaceAll('\\', '/'),
    CHAT_SOURCE_ROOTS_JSON: JSON.stringify([{ rootId: 'claude:fixture', app: 'claude', rootPath: src, label: 'test fixture' }]),
    CHAT_MUTEX_NAME: `Local\\chat-history-mcp-test-${process.pid}`,
  };
  execFileSync(process.execPath, ['--no-warnings', 'ops/cli.ts', 'ingest'], { cwd: ROOT, env: { ...process.env, ...env } });
  return {
    env,
    // the killed server and its background ingest may hold the db files for a moment
    cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  };
}
