/** DDL for archive.db (canonical, sacred) and index.db (disposable projection). */

export const ARCHIVE_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE source_root (
  root_id   TEXT PRIMARY KEY,
  app       TEXT NOT NULL,
  root_path TEXT NOT NULL,
  label     TEXT
);

CREATE TABLE source_gen (
  gen_key        TEXT PRIMARY KEY,
  root_id        TEXT NOT NULL REFERENCES source_root,
  kind           TEXT NOT NULL,
  locator        TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  reader_version INTEGER NOT NULL,
  first_seen_at  INTEGER,
  last_seen_at   INTEGER,
  missing_since  INTEGER,
  superseded_by  TEXT REFERENCES source_gen,
  UNIQUE (root_id, locator, fingerprint)
);

CREATE TABLE source_cursor (
  gen_key     TEXT PRIMARY KEY REFERENCES source_gen,
  cursor_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE source_state (
  source                 TEXT PRIMARY KEY,
  last_scan_at           INTEGER,
  last_ingested_event_ts INTEGER,
  records_total          INTEGER NOT NULL DEFAULT 0,
  parse_errors           INTEGER NOT NULL DEFAULT 0,
  quarantined_count      INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  last_error_at          INTEGER
);

CREATE TABLE writer_heartbeat (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  pid        INTEGER,
  boot_id    TEXT,
  started_at INTEGER,
  beat_at    INTEGER
);

CREATE TABLE conversation (
  conv_id          INTEGER PRIMARY KEY,
  public_id        TEXT UNIQUE NOT NULL,
  app              TEXT NOT NULL,
  root_id          TEXT NOT NULL REFERENCES source_root,
  logical_id       TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'main',
  gen_key          TEXT REFERENCES source_gen,
  cwd_key          TEXT,
  cwd_display      TEXT,
  title            TEXT,
  title_revision   INTEGER,
  started_at       INTEGER,
  last_activity_at INTEGER,
  head_ext_id      TEXT,
  state            TEXT NOT NULL DEFAULT 'active',
  state_at         INTEGER,
  UNIQUE (app, root_id, logical_id)
);
CREATE INDEX conversation_activity ON conversation(last_activity_at);

CREATE TABLE conversation_relation (
  from_conv      INTEGER NOT NULL REFERENCES conversation,
  to_conv        INTEGER,
  to_logical     TEXT NOT NULL,
  rel            TEXT NOT NULL,
  via_source_key TEXT,
  PRIMARY KEY (from_conv, rel, to_logical)
);

CREATE TABLE turn (
  turn_id     INTEGER PRIMARY KEY,
  conv_id     INTEGER NOT NULL REFERENCES conversation,
  ordinal     INTEGER NOT NULL,
  ext_turn_id TEXT,
  started_at  INTEGER,
  ended_at    INTEGER,
  state       TEXT NOT NULL DEFAULT 'active',
  UNIQUE (conv_id, ordinal)
);

CREATE TABLE body (
  body_id      INTEGER PRIMARY KEY,
  content_hash TEXT UNIQUE NOT NULL,
  role         TEXT NOT NULL,
  text_index   TEXT NOT NULL,
  paths        TEXT,
  full_bytes   INTEGER NOT NULL,
  truncated    INTEGER NOT NULL DEFAULT 0,
  frame_id     INTEGER,
  frame_off    INTEGER,
  frame_len    INTEGER
);
CREATE INDEX body_frame ON body(frame_id) WHERE frame_id IS NOT NULL;

CREATE TABLE item (
  item_id       INTEGER PRIMARY KEY,
  source_key    TEXT NOT NULL UNIQUE,
  public_id     TEXT NOT NULL,
  conv_id       INTEGER NOT NULL REFERENCES conversation,
  turn_id       INTEGER REFERENCES turn,
  kind          TEXT NOT NULL,
  body_id       INTEGER REFERENCES body,
  logical_id    TEXT,
  parent_ext_id TEXT,
  call_id       TEXT,
  ordinal       INTEGER NOT NULL,
  ts            INTEGER,
  ts_is_copy    INTEGER NOT NULL DEFAULT 0,
  revision      INTEGER NOT NULL,
  branch_state  TEXT NOT NULL DEFAULT 'active',
  state         TEXT NOT NULL DEFAULT 'active',
  tool_name     TEXT,
  is_error      INTEGER,
  meta_json     TEXT
);
CREATE INDEX item_conv_ord ON item(conv_id, ordinal);
CREATE INDEX item_body ON item(body_id);
CREATE INDEX item_ts ON item(ts);
CREATE INDEX item_pub ON item(public_id);

CREATE TABLE ext_edge (
  conv_id       INTEGER NOT NULL,
  ext_id        TEXT NOT NULL,
  parent_ext_id TEXT,
  PRIMARY KEY (conv_id, ext_id)
) WITHOUT ROWID;

CREATE TABLE item_file (
  item_id      INTEGER NOT NULL,
  path_key     TEXT NOT NULL,
  path_display TEXT NOT NULL,
  op           TEXT,
  PRIMARY KEY (item_id, path_key)
);
CREATE INDEX item_file_path ON item_file(path_key);

CREATE TABLE tool_frame (
  frame_id  INTEGER PRIMARY KEY,
  file      TEXT NOT NULL,
  offset    INTEGER,
  clen      INTEGER,
  ulen      INTEGER,
  doc_count INTEGER,
  min_ts    INTEGER,
  max_ts    INTEGER,
  srcs      TEXT
);

CREATE TABLE image (
  sha256         TEXT PRIMARY KEY,
  bytes          INTEGER,
  mime           TEXT,
  blob_path      TEXT,
  description    TEXT,
  descr_keywords TEXT,
  descr_ocr      TEXT,
  descr_model    TEXT,
  descr_at       INTEGER
);

CREATE TABLE image_occurrence (
  item_id INTEGER NOT NULL,
  sha256  TEXT NOT NULL,
  loc     TEXT NOT NULL,
  PRIMARY KEY (item_id, sha256, loc)
);

CREATE TABLE purge_tombstone (
  scope_kind TEXT NOT NULL,
  scope_key  TEXT NOT NULL,
  created_at INTEGER,
  reason     TEXT,
  PRIMARY KEY (scope_kind, scope_key)
);

CREATE TABLE purge_log (
  id            INTEGER PRIMARY KEY,
  ts            INTEGER,
  scope         TEXT,
  docs_removed  INTEGER,
  blobs_removed INTEGER,
  verified      INTEGER
);

CREATE TABLE quarantine (
  q_id        INTEGER PRIMARY KEY,
  gen_key     TEXT,
  position    TEXT,
  reason      TEXT,
  raw_excerpt BLOB,
  seen_at     INTEGER
);
`;

export const INDEX_SCHEMA = `
CREATE TABLE proj_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE VIRTUAL TABLE fts USING fts5(
  text,
  text_stem,
  paths,
  content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2"
);

CREATE TABLE doc_attr (
  body_id   INTEGER PRIMARY KEY,
  src       TEXT,
  role      TEXT,
  ts_repr   INTEGER,
  truncated INTEGER
);

CREATE VIRTUAL TABLE path_lookup USING fts5(path_key, tokenize="trigram");

CREATE TABLE path_seen (path_key TEXT PRIMARY KEY);
`;
