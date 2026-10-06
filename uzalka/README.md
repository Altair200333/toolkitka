# uzalka

A tray app that shows how much of your Claude Code and Codex limits is used.

- Finds every Claude Code and Codex config folder in your home (`~/.claude*`, `~/.codex*`);
  more folders can be added by path in Settings. The same login found in two folders is shown once.
- Shows the 5-hour, weekly and per-model windows with their reset times.
- The tray icon shows the average weekly usage across your accounts, colored by level.
- Refreshes every 30 minutes and when you open the popup (at most once a minute).
- Starts with Windows if you turn it on in Settings.

## How it reads the limits

For each folder it takes the local login (`.credentials.json` for Claude Code, `auth.json` for Codex)
and asks the provider's own usage endpoint. If the access token has expired, it refreshes it the
way the CLI does and saves it back to the same file. Apart from the geo check below, nothing is
sent anywhere else.

Geo guard: before calling the provider it looks up the country of your public IP (a few public
IP/geo services) and skips the refresh in blocked countries (list in `src-tauri/src/geo.rs`), or when
the country can't be determined, so accounts are not flagged by accident.

## Data for other tools

- `%APPDATA%\uzalka\usage.json` — the latest snapshot of all accounts (`schema_version: 1`).
- A local HTTP endpoint on `127.0.0.1:8318`, protected by a key (`hub` in Uzalka's `config.json`,
  the key is generated on first start):
  - `GET /v0/router/usage?max_age_ms=300000` — the snapshot, refreshed first if older than that.
    [`claude-router`](../claude-router/) uses it.
  - `GET /v0/management/auth-files`, `POST /v0/management/api-call`, `POST /v0/management/reset-quota` —
    lets T3 Code show these limits in its usage panel (Settings → Providers → "Add a CLIProxyAPI hub";
    the URL and key are in Uzalka's Settings view).

## Build

Needs Node and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) (Rust, WebView2).

```powershell
npm ci
npx tauri build --no-bundle    # -> src-tauri\target\release\uzalka.exe
npx tauri build                # same plus an NSIS installer
```
