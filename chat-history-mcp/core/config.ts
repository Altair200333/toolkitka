import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();

/** Where our own data lives. index.db is a disposable projection; everything else is precious.
 *  CHAT_ARCHIVE_DIR overrides the location (tests, dry runs). */
const dataDir = process.env.CHAT_ARCHIVE_DIR ?? join(home, '.chat-history').replaceAll('\\', '/');

export const paths = {
  dataDir,
  archiveDb: `${dataDir}/archive.db`,
  indexDb: `${dataDir}/index.db`,
  rawDir: `${dataDir}/raw`,
  blobsDir: `${dataDir}/blobs`,
  imagesDir: `${dataDir}/blobs/images`,
  /** Best kept on another disk — CHAT_BACKUP_DIR. */
  backupDir: process.env.CHAT_BACKUP_DIR ?? `${dataDir}/backup`,
};

export interface SourceRootDef {
  rootId: string;
  app: 'claude' | 'codex' | 'opencode' | 't3';
  rootPath: string;
  label: string;
}

/** Claude Code config dirs in home: ~/.claude plus any ~/.claude-<name> (a CLAUDE_CONFIG_DIR
 *  per profile), each one only if it has a projects/ folder. rootId and label derive from
 *  the dir name — the archive keys data by rootId, so they must never change for a dir. */
function claudeRoots(): SourceRootDef[] {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((n) => (n === '.claude' || n.startsWith('.claude-')) && existsSync(join(home, n, 'projects')))
    .sort()
    .map((n): SourceRootDef => {
      const name = n === '.claude' ? 'main' : n.slice('.claude-'.length);
      return { rootId: `claude:${name}`, app: 'claude', rootPath: join(home, n), label: `Claude Code (${name})` };
    });
}

/** Source apps on this machine. Read-only for us, always; a missing root just yields nothing.
 *  CHAT_SOURCE_ROOTS_JSON replaces the whole list — tests ingest a frozen snapshot,
 *  because the live roots grow while a test runs (the session doing the testing
 *  appends to its own transcript). */
export const sourceRoots: SourceRootDef[] = process.env.CHAT_SOURCE_ROOTS_JSON ? JSON.parse(process.env.CHAT_SOURCE_ROOTS_JSON) : [
  ...claudeRoots(),
  { rootId: 'codex:main', app: 'codex', rootPath: join(home, '.codex'), label: 'Codex CLI' },
  { rootId: 'opencode:live', app: 'opencode', rootPath: join(home, '.local/share/opencode'), label: 'OpenCode' },
  { rootId: 't3:state', app: 't3', rootPath: join(home, '.t3/userdata'), label: 't3 code' },
];

/** Indexing policy for tool outputs. Bodies above threshold are cut for FTS;
 *  full bodies always live in zstd frames and are reachable via deep_search. */
export const toolTextPolicy = {
  indexThresholdBytes: 6 * 1024,
  headBytes: 4 * 1024,
  tailBytes: 2 * 1024,
  errExtractCapBytes: 4 * 1024,
  pathsCapBytes: 2 * 1024,
};

export const ingestPolicy = {
  /** One archive.db transaction: whichever limit hits first. Keeps the event loop responsive. */
  batchMaxItems: 2000,
  batchMaxBytes: 8 * 1024 * 1024,
  /** Codex writes lines up to ~18 MB; beyond this cap the record goes to quarantine. */
  lineCapBytes: 64 * 1024 * 1024,
  /** Target size of one zstd frame of full tool bodies. */
  frameTargetBytes: 256 * 1024,
  /** OpenCode cursor overlap: time_updated has duplicate-millisecond collisions. */
  opencodeOverlapMs: 2000,
  debounceMs: 7 * 60 * 1000,
};

/** CHAT_MUTEX_NAME lets tests isolate their mutex from concurrently running suite files. */
export const mutexName = process.env.CHAT_MUTEX_NAME ?? 'Global\\chat-history-mcp-writer';

export const freshness = {
  heartbeatIntervalMs: 60 * 1000,
  warnLagMs: 24 * 60 * 60 * 1000,
  alertLagMs: 72 * 60 * 60 * 1000,
  deadWriterMs: 60 * 60 * 1000,
};
