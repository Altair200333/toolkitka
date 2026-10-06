# claude-router

A drop-in `claude.exe` that switches between your Claude accounts automatically.
Your app (T3 Code, a terminal, a script) starts it exactly like Claude Code. The router decides which
account should run this chat, then starts the real `claude.exe` with the same arguments.

```text
your app ── starts "claude.exe" ──▶ claude-router
                                      1. limits of every account (Uzalka, or Claude Code itself)
                                      2. where the newest copy of this chat lives
                                      3. picks an account, copies the chat there if needed
                                      4. runs the real claude.exe with CLAUDE_CONFIG_DIR = that account
                                      │
                                      ▼
                                   claude.exe  ◀── stdin/stdout passed through byte for byte
```

## What it does

- **New chat** goes to the account whose weekly limit resets soonest (among accounts with at least
  `new_chat_min_percent` left), so that quota is not wasted.
- **A running thread stays on its account** while it has `switch_below_percent` or more left: moving
  costs a cache miss. "Left" is the smallest of the 5-hour, weekly and current-model weekly windows.
- **Switching happens between turns, never mid-answer.** After a turn ends the router checks the
  limits. If another account is clearly better, it lets this `claude.exe` exit, and the next message
  starts on the other account with the chat copied over.
- **The chat is copied, not moved.** The newest copy wins. A copy that has turns the newest one lacks
  is never overwritten; the router stays where it is instead. Overwritten copies are backed up.
- **Hit a limit mid-turn?** If another account has quota, the router tells the app "resets in 90 s"
  instead of the real reset time.
  T3 Code with auto-resume of rate-limited threads (`autoResumeLimitedThreads`) then continues the
  thread by itself, on another account.
- **Background work.** Background shell commands (builds, long jobs) survive the switch; the next
  start tells the model which background agents were interrupted and where command output went.
- **Broken login.** An account whose login is gone (no refresh token) is skipped while another
  account can serve; passing auth errors keep an account out for 10 minutes. A thread that sits on a
  dead account moves away and the model asks you to `/login` there.
- **Nested `claude`** started from inside a chat goes through the router too (`route_nested`).

## Setup

Windows only (it uses Job Objects to keep child processes in check).

```powershell
cargo build --release
mkdir bin
copy target\release\claude-router.exe bin\claude.exe     # the name must be claude.exe
copy router.example.json bin\router.json                  # then edit it
bin\claude.exe --router-explain                           # which account it would pick and why
```

Then point your app at `bin\claude.exe` instead of Claude Code's own `claude.exe`
(T3 Code: the Claude provider's binary path).

## Config: `bin\router.json`

| Key | Meaning |
|---|---|
| `claude_exe` | the real Claude Code `claude.exe` |
| `usage_json` | Uzalka's snapshot (`%APPDATA%\uzalka\usage.json`); Uzalka's local endpoint is found next to it |
| `accounts[]` | `name` and `config_dir` (a Claude Code config folder with its own login). Optional `only_paths` / `exclude_paths` limit an account to some project folders |
| `face_account` | account used for `--version` and the app's status checks |
| `new_chat_min_percent` | a new chat goes only to an account with at least this much left (20) |
| `switch_below_percent` | a thread looks for another account below this (10) |
| `burn_soon_hours` | move to an account whose unused weekly quota resets within this many hours (6) |
| `leave_with_tasks_below_percent` | below this, leave even with background agents running (2) |
| `fresh_minutes` / `max_snapshot_age_minutes` | how old limit data may be before it is asked again / ignored |
| `route_nested` | route `claude` started from inside a chat |

`%VAR%` in paths is expanded. The router reads the config on every start, so edits apply to the next
start without rebuilding.

## Files

Next to the exe: `router.json` and `state\` (`router.log` with every decision, live limits, which
thread is on which account, interrupted background tasks, backups of overwritten chat copies).

## Tests

```powershell
cargo test --release                                  # unit tests
cargo build --release --example fake_claude
node e2e/drive.mjs [scenario ...]                     # end to end against a fake claude.exe, no quota spent
node e2e/summary.mjs < result.json
```
