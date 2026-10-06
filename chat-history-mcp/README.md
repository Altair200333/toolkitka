# chat-history-mcp

An MCP server that keeps a local archive of your coding-agent chats and lets the agent search it:
"what did we decide about X last week?", "where did I see this error before?".

- Reads chats of **Claude Code**, **Codex CLI**, **OpenCode** and **T3 Code**. Read-only: it never
  writes to their folders.
- Keeps everything in its own SQLite archive. Nothing is dropped when an app deletes old sessions;
  only `chat_purge` removes a chat.
- Full-text search (SQLite FTS5) with Russian and English word forms, plus a substring/regex scan
  over full tool outputs.
- Runs locally; nothing is sent anywhere.

## Sources

| App | Read from | `rootId` |
|---|---|---|
| Claude Code | `~/.claude/projects` and `~/.claude-<name>/projects` — every extra config folder in your home (for example one used with `CLAUDE_CONFIG_DIR`) | `claude:main`, `claude:<name>` |
| Codex CLI | `~/.codex/sessions`, `~/.codex/archived_sessions` (+ `state_5.sqlite` for thread info) | `codex:main` |
| OpenCode | `~/.local/share/opencode` (`opencode.db`, its `.bak` copies, the older `storage/` JSON) | `opencode:live` |
| T3 Code | `~/.t3/userdata/state.sqlite` | `t3:state` |

Apps that are not installed are simply skipped. For other locations set `CHAT_SOURCE_ROOTS_JSON`.

## Tools

| Tool | What it does |
|---|---|
| `chat_search` | Full-text search over all chats. Filters: `src` (app), `role`, `after` / `before`, `project` (part of the working dir), `tool`, `branch`, `sort`, `k`, `cursor`. Returns short cards with `p:<message id>` and `c:<chat id>`. |
| `chat_read` | Reads one chat page by page: user and assistant text plus metadata. Tool bodies and reasoning are not expanded here. |
| `chat_details` | Full bodies by `p:<id>`: tool outputs (including the parts cut from the index), reasoning, tool calls. Up to 20 ids, `max_chars` (default 20000). |
| `chat_deep_search` | Substring or regex scan over full tool outputs, including the middles the index does not see. Newest first, 30 s budget, at most 2 scans at a time; narrow it with `chat` / `after` / `before`. |
| `chat_list` | Chat cards, newest first. Filters: app, project, date, title substring. |
| `chat_status` | Freshness per source, writer heartbeat, store sizes, parse errors and quarantine. |
| `chat_purge` | Deletes one chat forever: archive, index, raw and blob copies, every backup generation; a tombstone keeps it from coming back. The first call only shows what will be deleted; it runs only when called again with `confirm` set to the chat id. |

Tool descriptions and answers are currently written in Russian. Queries work in Russian and English;
file paths can be typed as is.

## Requirements

- Windows 10/11. The single-writer lock is a named Windows mutex.
- Node.js 22.22.3 or newer. The TypeScript runs directly, with the built-in `node:sqlite` and zstd
  from `node:zlib`; no build step.

## Install

```powershell
cd chat-history-mcp
npm ci
npm run ingest    # optional: build the archive once before the first use
```

Every server start runs an ingest in the background. On a large history the first one takes a
while, and until it finishes the tools have no archive to answer from — hence `npm run ingest`.

### Claude Code

```powershell
claude mcp add --scope user chat-history -- node --no-warnings C:/path/to/chat-history-mcp/mcp/server.ts
```

Environment variables go after the name: `claude mcp add --scope user chat-history -e CHAT_ARCHIVE_DIR=D:/chat-archive -- node ...`

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.chat-history]
command = "node"
args = ["--no-warnings", "C:/path/to/chat-history-mcp/mcp/server.ts"]
# env = { CHAT_ARCHIVE_DIR = "D:/chat-archive" }
```

Every client starts its own server process. They all share one archive, and only one process
writes to it at a time.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CHAT_ARCHIVE_DIR` | `~/.chat-history` | Where the archive lives. |
| `CHAT_BACKUP_DIR` | `<archive dir>/backup` | Backup generations and copies of `raw/` and `blobs/`. Better on another disk. |
| `CHAT_SOURCE_ROOTS_JSON` | discovered automatically | Replaces the whole source list, e.g. `[{"rootId":"claude:main","app":"claude","rootPath":"C:/Users/me/.claude","label":"Claude Code (main)"}]`. `app` is `claude`, `codex`, `opencode` or `t3`. Keep each `rootId` stable: the archive keys data by it. |
| `CHAT_MUTEX_NAME` | `Global\chat-history-mcp-writer` | Name of the writer lock. Change it only to isolate a test archive. |

If you change `CHAT_ARCHIVE_DIR` or `CHAT_BACKUP_DIR`, every process must see the same values:
the MCP servers, `node ops/cli.ts` and a scheduled task. The simplest way is user environment
variables (`setx CHAT_ARCHIVE_DIR D:\chat-archive`, then restart the clients); setting them only in
an MCP registration leaves the CLI and the scheduled task on the default `~/.chat-history`.

## Where the data lives

```text
~/.chat-history/
  archive.db   the archive: chats, messages, texts, read cursors, quarantine, purge log
  index.db     the search index (FTS5); can be thrown away and rebuilt from archive.db
  raw/         zstd copies of the source JSONL bytes, written before parsing
  blobs/       zstd frames with full bodies of long tool outputs
  backup/      backup generations, unless CHAT_BACKUP_DIR points elsewhere
```

## How it works

```text
server start --spawn, low priority--> ops/cli.ts ingest   (one writer at a time: named mutex)
                                           |
source files --read only--> raw/ copy --> reader --> archive.db --> index.db (FTS5)
                                                         |
chat_search  ------------------------------------- index.db + archive.db
chat_read / chat_details / chat_deep_search ------ archive.db + blobs/
```

- **Incremental.** Every source file or table has a cursor; an ingest reads only what was added
  since the last one. A file whose first 1 KB changed is read again from the start.
- **archive.db vs index.db.** `archive.db` is the source of truth (SQLite, WAL, `synchronous=FULL`).
  `index.db` is a projection of it for search, bound to the archive's id; `node ops/cli.ts rebuild`
  recreates it from scratch.
- **Long tool outputs.** Outputs over 6 KB are indexed as the first 4 KB + the last 2 KB + file
  paths + error lines. The full text goes into zstd frames (~256 KB each) in `blobs/`;
  `chat_details` and `chat_deep_search` read it from there.
- **Raw mirror.** New bytes of every Claude Code and Codex JSONL file are appended to `raw/` as zstd
  frames before they are parsed, so the archive can be re-parsed later, even after the app has
  deleted the original.
- **Bad records** go to quarantine (counted in `chat_status`) and never stop an ingest.
- **Branches.** Messages left on an abandoned branch of a chat stay searchable and are marked.

## Command line

```text
node ops/cli.ts ingest [--root=<rootId>] [--backup]   read new data from the sources (then back up)
node ops/cli.ts status                                freshness, counts, sizes, recent purges
node ops/cli.ts search <query>                        the same search as chat_search
node ops/cli.ts read <chat-id>                        print a chat
node ops/cli.ts rebuild                               recreate index.db from archive.db
node ops/cli.ts backup                                new backup generation + copy of raw/ and blobs/
node ops/cli.ts purge c:<id> [--yes] [--reason=...]   delete a chat forever (preview without --yes)
node ops/cli.ts install-task                          print a Task Scheduler command for a daily ingest + backup
```

`install-task` only prints the command; you run it yourself. A backup is `VACUUM INTO` +
`integrity_check` + zstd; it keeps 4 daily and 3 monthly generations. To restore:
`zstd -d gen-YYYYMMDD.db.zst`, put the result in place of `archive.db`, run `node ops/cli.ts rebuild`.

## Tests

```powershell
npm test
```

By default the tests use temp folders and generated chats only, even if `CHAT_ARCHIVE_DIR` is set.
`CHAT_SMOKE=1` turns on the real-data tests:

- they read your real Codex, OpenCode and T3 Code stores end to end (read-only);
  `CODEX_SMOKE_SAMPLE=<n>` reads only every n-th Codex file;
- if `CHAT_ARCHIVE_DIR` is set too, the MCP and token-budget tests use that archive instead of a
  generated one, and the server they start runs its usual ingest from your sources into it.

## License

MIT
