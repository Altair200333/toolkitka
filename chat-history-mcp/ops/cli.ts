import { rmSync, existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { paths } from '../core/config.ts';
import { openArchive, openIndex, archiveUuid } from '../core/db.ts';
import { ensureFresh } from '../ingest/pipeline.ts';
import { catchUpProjection } from '../index/projector.ts';
import { searchDocs, readChat, freshness } from '../search/engine.ts';
import { formatHits, formatChatPage, formatFreshness } from '../mcp/format.ts';

const [, , cmd, ...args] = process.argv;

function openReadonly(): { archive: DatabaseSync; index: DatabaseSync } {
  const archive = openArchive(paths.archiveDb, { readonly: true });
  const uuid = archiveUuid(archive);
  const { db: index, needsRebuild } = openIndex(paths.indexDb, uuid, { readonly: true });
  if (needsRebuild) throw new Error('index.db отстал от archive.db — запусти rebuild');
  return { archive, index };
}

switch (cmd) {
  case 'ingest': {
    const only = args.filter((a) => a.startsWith('--root=')).map((a) => a.slice(7));
    const { sourceRoots } = await import('../core/config.ts');
    const roots = only.length ? sourceRoots.filter((r) => only.includes(r.rootId)) : undefined;
    const result = await ensureFresh({ roots, log: (m) => console.error(`[ingest] ${m}`) });
    if (!result) {
      console.log('другой писатель уже держит мьютекс — выходим');
      process.exitCode = 3;
      break;
    }
    console.log(JSON.stringify(result, null, 2));
    if (args.includes('--backup')) {
      const { backupArchive } = await import('./backup.ts');
      const r = backupArchive();
      console.log(`бэкап: ${r.generation} (${(r.bytes / 1048576).toFixed(1)} MB)`);
    }
    break;
  }
  case 'rebuild': {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = paths.indexDb + suffix;
      if (existsSync(p)) rmSync(p);
    }
    const archive = openArchive(paths.archiveDb, { readonly: true });
    const { db: index } = openIndex(paths.indexDb, archiveUuid(archive));
    const started = Date.now();
    const stats = catchUpProjection(archive, index);
    console.log(`rebuild: ${stats.bodiesAdded} bodies, ${stats.pathsAdded} paths, ${Date.now() - started} ms`);
    index.close();
    archive.close();
    break;
  }
  case 'status': {
    const archive = openArchive(paths.archiveDb, { readonly: true });
    const f = freshness(archive);
    console.log(formatFreshness(f.sources, f.heartbeat));
    for (const s of f.sources) {
      console.log(`  ${s.source}: parse_errors=${s.parseErrors} quarantined=${s.quarantined}`);
    }
    for (const [name, p] of [['archive.db', paths.archiveDb], ['index.db', paths.indexDb]] as const) {
      if (existsSync(p)) console.log(`  ${name}: ${(statSync(p).size / 1048576).toFixed(1)} MB`);
    }
    const counts = archive.prepare(`SELECT (SELECT COUNT(*) FROM conversation) AS convs, (SELECT COUNT(*) FROM item) AS items, (SELECT COUNT(*) FROM body) AS bodies`).get() as Record<string, number>;
    console.log(`  conversations=${counts.convs} items=${counts.items} bodies=${counts.bodies}`);
    const purges = archive.prepare(`SELECT ts, scope, docs_removed, verified FROM purge_log ORDER BY id DESC LIMIT 5`).all() as { ts: number; scope: string; docs_removed: number; verified: number }[];
    for (const p of purges) {
      console.log(`  purge ${new Date(p.ts).toISOString().slice(0, 10)} ${p.scope}: ${p.docs_removed} docs, verified=${p.verified}`);
    }
    archive.close();
    break;
  }
  case 'purge': {
    const chat = args.find((a) => !a.startsWith('--'));
    if (!chat) {
      console.log('usage: node ops/cli.ts purge c:<chat-id> [--yes] [--reason=...]');
      break;
    }
    const { previewPurge, purgeConversation } = await import('./purge.ts');
    const ro = openArchive(paths.archiveDb, { readonly: true });
    const p = previewPurge(ro, chat);
    ro.close();
    if (!p) {
      console.error(`чат ${chat} не найден`);
      process.exitCode = 1;
      break;
    }
    console.log(`будет удалено навсегда: c:${p.publicId} «${(p.title ?? '').slice(0, 60)}» — ${p.items} items, ${p.bodiesExclusive} тел, ${p.framesTouched} blob-фреймов, ${p.rawFiles.length} raw-файлов; старые поколения бэкапа перегенерируются`);
    if (!args.includes('--yes')) {
      console.log('это необратимо; повтори команду с --yes');
      break;
    }
    const reason = args.find((a) => a.startsWith('--reason='))?.slice(9);
    const r = purgeConversation(chat, { reason, log: (m) => console.error(`[purge] ${m}`) });
    if (!r) {
      console.error('другой писатель держит мьютекс — попробуй позже');
      process.exitCode = 1;
      break;
    }
    console.log(`удалено: ${r.items} items, ${r.bodiesExclusive} тел · verified=${r.verified}`);
    break;
  }
  case 'search': {
    const { archive, index } = openReadonly();
    const { hits, nextCursor } = searchDocs(index, archive, { query: args.join(' '), k: 10 });
    console.log(formatHits(hits, nextCursor ? JSON.stringify(nextCursor) : undefined));
    const f = freshness(archive);
    console.log(formatFreshness(f.sources, f.heartbeat));
    archive.close();
    index.close();
    break;
  }
  case 'read': {
    const { archive, index } = openReadonly();
    const page = readChat(archive, args[0], { maxChars: 6000 });
    console.log(page ? formatChatPage(page) : `чат ${args[0]} не найден`);
    archive.close();
    index.close();
    break;
  }
  case 'backup': {
    const { backupArchive } = await import('./backup.ts');
    const r = backupArchive();
    console.log(`бэкап: ${r.generation} (${(r.bytes / 1048576).toFixed(1)} MB) · vacuum ${r.vacuumMs}ms · verify ${r.verifyMs}ms · zstd ${r.compressMs}ms`);
    break;
  }
  case 'install-task': {
    const node = process.execPath;
    const script = fileURLToPath(new URL('./cli.ts', import.meta.url));
    console.log('Команда регистрации ежедневной задачи (выполни сам, меняет системный планировщик):');
    console.log(`schtasks /Create /TN "chat-history-mcp ingest" /TR "\\"${node}\\" --no-warnings \\"${script}\\" ingest --backup" /SC DAILY /ST 04:00 /F`);
    console.log('Важно: оставь задаче режим «Run only when user is logged on» (иначе Local-мьютексы других процессов её не увидят; наш Global-мьютекс совместим с обоими режимами).');
    break;
  }
  case 'nuke': {
    if (!paths.dataDir.includes('chat-archive-dev')) {
      console.error('nuke удаляет только dev-директории (chat-archive-dev*), не боевой архив');
      process.exitCode = 1;
      break;
    }
    rmSync(paths.dataDir, { recursive: true, force: true });
    console.log(`удалено: ${paths.dataDir}`);
    break;
  }
  default:
    console.log('usage: node ops/cli.ts <ingest|rebuild|status|search <query>|read <chat-id>|purge c:<id>|backup|install-task|nuke>');
}
