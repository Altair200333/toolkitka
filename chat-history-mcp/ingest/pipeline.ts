import { setImmediate as yieldTick } from 'node:timers/promises';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { openArchive, archiveUuid, openIndex } from '../core/db.ts';
import { convPublicId, publicId, pathKey } from '../core/ids.ts';
import { paths, sourceRoots, ingestPolicy, type SourceRootDef } from '../core/config.ts';
import { buildToolText, buildPlainText } from '../index/tool-text.ts';
import { contentHash } from '../core/ids.ts';
import { rmSync } from 'node:fs';
import { tryAcquireWriter } from './mutex.ts';
import { FrameStore } from './frames.ts';
import { mirrorBytes, rawMirrorPath } from './raw-mirror.ts';
import { catchUpProjection } from '../index/projector.ts';
import { readers } from '../readers/registry.ts';
import type { ChangeBatch, GenerationInfo } from '../readers/types.ts';

const TITLE_PRIORITY = { first_user: 1, ai: 2, custom: 3 } as const;

export interface IngestResult {
  generationsSeen: number;
  generationsIngested: number;
  itemsUpserted: number;
  quarantined: number;
  tookMs: number;
  abandonedLockRecovered: boolean;
}

interface CursorState {
  /** Reader-owned cursor JSON (shape differs per source). */
  json: Record<string, unknown>;
  /** Pipeline-owned raw-mirror offset for file-based generations. */
  rawOffset: number;
}

class ArchiveWriter {
  db: DatabaseSync;
  frames: FrameStore;
  #stmt: Record<string, StatementSync>;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.frames = new FrameStore(paths.blobsDir, db);
    this.frames.reconcileOnStart();
    this.#stmt = {
      rootUpsert: db.prepare(`INSERT INTO source_root (root_id, app, root_path, label) VALUES (?,?,?,?)
        ON CONFLICT(root_id) DO UPDATE SET root_path = excluded.root_path, label = excluded.label`),
      genSelect: db.prepare(`SELECT gen_key, fingerprint FROM source_gen WHERE root_id = ? AND locator = ? AND superseded_by IS NULL`),
      genInsert: db.prepare(`INSERT OR IGNORE INTO source_gen (gen_key, root_id, kind, locator, fingerprint, reader_version, first_seen_at, last_seen_at)
        VALUES (?,?,?,?,?,?,?,?)`),
      genSeen: db.prepare(`UPDATE source_gen SET last_seen_at = ?, missing_since = NULL WHERE gen_key = ?`),
      genSupersede: db.prepare(`UPDATE source_gen SET superseded_by = ? WHERE gen_key = ?`),
      cursorGet: db.prepare(`SELECT cursor_json FROM source_cursor WHERE gen_key = ?`),
      cursorSet: db.prepare(`INSERT INTO source_cursor (gen_key, cursor_json, updated_at) VALUES (?,?,?)
        ON CONFLICT(gen_key) DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at`),
      convSelect: db.prepare(`SELECT conv_id, title, title_revision, started_at, last_activity_at FROM conversation WHERE app = ? AND root_id = ? AND logical_id = ?`),
      convInsert: db.prepare(`INSERT INTO conversation (public_id, app, root_id, logical_id, kind, gen_key, cwd_key, cwd_display, started_at, last_activity_at, head_ext_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
      convUpdate: db.prepare(`UPDATE conversation SET gen_key = ?, head_ext_id = COALESCE(?, head_ext_id),
        cwd_key = COALESCE(cwd_key, ?), cwd_display = COALESCE(cwd_display, ?),
        started_at = ?, last_activity_at = ? WHERE conv_id = ?`),
      convTitle: db.prepare(`UPDATE conversation SET title = ?, title_revision = ? WHERE conv_id = ?`),
      bodySelect: db.prepare(`SELECT body_id FROM body WHERE content_hash = ?`),
      bodyInsert: db.prepare(`INSERT INTO body (content_hash, role, text_index, paths, full_bytes, truncated) VALUES (?,?,?,?,?,?)`),
      bodyFrameRef: db.prepare(`UPDATE body SET frame_id = ?, frame_off = ?, frame_len = ? WHERE content_hash = ? AND frame_id IS NULL`),
      itemUpsert: db.prepare(`INSERT INTO item (source_key, public_id, conv_id, kind, body_id, logical_id, parent_ext_id, call_id, ordinal, ts, ts_is_copy, revision, tool_name, is_error, meta_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_key) DO UPDATE SET
          body_id = excluded.body_id, ts = excluded.ts, revision = excluded.revision,
          tool_name = excluded.tool_name, is_error = excluded.is_error, meta_json = excluded.meta_json,
          state = 'active'
        WHERE excluded.revision > item.revision`),
      itemIdBySourceKey: db.prepare(`SELECT item_id FROM item WHERE source_key = ?`),
      fileUpsert: db.prepare(`INSERT OR REPLACE INTO item_file (item_id, path_key, path_display, op) VALUES (?,?,?,?)`),
      edgeUpsert: db.prepare(`INSERT OR REPLACE INTO ext_edge (conv_id, ext_id, parent_ext_id) VALUES (?,?,?)`),
      quarantineInsert: db.prepare(`INSERT INTO quarantine (gen_key, position, reason, raw_excerpt, seen_at) VALUES (?,?,?,?,?)`),
      stateUpsert: db.prepare(`INSERT INTO source_state (source, last_scan_at, last_ingested_event_ts, records_total, parse_errors, quarantined_count)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(source) DO UPDATE SET
          last_scan_at = excluded.last_scan_at,
          last_ingested_event_ts = MAX(COALESCE(source_state.last_ingested_event_ts, 0), COALESCE(excluded.last_ingested_event_ts, 0)),
          records_total = source_state.records_total + excluded.records_total,
          parse_errors = source_state.parse_errors + excluded.parse_errors,
          quarantined_count = source_state.quarantined_count + excluded.quarantined_count`),
      stateError: db.prepare(`UPDATE source_state SET last_error = ?, last_error_at = ? WHERE source = ?`),
      heartbeat: db.prepare(`INSERT INTO writer_heartbeat (id, pid, boot_id, started_at, beat_at) VALUES (1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, boot_id = excluded.boot_id, started_at = excluded.started_at, beat_at = excluded.beat_at`),
      beat: db.prepare(`UPDATE writer_heartbeat SET beat_at = ? WHERE id = 1`),
      tombstoneCheck: db.prepare(`SELECT 1 FROM purge_tombstone WHERE scope_kind = 'conversation' AND scope_key = ?`),
    };
  }

  isTombstoned(scopeKey: string): boolean {
    return this.#stmt.tombstoneCheck.get(scopeKey) !== undefined;
  }

  stmt(name: string): StatementSync {
    return this.#stmt[name];
  }

  /** Ensures the generation row exists; detects fingerprint change (truncate/rewrite)
   *  and supersedes the old generation so the file is re-read from scratch. */
  syncGeneration(gen: GenerationInfo, readerVersion: number, now: number) {
    const current = this.#stmt.genSelect.get(gen.rootId, gen.locator) as { gen_key: string; fingerprint: string } | undefined;
    if (current && current.gen_key !== gen.genKey) {
      this.#stmt.genInsert.run(gen.genKey, gen.rootId, gen.kind, gen.locator, gen.fingerprint, readerVersion, now, now);
      this.#stmt.genSupersede.run(gen.genKey, current.gen_key);
    } else if (!current) {
      this.#stmt.genInsert.run(gen.genKey, gen.rootId, gen.kind, gen.locator, gen.fingerprint, readerVersion, now, now);
    }
    this.#stmt.genSeen.run(now, gen.genKey);
  }

  getCursor(genKeyValue: string): CursorState {
    const row = this.#stmt.cursorGet.get(genKeyValue) as { cursor_json: string } | undefined;
    if (!row) return { json: {}, rawOffset: 0 };
    const { raw_offset, ...json } = JSON.parse(row.cursor_json);
    return { json, rawOffset: raw_offset ?? 0 };
  }

  /** One batch = one FULL transaction: data + cursor commit together. */
  applyBatch(gen: GenerationInfo, batch: ChangeBatch, cursor: Record<string, unknown>): { items: number; quarantined: number } {
    const now = Date.now();
    const db = this.db;
    db.exec('BEGIN');
    try {
      const conv = batch.conversation;
      let convRow = this.#stmt.convSelect.get(conv.app, conv.rootId, conv.logicalId) as
        { conv_id: number; title: string | null; title_revision: number | null; started_at: number | null; last_activity_at: number | null } | undefined;
      if (!convRow) {
        this.#stmt.convInsert.run(
          convPublicId(conv.app, conv.rootId, conv.logicalId), conv.app, conv.rootId, conv.logicalId,
          conv.kind, conv.genKey, conv.cwdDisplay ? pathKey(conv.cwdDisplay) : null, conv.cwdDisplay ?? null,
          conv.startedAt ?? null, conv.lastActivityAt ?? null, conv.headExtId ?? null,
        );
        convRow = this.#stmt.convSelect.get(conv.app, conv.rootId, conv.logicalId) as typeof convRow;
      } else {
        const started = Math.min(convRow.started_at ?? Infinity, conv.startedAt ?? Infinity);
        const last = Math.max(convRow.last_activity_at ?? 0, conv.lastActivityAt ?? 0);
        this.#stmt.convUpdate.run(
          conv.genKey, conv.headExtId ?? null,
          conv.cwdDisplay ? pathKey(conv.cwdDisplay) : null, conv.cwdDisplay ?? null,
          Number.isFinite(started) ? started : null, last || null, convRow!.conv_id,
        );
      }
      const convId = convRow!.conv_id;

      if (conv.title) {
        // title_revision packs priority (custom > ai > first_user) with the record's byte offset
        const newPacked = TITLE_PRIORITY[conv.title.source] * 2 ** 40 + Math.min(conv.title.revision, 2 ** 40 - 1);
        if (newPacked >= (convRow!.title_revision ?? -1)) {
          this.#stmt.convTitle.run(conv.title.text, newPacked, convId);
        }
      }

      for (const e of batch.edges) {
        this.#stmt.edgeUpsert.run(convId, e.extId, e.parentExtId ?? null);
      }

      const pendingFrames: { hash: string }[] = [];
      let itemCount = 0;
      for (const item of batch.items) {
        let bodyId: number | null = null;
        if (item.text) {
          const built = item.role === 'tool' ? buildToolText(item.text) : buildPlainText(item.text);
          const hash = contentHash(item.role, item.text);
          const existing = this.#stmt.bodySelect.get(hash) as { body_id: number } | undefined;
          if (existing) {
            bodyId = existing.body_id;
          } else {
            const res = this.#stmt.bodyInsert.run(hash, item.role, built.textIndex, built.paths || null, built.fullBytes, built.truncated ? 1 : 0);
            bodyId = Number(res.lastInsertRowid);
            if (built.truncated) {
              this.frames.add(hash, item.text);
              pendingFrames.push({ hash });
            }
          }
        }
        this.#stmt.itemUpsert.run(
          item.sourceKey, publicId(item.sourceKey), convId, item.kind, bodyId,
          item.logicalId ?? null, item.parentExtId ?? null, item.callId ?? null, item.ordinal, item.ts ?? null,
          item.tsIsCopy ? 1 : 0, item.revision, item.toolName ?? null,
          item.isError === undefined ? null : item.isError ? 1 : 0,
          item.meta && Object.keys(item.meta).length ? JSON.stringify(item.meta) : null,
        );
        itemCount++;
        if (item.files?.length) {
          const row = this.#stmt.itemIdBySourceKey.get(item.sourceKey) as { item_id: number } | undefined;
          if (row) {
            for (const f of item.files) {
              this.#stmt.fileUpsert.run(row.item_id, pathKey(f.pathDisplay), f.pathDisplay, f.op ?? null);
            }
          }
        }
      }

      if (pendingFrames.length) {
        const refs = this.frames.takeRefs();
        for (const { hash } of pendingFrames) {
          const ref = refs.get(hash);
          if (ref) this.#stmt.bodyFrameRef.run(ref.frameId, ref.frameOff, ref.frameLen, hash);
        }
      }

      for (const q of batch.quarantine) {
        this.#stmt.quarantineInsert.run(gen.genKey, q.position, q.reason, Buffer.from(q.excerpt, 'utf8'), now);
      }

      this.#stmt.cursorSet.run(gen.genKey, JSON.stringify(cursor), now);
      db.exec('COMMIT');
      return { items: itemCount, quarantined: batch.quarantine.length };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Active branch = ancestors of the head; everything else is an abandoned fork.
   *  Search still sees abandoned items, marked as such. */
  recomputeBranchState(convId: number) {
    const db = this.db;
    const head = (db.prepare(`SELECT head_ext_id FROM conversation WHERE conv_id = ?`).get(convId) as { head_ext_id: string | null } | undefined)?.head_ext_id;
    if (!head) return;
    const edges = db.prepare(`SELECT ext_id, parent_ext_id FROM ext_edge WHERE conv_id = ?`).all(convId) as { ext_id: string; parent_ext_id: string | null }[];
    const parent = new Map(edges.map((e) => [e.ext_id, e.parent_ext_id]));
    const active = new Set<string>();
    let cur: string | null | undefined = head;
    while (cur && !active.has(cur)) {
      active.add(cur);
      cur = parent.get(cur);
    }
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS active_uuid (id TEXT PRIMARY KEY)`);
      db.exec(`DELETE FROM active_uuid`);
      const ins = db.prepare(`INSERT OR IGNORE INTO active_uuid (id) VALUES (?)`);
      for (const id of active) ins.run(id);
      db.prepare(`UPDATE item SET branch_state = 'abandoned' WHERE conv_id = ? AND logical_id IS NOT NULL AND branch_state = 'active' AND logical_id NOT IN (SELECT id FROM active_uuid)`).run(convId);
      db.prepare(`UPDATE item SET branch_state = 'active' WHERE conv_id = ? AND logical_id IS NOT NULL AND branch_state = 'abandoned' AND logical_id IN (SELECT id FROM active_uuid)`).run(convId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** The single write path: every MCP process and the scheduled task call this;
 *  the named mutex guarantees one writer machine-wide. */
export async function ensureFresh(opts: { roots?: SourceRootDef[]; log?: (msg: string) => void } = {}): Promise<IngestResult | null> {
  const lock = tryAcquireWriter();
  if (!lock) return null;
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const result: IngestResult = {
    generationsSeen: 0, generationsIngested: 0, itemsUpserted: 0, quarantined: 0,
    tookMs: 0, abandonedLockRecovered: lock.abandoned,
  };
  const archive = openArchive(paths.archiveDb);
  try {
    if (lock.abandoned) log('previous writer died holding the mutex; state is WAL-consistent, proceeding');
    const writer = new ArchiveWriter(archive);
    writer.stmt('heartbeat').run(process.pid, null, started, started);

    const roots = opts.roots ?? sourceRoots;
    const byApp = new Map<string, { maxEventTs: number; items: number; quarantined: number }>();

    for (const root of roots) {
      const reader = readers[root.app];
      if (!reader) continue;
      writer.stmt('rootUpsert').run(root.rootId, root.app, root.rootPath, root.label);
      let generations: GenerationInfo[] = [];
      try {
        generations = reader.discover(root);
      } catch (e) {
        writer.stmt('stateError').run(String(e).slice(0, 500), Date.now(), root.app);
        continue;
      }
      result.generationsSeen += generations.length;
      const now = Date.now();
      for (const gen of generations) {
        writer.syncGeneration(gen, reader.readerVersion, now);
        const cursor = writer.getCursor(gen.genKey);
        const knownOffset = cursor.json.byte_offset;
        if (typeof knownOffset === 'number' && gen.sizeBytes <= knownOffset) continue;

        if (gen.kind === 'jsonl_file' || gen.kind === 'log_file') {
          cursor.rawOffset = mirrorBytes(paths.rawDir, gen.rootId, gen.locator, gen.absPath, cursor.rawOffset, gen.sizeBytes);
        }

        let convIdForBranch: number | null = null;
        while (true) {
          const before = JSON.stringify(cursor.json);
          const batch = reader.readBatch(gen, before, { maxItems: ingestPolicy.batchMaxItems, maxBytes: ingestPolicy.batchMaxBytes });
          cursor.json = JSON.parse(batch.cursorAfter);
          const scopeKey = `${batch.conversation.app}|${batch.conversation.rootId}|${batch.conversation.logicalId}`;
          if (writer.isTombstoned(scopeKey)) {
            // purged forever: consume the source without storing, drop the freshly mirrored bytes
            writer.stmt('cursorSet').run(gen.genKey, JSON.stringify({ ...cursor.json, raw_offset: cursor.rawOffset }), Date.now());
            if (gen.kind === 'jsonl_file' || gen.kind === 'log_file') rmSync(rawMirrorPath(paths.rawDir, gen.rootId, gen.locator), { force: true });
            if (batch.eof) break;
            continue;
          }
          const applied = writer.applyBatch(gen, batch, { ...cursor.json, raw_offset: cursor.rawOffset });
          result.itemsUpserted += applied.items;
          result.quarantined += applied.quarantined;
          const app = byApp.get(root.app) ?? { maxEventTs: 0, items: 0, quarantined: 0 };
          app.maxEventTs = Math.max(app.maxEventTs, batch.maxEventTs ?? 0);
          app.items += applied.items;
          app.quarantined += applied.quarantined;
          byApp.set(root.app, app);
          if (batch.items.length || batch.quarantine.length) {
            const c = batch.conversation;
            const row = archive.prepare(`SELECT conv_id FROM conversation WHERE app = ? AND root_id = ? AND logical_id = ?`).get(c.app, c.rootId, c.logicalId) as { conv_id: number } | undefined;
            convIdForBranch = row?.conv_id ?? null;
          }
          await yieldTick();
          if (batch.eof) break;
          if (batch.cursorAfter === before && !batch.items.length && !batch.quarantine.length) {
            writer.stmt('stateError').run(`reader stalled on ${gen.locator}`, Date.now(), root.app);
            break;
          }
        }
        if (convIdForBranch !== null) writer.recomputeBranchState(convIdForBranch);
        result.generationsIngested++;
        writer.stmt('beat').run(Date.now());
      }
    }

    const scanTs = Date.now();
    for (const [app, agg] of byApp) {
      writer.stmt('stateUpsert').run(app, scanTs, agg.maxEventTs || null, agg.items, 0, agg.quarantined);
    }
    for (const app of new Set(roots.map((r) => r.app))) {
      if (!byApp.has(app)) writer.stmt('stateUpsert').run(app, scanTs, null, 0, 0, 0);
    }

    const uuid = archiveUuid(archive);
    const { db: index } = openIndex(paths.indexDb, uuid);
    try {
      catchUpProjection(archive, index);
    } finally {
      index.close();
    }

    writer.stmt('beat').run(Date.now());
    result.tookMs = Date.now() - started;
    return result;
  } finally {
    archive.close();
    lock.release();
  }
}
