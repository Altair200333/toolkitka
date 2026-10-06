import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ARCHIVE_SCHEMA, INDEX_SCHEMA } from './schema.ts';

export const SCHEMA_VERSION = 1;

/** Bump whenever the projection recipe changes (truncation policy, stemmer, fts config):
 *  existing index.db files then report needsRebuild. 2 = shadow-stem column populated. */
export const PROJECTION_VERSION = 2;

function applyPragmas(db: DatabaseSync, synchronous: 'FULL' | 'NORMAL') {
  db.exec(`PRAGMA journal_mode=WAL`);
  db.exec(`PRAGMA synchronous=${synchronous}`);
  db.exec(`PRAGMA busy_timeout=5000`);
  db.exec(`PRAGMA foreign_keys=ON`);
}

function metaGet(db: DatabaseSync, table: string, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

function metaSet(db: DatabaseSync, table: string, key: string, value: string) {
  db.prepare(`INSERT INTO ${table}(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** Opens (creating if needed) the canonical archive. synchronous=FULL: this file is the source of truth. */
export function openArchive(path: string, opts: { readonly?: boolean } = {}): DatabaseSync {
  if (opts.readonly) {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=5000`);
    return db;
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  applyPragmas(db, 'FULL');
  const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'`).get();
  if (!hasMeta) {
    db.exec('BEGIN');
    db.exec(ARCHIVE_SCHEMA);
    metaSet(db, 'meta', 'archive_uuid', randomUUID());
    metaSet(db, 'meta', 'schema_version', String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } else {
    const version = Number(metaGet(db, 'meta', 'schema_version'));
    if (version !== SCHEMA_VERSION) {
      throw new Error(`archive.db schema_version=${version}, expected ${SCHEMA_VERSION}; run a migration first`);
    }
    // Archives built before 2026-10-05 lack it: without it every "bodies of frame N" lookup
    // (purge) scans the whole body table — ~5 s per frame. Only a speed-up: callers open this
    // right after taking the writer mutex, outside their try/finally, so it must not throw.
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS body_frame ON body(frame_id) WHERE frame_id IS NOT NULL`);
    } catch { /* disk full / read-only file: the archive still works, just slower */ }
  }
  return db;
}

/** Opens the projection. If it is missing, stale or belongs to another archive — caller must rebuild. */
export function openIndex(path: string, archiveUuid: string, opts: { readonly?: boolean } = {}): { db: DatabaseSync; needsRebuild: boolean } {
  if (opts.readonly) {
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      db.exec(`PRAGMA busy_timeout=5000`);
      return { db, needsRebuild: projectionStale(db, archiveUuid) };
    } catch {
      return { db: undefined as unknown as DatabaseSync, needsRebuild: true };
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  applyPragmas(db, 'NORMAL');
  const hasMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='proj_meta'`).get();
  if (!hasMeta || projectionStale(db, archiveUuid)) resetProjection(db, archiveUuid, !!hasMeta);
  return { db, needsRebuild: false };
}

function projectionStale(db: DatabaseSync, archiveUuid: string): boolean {
  return metaGet(db, 'proj_meta', 'archive_uuid') !== archiveUuid
    || metaGet(db, 'proj_meta', 'projection_version') !== String(PROJECTION_VERSION);
}

/** Recreates the projection in place. Deleting index.db would fail on Windows while
 *  a readonly consumer holds it open; dropping tables under WAL works regardless.
 *  Also exported for purge, which must rebuild even when nothing looks stale. */
export function resetProjection(db: DatabaseSync, archiveUuid: string, wipe: boolean) {
  db.exec('BEGIN');
  if (wipe) {
    for (const t of ['fts', 'path_lookup', 'doc_attr', 'path_seen', 'proj_meta']) db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  db.exec(INDEX_SCHEMA);
  metaSet(db, 'proj_meta', 'archive_uuid', archiveUuid);
  metaSet(db, 'proj_meta', 'projection_version', String(PROJECTION_VERSION));
  metaSet(db, 'proj_meta', 'cursor_body_id', '0');
  db.exec('COMMIT');
}

export function archiveUuid(db: DatabaseSync): string {
  const v = metaGet(db, 'meta', 'archive_uuid');
  if (!v) throw new Error('archive.db has no archive_uuid');
  return v;
}

export function projGet(db: DatabaseSync, key: string): string | undefined {
  return metaGet(db, 'proj_meta', key);
}

export function projSet(db: DatabaseSync, key: string, value: string) {
  metaSet(db, 'proj_meta', key, value);
}
