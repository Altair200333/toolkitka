import { zstdDecompressSync } from 'node:zlib';
import { openSync, readSync, writeSync, closeSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { paths } from '../core/config.ts';
import { openArchive, openIndex, archiveUuid, resetProjection } from '../core/db.ts';
import { tryAcquireWriter } from '../ingest/mutex.ts';
import { FrameStore } from '../ingest/frames.ts';
import { rawMirrorPath } from '../ingest/raw-mirror.ts';
import { catchUpProjection } from '../index/projector.ts';
import { backupArchive } from './backup.ts';

export interface PurgePreview {
  convId: number;
  publicId: string;
  title: string | null;
  scopeKey: string;
  items: number;
  bodiesExclusive: number;
  framesTouched: number;
  rawFiles: string[];
}

export interface PurgeResult extends PurgePreview {
  backupsRegenerated: number;
  verified: boolean;
}

const stripPrefix = (id: string) => (id.startsWith('c:') ? id.slice(2) : id);

/** Counts what a purge would remove. Read-only; used for the echo-confirmation step. */
export function previewPurge(archive: DatabaseSync, chatId: string): PurgePreview | null {
  const conv = archive.prepare(`SELECT conv_id, public_id, title, app, root_id, logical_id FROM conversation WHERE public_id = ?`)
    .get(stripPrefix(chatId)) as { conv_id: number; public_id: string; title: string | null; app: string; root_id: string; logical_id: string } | undefined;
  if (!conv) return null;
  const items = (archive.prepare(`SELECT COUNT(*) AS n FROM item WHERE conv_id = ?`).get(conv.conv_id) as { n: number }).n;
  const excl = archive.prepare(`
    SELECT COUNT(*) AS n, COUNT(DISTINCT b.frame_id) AS frames FROM body b
    WHERE b.body_id IN (SELECT body_id FROM item WHERE conv_id = ?)
      AND NOT EXISTS (SELECT 1 FROM item o WHERE o.body_id = b.body_id AND o.conv_id != ?)`)
    .get(conv.conv_id, conv.conv_id) as { n: number; frames: number };
  return {
    convId: conv.conv_id,
    publicId: conv.public_id,
    title: conv.title,
    scopeKey: `${conv.app}|${conv.root_id}|${conv.logical_id}`,
    items,
    bodiesExclusive: excl.n,
    framesTouched: excl.frames,
    rawFiles: rawFilesOf(archive, conv.conv_id),
  };
}

/** Raw-mirror files that belong 1:1 to this conversation (file-per-conversation sources
 *  only: claude/codex jsonl). Shared-store sources (t3 db, opencode dirs) are not mirrored
 *  per conversation, so there is nothing to delete for them here. */
function rawFilesOf(archive: DatabaseSync, convId: number): string[] {
  const rows = archive.prepare(`
    SELECT DISTINCT g.root_id, g.locator FROM source_gen g
    WHERE g.kind IN ('jsonl_file', 'log_file')
      AND (g.root_id, g.locator) IN (
        SELECT g2.root_id, g2.locator FROM conversation c JOIN source_gen g2 ON g2.gen_key = c.gen_key
        WHERE c.conv_id = ?)`)
    .all(convId) as { root_id: string; locator: string }[];
  return rows.map((r) => rawMirrorPath(paths.rawDir, r.root_id, r.locator)).filter((p) => existsSync(p));
}

/** Deletes one chat forever.
 *  Runs as the writer under the global mutex. Returns null if another writer holds it. */
export function purgeConversation(chatId: string, opts: { reason?: string; log?: (m: string) => void } = {}): PurgeResult | null {
  const lock = tryAcquireWriter();
  if (!lock) return null;
  const log = opts.log ?? (() => {});
  const archive = openArchive(paths.archiveDb);
  try {
    archive.exec(`PRAGMA secure_delete=ON`);
    const preview = previewPurge(archive, chatId);
    if (!preview) throw new Error(`чат ${chatId} не найден`);
    const convId = preview.convId;
    const now = Date.now();

    const exclusive = archive.prepare(`
      SELECT b.body_id, b.content_hash, b.frame_id, b.frame_off, b.frame_len FROM body b
      WHERE b.body_id IN (SELECT body_id FROM item WHERE conv_id = ?)
        AND NOT EXISTS (SELECT 1 FROM item o WHERE o.body_id = b.body_id AND o.conv_id != ?)`)
      .all(convId, convId) as { body_id: number; content_hash: string; frame_id: number | null; frame_off: number; frame_len: number }[];
    const exclusiveIds = new Set(exclusive.map((b) => b.body_id));
    const frameIds = [...new Set(exclusive.filter((b) => b.frame_id !== null).map((b) => b.frame_id as number))];

    const frames = new FrameStore(paths.blobsDir, archive);
    frames.reconcileOnStart();
    const zeroRanges: { file: string; offset: number; clen: number }[] = [];

    archive.exec('BEGIN');
    try {
      // Frames holding purged bodies are rewritten: survivors move to a fresh frame,
      // the old frame row dies now and its bytes are zeroed after COMMIT.
      for (const frameId of frameIds) {
        const frame = archive.prepare(`SELECT file, offset, clen, ulen FROM tool_frame WHERE frame_id = ?`).get(frameId) as
          { file: string; offset: number; clen: number; ulen: number };
        const survivors = (archive.prepare(`SELECT body_id, content_hash, frame_off, frame_len FROM body WHERE frame_id = ?`).all(frameId) as
          { body_id: number; content_hash: string; frame_off: number; frame_len: number }[])
          .filter((b) => !exclusiveIds.has(b.body_id));
        if (survivors.length) {
          const raw = zstdDecompressSync(readRange(join(paths.blobsDir, frame.file), frame.offset, frame.clen));
          for (const s of survivors) frames.add(s.content_hash, raw.subarray(s.frame_off, s.frame_off + s.frame_len).toString('utf8'));
          const refs = frames.takeRefs();
          const repoint = archive.prepare(`UPDATE body SET frame_id = ?, frame_off = ?, frame_len = ? WHERE body_id = ?`);
          for (const s of survivors) {
            const ref = refs.get(s.content_hash)!;
            repoint.run(ref.frameId, ref.frameOff, ref.frameLen, s.body_id);
          }
        }
        archive.prepare(`DELETE FROM tool_frame WHERE frame_id = ?`).run(frameId);
        zeroRanges.push(frame);
      }

      archive.prepare(`DELETE FROM item_file WHERE item_id IN (SELECT item_id FROM item WHERE conv_id = ?)`).run(convId);
      archive.prepare(`DELETE FROM image_occurrence WHERE item_id IN (SELECT item_id FROM item WHERE conv_id = ?)`).run(convId);
      archive.prepare(`DELETE FROM ext_edge WHERE conv_id = ?`).run(convId);
      archive.prepare(`DELETE FROM turn WHERE conv_id = ?`).run(convId);
      archive.prepare(`DELETE FROM conversation_relation WHERE from_conv = ?`).run(convId);
      archive.prepare(`DELETE FROM quarantine WHERE gen_key IN (
        SELECT g.gen_key FROM source_gen g WHERE (g.root_id, g.locator) IN (
          SELECT g2.root_id, g2.locator FROM conversation c JOIN source_gen g2 ON g2.gen_key = c.gen_key WHERE c.conv_id = ?))`).run(convId);
      archive.prepare(`DELETE FROM item WHERE conv_id = ?`).run(convId);
      const delBody = archive.prepare(`DELETE FROM body WHERE body_id = ?`);
      for (const id of exclusiveIds) delBody.run(id);
      archive.prepare(`DELETE FROM conversation WHERE conv_id = ?`).run(convId);
      archive.prepare(`INSERT OR REPLACE INTO purge_tombstone (scope_kind, scope_key, created_at, reason) VALUES ('conversation', ?, ?, ?)`)
        .run(preview.scopeKey, now, opts.reason ?? null);
      archive.prepare(`INSERT INTO purge_log (ts, scope, docs_removed, blobs_removed, verified) VALUES (?,?,?,?,0)`)
        .run(now, `c:${preview.publicId}`, preview.items, exclusiveIds.size);
      archive.exec('COMMIT');
    } catch (e) {
      archive.exec('ROLLBACK');
      throw e;
    }

    // Byte hygiene outside the transaction: refs are already gone from the DB.
    // The backup mirror copies (ops/backup.ts mirrorStores) are append-only synced and would
    // keep the purged bytes forever, so they are edited here explicitly too.
    for (const r of zeroRanges) {
      zeroRange(join(paths.blobsDir, r.file), r.offset, r.clen);
      zeroRange(join(paths.backupDir, 'blobs', r.file), r.offset, r.clen);
    }
    for (const f of preview.rawFiles) {
      rmSync(f, { force: true });
      rmSync(join(paths.backupDir, 'raw', relative(paths.rawDir, f)), { force: true });
    }
    archive.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
    log(`архив: ${preview.items} items, ${exclusiveIds.size} bodies, ${frameIds.length} frames, ${preview.rawFiles.length} raw-файлов`);

    // The projection may still serve purged rowids — rebuild it from scratch.
    const uuid = archiveUuid(archive);
    const { db: index } = openIndex(paths.indexDb, uuid);
    try {
      resetProjection(index, uuid, true);
      catchUpProjection(archive, index);
      log('index.db пересобран');

      // Old backup generations contain the purged content — they die, one fresh gen replaces them.
      let backupsRegenerated = 0;
      if (existsSync(paths.backupDir)) {
        for (const f of readdirSync(paths.backupDir)) {
          if (/^gen-\d{8}\.db\.zst$/.test(f)) {
            rmSync(join(paths.backupDir, f));
            backupsRegenerated++;
          }
        }
      }
      backupArchive();
      log(`бэкап: ${backupsRegenerated} старых поколений удалено, свежее записано`);

      const verified = verifyGone(archive, index, preview, exclusiveIds);
      archive.prepare(`UPDATE purge_log SET verified = ? WHERE ts = ? AND scope = ?`).run(verified ? 1 : 0, now, `c:${preview.publicId}`);
      return { ...preview, backupsRegenerated, verified };
    } finally {
      index.close();
    }
  } finally {
    archive.close();
    lock.release();
  }
}

function verifyGone(archive: DatabaseSync, index: DatabaseSync, p: PurgePreview, bodyIds: Set<number>): boolean {
  const conv = (archive.prepare(`SELECT COUNT(*) AS n FROM conversation WHERE public_id = ?`).get(p.publicId) as { n: number }).n;
  const items = (archive.prepare(`SELECT COUNT(*) AS n FROM item WHERE conv_id = ?`).get(p.convId) as { n: number }).n;
  let indexed = 0;
  const q = index.prepare(`SELECT COUNT(*) AS n FROM doc_attr WHERE body_id = ?`);
  for (const id of bodyIds) indexed += (q.get(id) as { n: number }).n;
  return conv === 0 && items === 0 && indexed === 0;
}

function readRange(path: string, offset: number, len: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    let done = 0;
    while (done < len) {
      const n = readSync(fd, buf, done, len - done, offset + done);
      if (n <= 0) break;
      done += n;
    }
    return buf.subarray(0, done);
  } finally {
    closeSync(fd);
  }
}

function zeroRange(path: string, offset: number, len: number) {
  if (!existsSync(path)) return;
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, Buffer.alloc(len), 0, len, offset);
  } finally {
    closeSync(fd);
  }
}
