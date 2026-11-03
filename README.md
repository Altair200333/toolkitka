# Toolkitka


## Human Lore

Solving few common issues when working with agents, 
- one is managing and automatically and efficiently routing session between claude accounts (and transfering live sessions to avoid hitting limits)
- the tool to see usage limits in claude/codex, i know everyone has vibecoded it already, and still made my own, native for windows :)
- chat history, when working in claude/codex/t3 its always needed to reference some of the past chats, sometimes pretty vaguely

So nothing crazy, but very light and efficient, robust and tested in hundreds of hours of work small tools to make daily life easier

## Slop Zone

**Three small Windows tools for living with coding agents: see your limits, switch Claude accounts automatically, and give the agent a memory longer than one chat.**

Coding agents are tireless, capable, and completely oblivious to their own rate limits. They burn through a 5-hour window without a word, stop mid-refactor when the quota hits zero, and by next week have no memory of what you agreed on today. `toolkitka` handles all three on your machine:

- **uzalka** sits in the system tray and shows how much of your Claude Code and Codex quota is used.
- **claude-router** wraps `claude.exe` and routes chats across your Claude accounts automatically.
- **chat-history-mcp** keeps a local searchable archive of your past chats so the agent can look things up itself.

```text
   ┌──────────┐    limits     ┌───────────────┐    the right account    ┌─────────────┐
   │  uzalka  │ ────────────▶ │ claude-router │ ──────────────────────▶ │ Claude Code │
   └──────────┘   127.0.0.1   └───────────────┘   (the chat moves too)  └─────────────┘
     tray icon                  drop-in claude.exe                              │
                                                                                │ chats on disk
                                                                                ▼
          "what did we decide about X last week?"                 ┌──────────────────┐
   any MCP client ──────────────────────────────────────────────▶ │ chat-history-mcp │
                                                                  └──────────────────┘
```

The tools are independent: use one, two, or all three. The router works best with `uzalka` running, but can query Claude Code for limits on its own.

---

## What each one does

### uzalka (the fuel gauge)

A native Windows tray app (Rust + Tauri 2, plain HTML/JS popup) that tracks your Claude Code and Codex limits so you don't learn about an empty tank halfway through a task.

- Scans `~/.claude*` and `~/.codex*` config folders automatically (extra paths can be added in Settings), deduplicating folders that point to the same account and organization.
- Reads local credentials (`.credentials.json`, `auth.json`), queries the provider's usage endpoint, and refreshes expired OAuth tokens the same way the official CLI does.
- Displays 5-hour, weekly, and per-model usage windows with reset times. The tray icon shows average weekly usage across accounts, colored by level, refreshing every 30 minutes or when you open the popup.
- Exposes the latest snapshot at `%APPDATA%\uzalka\usage.json` and over a key-protected local HTTP server on `127.0.0.1:8318` for `claude-router` and T3 Code's usage panel.
- Includes an IP geo-guard (`src-tauri/src/geo.rs`) that checks your public IP country before polling and pauses refreshes in unsupported regions or when the lookup fails.

### claude-router (the dispatcher)

A drop-in `claude.exe` wrapper that routes sessions across your Claude accounts. Your editor or CLI launches it like normal Claude Code; the router picks the best account, migrates the session transcript if needed, and spawns the real `claude.exe` with `CLAUDE_CONFIG_DIR` pointed at that account.

```text
your app ── starts "claude.exe" ──▶ claude-router
                                      1. reads account limits (from uzalka + live stream events)
                                      2. locates the newest copy of this chat
                                      3. picks an account and copies the transcript over if needed
                                      4. spawns the real claude.exe with CLAUDE_CONFIG_DIR set
                                      │
                                      ▼
                                   claude.exe  ◀── stdin/stdout passed through
```

- Routes new chats to the account whose weekly quota resets soonest (among accounts with at least 20% left), so expiring quota gets spent first.
- Keeps active chats on their current account while at least 10% remains (or until another account's weekly quota is within 6 hours of resetting), avoiding unnecessary prompt-cache misses on large contexts. Switches happen strictly between turns, never mid-answer.
- Supports an optional burn-rate strategy (`"strategy": "fable_spread"` in `router.json`) that tracks active threads and dollar spend per call, checking whether an account's 5-hour window can carry a new chat alongside the threads already running there.
- Copies session transcripts across account folders on switch, backing up overwritten files and refusing to overwrite any copy that has newer turns.
- Rewrites mid-turn rate-limit notices to "resets in 90 s" when another account has room, letting T3 Code's `autoResumeLimitedThreads` automatically resume the thread on the next account.
- Uses Windows Job Objects and handle inheritance rules so background shell commands (builds, long jobs) survive account switches without holding pipes open, while dead or logged-out accounts are skipped automatically.

### chat-history-mcp (the memory)

A local MCP server that archives and indexes your chats from Claude Code, Codex CLI, OpenCode, and T3 Code so agents can search past work (`"what did we decide about X last week?"`, `"where did this error come up before?"`).

- Reads app folders strictly read-only and stores its own copy in `~/.chat-history`, so sessions survive even if an app cleans up its own history. Nothing is deleted unless you explicitly run `chat_purge` with confirmation.
- Uses two SQLite databases (`archive.db` as the source of truth and a rebuildable FTS5 `index.db` with Russian and English morphology) plus zstd-compressed blob files for raw JSONL mirrors and long tool outputs.
- Indexes the head, tail, file paths, and error lines of large tool outputs while keeping the full body one call away via `chat_details` or regex scan (`chat_deep_search`).
- Runs an incremental background ingest on startup (coordinated across processes via a named Windows mutex) and supports zstd-compressed `VACUUM INTO` backups (4 daily, 3 monthly generations).
- Exposes `chat_search`, `chat_read`, `chat_details`, `chat_deep_search`, `chat_list`, `chat_status`, and `chat_purge`. Runs directly on Node.js 22.22.3+ using built-in `node:sqlite` and `node:zlib` with no build step.

Each folder has its own README with full configuration tables.

---

## Setup

> **Setting this up with an AI agent?** Point it at this section. Commands are PowerShell, and every numbered step starts and ends in the repository root. Run the **Check** block at the end of each step before moving on. Steps marked **[ask the human]** require a user choice or interactive login.

### 0. Prerequisites

Each tool is independent: `uzalka` needs Node and Rust, `claude-router` needs Rust and Claude Code, and `chat-history-mcp` needs only Node.

| Needed | For | Check | Notes |
|---|---|---|---|
| Windows 10/11 | all | | Windows-only (Job Objects, Registry, Win32 mutex) |
| Git | cloning | `git --version` | `winget install Git.Git` |
| Node.js >= 22.22.3 | uzalka, chat-history-mcp | `node -v` | Older 22.x lacks `node:sqlite` + zstd support |
| Rust (stable, MSVC) + VS C++ Build Tools | uzalka, claude-router | `cargo -V` | See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |
| WebView2 | uzalka | | Included with Windows 11 |
| Claude Code (native) | claude-router, MCP setup | `claude --version` | Default path: `%USERPROFILE%\.local\bin\claude.exe` |
| Codex CLI | optional | `codex --version` | |

**[ask the human]**

1. **Which tools** to install.
2. **Which Claude Code config folders** to use. Keep them in `%USERPROFILE%` named `.claude` or `.claude-<name>` (e.g. `~/.claude-work`) so `uzalka` and `chat-history-mcp` discover them automatically. Log into each folder and clear the variable afterward:
   ```powershell
   $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-work"; claude
   # run /login inside, exit, then clear the variable:
   Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
   ```
3. **Where the chat archive should live.** Defaults to `~/.chat-history` (backups in `~/.chat-history/backup`). If migrating an existing archive from another machine, copy it into place before starting.
4. **Whether they use T3 Code** (for wiring in the router and usage hub).

### 1. Clone

```powershell
git clone https://github.com/Altair200333/toolkitka
cd toolkitka
```

### 2. uzalka

```powershell
cd uzalka
npm ci
npx tauri build --no-bundle
Start-Process .\src-tauri\target\release\uzalka.exe
cd ..
```

Optional autostart with Windows (or toggle "Run Uzalka when Windows starts" in the tray popup Settings):

```powershell
New-ItemProperty -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name Uzalka -Value ('"' + (Resolve-Path .\uzalka\src-tauri\target\release\uzalka.exe) + '"') -Force
```

**Check** (wait a few seconds after launch for the first refresh):

```powershell
Invoke-RestMethod http://127.0.0.1:8318/healthz
(Get-Content -Raw -Encoding UTF8 $env:APPDATA\uzalka\usage.json | ConvertFrom-Json).accounts.Count
(Get-Content -Raw -Encoding UTF8 $env:APPDATA\uzalka\usage.json | ConvertFrom-Json).paused
```

- `healthz` returns `ok: True`.
- `accounts.Count` matches your logged-in config folders.
- `paused` should be empty (if it prints `"Refresh paused..."`, see `uzalka/src-tauri/src/geo.rs`).
- *Optional:* to show limits in T3 Code, go to T3 Settings -> Providers -> "Add a CLIProxyAPI hub" and paste the URL and key from Uzalka's Settings.

### 3. claude-router

```powershell
cd claude-router
cargo build --release
mkdir bin
copy target\release\claude-router.exe bin\claude.exe
copy router.example.json bin\router.json
cd ..
```

The binary in `bin\` must be named `claude.exe`. On later rebuilds, copy only the `.exe` so you don't overwrite your `bin\router.json`.

Edit `claude-router\bin\router.json`:
- `claude_exe`: full path to the real `claude.exe` (from `(Get-Command claude).Source`), never a `.cmd`/`.ps1` wrapper or the router itself.
- `accounts`: your config folders from step 0 (`name` + `config_dir`).
- `face_account`: one of the account `name`s above (used for `--version` and status checks).
- Optional: add `"strategy": "fable_spread"` to enable burn-rate routing (see `claude-router/README.md`).

**Check:**

```powershell
claude-router\bin\claude.exe --router-explain
claude-router\bin\claude.exe --version
```

### 3b. Wire the router into T3 Code **[ask the human]**

Skip if not using T3 Code. Otherwise, back up `%USERPROFILE%\.t3\userdata\settings.json` and merge a router entry into `providerInstances` alongside existing providers, plus `"autoResumeLimitedThreads": true` at the top level:

```json
{
  "providerInstances": {
    "claudeAgent_router": {
      "driver": "claudeAgent",
      "displayName": "claude auto",
      "enabled": true,
      "config": {
        "binaryPath": "C:/path/to/toolkitka/claude-router/bin/claude.exe",
        "homePath": "C:/Users/<you>/.claude"
      }
    }
  },
  "autoResumeLimitedThreads": true
}
```

Set `homePath` to the `face_account` folder. **Check:** "claude auto" appears in T3 Code's provider list.

### 4. chat-history-mcp

```powershell
cd chat-history-mcp
npm ci
cd ..
```

If using a custom archive path instead of `~/.chat-history`, set user environment variables and open a fresh terminal (and restart running clients so they pick them up):

```powershell
setx CHAT_ARCHIVE_DIR D:\chat-archive
setx CHAT_BACKUP_DIR E:\chat-archive-backup
```

Run the initial ingest once so the archive is populated before first use:

```powershell
cd chat-history-mcp
npm run ingest
cd ..
```

**Register with Claude Code** once per config folder from step 0 (drop the `-e` flags if using the default `~/.chat-history` path; if the user also runs plain `claude` without `CLAUDE_CONFIG_DIR`, run once more with `CLAUDE_CONFIG_DIR` unset):

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-work"; claude mcp add --scope user chat-history -e CHAT_ARCHIVE_DIR=D:/chat-archive -e CHAT_BACKUP_DIR=E:/chat-archive-backup -- node --no-warnings C:/path/to/toolkitka/chat-history-mcp/mcp/server.ts; Remove-Item Env:CLAUDE_CONFIG_DIR
```

**Register with Codex CLI** (optional) in `~/.codex/config.toml`:

```toml
[mcp_servers.chat-history]
command = "node"
args = ["--no-warnings", "C:/path/to/toolkitka/chat-history-mcp/mcp/server.ts"]
env = { CHAT_ARCHIVE_DIR = "D:/chat-archive", CHAT_BACKUP_DIR = "E:/chat-archive-backup" }
```

**Check** (for each config folder, plus archive status):

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-work"; claude mcp get chat-history; Remove-Item Env:CLAUDE_CONFIG_DIR
cd chat-history-mcp
node ops/cli.ts status
cd ..
```

*Optional daily backup task:* `node chat-history-mcp/ops/cli.ts install-task` prints a Windows Task Scheduler command for the human to review and run.

### 5. Final check

1. `Invoke-RestMethod http://127.0.0.1:8318/healthz` returns `ok: True`.
2. `claude-router\bin\claude.exe --router-explain` lists all accounts with live limits.
3. Start a chat through the router and ask the agent to call `chat_status`: it answers, and `claude-router\bin\state\router.log` records the chosen account.

---

## What lives where

None of these runtime files are tracked by git:

| What | Where |
|---|---|
| uzalka binary | `uzalka\src-tauri\target\release\uzalka.exe` |
| uzalka config & hub key | `%APPDATA%\uzalka\config.json` |
| latest limits snapshot | `%APPDATA%\uzalka\usage.json` |
| router binary, config, state | `claude-router\bin\claude.exe`, `router.json`, `state\` |
| chat archive | `~/.chat-history` (or `CHAT_ARCHIVE_DIR`) |
| MCP registrations | `<config folder>\.claude.json`, `~/.claude.json`, `~/.codex/config.toml` |
| autostart entry | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (`Uzalka`) |

## License

MIT, see [LICENSE](LICENSE).
