import type { DatabaseSync } from 'node:sqlite';
import { projGet, projSet } from '../core/db.ts';
import { stemText } from '../search/query.ts';

const BATCH = 5000;

/** Bodies are content-addressed and immutable, so the projection only ever inserts:
 *  everything with body_id above the cursor is new. Deletions happen only via purge,
 *  which drops and rebuilds the whole index.db. */
export function catchUpProjection(archive: DatabaseSync, index: DatabaseSync): { bodiesAdded: number; pathsAdded: number } {
  let bodiesAdded = 0;
  let pathsAdded = 0;

  const selectBodies = archive.prepare(`
    SELECT b.body_id, b.text_index, b.paths, b.truncated,
           (SELECT c.app FROM item i JOIN conversation c ON c.conv_id = i.conv_id
             WHERE i.body_id = b.body_id ORDER BY i.item_id LIMIT 1) AS src,
           (SELECT i.ts FROM item i WHERE i.body_id = b.body_id ORDER BY i.item_id LIMIT 1) AS ts,
           b.role
    FROM body b WHERE b.body_id > ? ORDER BY b.body_id LIMIT ?`);
  const insertFts = index.prepare(`INSERT INTO fts (rowid, text, text_stem, paths) VALUES (?,?,?,?)`);
  const insertAttr = index.prepare(`INSERT OR REPLACE INTO doc_attr (body_id, src, role, ts_repr, truncated) VALUES (?,?,?,?,?)`);

  while (true) {
    const cursor = Number(projGet(index, 'cursor_body_id') ?? 0);
    const rows = selectBodies.all(cursor, BATCH) as {
      body_id: number; text_index: string; paths: string | null; truncated: number;
      src: string | null; ts: number | null; role: string;
    }[];
    if (!rows.length) break;
    index.exec('BEGIN');
    try {
      for (const r of rows) {
        insertFts.run(r.body_id, r.text_index, stemText(r.text_index), r.paths ?? '');
        insertAttr.run(r.body_id, r.src, r.role, r.ts, r.truncated);
      }
      projSet(index, 'cursor_body_id', String(rows.at(-1)!.body_id));
      index.exec('COMMIT');
    } catch (e) {
      index.exec('ROLLBACK');
      throw e;
    }
    bodiesAdded += rows.length;
  }

  const selectPaths = archive.prepare(`
    SELECT f.item_id, f.path_key FROM item_file f WHERE f.item_id > ? ORDER BY f.item_id LIMIT ?`);
  const pathKnown = index.prepare(`SELECT 1 FROM path_seen WHERE path_key = ?`);
  const pathInsert = index.prepare(`INSERT INTO path_lookup (path_key) VALUES (?)`);
  const pathSeen = index.prepare(`INSERT OR IGNORE INTO path_seen (path_key) VALUES (?)`);

  while (true) {
    const cursor = Number(projGet(index, 'cursor_pathfile_id') ?? 0);
    let rows = selectPaths.all(cursor, BATCH) as { item_id: number; path_key: string }[];
    if (!rows.length) break;
    if (rows.length === BATCH) {
      // avoid cutting between two paths of the same item: drop the trailing item unless it is the only one
      const lastId = rows.at(-1)!.item_id;
      const kept = rows.filter((r) => r.item_id !== lastId);
      if (kept.length) rows = kept;
    }
    index.exec('BEGIN');
    try {
      for (const r of rows) {
        if (!pathKnown.get(r.path_key)) {
          pathInsert.run(r.path_key);
          pathsAdded++;
        }
        pathSeen.run(r.path_key);
      }
      projSet(index, 'cursor_pathfile_id', String(rows.at(-1)!.item_id));
      index.exec('COMMIT');
    } catch (e) {
      index.exec('ROLLBACK');
      throw e;
    }
  }

  return { bodiesAdded, pathsAdded };
}
