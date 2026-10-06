# toolkitka

**Three small Windows tools for living with coding agents: see your limits, switch Claude accounts
automatically, and give the agent a memory longer than one chat.**

Coding agents are brilliant, tireless and a little forgetful. They don't mention how much quota is
left until it is gone, they stop mid-sentence when it runs out, and next week they have no idea what
you agreed on today. toolkitka takes the edge off all three, on your own machine:

- **uzalka** shows how much of your Claude Code and Codex limits is used.
- **claude-router** switches between your Claude accounts automatically, so you rarely meet a limit
  the hard way.
- **chat-history-mcp** keeps a searchable archive of your chats, so the agent can look things up
  instead of asking you.

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

The tools are independent: take one, two or all three. The router works best with uzalka running,
but can ask Claude Code for the limits itself.

---

## What each one does

### uzalka — the fuel gauge

A tray icon that shows how much of your limits is used, so you learn it from a glance and not from
an agent that stops halfway through a refactor.

- Finds every Claude Code and Codex config folder in your home (`~/.claude*`, `~/.codex*`). More
  folders can be added by path. The same login found in two folders is shown once.
- Reads the local login (`.credentials.json`, `auth.json`) and asks the provider's own usage
  endpoint. An expired token is refreshed the way the CLI does it and saved back.
- Shows usage and reset times for the 5-hour, weekly and per-model limits. The icon shows the
  average weekly usage across your accounts; its color tells the level.
- Refreshes every 30 minutes. Opening the popup refreshes too, at most once a minute.
- Shares what it knows: `%APPDATA%\uzalka\usage.json` and a small key-protected HTTP endpoint on
  `127.0.0.1:8318`. The router reads it, and T3 Code can show the same limits in its usage panel.
- Geo guard: it checks the country of your public IP first and skips the refresh in blocked
  countries (`src-tauri/src/geo.rs`) or when the country can't be determined.
- Tauri 2: a Rust backend and a plain HTML/JS popup, no frontend build.

### claude-router — the dispatcher

A drop-in `claude.exe` that switches between your Claude accounts automatically. Your app starts it
the way it would start Claude Code. The router picks the account that should run this chat, then
starts the real `claude.exe` with the same arguments.

```text
your app ── starts "claude.exe" ──▶ claude-router
                                      1. reads the limits of every account
                                      2. finds the newest copy of this chat
                                      3. picks an account, copies the chat there if needed
                                      4. runs the real claude.exe with CLAUDE_CONFIG_DIR
                                         set to that account's config folder
                                      │
                                      ▼
                                   claude.exe  ◀── stdin/stdout passed through
```

- **New chats** go to the account whose weekly quota resets soonest, among those with at least 20%
  left. Use it or lose it.
- **A running chat stays put** while its account has at least 10% left, because moving costs a
  prompt-cache miss. The one exception: another account's unused weekly quota is about to reset
  (within 6 hours), so the miss is paid from quota that would be lost anyway. Either way, it moves
  only between turns, never in the middle of an answer. All these numbers live in the config.
- **Moving is copying.** The chat transcript is copied into the other account's folder. The newest
  copy wins; a copy with turns the newest one lacks is never overwritten; overwritten copies are
  backed up.
- **A limit in the middle of a turn.** If another account has quota, the router tells the app
  "resets in 90 s" instead of the real reset time. T3 Code with auto-resume of rate-limited threads
  then continues the chat by itself, on the other account.
- **Background work.** Background shell commands survive a switch. Background agents that were cut
  off are reported to the model on the next start.
- **Missing logins.** An account whose login is gone (no refresh token) is skipped while another
  account can serve.
- **Under the hood.** Claude Code's output is passed on byte for byte; the router only reads it to
  notice limits, account errors and background tasks, and adds a line of its own when it needs to
  (like the 90-second notice). Windows Job Objects keep child processes together. The router's
  folder goes first on the child's `PATH`, so a `claude` started from inside a chat comes back
  through the router. The config is re-read on every start; every decision goes to
  `state\router.log`.

### chat-history-mcp — the memory

An MCP server that keeps a local archive of your Claude Code, Codex CLI, OpenCode and T3 Code chats,
so the agent can answer "what did we decide about X last week?" or "where have I seen this error
before?".

- **Never writes to the apps' folders.** It keeps its own copy, so chats survive even when an app
  deletes old sessions. A chat leaves the archive only through `chat_purge`, which first shows what
  it would delete and needs a second, confirming call.
- **Two SQLite files.** `archive.db` is the source of truth. `index.db` is a full-text index (FTS5)
  with Russian and English word forms; it can be thrown away and rebuilt.
- **Long tool outputs.** The index keeps the beginning and the end of a long output, plus file paths
  and error lines. The full text is stored in zstd-compressed files and is one tool call away
  (`chat_details`, or a regex scan with `chat_deep_search`).
- **Raw mirror.** New bytes of every Claude Code and Codex JSONL file are saved before parsing, so
  the archive can be re-parsed later, even after the app has deleted the original.
- **Incremental.** Every server start runs a background ingest that reads what is new since the last
  one. A named Windows mutex lets only one process write at a time; any number can read.
- **Backups.** `VACUUM INTO` + integrity check + zstd, 4 daily and 3 monthly generations.
- **Tools:** `chat_search`, `chat_read`, `chat_details`, `chat_deep_search`, `chat_list`,
  `chat_status`, `chat_purge`. Tool descriptions are in Russian for now; queries work in both
  languages.
- Node.js 22.22.3 or newer runs the TypeScript directly, with `node:sqlite` and zstd from
  `node:zlib`. No build step.

Each folder has its own README with every setting.

---

## Setup

> **Setting this up with an AI agent?** Point it at this section. It is written to be followed from
> top to bottom. Commands are PowerShell. Every step starts and ends in the repository root. Most
> steps end with a **Check**; do not go on until it passes. Steps marked **[ask the human]** need a
> decision or a login that only the human can give.

### 0. Before you start

**Only want some of the tools?** Each one is a separate step below; skip the rest. uzalka needs Node
and Rust, claude-router needs Rust and Claude Code, chat-history-mcp needs only Node.

| Needed | For | Check | How to get it |
|---|---|---|---|
| Windows 10 or 11 | all | | all three tools are Windows-only |
| Git | cloning | `git --version` | `winget install Git.Git` |
| Node.js 22.22.3 or newer | uzalka (build), chat-history-mcp | `node -v` | `winget install OpenJS.NodeJS.LTS` or nvm-windows. An older 22.x will not do: the MCP needs `node:sqlite` with zstd. Developed on 22.23. |
| Rust (stable, MSVC) and Visual Studio Build Tools with "Desktop development with C++" | uzalka, claude-router | `cargo -V` | the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) page walks through both |
| WebView2 | uzalka | | ships with Windows 11; the Tauri page covers Windows 10 |
| Claude Code, native installer | claude-router, registering the MCP | `claude --version` | Claude Code's setup docs; it lands in `%USERPROFILE%\.local\bin\claude.exe` |
| Codex CLI | optional | `codex --version` | |

**[ask the human]**

1. **Which tools** to set up.
2. **Which Claude Code config folders** to use. Each folder holds its own login: `~/.claude` is the
   default, others are used through `CLAUDE_CONFIG_DIR`. Keep them in the home folder and name them
   `.claude` or `.claude-<name>` (for example `~/.claude-work`): that is how uzalka and
   chat-history-mcp find them. A folder anywhere else must be added by hand: in uzalka's Settings
   under "Add config path", and for the MCP through `CHAT_SOURCE_ROOTS_JSON` (careful: that variable
   replaces the whole source list, see `chat-history-mcp/README.md`).

   Every folder must be logged in, with the variable set to it:

   ```powershell
   $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-work"; claude
   ```

   Type `/login` inside, exit, then run `Remove-Item Env:CLAUDE_CONFIG_DIR`. A `$env:` variable
   stays set for the rest of the PowerShell session, so clear it every time. Otherwise the next
   command quietly runs against the same folder.
3. **Where the chat archive should live.** The default is `~/.chat-history`; a roomy disk is better.
   If there is an archive from another machine, copy that folder over now, before anything starts.
4. **Whether they use T3 Code.** That is where the router gets wired in.

### 1. Clone

```powershell
git clone https://github.com/Altair200333/toolkitka
cd toolkitka
```

From here on, "the repository root" is this `toolkitka` folder.

### 2. uzalka

```powershell
cd uzalka
npm ci
npx tauri build --no-bundle
Start-Process .\src-tauri\target\release\uzalka.exe
cd ..
```

The first build takes a few minutes and about 1.5 GB of disk (the Rust build cache in
`src-tauri\target`).

Start with Windows: click the tray icon, then the gear icon (Settings), and next to "Run Uzalka when
Windows starts" press **Add to startup**. It writes this registry value, which you can also set
yourself:

```powershell
New-ItemProperty -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Run -Name Uzalka -Value ('"' + (Resolve-Path .\uzalka\src-tauri\target\release\uzalka.exe) + '"') -Force
```

**Check.** Give it a few seconds after the start: `usage.json` appears after the first refresh.

```powershell
Invoke-RestMethod http://127.0.0.1:8318/healthz
(Get-Content -Raw -Encoding UTF8 $env:APPDATA\uzalka\usage.json | ConvertFrom-Json).accounts.Count
(Get-Content -Raw -Encoding UTF8 $env:APPDATA\uzalka\usage.json | ConvertFrom-Json).paused
```

- The first shows `True` in the `ok` column.
- The second is how many accounts it found. It should be at least the number of folders from
  step 0 (Codex folders and older Claude folders count too; the same login in two folders counts
  once).
- The third should print nothing. If it prints "Refresh paused — …", the geo guard stopped the
  refresh (`uzalka/src-tauri/src/geo.rs`).

**Optional, the T3 Code usage panel.** T3 can show the same limits: in T3, Settings → Providers →
"Add a CLIProxyAPI hub". The URL and the key are in uzalka's Settings, under "T3 Code hub".

### 3. claude-router

```powershell
cd claude-router
cargo build --release
mkdir bin
copy target\release\claude-router.exe bin\claude.exe
copy router.example.json bin\router.json
cd ..
```

The exe must be named `claude.exe`: that is the name apps look for. `bin\` is ignored by git, so your
real config and the router's state stay out of the repository. On a later rebuild, copy only the exe:
copying `router.example.json` again would overwrite your config.

Edit `claude-router\bin\router.json`:

- `claude_exe` — the real Claude Code `claude.exe` (the native installer puts it in
  `%USERPROFILE%\.local\bin\claude.exe`). `(Get-Command claude).Source` helps find it. Point at the
  `.exe` itself, not at a `.cmd` or `.ps1` wrapper, and never at the router.
- `accounts` — one entry per config folder from step 0. `name` is any label; it shows up in the log.
- `face_account` — the account used for `--version` and the app's status checks. It must be one of
  the `name`s above (the example's `personal` and `work` are placeholders).
- The thresholds can stay as they are. The full table is in `claude-router/README.md`.

**Check:**

```powershell
claude-router\bin\claude.exe --router-explain
claude-router\bin\claude.exe --version
```

The first lists every account with its limits and says which one it would pick, and why. The second
prints Claude Code's own version.

### 3b. Wire the router into T3 Code **[ask the human]**

Skip this if they don't use T3 Code. Any other app works too, as long as it lets you choose the
`claude` binary: point it at `claude-router\bin\claude.exe`.

Back up `%USERPROFILE%\.t3\userdata\settings.json` first. Then add one more entry inside
`providerInstances`, next to the ones already there, and turn on auto-resume at the top level. Keep
everything else in the file as it is. T3 picks up edits to this file without a restart.

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

`homePath` is the folder of the `face_account`. **Check:** "claude auto" shows up among T3's
providers; step 5 tests it for real.

### 4. chat-history-mcp

```powershell
cd chat-history-mcp
npm ci
cd ..
```

**Archive location.** Skip this if the default `~/.chat-history` is fine (backups then go to
`~/.chat-history/backup`). Otherwise every process must see the same paths, so set them for the user.
The drive letters are examples; a backup on another disk is nice but optional.

```powershell
setx CHAT_ARCHIVE_DIR D:\chat-archive
setx CHAT_BACKUP_DIR E:\chat-archive-backup
```

`setx` only reaches programs started after it. Open a new terminal and go back to the repository
root. Apps that are already running (T3 Code, open Claude Code or Codex sessions) keep the old
values until they restart, which is why the registrations below pass the same values once more.

**Build the archive once.** On a long history this takes a while, and until it is done the tools
have nothing to answer from.

```powershell
cd chat-history-mcp
npm run ingest
cd ..
```

**Register with Claude Code.** Claude Code keeps its MCP list per config folder, in that folder's
`.claude.json`. Run this once for every folder from step 0, `~/.claude` included: the router always
starts Claude Code with `CLAUDE_CONFIG_DIR` set, even for the default folder. Use the full path with
forward slashes.

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-work"; claude mcp add --scope user chat-history -e CHAT_ARCHIVE_DIR=D:/chat-archive -e CHAT_BACKUP_DIR=E:/chat-archive-backup -- node --no-warnings C:/path/to/toolkitka/chat-history-mcp/mcp/server.ts; Remove-Item Env:CLAUDE_CONFIG_DIR
```

- Kept the default archive? Drop both `-e` parts, here and in the Codex block below.
- If the `node` on `PATH` is older than 22.22.3, put the full path to a newer `node.exe` instead of
  `node`.
- If the human also runs a plain `claude` with no `CLAUDE_CONFIG_DIR` at all, register once more with
  the variable cleared. That one goes to `~/.claude.json`, next to the folder rather than inside it.

**Register with Codex CLI** (optional), in `~/.codex/config.toml`. If a `[mcp_servers.chat-history]`
table is already there, edit it instead of adding a second one.

```toml
[mcp_servers.chat-history]
command = "node"
args = ["--no-warnings", "C:/path/to/toolkitka/chat-history-mcp/mcp/server.ts"]
env = { CHAT_ARCHIVE_DIR = "D:/chat-archive", CHAT_BACKUP_DIR = "E:/chat-archive-backup" }
```

**Check**, once for every config folder:

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-work"; claude mcp get chat-history; Remove-Item Env:CLAUDE_CONFIG_DIR
```

It should say the server is connected. Then the archive itself:

```powershell
cd chat-history-mcp
node ops/cli.ts status
cd ..
```

**Optional, a daily ingest and backup.** This prints a Task Scheduler command; it does not run it.
Show it to the human and let them decide.

```powershell
cd chat-history-mcp
node ops/cli.ts install-task
cd ..
```

### 5. All together

1. `Invoke-RestMethod http://127.0.0.1:8318/healthz` shows `True` in the `ok` column.
2. `claude-router\bin\claude.exe --router-explain` lists every account with fresh limits.
3. Start a new chat through the router (in T3 Code with the "claude auto" provider, or by running
   `claude-router\bin\claude.exe` in a terminal) and ask the agent to call `chat_status`. The chat
   answers, and `claude-router\bin\state\router.log` has a fresh line with the account it picked.

---

## What lives where

None of this is tracked by git.

| What | Where |
|---|---|
| uzalka exe | `uzalka\src-tauri\target\release\uzalka.exe` |
| uzalka settings and hub key | `%APPDATA%\uzalka\config.json` (created on first start) |
| latest limits | `%APPDATA%\uzalka\usage.json` |
| router exe, config, state | `claude-router\bin\claude.exe`, `router.json`, `state\` |
| chat archive | `~/.chat-history`, or `CHAT_ARCHIVE_DIR` |
| MCP registrations | `<config folder>\.claude.json` (or `~/.claude.json` for a plain `claude` without `CLAUDE_CONFIG_DIR`), and `~/.codex/config.toml` |
| autostart | registry `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `Uzalka` |

## License

MIT, see [LICENSE](LICENSE).
