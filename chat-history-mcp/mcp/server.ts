import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { setPriority, constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { paths } from '../core/config.ts';
import { openArchive, openIndex, archiveUuid } from '../core/db.ts';
import { searchDocs, readChat, freshness } from '../search/engine.ts';
import type { DeepSearchParams, DeepSearchResult } from '../search/deep.ts';
import { readFullBody } from '../search/bodies.ts';
import { formatHits, formatChatPage, formatFreshness } from './format.ts';

const server = new McpServer({ name: 'chat-history', version: '0.1.0' });

/** Soft budget of one deep search: the scan stops and answers with what it found so far. */
const DEEP_BUDGET_MS = 30_000;
/** Hard stop for a scan stuck inside one body (a backtracking regex): the worker is killed. */
const DEEP_KILL_MS = 60_000;
/** Scans running at once in this server; each takes a full core and the disk, the rest wait. */
const DEEP_PARALLEL = 2;
let deepRunning = 0;
const deepWaiting: (() => void)[] = [];

/** One server serves a session and all its subagents, and every handler runs on one thread.
 *  The deep scan is long synchronous work, so it runs in a worker: other tool calls keep
 *  answering, and the worker is killed on timeout or when the client cancels the call.
 *  The time budget starts when the scan gets its slot, not while it waits for one. */
async function deepSearchInWorker(params: DeepSearchParams, signal: AbortSignal): Promise<DeepSearchResult> {
  if (deepRunning >= DEEP_PARALLEL) await new Promise<void>((r) => deepWaiting.push(r));
  deepRunning++;
  try {
    return await runDeepWorker({ ...params, deadline: Date.now() + DEEP_BUDGET_MS }, signal);
  } finally {
    deepRunning--;
    deepWaiting.shift()?.();
  }
}

function runDeepWorker(params: DeepSearchParams, signal: AbortSignal): Promise<DeepSearchResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('глубокий поиск отменён клиентом'));
    const worker = new Worker(new URL('../search/deep-worker.ts', import.meta.url), { workerData: params });
    const stop = (why: string) => {
      void worker.terminate();
      reject(new Error(why));
    };
    const timer = setTimeout(() => stop(`глубокий поиск не уложился в ${DEEP_KILL_MS / 1000} с и остановлен — упрости regex или сузь scope (chat/after/before)`), DEEP_KILL_MS);
    const onAbort = () => stop('глубокий поиск отменён клиентом');
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    worker.once('message', (r: DeepSearchResult) => { settle(); resolve(r); });
    worker.once('error', (e) => { settle(); reject(e); });
    worker.once('exit', (code) => { settle(); reject(new Error(`deep search worker exited with code ${code}`)); });
  });
}

function withDbs<T>(fn: (archive: DatabaseSync, index: DatabaseSync) => T): T {
  const archive = openArchive(paths.archiveDb, { readonly: true });
  try {
    const { db: index, needsRebuild } = openIndex(paths.indexDb, archiveUuid(archive), { readonly: true });
    if (needsRebuild) throw new Error('индекс отстал от архива — запусти: node ops/cli.ts rebuild');
    try {
      return fn(archive, index);
    } finally {
      index.close();
    }
  } finally {
    archive.close();
  }
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function footer(archive: DatabaseSync): string {
  const f = freshness(archive);
  return formatFreshness(f.sources, f.heartbeat);
}

const truncationNote = 'Выводы инструментов длиннее 6 КБ индексируются как head 4КБ + tail 2КБ + пути + error-строки; совпадения только в середине длинного вывода этому поиску не видны (такие хиты несут t:1).';

server.registerTool('chat_search', {
  title: 'Поиск по истории чатов',
  description: `Полнотекстовый поиск по всей истории чатов Claude Code / Codex / OpenCode / t3 на этой машине. Запрос — свободный текст (русский/английский, словоформы обрабатываются сервером; пути файлов можно писать как есть). ${truncationNote} Результат: карточки с p:<id сообщения> и c:<id чата> для chat_read/chat_details.`,
  inputSchema: z.object({
    query: z.string().describe('свободный текст запроса'),
    src: z.enum(['claude', 'codex', 'opencode', 't3']).optional().describe('только это приложение'),
    role: z.enum(['user', 'assistant', 'tool', 'reasoning']).optional(),
    after: z.string().optional().describe('ISO-дата: только новее'),
    before: z.string().optional().describe('ISO-дата: только старее'),
    project: z.string().optional().describe('подстрока пути проекта (cwd)'),
    tool: z.string().optional().describe('имя инструмента (Bash, Edit, …)'),
    branch: z.enum(['all', 'active']).optional().describe('по умолчанию all: ищем и в отменённых ветках, помечая [ветка]'),
    sort: z.enum(['rank', 'time']).optional(),
    k: z.number().int().min(1).max(50).optional(),
    cursor: z.string().optional().describe('курсор следующей страницы из прошлого ответа'),
  }),
}, async (args) => {
  return withDbs((archive, index) => {
    const { hits, nextCursor } = searchDocs(index, archive, {
      query: args.query,
      src: args.src,
      role: args.role,
      after: args.after ? Date.parse(args.after) : undefined,
      before: args.before ? Date.parse(args.before) : undefined,
      project: args.project,
      tool: args.tool,
      branch: args.branch ?? 'all',
      sort: args.sort,
      k: args.k ?? 10,
      cursor: args.cursor ? JSON.parse(Buffer.from(args.cursor, 'base64').toString()) : undefined,
    });
    const cur = nextCursor ? Buffer.from(JSON.stringify(nextCursor)).toString('base64') : undefined;
    let out = formatHits(hits, cur);
    if (!hits.length) out += `\nhint: если искомое могло быть в середине длинного вывода инструмента — попробуй другой запрос или дождись chat_deep_search`;
    return text(out + '\n' + footer(archive));
  });
});

server.registerTool('chat_read', {
  title: 'Чтение чата',
  description: 'Читает чат постранично: тексты user/assistant + метаданные (tools: N, reasoning: ~K tok). Тела инструментов и reasoning сюда не разворачиваются — бери их через chat_details по p:<id>.',
  inputSchema: z.object({
    chat: z.string().describe('c:<id> из chat_search / chat_list'),
    cursor: z.number().int().optional().describe('ordinal из "next:" прошлой страницы'),
    branch: z.enum(['active', 'all']).optional(),
    max_chars: z.number().int().min(1000).max(60000).optional(),
  }),
}, async (args) => {
  return withDbs((archive) => {
    const page = readChat(archive, args.chat.replace(/^c:/, ''), {
      fromOrdinal: args.cursor,
      branch: args.branch ?? 'active',
      maxChars: args.max_chars ?? 12000,
    });
    if (!page) return text(`чат ${args.chat} не найден`);
    return text(formatChatPage(page) + '\n' + footer(archive));
  });
});

server.registerTool('chat_details', {
  title: 'Тяжёлое содержимое сообщений',
  description: 'Отдаёт полные тела по p:<id>: выводы инструментов (включая усечённые в индексе — из архива полных тел), reasoning, вызовы инструментов. Экономит токены: зови только когда реально нужно содержимое.',
  inputSchema: z.object({
    ids: z.array(z.string()).min(1).max(20).describe('p:<id> сообщений'),
    max_chars: z.number().int().min(1000).max(100000).optional().describe('лимит на всё вместе, default 20000'),
  }),
}, async (args) => {
  return withDbs((archive) => {
    const maxChars = args.max_chars ?? 20000;
    const out: string[] = [];
    let used = 0;
    const find = archive.prepare(`SELECT i.item_id, i.kind, i.tool_name, i.body_id, i.is_error, c.public_id AS conv_pid FROM item i JOIN conversation c ON c.conv_id = i.conv_id WHERE i.public_id = ?`);
    for (const rawId of args.ids) {
      const id = rawId.replace(/^p:/, '');
      const row = find.get(id) as { item_id: number; kind: string; tool_name: string | null; body_id: number | null; is_error: number | null; conv_pid: string } | undefined;
      if (!row) {
        out.push(`p:${id} — не найдено`);
        continue;
      }
      const full = row.body_id !== null ? readFullBody(archive, row.body_id) ?? '' : '';
      const budget = maxChars - used;
      if (budget <= 0) {
        out.push(`p:${id} — пропущено: лимит max_chars исчерпан`);
        continue;
      }
      const body = full.length > budget ? full.slice(0, budget) + `\n…[обрезано: ${full.length - budget} симв. за лимитом max_chars]` : full;
      used += body.length;
      const head = [`p:${id}`, row.kind, row.tool_name ?? '', row.is_error ? 'ERROR' : '', `c:${row.conv_pid}`].filter(Boolean).join(' · ');
      out.push(`=== ${head}\n${body}`);
    }
    return text(out.join('\n\n'));
  });
});

server.registerTool('chat_deep_search', {
  title: 'Глубокий поиск по полным телам',
  description: `Substring/regex-поиск по ПОЛНЫМ выводам инструментов, включая середины, которых нет в обычном индексе. Скан линейный, от новых к старым: один чат или неделя (chat/after/before) — секунды, весь архив — 20–30 с. Одновременно идут не больше ${DEEP_PARALLEL} сканов, остальные ждут. Лимит ${DEEP_BUDGET_MS / 1000} с: не успел — вернёт найденное и скажет, что просмотрено не всё. Сужай scope, когда можешь; src сам по себе скан не сужает.`,
  inputSchema: z.object({
    pattern: z.string().describe('подстрока или regex'),
    regex: z.boolean().optional(),
    chat: z.string().optional().describe('c:<id> — искать только в этом чате'),
    src: z.enum(['claude', 'codex', 'opencode', 't3']).optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    max_hits: z.number().int().min(1).max(100).optional(),
  }),
}, async (args, ctx) => {
  const { hits, scannedBodies, exhausted, timedOut } = await deepSearchInWorker({
    pattern: args.pattern,
    regex: args.regex,
    chat: args.chat,
    src: args.src,
    after: args.after ? Date.parse(args.after) : undefined,
    before: args.before ? Date.parse(args.before) : undefined,
    maxHits: args.max_hits ?? 20,
  }, ctx.mcpReq.signal);
  const lines = hits.map((h, i) => {
    const date = h.ts ? new Date(h.ts).toISOString().slice(0, 10) : '?';
    return `${i + 1}. p:${h.itemPublicId} ${h.src}/${h.toolName ?? 'tool'} ${date} · «${(h.convTitle ?? '').slice(0, 50)}» c:${h.convPublicId}\n   ${h.context.slice(0, 400)}`;
  });
  const head = hits.length ? lines.join('\n') : 'ничего не найдено';
  const tail = timedOut
    ? `время вышло (${DEEP_BUDGET_MS / 1000} с): просмотрено тел ${scannedBodies}, более старые не просмотрены — сузь scope (chat/after/before)`
    : exhausted ? `просмотрено тел: ${scannedBodies}` : `лимит max_hits достигнут — scope можно сузить`;
  // Deep search reads only archive.db, so a stale index.db must not fail it (withDbs would).
  const archive = openArchive(paths.archiveDb, { readonly: true });
  try {
    return text(`${head}\n${tail}\n${footer(archive)}`);
  } finally {
    archive.close();
  }
});

server.registerTool('chat_list', {
  title: 'Список чатов',
  description: 'Карточки бесед, свежие сверху. Фильтры: приложение, проект, дата, подстрока титула.',
  inputSchema: z.object({
    src: z.enum(['claude', 'codex', 'opencode', 't3']).optional(),
    project: z.string().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    q: z.string().optional().describe('подстрока в титуле'),
    k: z.number().int().min(1).max(50).optional(),
    cursor: z.string().optional(),
  }),
}, async (args) => {
  return withDbs((archive) => {
    const filters: string[] = [`kind = 'main'`];
    const fargs: (string | number)[] = [];
    if (args.src) { filters.push(`app = ?`); fargs.push(args.src); }
    if (args.project) { filters.push(`cwd_key LIKE ?`); fargs.push(`%${args.project.toLowerCase().replaceAll('\\', '/')}%`); }
    if (args.after) { filters.push(`last_activity_at >= ?`); fargs.push(Date.parse(args.after)); }
    if (args.before) { filters.push(`last_activity_at <= ?`); fargs.push(Date.parse(args.before)); }
    if (args.q) { filters.push(`title LIKE ?`); fargs.push(`%${args.q}%`); }
    if (args.cursor) {
      const c = JSON.parse(Buffer.from(args.cursor, 'base64').toString());
      filters.push(`(last_activity_at < ? OR (last_activity_at = ? AND public_id > ?))`);
      fargs.push(c.ts, c.ts, c.pid);
    }
    const k = args.k ?? 20;
    const rows = archive.prepare(`
      SELECT public_id, app, root_id, title, cwd_display, last_activity_at, started_at,
             (SELECT COUNT(*) FROM item WHERE item.conv_id = conversation.conv_id AND kind IN ('user','assistant')) AS msgs
      FROM conversation WHERE ${filters.join(' AND ')}
      ORDER BY last_activity_at DESC, public_id ASC LIMIT ?`).all(...fargs, k + 1) as {
        public_id: string; app: string; root_id: string; title: string | null; cwd_display: string | null;
        last_activity_at: number | null; started_at: number | null; msgs: number;
      }[];
    const more = rows.length > k;
    if (more) rows.length = k;
    const lines = rows.map((r) => {
      const date = r.last_activity_at ? new Date(r.last_activity_at).toISOString().slice(0, 10) : '?';
      return `c:${r.public_id} ${r.app}/${r.root_id} ${date} · «${(r.title ?? 'без названия').slice(0, 70)}» · ${r.msgs} сообщ. · ${r.cwd_display ?? ''}`;
    });
    if (more) {
      const last = rows.at(-1)!;
      lines.push(`next: cursor=${Buffer.from(JSON.stringify({ ts: last.last_activity_at, pid: last.public_id })).toString('base64')}`);
    }
    return text((lines.join('\n') || 'пусто') + '\n' + footer(archive));
  });
});

server.registerTool('chat_status', {
  title: 'Состояние индекса',
  description: 'Свежесть по источникам, живость писателя, размеры хранилищ, ошибки парсинга и карантин.',
  inputSchema: z.object({}),
}, async () => {
  return withDbs((archive, index) => {
    const f = freshness(archive);
    const counts = archive.prepare(`SELECT (SELECT COUNT(*) FROM conversation) AS convs, (SELECT COUNT(*) FROM item) AS items, (SELECT COUNT(*) FROM body) AS bodies, (SELECT COUNT(*) FROM quarantine) AS quarantined`).get() as Record<string, number>;
    const size = (p: string) => (existsSync(p) ? (statSync(p).size / 1048576).toFixed(1) + ' MB' : '—');
    const out = [
      formatFreshness(f.sources, f.heartbeat),
      ...f.sources.map((s) => `${s.source}: parse_errors=${s.parseErrors} quarantined=${s.quarantined}`),
      `хранилище: archive.db ${size(paths.archiveDb)} · index.db ${size(paths.indexDb)}`,
      `объём: ${counts.convs} чатов · ${counts.items} сообщений · ${counts.bodies} уникальных тел`,
    ];
    return text(out.join('\n'));
  });
});

server.registerTool('chat_purge', {
  title: 'Удалить чат навсегда',
  description: 'Необратимо удаляет чат из архива, индекса, blob/raw-зеркал и всех поколений бэкапа; tombstone не даёт ему воскреснуть из источника. Первый вызов без confirm показывает, что будет удалено; исполняется только повторный вызов с confirm, равным id чата.',
  inputSchema: z.object({
    chat: z.string().describe('c:<id> из chat_search / chat_list'),
    confirm: z.string().optional().describe('эхо-подтверждение: тот же c:<id> ещё раз'),
    reason: z.string().optional(),
  }),
}, async (args) => {
  const { previewPurge, purgeConversation } = await import('../ops/purge.ts');
  const id = args.chat.replace(/^c:/, '');
  if (args.confirm?.replace(/^c:/, '') !== id) {
    const archive = openArchive(paths.archiveDb, { readonly: true });
    try {
      const p = previewPurge(archive, id);
      if (!p) return text(`чат ${args.chat} не найден`);
      return text(`будет удалено НАВСЕГДА: c:${p.publicId} «${(p.title ?? '').slice(0, 60)}» — ${p.items} сообщений, ${p.bodiesExclusive} тел, ${p.framesTouched} blob-фреймов, ${p.rawFiles.length} raw-файлов; все старые поколения бэкапа перегенерируются.\nЧтобы исполнить, повтори вызов с confirm:"c:${p.publicId}". Это должно быть решением пользователя, не твоим.`);
    } finally {
      archive.close();
    }
  }
  const r = purgeConversation(id, { reason: args.reason });
  if (!r) return text('другой писатель держит мьютекс — повтори через минуту');
  return text(`удалено навсегда: c:${r.publicId} — ${r.items} сообщений, ${r.bodiesExclusive} тел · индекс пересобран · бэкап перегенерирован · verified=${r.verified}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Freshen in a separate below-normal-priority process: search answers immediately from the
// previous generation. Ingest is ~15 s of synchronous SQLite work; run in this process it would
// stall every tool call meanwhile. Exit code 3 = another writer holds the mutex — fine.
try {
  const ingest = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL('../ops/cli.ts', import.meta.url)), 'ingest'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  ingest.on('error', () => { /* freshness is best effort */ });
  ingest.unref();
  if (ingest.pid) setPriority(ingest.pid, constants.priority.PRIORITY_BELOW_NORMAL);
} catch { /* freshness is best effort */ }
