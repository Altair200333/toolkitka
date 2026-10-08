//! claude-router: T3 Code starts this instead of claude.exe.
//!
//! It picks a Claude account (spend first the weekly quota that resets first; Uzalka snapshot,
//! refreshed on demand through Uzalka's local hub, usage requests to claude.exe for what Uzalka
//! cannot answer, and the live `rate_limit_event` data claude.exe reports on every request),
//! copies the session transcript into that account if the thread
//! lived in another one, and runs the real claude.exe with the same arguments and
//! `CLAUDE_CONFIG_DIR` set to that account. stdin/stdout are passed through byte for byte; stdout
//! is only read to notice rate limits, account errors, background tasks and models in use.
//!
//! The router's own folder goes first on the PATH of the claude.exe it starts, and the router is
//! named claude.exe there: a `claude` started from inside a chat comes back through the router.
//!
//! Files next to the exe: `router.json` (config) and `state/` (log, live quota, usage answers,
//! session map, live threads, interrupted background tasks, test switches `force-account.txt` and
//! `switch-after-turn`, backups of overwritten copies).
//!
//! With `"strategy": "fable_spread"` in router.json the account is chosen by `strategy`;
//! the list of live threads and what they spend is kept either way.

mod strategy;

use serde_json::{json, Value};
use strategy::{Acc, Burn, Kind, Plan, Thread, Turn, World};
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const AUTH_ERRORS: [&str; 6] = ["signed out", "login expired", "token rejected", "refresh failed", "credentials:", "run /login"];
/// `error` values claude puts on an assistant message when this account cannot serve requests.
/// Network and server trouble (`overloaded`, `server_error`, `connection_error`) is not here:
/// another account would not help with it.
const ACCOUNT_ERRORS: [&str; 5] = ["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error"];
/// An account error seen in a chat keeps the account out of new choices this long. Such errors
/// are often passing: "403 Request not allowed" usually goes away within minutes, and "Not logged
/// in" has been seen to last about 10 min. A login that died for good shows in `.credentials.json`
/// instead (see `login_dead`).
const AUTH_BLOCK_MS: u64 = 10 * 60_000;
/// Models a thread used (agents included) count for its account choice this long.
const MODEL_MEMORY_MS: u64 = 24 * 3_600_000;
const WEEK_MS: u64 = 7 * 86_400_000;
const MOVE_MARGIN_PERCENT: f64 = 5.0;
/// Below this the margin rule no longer keeps a session where it is: the next request would fail.
const MARGIN_FLOOR_PERCENT: f64 = 2.0;
/// After deciding to switch, wait this long for T3 to send a queued or quick follow-up message;
/// if one comes, it goes to the running claude.exe and the switch waits for the next turn.
/// T3 sends a queued message only after its post-turn checkpoint: 4-5 s in a small repo.
const LEAVE_GRACE: Duration = Duration::from_secs(30);
/// After a turn the API refused, wait this long for T3's queued message and let it through:
/// it fails with the real reason, where a closed input would make T3 report a broken pipe.
const BLOCKED_GRACE: Duration = Duration::from_secs(8);
/// When a refused turn can go on on another account, T3 is told the limit resets this many seconds
/// from now: its own auto-resume ("Continue where you left off.") then restarts the thread, and
/// the restart comes through the router to the other account. T3 checks every 5 s.
const RESUME_AFTER_S: u64 = 90;
/// After such a promise claude's input stays open until this long before the promised time (a
/// message T3 queued still gets through), and the router is gone this long before it.
const PROMISE_CLOSE_BEFORE: Duration = Duration::from_secs(50);
const PROMISE_EXIT_BEFORE: Duration = Duration::from_secs(20);
/// A refusal stands until a reading taken at least this long after it shows room: a refresh right
/// after the refusal may still round 99.6% down, and a request that left before it may come back
/// allowed.
const LIFT_AFTER_MS: u64 = 5 * 60_000;
/// How long a usage request to claude.exe may take, and how often it is repeated while claude
/// says "no login": right after start it sometimes answers before it has read its login.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_ATTEMPTS: u32 = 4;
/// Uzalka refreshes all its accounts in about 4 s. A hung one must not hold every start, and the
/// end of a refused turn, for long: after this the router asks claude.exe itself.
const UZALKA_TIMEOUT: Duration = Duration::from_secs(15);
/// Set on every claude.exe the router starts, to the account it was given. A nested call whose
/// `CLAUDE_CONFIG_DIR` still equals it inherited the account; a different one was chosen by the caller.
const MARK_VAR: &str = "CLAUDE_ROUTER_CONFIG_DIR";
const CREDENTIAL_VARS: [&str; 3] = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
/// $ of limit cost per 1% of the 5-hour window, the week and the Fable week (measured on recorded threads).
const DOLLARS_PER_PERCENT: [f64; 3] = [1.75, 11.2, 4.2];
/// A running thread writes what it spent to the list of live threads at most this often.
const SAVE_EVERY_MS: u64 = 15_000;
/// A message id is remembered this long after its last block, so its repeated usage is not counted twice.
const COUNTED_MS: u64 = 10 * 60_000;

struct Account {
    name: String,
    config_dir: PathBuf,
    only_paths: Vec<String>,
    exclude_paths: Vec<String>,
    /// $ of limit cost in a whole 5-hour window, week and Fable week (`dollars_per_percent` in router.json).
    cap: [f64; 3],
}

struct Config {
    claude_exe: PathBuf,
    usage_json: PathBuf,
    max_snapshot_age_minutes: f64,
    /// Usage data older than this is asked again from claude.exe before a decision.
    fresh_minutes: f64,
    switch_below_percent: f64,
    /// A new chat starts only on an account with at least this much left, if there is one.
    new_chat_min_percent: f64,
    /// A thread moves to an account whose weekly quota resets within this many hours.
    burn_soon_hours: f64,
    /// Background tasks hold a thread on its account until quota drops below this.
    leave_with_tasks_below_percent: f64,
    /// The account T3's status check shows (email, plan); `None`: chosen like any start.
    face_account: Option<usize>,
    route_nested: bool,
    /// "fable_spread" in router.json: accounts are chosen by `strategy`; otherwise by `choose`.
    strategy: bool,
    /// A new claude -p run that no account admits waits at most this long, then fails. 0 (default): it
    /// fails at once with the time it would start (its caller's Bash tool would end a long wait anyway).
    cli_max_wait_ms: u64,
    accounts: Vec<Account>,
}

/// One quota window with the share already used, in percent.
#[derive(Debug, Clone)]
struct Window {
    kind: String,
    scope: Option<String>,
    used: f64,
    resets_ms: Option<u64>,
}

/// What the router knows about one account's quota for the models in use.
#[derive(Debug, Clone)]
struct Quota {
    left: f64,
    weekly_reset_ms: Option<u64>,
    /// Models that have their own weekly window on this account (Fable today).
    scoped: Vec<String>,
    detail: String,
}

type Score = Result<Quota, String>;

/// One reading of an account's quota from Uzalka or from claude.exe.
enum Reading {
    Windows(Vec<Window>),
    SignedOut(String),
}

/// Where a copy of the session transcript lives: account index, `projects/<slug>` dir, mtime.
struct SessionCopy {
    account: usize,
    slug_dir: PathBuf,
    mtime: SystemTime,
}

/// How the next turn leaves the current account.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Leave {
    /// Better elsewhere: wait for a quiet moment, never while background tasks run.
    Soft,
    /// Almost empty: wait for a quiet moment, background tasks or not.
    Low,
    /// The API refused this account or its login is dead: leave right after the turn.
    Blocked,
}

/// The next turn should run on another account.
struct Move {
    reason: String,
    kind: Leave,
    /// The account it would go to has quota data and room.
    target_has_quota: bool,
    /// Something the model should tell the user (an account that needs /login).
    notice: Option<String>,
    /// No account has room now: T3 may resume the thread then (the first account frees up before this one).
    resume_at_ms: Option<u64>,
}

/// How fresh the usage data must be for a decision.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Data {
    /// Whatever is on disk.
    AsIs,
    /// Refresh what is older than `fresh_minutes`.
    Fresh,
    /// Refresh what is older than half a minute: claude just reported a limit.
    Newest,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Expands `%NAME%` the way Windows paths do.
fn expand_env(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                out.push_str(&std::env::var(name).unwrap_or_else(|_| format!("%{name}%")));
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn norm_path(s: &str) -> String {
    let s = s.strip_prefix(r"\\?\").unwrap_or(s);
    s.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn under(path: &str, prefix: &str) -> bool {
    path == prefix || path.starts_with(&format!("{prefix}\\"))
}

fn allowed_here(account: &Account, cwd: &str) -> bool {
    (account.only_paths.is_empty() || account.only_paths.iter().any(|p| under(cwd, p)))
        && !account.exclude_paths.iter().any(|p| under(cwd, p))
}

/// Both paths lead to the same file or folder (junctions and links resolved).
fn same_file(a: &Path, b: &Path) -> bool {
    matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

fn load_config(path: &Path) -> Result<Config, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("bad {}: {e}", path.display()))?;
    let path_of = |key: &str| v[key].as_str().map(|s| PathBuf::from(expand_env(s))).ok_or(format!("{key} is missing in router.json"));
    let list = |a: &Value| a.as_array().map(|x| x.iter().filter_map(|p| p.as_str().map(norm_path)).collect()).unwrap_or_default();
    let mut accounts = Vec::new();
    for a in v["accounts"].as_array().ok_or("accounts is missing in router.json")? {
        let k: Vec<f64> = a["dollars_per_percent"].as_array().map(|x| x.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
        let k = if k.len() == 3 { [k[0], k[1], k[2]] } else { DOLLARS_PER_PERCENT };
        accounts.push(Account {
            name: a["name"].as_str().ok_or("account without name")?.to_string(),
            config_dir: PathBuf::from(expand_env(a["config_dir"].as_str().ok_or("account without config_dir")?)),
            only_paths: list(&a["only_paths"]),
            exclude_paths: list(&a["exclude_paths"]),
            cap: k.map(|x| x * 100.0),
        });
    }
    if accounts.is_empty() {
        return Err("router.json has no accounts".into());
    }
    let face_account = match v["face_account"].as_str() {
        Some(name) => Some(accounts.iter().position(|a| a.name == name).ok_or(format!("face_account {name} is not in accounts"))?),
        None => None,
    };
    Ok(Config {
        claude_exe: path_of("claude_exe")?,
        usage_json: path_of("usage_json")?,
        max_snapshot_age_minutes: v["max_snapshot_age_minutes"].as_f64().unwrap_or(120.0),
        fresh_minutes: v["fresh_minutes"].as_f64().unwrap_or(5.0),
        switch_below_percent: v["switch_below_percent"].as_f64().unwrap_or(10.0),
        new_chat_min_percent: v["new_chat_min_percent"].as_f64().unwrap_or(20.0),
        burn_soon_hours: v["burn_soon_hours"].as_f64().unwrap_or(6.0),
        leave_with_tasks_below_percent: v["leave_with_tasks_below_percent"].as_f64().unwrap_or(2.0),
        face_account,
        route_nested: v["route_nested"].as_bool().unwrap_or(true),
        strategy: v["strategy"].as_str() == Some("fable_spread"),
        cli_max_wait_ms: (v["cli_max_wait_minutes"].as_f64().unwrap_or(0.0) * 60_000.0) as u64,
        accounts,
    })
}

/// Value of `--name value` or `--name=value`.
fn flag(args: &[String], names: &[&str]) -> Option<String> {
    for (i, a) in args.iter().enumerate() {
        for n in names {
            if a == n {
                return args.get(i + 1).filter(|v| !v.starts_with('-')).cloned();
            }
            if let Some(v) = a.strip_prefix(n).and_then(|r| r.strip_prefix('=')) {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn has_flag(args: &[String], names: &[&str]) -> bool {
    args.iter().any(|a| names.iter().any(|n| a == n || a.strip_prefix(n).is_some_and(|r| r.starts_with('='))))
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2026-10-04T07:40:00.300952+00:00` -> unix ms.
fn parse_rfc3339(s: &str) -> Option<u64> {
    let num = |a: usize, l: usize| s.get(a..a + l)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 2)?, num(8, 2)?, num(11, 2)?, num(14, 2)?, num(17, 2)?);
    let b = s.as_bytes();
    let mut i = 19;
    let mut frac_ms = 0;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let digits = &s[start..i];
        frac_ms = format!("{:0<3}", &digits[..digits.len().min(3)]).parse::<i64>().ok()?;
    }
    let offset_min = match b.get(i) {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(&c) if c == b'+' || c == b'-' => {
            let o = num(i + 1, 2)? * 60 + num(i + 4, 2)?;
            if c == b'+' { o } else { -o }
        }
        _ => return None,
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset_min * 60;
    u64::try_from(secs * 1000 + frac_ms).ok()
}

/// Uzalka and claude's usage answer write RFC 3339 strings, claude's events write unix seconds.
fn parse_time_ms(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_f64().map(|t| if t > 1e12 { t as u64 } else { (t * 1000.0) as u64 }),
        Value::String(s) => parse_rfc3339(s),
        _ => None,
    }
}

/// Smallest share left among the windows that limit these models, plus a short description.
/// A model-scoped window counts when any of the models (main thread or agents) uses it.
fn remaining(windows: &[Window], models: &[String], now: u64) -> Option<(f64, String)> {
    let models: Vec<String> = models.iter().map(|m| m.to_lowercase()).collect();
    let mut least: Option<f64> = None;
    let mut parts = Vec::new();
    for w in windows {
        let applies = match &w.scope {
            None => w.kind == "session" || w.kind == "weekly_all",
            Some(s) => !s.is_empty() && models.iter().any(|m| m.contains(s.as_str())),
        };
        if !applies {
            continue;
        }
        // A window that has already reset since the data was taken is full again.
        let used = if w.resets_ms.is_some_and(|r| r <= now) { 0.0 } else { w.used };
        let left = (100.0 - used).clamp(0.0, 100.0);
        let scope = w.scope.as_ref().map(|s| format!("/{s}")).unwrap_or_default();
        parts.push(format!("{}{scope} {left:.0}%", w.kind));
        least = Some(least.map_or(left, |l| l.min(left)));
    }
    least.map(|l| (l, parts.join(", ")))
}

/// When the account-wide weekly window resets next (a reset already past means a week later).
fn next_weekly_reset(windows: &[Window], now: u64) -> Option<u64> {
    let mut r = windows.iter().find(|w| w.kind == "weekly_all" && w.scope.is_none())?.resets_ms?;
    while r <= now {
        r += WEEK_MS;
    }
    Some(r)
}

/// Quota windows in the shape Uzalka and claude's usage answer share.
fn parse_windows(list: &Value) -> Vec<Window> {
    list.as_array()
        .map(|ws| {
            ws.iter()
                .filter_map(|w| {
                    let model = w["scope"]["model"].as_object();
                    Some(Window {
                        kind: w["kind"].as_str()?.to_string(),
                        scope: model.map(|m| {
                            m.get("display_name").and_then(Value::as_str).or(m.get("id").and_then(Value::as_str)).unwrap_or("").to_lowercase()
                        }),
                        used: w["percent"].as_f64()?,
                        resets_ms: parse_time_ms(&w["resets_at"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// This account in Uzalka's usage.json (twins share an account_key): when, and what it saw.
fn uzalka_reading(snapshot: &Value, account: &Account) -> Result<(u64, Reading), String> {
    if let Some(p) = snapshot["paused"].as_str() {
        return Err(format!("uzalka paused: {p}"));
    }
    let entries = snapshot["accounts"].as_array().ok_or("uzalka snapshot has no accounts")?;
    let me = norm_path(&account.config_dir.to_string_lossy());
    let key = entries
        .iter()
        .find(|a| a["kind"] == "claude" && a["path"].as_str().map(norm_path).as_deref() == Some(me.as_str()))
        .and_then(|a| a["account_key"].as_str())
        .ok_or("not in uzalka or no account identity")?;
    let source = entries
        .iter()
        .filter(|a| a["account_key"].as_str() == Some(key) && a["windows"].as_array().is_some_and(|w| !w.is_empty()) && a["updated_ms"].as_u64().is_some())
        .max_by_key(|a| a["updated_ms"].as_u64())
        .ok_or("no successful quota snapshot in uzalka")?;
    let updated = source["updated_ms"].as_u64().unwrap_or(0);
    let error = source["error"].as_str().unwrap_or("").to_lowercase();
    if AUTH_ERRORS.iter().any(|m| error.contains(m)) {
        return Ok((updated, Reading::SignedOut(format!("uzalka: {error}"))));
    }
    Ok((updated, Reading::Windows(parse_windows(&source["windows"]))))
}

/// The last answer claude.exe gave the router to a usage request for this account.
fn probe_reading(state: &Path, account: &Account) -> Result<(u64, Reading), String> {
    let v = read_json(&usage_path(state, account)).ok_or("no usage answer from claude yet")?;
    let updated = v["updated_ms"].as_u64().ok_or("usage answer without time")?;
    if v["signed_in"] == false {
        return Ok((updated, Reading::SignedOut("claude reports no login".into())));
    }
    let windows = parse_windows(&v["limits"]);
    if windows.is_empty() {
        return Err("claude gave no quota data".into());
    }
    Ok((updated, Reading::Windows(windows)))
}

/// Windows from the `unifiedWindows` part of the last `rate_limit_event` this router saw.
/// `seven_day_overage_included` names no model; the model's own window comes from the readings.
fn live_windows(live: &Value) -> Vec<Window> {
    let Some(map) = live["unified_windows"].as_object() else { return Vec::new() };
    map.iter()
        .filter_map(|(key, w)| {
            let (kind, scope) = match key.as_str() {
                "five_hour" => ("session", None),
                "seven_day" => ("weekly_all", None),
                "seven_day_overage_included" => return None,
                other => ("weekly_scoped", Some(other.strip_prefix("seven_day_")?.to_lowercase())),
            };
            Some(Window { kind: kind.into(), scope, used: w["utilization"].as_f64()? * 100.0, resets_ms: parse_time_ms(&w["resetsAt"]) })
        })
        .collect()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(fs::read_to_string(path).ok()?.trim_start_matches('\u{feff}')).ok()
}

fn write_json(path: &Path, v: &Value) {
    // Its own temporary file per write: two threads of one router may write the same file.
    static WRITES: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!("tmp{}-{}", std::process::id(), WRITES.fetch_add(1, Ordering::Relaxed)));
    if fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default()).is_err() {
        return;
    }
    // Another router reading the file at this moment makes the rename fail on Windows.
    for _ in 0..5 {
        if fs::rename(&tmp, path).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = fs::remove_file(&tmp);
}

/// Runs `f` holding a short lock file. A lock older than 10 s was left by a router that died; after
/// 2 s of waiting `f` runs anyway.
fn locked<T>(lock: &Path, f: impl FnOnce() -> T) -> T {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut taken = false;
    while Instant::now() < deadline {
        if fs::OpenOptions::new().write(true).create_new(true).open(lock).is_ok() {
            taken = true;
            break;
        }
        if fs::metadata(lock).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(10)) {
            let _ = fs::remove_file(lock);
            continue;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    let out = f();
    if taken {
        let _ = fs::remove_file(lock);
    }
    out
}

/// Read-modify-write of `live/<account>.json` under a short lock: every router on an account
/// reports its events there, several at a time when agents run.
fn update_live(state: &Path, account: &Account, change: impl FnOnce(&mut Value)) {
    let path = live_path(state, account);
    locked(&path.with_extension("lock"), || {
        let mut live = read_json(&path).unwrap_or_else(|| json!({}));
        change(&mut live);
        write_json(&path, &live);
    });
}

fn live_path(state: &Path, account: &Account) -> PathBuf {
    state.join("live").join(format!("{}.json", account.name))
}

fn usage_path(state: &Path, account: &Account) -> PathBuf {
    state.join("usage").join(format!("{}.json", account.name))
}

/// Newest full reading (Uzalka or claude's usage answer), whatever it says, and its time.
fn newest_reading(state: &Path, snapshot: &Result<Value, String>, account: &Account) -> Result<(u64, Reading), String> {
    let uz = snapshot.as_ref().map_err(Clone::clone).and_then(|s| uzalka_reading(s, account));
    let pr = probe_reading(state, account);
    match (uz, pr) {
        (Ok(u), Ok(p)) => Ok(if p.0 >= u.0 { p } else { u }),
        (Ok(r), Err(_)) | (Err(_), Ok(r)) => Ok(r),
        (Err(e), Err(_)) => Err(e),
    }
}

/// claude blanks both tokens in `.credentials.json` when its login dies for good (the refresh was
/// refused, or it signed out); only /login with that folder brings it back. A passing refusal
/// ("403 Request not allowed", the "Not logged in" of 2026-10-05) leaves the tokens in place.
fn login_dead(account: &Account) -> bool {
    read_json(&account.config_dir.join(".credentials.json")).is_some_and(|v| v["claudeAiOauth"]["refreshToken"].as_str().is_some_and(str::is_empty))
}

/// A refusal no longer holds when a reading taken LIFT_AFTER_MS after it shows the refused windows
/// below 100% (the reset claude promised can come early, as on 2026-09-28).
fn lifted(windows: &[Window], scope: Option<&str>, now: u64) -> bool {
    let relevant: Vec<&Window> = windows
        .iter()
        .filter(|w| match scope {
            None => w.scope.is_none() && (w.kind == "session" || w.kind == "weekly_all"),
            Some(s) => w.scope.as_deref() == Some(s),
        })
        .collect();
    !relevant.is_empty() && relevant.iter().all(|w| w.used < 100.0 || w.resets_ms.is_some_and(|r| r <= now))
}

/// The account's live events (`live/<account>.json`), when they were last written, whether that is recent
/// enough to go by, and its newest full reading if that is recent enough.
fn readings(cfg: &Config, state: &Path, snapshot: &Result<Value, String>, account: &Account, now: u64) -> (Option<Value>, u64, bool, Result<(u64, Reading), String>) {
    let live = read_json(&live_path(state, account));
    let max_age_ms = cfg.max_snapshot_age_minutes * 60_000.0;
    let live_updated = live.as_ref().and_then(|l| l["updated_ms"].as_u64()).unwrap_or(0);
    let live_fresh = now.saturating_sub(live_updated) as f64 <= max_age_ms;
    let reading = newest_reading(state, snapshot, account).and_then(|(updated, r)| {
        if now.saturating_sub(updated) as f64 > max_age_ms {
            return Err(format!("quota data is {} min old", now.saturating_sub(updated) / 60_000));
        }
        Ok((updated, r))
    });
    (live, live_updated, live_fresh, reading)
}

/// The newest windows: the full reading with the windows of later live events on top, or the live
/// events alone while they are recent enough.
fn merge_windows(reading: Result<(u64, Reading), String>, live: Option<&Value>, live_updated: u64, live_fresh: bool) -> Result<Vec<Window>, String> {
    match (reading, live) {
        (Ok((_, Reading::SignedOut(e))), _) => Err(format!("auth failure: {e}")),
        (Ok((updated, Reading::Windows(mut windows))), Some(live)) if live_updated > updated => {
            for lw in live_windows(live) {
                windows.retain(|w| !(w.kind == lw.kind && w.scope == lw.scope));
                windows.push(lw);
            }
            Ok(windows)
        }
        (Ok((_, Reading::Windows(windows))), _) => Ok(windows),
        (Err(_), Some(live)) if live_fresh => Ok(live_windows(live)),
        (Err(e), _) => Err(e),
    }
}

/// Share of quota left for these models on this account, newest data wins.
fn score(cfg: &Config, state: &Path, snapshot: &Result<Value, String>, account: &Account, models: &[String], now: u64) -> Score {
    if login_dead(account) {
        return Err(format!("auth failure: signed out, needs /login with CLAUDE_CONFIG_DIR={}", account.config_dir.display()));
    }
    let (live, live_updated, live_fresh, reading) = readings(cfg, state, snapshot, account, now);
    if let Some(l) = &live {
        let (read_at, read_windows): (u64, &[Window]) = match &reading {
            Ok((t, Reading::Windows(w))) => (*t, w),
            _ => (0, &[]),
        };
        // Files written before rejected_scope_ms existed keep a model's refusal time in rejected_ms.
        let newer = |at: Option<u64>| read_at > at.or(l["rejected_ms"].as_u64()).unwrap_or(0) + LIFT_AFTER_MS;
        if let Some(until) = l["rejected_until_ms"].as_u64().filter(|&u| u > now) {
            if !(newer(None) && lifted(read_windows, None, now)) {
                return Err(format!("rejected by the API, resets in {} min", (until - now) / 60_000));
            }
        }
        if let Some(scopes) = l["rejected_scopes"].as_object() {
            for (scope, until) in scopes {
                let until = until.as_u64().unwrap_or(0);
                let newer = newer(l["rejected_scope_ms"][scope].as_u64());
                if until > now && models.iter().any(|m| m.to_lowercase().contains(scope.as_str())) && !(newer && lifted(read_windows, Some(scope), now)) {
                    return Err(format!("rejected by the API for {scope}, resets in {} min", (until - now) / 60_000));
                }
            }
        }
        let failed = l["auth_failed_ms"].as_u64().unwrap_or(0);
        if now.saturating_sub(failed) < AUTH_BLOCK_MS && failed > l["allowed_ms"].as_u64().unwrap_or(0) {
            return Err(format!("auth failure in a chat {} min ago ({})", (now - failed) / 60_000, l["auth_error"].as_str().unwrap_or("?")));
        }
    }
    let windows = merge_windows(reading, live.as_ref(), live_updated, live_fresh)?;
    let (left, detail) = remaining(&windows, models, now).ok_or("no quota windows for this model")?;
    let scoped = windows.iter().filter_map(|w| w.scope.clone()).filter(|s| !s.is_empty()).collect();
    Ok(Quota { left, weekly_reset_ms: next_weekly_reset(&windows, now), scoped, detail })
}

/// An account as the strategy sees it: use and end of its 5-hour, weekly and Fable
/// windows. A refusal that stands counts as its window full until the reset the API named.
fn account_view(cfg: &Config, state: &Path, snapshot: &Result<Value, String>, account: &Account, now: u64) -> Acc {
    let mut v = Acc { cap: account.cap, ..Acc::default() };
    let whole = score(cfg, state, snapshot, account, &[], now);
    v.dead = matches!(&whole, Err(e) if e.contains("auth failure"));
    let (live, live_updated, live_fresh, reading) = readings(cfg, state, snapshot, account, now);
    let windows = merge_windows(reading, live.as_ref(), live_updated, live_fresh).unwrap_or_default();
    // A window that has reset is empty (and a 5-hour one is not open) until the next request.
    for w in windows.iter().filter(|w| !w.resets_ms.is_some_and(|r| r <= now)) {
        match (w.kind.as_str(), w.scope.as_deref()) {
            // A window in use with no reset named ends within 5 h: taken as the latest.
            ("session", None) => (v.u5, v.w5_end) = (w.used, w.resets_ms.or((w.used > 0.0).then_some(now + 5 * 3_600_000))),
            ("weekly_all", None) => v.u7 = w.used,
            ("weekly_scoped", Some("fable")) => v.uf = w.used,
            _ => {}
        }
    }
    v.w7_end = next_weekly_reset(&windows, now);
    v.unknown = !windows.iter().any(|w| w.scope.is_none() && (w.kind == "session" || w.kind == "weekly_all"));
    let live = live.unwrap_or(Value::Null);
    if rejected(&whole) {
        let until = live["rejected_until_ms"].as_u64().filter(|&u| u > now);
        if live["rejected_until_type"] == "seven_day" {
            v.u7 = 100.0;
            v.w7_end = until.or(v.w7_end);
        } else {
            v.u5 = 100.0;
            v.w5_end = until.or(v.w5_end);
        }
        v.unknown = false;
    } else if rejected(&score(cfg, state, snapshot, account, &["fable".to_string()], now)) {
        v.uf = 100.0;
    }
    v
}

/// An account that will certainly fail: the API refused it, or it is signed out.
fn blocked(score: &Score) -> bool {
    matches!(score, Err(e) if e.starts_with("rejected") || e.contains("auth failure"))
}

fn rejected(score: &Score) -> bool {
    matches!(score, Err(e) if e.starts_with("rejected"))
}

fn hours_until(ms: Option<u64>, now: u64) -> String {
    ms.map(|r| format!("{:.1} h", r.saturating_sub(now) as f64 / 3_600_000.0)).unwrap_or_else(|| "unknown time".into())
}

/// Picks the account. `holder` is the account that has the newest copy of the session.
/// New chats go where the weekly quota resets soonest (it would be lost otherwise), among
/// accounts with room; a thread stays where it is while there is quota, because a move costs a
/// cache miss, unless another account's weekly quota is about to reset unused.
fn choose(cfg: &Config, scores: &[Score], allowed: &[usize], holder: Option<usize>, forced: Option<&str>, now: u64) -> (usize, String) {
    if let Some(name) = forced {
        if let Some(&i) = allowed.iter().find(|&&i| cfg.accounts[i].name == name) {
            return (i, format!("forced by force-account.txt ({name})"));
        }
    }
    let quota = |i: usize| scores[i].as_ref().ok();
    let roomy = |i: usize| quota(i).is_some_and(|q| q.left >= cfg.new_chat_min_percent && q.left >= cfg.switch_below_percent);
    let soonest = allowed.iter().copied().filter(|&i| roomy(i)).min_by(|&a, &b| {
        let (qa, qb) = (&scores[a].as_ref().unwrap(), &scores[b].as_ref().unwrap());
        qa.weekly_reset_ms.unwrap_or(u64::MAX).cmp(&qb.weekly_reset_ms.unwrap_or(u64::MAX)).then(qb.left.total_cmp(&qa.left))
    });
    let holder = holder.filter(|h| allowed.contains(h));
    if let Some(h) = holder {
        match &scores[h] {
            Ok(q) if q.left >= cfg.switch_below_percent => {
                // The cache miss of a move is paid from quota that would reset unused anyway.
                if let Some(s) = soonest.filter(|&s| s != h) {
                    let qs = quota(s).unwrap();
                    let burns = qs.weekly_reset_ms.is_some_and(|r| {
                        r.saturating_sub(now) as f64 <= cfg.burn_soon_hours * 3_600_000.0 && q.weekly_reset_ms.map_or(true, |hr| r < hr)
                    });
                    if burns {
                        return (s, format!(
                            "moves from {}: weekly quota of {} resets in {} with {:.0}% left",
                            cfg.accounts[h].name, cfg.accounts[s].name, hours_until(qs.weekly_reset_ms, now), qs.left
                        ));
                    }
                }
                return (h, format!("stays on the session's account, {:.0}% left", q.left));
            }
            Err(e) if !blocked(&scores[h]) => return (h, format!("stays on the session's account, no quota data ({e})")),
            _ => {}
        }
    }
    let best = allowed
        .iter()
        .filter_map(|&i| quota(i).map(|q| (i, q.left)))
        .fold(None, |best: Option<(usize, f64)>, (i, left)| match best {
            Some((_, b)) if b >= left => best,
            _ => Some((i, left)),
        });
    // When every account is low, a move costs a cache miss for a few percent: not worth it.
    if let (Some((_, best_left)), Some(h)) = (best, holder) {
        if let Ok(q) = &scores[h] {
            if q.left >= MARGIN_FLOOR_PERCENT && best_left < q.left + MOVE_MARGIN_PERCENT {
                return (h, format!("stays on the session's account, {:.0}% left and no account has {MOVE_MARGIN_PERCENT:.0}% more", q.left));
            }
        }
    }
    let moves = |i: usize| holder.filter(|&h| h != i).map(|h| format!("moves from {}: ", cfg.accounts[h].name)).unwrap_or_default();
    if let Some(s) = soonest {
        let q = quota(s).unwrap();
        return (s, format!("{}weekly quota resets soonest here (in {}), {:.0}% left", moves(s), hours_until(q.weekly_reset_ms, now), q.left));
    }
    match (best, holder) {
        (Some((i, left)), _) => (i, format!("{}most quota left ({left:.0}%)", moves(i))),
        (None, Some(h)) if !blocked(&scores[h]) => (h, "no account has quota data, stays on the session's account".into()),
        (None, _) => {
            // Everyone looks blocked: an auth error may have been passing, a rejection is not.
            let first = allowed
                .iter()
                .copied()
                .find(|&i| !blocked(&scores[i]))
                .or(allowed.iter().copied().find(|&i| !rejected(&scores[i])))
                .or(allowed.first().copied())
                .unwrap_or(0);
            (first, if allowed.is_empty() { "no account is allowed for this folder, using the first one".into() } else { "no usable quota data, first allowed account".into() })
        }
    }
}

/// Asks claude.exe for this account's usage, the same request T3 uses for its status line.
/// claude refreshes its own login token if it needs to.
fn ask_usage(cfg: &Config, account: &Account) -> Result<Value, String> {
    let mut cmd = Command::new(&cfg.claude_exe);
    cmd.args([
        "--output-format",
        "stream-json",
        "--verbose",
        "--input-format",
        "stream-json",
        "--setting-sources=user",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--settings",
        r#"{"disableAllHooks":true}"#,
    ])
    .env("CLAUDE_CONFIG_DIR", &account.config_dir)
    .env_remove("CLAUDECODE")
    .env_remove(MARK_VAR)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy().to_uppercase();
        if k.starts_with("CLAUDE_CODE_") || k.starts_with("ANTHROPIC_") {
            cmd.env_remove(&k);
        }
    }
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("cannot start claude: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v["type"] == "control_response" && tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut result = Err("claude gave no usage answer in time".to_string());
    for attempt in 1..=PROBE_ATTEMPTS {
        let id = format!("router-usage-{attempt}");
        let request = json!({"type": "control_request", "request_id": id, "request": {"subtype": "get_usage"}});
        if writeln!(stdin, "{request}").is_err() {
            result = Err("claude closed its input".into());
            break;
        }
        let answer = loop {
            let Some(wait) = deadline.checked_duration_since(Instant::now()) else { break None };
            match rx.recv_timeout(wait) {
                Ok(v) if v["response"]["request_id"] == id.as_str() => break Some(v),
                Ok(_) => continue,
                Err(_) => break None,
            }
        };
        let Some(v) = answer else { break };
        let response = v["response"]["response"].clone();
        if v["response"]["subtype"] != "success" {
            result = Err(format!("usage request failed: {}", v["response"]["error"]));
            break;
        }
        let signed_in = response["subscription_type"].is_string();
        result = Ok(response);
        if signed_in || attempt == PROBE_ATTEMPTS {
            break;
        }
        // Right after start claude sometimes answers before it has read its login.
        std::thread::sleep(Duration::from_millis(1500));
    }
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn save_usage(state: &Path, account: &Account, response: &Value, now: u64) {
    let v = json!({
        "updated_ms": now,
        "signed_in": response["subscription_type"].is_string(),
        "subscription_type": response["subscription_type"],
        "available": response["rate_limits_available"],
        "limits": response["rate_limits"]["limits"],
    });
    write_json(&usage_path(state, account), &v);
}

/// Asks claude.exe for the usage of these accounts at once. If another router is already doing
/// it, waits for that one instead: the answers land in the same files.
fn refresh_usage(cfg: &Config, state: &Path, which: &[usize], log: &Log) {
    let lock = state.join("usage").join("refresh.lock");
    let take = || fs::OpenOptions::new().write(true).create_new(true).open(&lock).is_ok();
    let mut taken = take();
    if !taken && fs::metadata(&lock).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(60)) {
        let _ = fs::remove_file(&lock);
        taken = take();
    }
    if !taken {
        let until = Instant::now() + PROBE_TIMEOUT + Duration::from_secs(5);
        while lock.exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(250));
        }
        return;
    }
    std::thread::scope(|s| {
        for &i in which {
            s.spawn(move || {
                let account = &cfg.accounts[i];
                let started = Instant::now();
                match ask_usage(cfg, account) {
                    Ok(response) => {
                        save_usage(state, account, &response, now_ms());
                        log.write(json!({"event": "usage_refreshed", "account": account.name, "ms": started.elapsed().as_millis() as u64,
                            "signed_in": response["subscription_type"].is_string()}));
                    }
                    Err(e) => log.write(json!({"event": "usage_refresh_failed", "account": account.name, "error": e})),
                }
            });
        }
    });
    let _ = fs::remove_file(&lock);
}

/// Asks Uzalka's local hub (port and key from its config.json next to usage.json) for a snapshot
/// no older than `max_age_ms`. Uzalka refreshes first when its data is older and, as always,
/// writes usage.json, which is what the router reads.
fn ask_uzalka(cfg: &Config, max_age_ms: u64) -> Result<Value, String> {
    let conf = read_json(&cfg.usage_json.with_file_name("config.json")).ok_or("cannot read uzalka config.json")?;
    let hub = &conf["hub"];
    if hub["enabled"] == false {
        return Err("uzalka hub is off".into());
    }
    let port = hub["port"].as_u64().and_then(|p| u16::try_from(p).ok()).unwrap_or(8318);
    let key = hub["key"].as_str().unwrap_or("");
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| format!("uzalka is not answering on port {port}: {e}"))?;
    let _ = stream.set_read_timeout(Some(UZALKA_TIMEOUT));
    let request = format!(
        "GET /v0/router/usage?max_age_ms={max_age_ms} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {key}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).map_err(|e| format!("uzalka request: {e}"))?;
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).map_err(|e| format!("uzalka reply: {e}"))?;
    let reply = String::from_utf8_lossy(&reply);
    let (head, body) = reply.split_once("\r\n\r\n").ok_or("uzalka reply has no body")?;
    let status = head.split_whitespace().nth(1).unwrap_or("");
    if status != "200" {
        return Err(format!("uzalka answered {status}: {}", body.chars().take(200).collect::<String>()));
    }
    serde_json::from_str(body).map_err(|e| format!("bad uzalka reply: {e}"))
}

/// Makes the usage data of these accounts no older than `max_age_ms`: Uzalka first (one request
/// refreshes every account), then claude.exe itself for the accounts Uzalka could not help with
/// (not running, its request failing, or a login problem claude may not have: claude logs in on
/// its own). A dead login is not asked about: nothing but /login changes it. Returns whether
/// anything was asked.
fn refresh_stale(cfg: &Config, state: &Path, which: &[usize], log: &Log, max_age_ms: u64) -> bool {
    let stale = |snapshot: &Result<Value, String>| -> Vec<usize> {
        let now = now_ms();
        let old = |t: u64| now.saturating_sub(t) > max_age_ms;
        which
            .iter()
            .copied()
            .filter(|&i| {
                let account = &cfg.accounts[i];
                if login_dead(account) {
                    return false;
                }
                match newest_reading(state, snapshot, account) {
                    Ok((t, Reading::Windows(_))) => old(t),
                    Ok((_, Reading::SignedOut(_))) => probe_reading(state, account).map_or(true, |(t, _)| old(t)),
                    Err(_) => true,
                }
            })
            .collect()
    };
    if stale(&read_snapshot(cfg)).is_empty() {
        return false;
    }
    let started = Instant::now();
    match ask_uzalka(cfg, max_age_ms) {
        Ok(v) => log.write(json!({"event": "uzalka_refreshed", "ms": started.elapsed().as_millis() as u64,
            "refreshed": v["refreshed"], "timed_out": v["timed_out"], "paused": v["paused"]})),
        Err(e) => log.write(json!({"event": "uzalka_refresh_failed", "ms": started.elapsed().as_millis() as u64, "error": e})),
    }
    let left = stale(&read_snapshot(cfg));
    if !left.is_empty() {
        refresh_usage(cfg, state, &left, log);
    }
    true
}

/// Every account folder that has `projects/<slug>/<id>.jsonl`.
fn find_copies(cfg: &Config, id: &str) -> Vec<SessionCopy> {
    let file = format!("{id}.jsonl");
    let mut copies = Vec::new();
    for (account, a) in cfg.accounts.iter().enumerate() {
        let Ok(dirs) = fs::read_dir(a.config_dir.join("projects")) else { continue };
        for dir in dirs.flatten() {
            let path = dir.path().join(&file);
            if let Ok(mtime) = fs::metadata(&path).and_then(|m| m.modified()) {
                copies.push(SessionCopy { account, slug_dir: dir.path(), mtime });
            }
        }
    }
    copies
}

/// The newest copy; copies made by the router keep the source mtime, so ties go to the
/// account the router last ran this session on.
fn pick_holder(copies: &[SessionCopy], last_used: Option<usize>) -> Option<usize> {
    let newest = copies.iter().map(|c| c.mtime).max()?;
    let fresh: Vec<usize> = (0..copies.len())
        .filter(|&i| newest.duration_since(copies[i].mtime).map_or(true, |d| d < Duration::from_secs(2)))
        .collect();
    fresh.iter().copied().find(|&i| Some(copies[i].account) == last_used).or(fresh.first().copied())
}

fn copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let to = dst.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &to)?;
        } else {
            fs::copy(e.path(), to)?;
        }
    }
    Ok(())
}

/// Moves a file or folder, also across drives.
fn move_any(src: &Path, dst: &Path) -> io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    if src.is_dir() {
        copy_dir(src, dst)?;
        fs::remove_dir_all(src)
    } else {
        fs::copy(src, dst)?;
        fs::remove_file(src)
    }
}

/// Whether file `whole` begins with the content of file `start`, read piece by piece: long
/// transcripts run to hundreds of MB.
fn file_starts_with(whole: &Path, start: &Path) -> io::Result<bool> {
    let mut left = fs::metadata(start)?.len();
    if left > fs::metadata(whole)?.len() {
        return Ok(false);
    }
    let (mut a, mut b) = (fs::File::open(whole)?, fs::File::open(start)?);
    let (mut ba, mut bb) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    while left > 0 {
        let n = left.min(1 << 20) as usize;
        a.read_exact(&mut ba[..n])?;
        b.read_exact(&mut bb[..n])?;
        if ba[..n] != bb[..n] {
            return Ok(false);
        }
        left -= n as u64;
    }
    Ok(true)
}

/// Copies `<id>.jsonl` and the `<id>/` folder (subagents, tool results) into the same project
/// folder of another account. An older copy already there goes to `backup` first; a copy that
/// is not simply an earlier state of the source (someone continued it there) is left alone.
/// Accounts that share one `projects` folder (a junction) need no copy at all.
fn copy_session(src_slug: &Path, dst_config: &Path, id: &str, backup: &Path) -> io::Result<PathBuf> {
    let slug = src_slug.file_name().ok_or_else(|| io::Error::other("bad project folder"))?;
    let dst_slug = dst_config.join("projects").join(slug);
    if dst_slug.exists() && same_file(src_slug, &dst_slug) {
        return Ok(dst_slug);
    }
    fs::create_dir_all(&dst_slug)?;
    let file = format!("{id}.jsonl");
    if dst_slug.join(&file).exists() && !file_starts_with(&src_slug.join(&file), &dst_slug.join(&file))? {
        return Err(io::Error::other("the copy there has turns the newest copy lacks, not overwriting it"));
    }
    for name in [file.as_str(), id] {
        let old = dst_slug.join(name);
        if old.exists() {
            move_any(&old, &backup.join(slug).join(name))?;
        }
    }
    let tmp = dst_slug.join(format!("{id}.jsonl.router-tmp"));
    fs::copy(src_slug.join(&file), &tmp)?;
    fs::rename(&tmp, dst_slug.join(&file))?;
    if src_slug.join(id).is_dir() {
        copy_dir(&src_slug.join(id), &dst_slug.join(id))?;
    }
    Ok(dst_slug)
}

#[derive(Clone)]
struct Log {
    path: PathBuf,
}

impl Log {
    fn write(&self, mut v: Value) {
        v["ts"] = json!(now_ms());
        v["pid"] = json!(std::process::id());
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = f.write_all(format!("{v}\n").as_bytes());
        }
    }
}

fn top_type(line: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(line).ok()?["type"].as_str().map(str::to_string)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// `message.model` of an assistant line, read from its start without parsing the whole line.
fn line_model(line: &[u8]) -> Option<String> {
    let head = &line[..line.len().min(400)];
    let key = b"\"model\":\"";
    let start = head.windows(key.len()).position(|w| w == key)? + key.len();
    let end = head[start..].iter().position(|&b| b == b'"')? + start;
    let model = String::from_utf8(head[start..end].to_vec()).ok()?;
    (!model.is_empty() && !model.starts_with('<')).then_some(model)
}

/// Saves live quota from a `rate_limit_event`; when the API refused a request, returns the kind
/// of limit (`rateLimitType`, named as T3 names it). `overage_scope` is the model whose window
/// claude reports as `seven_day_overage_included` (Fable today); such a refusal never closes the
/// whole account.
fn on_rate_limit(line: &[u8], account: &Account, state: &Path, log: &Log, overage_scope: Option<&str>) -> Option<String> {
    let v = serde_json::from_slice::<Value>(line).ok()?;
    if v["type"] != "rate_limit_event" {
        return None;
    }
    let info = &v["rate_limit_info"];
    let now = now_ms();
    // Extra usage turned on lets the request through after all (T3 reads it the same way).
    let overage = ["allowed", "allowed_warning"].iter().any(|s| info["overageStatus"] == *s) || info["isUsingOverage"] == true || info["overageInUse"] == true;
    let rejected = info["status"] == "rejected" && !overage;
    update_live(state, account, |live| {
        live["updated_ms"] = json!(now);
        if info["unifiedWindows"].is_object() {
            live["unified_windows"] = info["unifiedWindows"].clone();
        }
        if rejected {
            let until = parse_time_ms(&info["resetsAt"]).unwrap_or(now + 3_600_000);
            let kind = info["rateLimitType"].as_str().unwrap_or("");
            let scope = match kind {
                "" | "five_hour" | "seven_day" => None,
                "seven_day_overage_included" => Some(overage_scope.unwrap_or("fable").to_string()),
                other => other.strip_prefix("seven_day_").map(str::to_lowercase),
            };
            // A model's refusals (every 30 s from its agents) do not push back the account's own.
            match scope {
                Some(s) => {
                    for key in ["rejected_scopes", "rejected_scope_ms"] {
                        if !live[key].is_object() {
                            live[key] = json!({});
                        }
                    }
                    live["rejected_scopes"][&s] = json!(until);
                    live["rejected_scope_ms"][&s] = json!(now);
                }
                None => {
                    live["rejected_until_ms"] = json!(until);
                    live["rejected_until_type"] = json!(kind);
                    live["rejected_ms"] = json!(now);
                }
            }
            live["rejected_type"] = json!(kind);
        } else {
            live["allowed_ms"] = json!(now);
            // A request went through well after the refusal: the account as a whole serves again.
            // A model's own refusal stays, the request may have been for another model.
            if now > live["rejected_ms"].as_u64().unwrap_or(0) + LIFT_AFTER_MS {
                if let Some(o) = live.as_object_mut() {
                    o.remove("rejected_until_ms");
                }
            }
        }
    });
    if !rejected {
        return None;
    }
    log.write(json!({"event": "rate_limit_rejected", "account": account.name, "info": info}));
    Some(info["rateLimitType"].as_str().unwrap_or("unknown").to_string())
}

/// An assistant message that says this account cannot serve requests (signed out, on hold...):
/// marks the account so new choices avoid it for a while. Returns the error kind.
fn on_account_error(line: &[u8], account: &Account, state: &Path, log: &Log) -> Option<String> {
    if !contains(line, b"\"error\":\"") || !ACCOUNT_ERRORS.iter().any(|e| contains(line, e.as_bytes())) {
        return None;
    }
    let v: Value = serde_json::from_slice(line).ok()?;
    let kind = v["error"].as_str().filter(|e| ACCOUNT_ERRORS.contains(e))?.to_string();
    update_live(state, account, |live| {
        live["auth_failed_ms"] = json!(now_ms());
        live["auth_error"] = json!(kind);
    });
    let text: String = v["message"]["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect();
    log.write(json!({"event": "account_error", "account": account.name, "error": kind, "text": text, "login_dead": login_dead(account)}));
    Some(kind)
}

/// How to leave an account, judged by the quota of the thread's own model: a refusal that only
/// hits the agents' model (Fable agents in an Opus thread) leaves softly, never killing the work.
fn leave_kind(cfg: &Config, own: &Score) -> Leave {
    match own {
        // A login refused while its tokens are still in place usually passes within minutes.
        Err(e) if e.contains("(authentication_failed)") => Leave::Soft,
        s if blocked(s) => Leave::Blocked,
        Ok(q) if q.left < cfg.leave_with_tasks_below_percent => Leave::Low,
        _ => Leave::Soft,
    }
}

/// A refusal event of this kind that resets at `at_s` (unix seconds), for T3: it records a turn as
/// limited, and resumes it at the reset, only after such events, keeping the latest per kind.
fn refusal_event(session_id: &str, kind: &str, at_s: u64) -> Vec<u8> {
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    let a = t ^ ((std::process::id() as u64) << 40);
    let b = COUNT.fetch_add(1, Ordering::SeqCst).wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ t.rotate_left(23);
    let uuid = format!("{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}", (a >> 32) as u32, (a >> 16) as u16, a as u16 & 0xfff, (b >> 48) as u16 & 0xfff, b & 0xffff_ffff_ffff);
    let v = json!({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": at_s, "rateLimitType": kind, "isUsingOverage": false},
        "uuid": uuid, "session_id": session_id});
    let mut out = serde_json::to_vec(&v).unwrap_or_default();
    out.push(b'\n');
    out
}

/// The job `contain_children` made, kept to loosen it later.
#[cfg(windows)]
static JOB: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Puts the router into a job that kills claude.exe and everything it started once the router
/// exits or is killed, so nothing keeps spending quota after T3 drops the router.
#[cfg(windows)]
fn contain_children() {
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32);
        AssignProcessToJobObject(job, GetCurrentProcess());
        // The handle is kept open on purpose: it closes when the router exits.
        JOB.store(job as usize, Ordering::SeqCst);
    }
}

/// Leaving an account while background commands run (builds, renders, long jobs): only
/// claude.exe is ended, the commands it started go on as separate processes. The next process
/// tells the model about them.
#[cfg(windows)]
fn end_claude_keep_commands(claude_pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let job = JOB.load(Ordering::SeqCst);
        if job != 0 {
            let info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            SetInformationJobObject(job as _, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32);
        }
        let claude = OpenProcess(PROCESS_TERMINATE, 0, claude_pid);
        if !claude.is_null() {
            TerminateProcess(claude, 1);
            CloseHandle(claude);
        }
    }
}

#[cfg(not(windows))]
fn contain_children() {}

#[cfg(not(windows))]
fn end_claude_keep_commands(_: u32) {}

/// T3 starts the router without a console; a console program started from there would get
/// its own visible window unless we ask for none.
#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() }.is_null() {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(not(windows))]
fn hide_console(_: &mut Command) {}

/// What the router saw in claude's output so far, shared with the threads that may leave.
#[derive(Default)]
struct Seen {
    /// The last `background_tasks_changed` roster: background agents and commands still running.
    tasks: Vec<Value>,
    /// The launch model plus every model an assistant message (main thread or agent) came from,
    /// with when it was last seen.
    models: Vec<(String, u64)>,
    /// This turn so far: the `rateLimitType` of each refusal the API sent.
    refused: Vec<String>,
    /// This turn so far: claude's own message on the main thread said `rate_limit`.
    limit_error: bool,
    /// Messages T3 sent that no `result` has answered yet. One result may answer several (claude
    /// runs messages sent close together as one turn), so a result that ends T3's turn answers all
    /// sent before it.
    pending: u32,
    /// The main thread is answering (also on its own, after a background task finished, and while
    /// claude retries its request).
    answering: bool,
    /// When the last `result` went to T3, when T3's last message went to claude, and when claude
    /// last said it is compacting the context before answering.
    last_result_ms: u64,
    last_write_ms: u64,
    last_busy_ms: u64,
    /// T3 was told the latest limited turn resets at this time (unix ms): the router must be gone
    /// by then.
    promised_ms: Option<u64>,
    /// T3 wrote to claude after its input was closed: that turn fails when the router exits.
    late_input: bool,
}

/// A message claude shows no sign of starting on this long after the last result, write or
/// compacting notice is taken as answered (folded into a turn claude started itself without a
/// trace): the count cannot hold the router forever.
const WAITING_MS: u64 = 180_000;

/// How a `result` line stands for T3 (as its server handles turns).
struct Ending {
    /// Cut short by an interrupt or by a message T3 steered into the turn.
    aborted: bool,
    /// A turn claude started itself (a background task finished...) that answers no message of T3.
    own: bool,
    /// T3 counts the turn as failed.
    failed: bool,
}

fn ending(v: &Value) -> Ending {
    let aborted = matches!(v["terminal_reason"].as_str(), Some("aborted_streaming" | "aborted_tools"));
    let answered = v["user_message_uuids"].as_array().is_some_and(|a| !a.is_empty()) || v["user_message_uuid"].is_string();
    let failed_reason = matches!(v["terminal_reason"].as_str(), Some("blocking_limit" | "api_error"));
    Ending {
        aborted,
        own: v["origin"]["kind"].as_str().is_some_and(|k| k != "human") && !answered,
        failed: !aborted && (v["subtype"] != "success" || v["is_error"] == true || v["api_error_status"] == 429 || failed_reason),
    }
}

impl Seen {
    /// A message of T3 is waiting for claude to start on it.
    fn waiting(&self) -> bool {
        self.pending > 0 && now_ms() < self.last_result_ms.max(self.last_write_ms).max(self.last_busy_ms) + WAITING_MS
    }

    fn turn_open(&self) -> bool {
        self.answering || self.waiting()
    }

    /// The result does not end T3's turn: T3 steered a message into it (T3 skips such a result),
    /// or claude answered something of its own while a message of T3 waits to run next.
    fn goes_on(&self, e: &Ending) -> bool {
        let steered = e.aborted && self.pending > if e.own { 0 } else { 1 } && self.waiting();
        steered || (e.own && self.pending > 0)
    }

    /// The result went to T3. `goes_on` and `sent` (pending) were taken when it was read: a
    /// message T3 sent while the router held the result is not answered by it.
    fn result_out(&mut self, goes_on: bool, own: bool, sent: u32) {
        self.answering = false;
        self.last_result_ms = now_ms();
        if !goes_on {
            self.pending = self.pending.saturating_sub(sent);
        } else if !own {
            self.pending = self.pending.saturating_sub(1);
        }
    }
}

fn model_names(models: &[(String, u64)]) -> Vec<String> {
    models.iter().map(|(m, _)| m.clone()).collect()
}

/// Asked after a turn whether the next turn should run elsewhere, on usage data as fresh as asked.
type Recheck = dyn Fn(&[String], Data) -> Option<Move> + Send + Sync;

/// Everything `run` needs besides the account.
struct Launch<'a> {
    cfg: &'a Config,
    args: Vec<OsString>,
    state: PathBuf,
    log: Log,
    home: PathBuf,
    session: Option<String>,
    overage_scope: Option<String>,
    recheck: Option<Arc<Recheck>>,
    tracker: Arc<Tracker>,
}

/// Runs claude.exe, passing stdin and stdout through. Returns the exit code for T3.
fn run(launch: Launch, account: &Account, models: Vec<(String, u64)>) -> i32 {
    let Launch { cfg, args, state, log, home, session, overage_scope, recheck, tracker } = launch;
    let mut cmd = Command::new(&cfg.claude_exe);
    cmd.args(&args)
        .env("CLAUDE_CONFIG_DIR", &account.config_dir)
        .env(MARK_VAR, &account.config_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for v in CREDENTIAL_VARS {
        cmd.env_remove(v);
    }
    if cfg.route_nested {
        // `claude` typed in a chat finds the router first; nothing outside this process tree changes.
        let mut path = OsString::from(home.as_os_str());
        if let Some(old) = std::env::var_os("PATH") {
            path.push(";");
            path.push(old);
        }
        cmd.env("PATH", path);
    }
    hide_console(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log.write(json!({"event": "spawn_failed", "error": e.to_string()}));
            eprintln!("claude-router: cannot start {}: {e}", cfg.claude_exe.display());
            return 1;
        }
    };
    let child_pid = child.id();
    let child_stdin = Arc::new(Mutex::new(child.stdin.take()));
    // How many user messages T3 has sent so far; a switch is called off if this changes.
    let user_messages = Arc::new(AtomicU64::new(0));
    let seen = Arc::new(Mutex::new(Seen { models, ..Seen::default() }));
    {
        let child_stdin = Arc::clone(&child_stdin);
        let user_messages = Arc::clone(&user_messages);
        let seen = Arc::clone(&seen);
        let log = log.clone();
        std::thread::spawn(move || {
            let mut input = io::stdin().lock();
            let mut line = Vec::with_capacity(1 << 16);
            loop {
                line.clear();
                match input.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let is_user = contains(&line, b"\"type\":\"user\"") && top_type(&line).as_deref() == Some("user");
                let mut guard = child_stdin.lock().unwrap();
                let Some(stdin) = guard.as_mut() else {
                    // Too late: claude's input is already closed for a switch. The router exits
                    // as soon as no turn runs, and T3 reports this turn as failed, so it is not
                    // lost silently.
                    log.write(json!({"event": "input_after_leaving", "user_message": is_user}));
                    seen.lock().unwrap().late_input = true;
                    break;
                };
                if is_user {
                    // Counted before claude can answer it.
                    user_messages.fetch_add(1, Ordering::SeqCst);
                    let mut s = seen.lock().unwrap();
                    s.pending += 1;
                    s.last_write_ms = now_ms();
                }
                if stdin.write_all(&line).is_err() {
                    break;
                }
            }
            // T3 closed our stdin: close claude's too so it finishes the same way.
            child_stdin.lock().unwrap().take();
        });
    }
    let Some(out) = child.stdout.take() else { return 1 };
    let mut reader = BufReader::with_capacity(1 << 16, out);
    let mut writer = io::stdout().lock();
    let mut line = Vec::with_capacity(1 << 16);
    let interrupted = session.as_ref().map(|id| state.join("interrupted").join(format!("{id}.json")));
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let is_result = contains(&line, b"\"type\":\"result\"") && top_type(&line).as_deref() == Some("result");
        // What the result answers is fixed as it is read, before it may be held below.
        let read = is_result.then(|| {
            let end = ending(&serde_json::from_slice::<Value>(&line).unwrap_or(Value::Null));
            let s = seen.lock().unwrap();
            (s.goes_on(&end), end.own, s.pending)
        });
        // Decided before the result goes out: a refusal that lets the thread go on elsewhere is
        // told to T3 inside this turn.
        let decision = match (&recheck, is_result) {
            (Some(recheck), true) => Some(decide_after_turn(recheck.as_ref(), &line, &seen, &state, &log, account, session.as_deref())),
            _ => None,
        };
        if let Some((_, Some(events))) = &decision {
            if writer.write_all(events).and_then(|_| writer.flush()).is_err() {
                let _ = child.kill();
                break;
            }
        }
        if writer.write_all(&line).and_then(|_| writer.flush()).is_err() {
            // T3 is gone; nothing would read claude's output any more.
            let _ = child.kill();
            break;
        }
        // The result first: its text may quote anything, event names included.
        if let Some((goes_on, own, sent)) = read {
            // Only now, with the result in T3's hands, is the turn over for the router too.
            seen.lock().unwrap().result_out(goes_on, own, sent);
            tracker.save();
            let Some((Some((first, by_flag)), _)) = decision else { continue };
            let Some(recheck) = &recheck else { continue };
            after_turn(LeaveCtx {
                first,
                by_flag,
                account: account.name.clone(),
                child_stdin: Arc::clone(&child_stdin),
                child_pid,
                user_messages: Arc::clone(&user_messages),
                seen: Arc::clone(&seen),
                log: log.clone(),
                recheck: Arc::clone(recheck),
                interrupted: interrupted.clone(),
                tracker: Arc::clone(&tracker),
            });
        } else if line.starts_with(b"{\"type\":\"assistant\"") {
            let main_thread = contains(&line, b"\"parent_tool_use_id\":null");
            let mut s = seen.lock().unwrap();
            if main_thread {
                s.answering = true;
            }
            if let Some(model) = line_model(&line) {
                let now = now_ms();
                // Stamped again at most hourly: a thread forgets models it stopped using.
                let fresh = s.models.iter().any(|(m, t)| *m == model && now.saturating_sub(*t) < 3_600_000);
                if !fresh {
                    s.models.retain(|(m, _)| *m != model);
                    s.models.push((model, now));
                    if let Some(id) = &session {
                        write_session(&state, id, &account.name, &s.models);
                    }
                }
            }
            if main_thread && contains(&line, b"\"error\":\"rate_limit\"") {
                s.limit_error = true;
            }
            drop(s);
            on_account_error(&line, account, &state, &log);
            if contains(&line, b"\"usage\"") {
                if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                    tracker.on_message(&v);
                }
            }
        } else if line.starts_with(b"{\"type\":\"stream_event\"") {
            // The first sign of a turn while the model still thinks (T3 asks for partial messages).
            if contains(&line, b"\"message_start\"") && serde_json::from_slice::<Value>(&line).is_ok_and(|v| v["parent_tool_use_id"].is_null() && v["event"]["type"] == "message_start") {
                seen.lock().unwrap().answering = true;
            }
        } else if contains(&line, b"\"rate_limit_event\"") {
            if let Some(kind) = on_rate_limit(&line, account, &state, &log, overage_scope.as_deref()) {
                let scope = match kind.as_str() {
                    "seven_day_overage_included" => Some(overage_scope.as_deref().unwrap_or("fable")),
                    k => k.strip_prefix("seven_day_"),
                };
                if scope.is_some_and(|s| s.eq_ignore_ascii_case("fable")) {
                    tracker.on_fable_refused();
                }
                let mut s = seen.lock().unwrap();
                if !s.refused.contains(&kind) {
                    s.refused.push(kind);
                }
            }
        } else if contains(&line, b"\"background_tasks_changed\"") {
            if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                if v["subtype"] == "background_tasks_changed" {
                    seen.lock().unwrap().tasks = v["tasks"].as_array().cloned().unwrap_or_default();
                }
            }
        } else if contains(&line, b"\"api_retry\"") || contains(&line, b"\"compacting\"") {
            // Busy before the first line of an answer: retrying the request of a turn that runs or
            // is waited for (the turn ends with its result), or compacting the context (repeated
            // every 30 s; it may come from a background agent too, so it only keeps a waiting
            // message waiting).
            let v = serde_json::from_slice::<Value>(&line).unwrap_or(Value::Null);
            let mut s = seen.lock().unwrap();
            if v["type"] == "system" && v["subtype"] == "api_retry" && s.pending > 0 {
                s.answering = true;
            } else if v["type"] == "system" && v["subtype"] == "status" && v["status"] == "compacting" {
                s.last_busy_ms = now_ms();
            }
        }
    }
    child.wait().ok().and_then(|s| s.code()).unwrap_or(1)
}

/// At the end of a turn: should the next one run elsewhere (and was that forced by the test flag)?
/// If the turn failed on a limit and another account has room, also the refusal events that tell
/// T3 the limit resets in RESUME_AFTER_S, one per refused kind (T3 keeps the latest per kind and
/// resumes at the latest of them); claude sends no event at all when it refused within 30 s.
/// An aborted result decides nothing: after a steer T3 skips it and the turn goes on (its refusals
/// count at the end), after an interrupt T3 closes the process anyway.
fn decide_after_turn(
    recheck: &dyn Fn(&[String], Data) -> Option<Move>,
    result: &[u8],
    seen: &Mutex<Seen>,
    state: &Path,
    log: &Log,
    account: &Account,
    session: Option<&str>,
) -> (Option<(Move, bool)>, Option<Vec<u8>>) {
    let v = serde_json::from_slice::<Value>(result).unwrap_or(Value::Null);
    let end = ending(&v);
    if end.aborted {
        return (None, None);
    }
    let (refused, limit_error, models, promised) = {
        let mut s = seen.lock().unwrap();
        // claude's own turn while a message of T3 waits: T3 put this turn's refusal events into
        // that waiting turn, so they count again at its result.
        let refused = if end.own && s.pending > 0 { s.refused.clone() } else { std::mem::take(&mut s.refused) };
        (refused, std::mem::take(&mut s.limit_error), model_names(&s.models), s.promised_ms)
    };
    let flag = state.join("switch-after-turn");
    if flag.exists() {
        let _ = fs::remove_file(&flag);
        return (Some((Move { reason: "switch-after-turn flag".into(), kind: Leave::Soft, target_has_quota: true, notice: None, resume_at_ms: None }, true)), None);
    }
    // T3 resumes only a failed turn; a successful one (agents refused, the thread went on) is
    // done whatever events came before its result.
    let limited = (!refused.is_empty() || limit_error) && end.failed;
    let promise_open = promised.is_some_and(|t| t > now_ms());
    // A turn that failed on a limit of its own (claude's message may be the only sign) is judged on
    // the newest data, unless a promise is already running and the data was refreshed for it. Any
    // other result (one model refused for agents, the turn failed for another reason) goes to T3 at once.
    let whole_account = refused.iter().any(|k| matches!(k.as_str(), "five_hour" | "seven_day" | "unknown"));
    let data = if end.failed && (limit_error || whole_account) && !promise_open { Data::Newest } else { Data::AsIs };
    let Some(mut m) = recheck(&models, data) else { return (None, None) };
    if !(limited && (m.target_has_quota || m.resume_at_ms.is_some()) && (m.kind == Leave::Blocked || limit_error)) {
        return (Some((m, false)), None);
    }
    let soon = now_ms() + RESUME_AFTER_S * 1000;
    let at_ms = if m.target_has_quota { soon } else { m.resume_at_ms.unwrap_or(soon).max(soon) };
    let id = v["session_id"].as_str().or(session).unwrap_or("");
    let kinds = if refused.is_empty() { vec!["five_hour".to_string()] } else { refused };
    let events: Vec<u8> = kinds.iter().flat_map(|k| refusal_event(id, k, at_ms / 1000)).collect();
    // T3 keeps the latest time it was told: the router leaves by the latest promise. A promise far
    // ahead (no account has room until then) is not waited for: the router leaves as after any
    // refusal and T3 resumes the thread then.
    if at_ms == soon {
        seen.lock().unwrap().promised_ms = Some(at_ms);
    }
    log.write(json!({"event": "refusal_reported", "account": account.name, "reason": m.reason, "kinds": kinds, "in_s": (at_ms - soon) / 1000 + RESUME_AFTER_S}));
    m.kind = Leave::Blocked;
    (Some((m, false)), Some(events))
}

struct LeaveCtx {
    first: Move,
    /// The move was asked for with the test flag: no second look at the data.
    by_flag: bool,
    account: String,
    child_stdin: Arc<Mutex<Option<ChildStdin>>>,
    child_pid: u32,
    user_messages: Arc<AtomicU64>,
    seen: Arc<Mutex<Seen>>,
    log: Log,
    recheck: Arc<Recheck>,
    interrupted: Option<PathBuf>,
    tracker: Arc<Tracker>,
}

/// The next turn should run elsewhere. Unless the account is refused or its login is dead, wait
/// LEAVE_GRACE for a new message from T3 and confirm the move with fresh usage data. Then close
/// claude's input: claude finishes and exits, its last output still flows to T3, and T3's next
/// message (or its own resume after a limit) starts a new process that can go to another account.
/// If background tasks keep claude running, it is ended a little later; background commands stay
/// alive, and the next process tells the model about them.
///
/// A Blocked move closes the input only between turns: BLOCKED_GRACE after the last result, so a
/// message T3 queued still reaches claude (and fails there with the real reason), and after a
/// promise to T3 not before PROMISE_CLOSE_BEFORE ahead of the latest promised time. The router is
/// gone PROMISE_EXIT_BEFORE before that time. A running turn is never cut: T3 would fail it.
fn after_turn(ctx: LeaveCtx) {
    let messages_before = ctx.user_messages.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        let LeaveCtx { first: mut m, by_flag, account, child_stdin, child_pid, user_messages, seen, log, recheck, interrupted, tracker } = ctx;
        let busy = || !seen.lock().unwrap().tasks.is_empty();
        let promise = || seen.lock().unwrap().promised_ms.filter(|&t| t > now_ms());
        let ms = |d: Duration| d.as_millis() as u64;
        if promise().is_some() {
            m.kind = Leave::Blocked;
        }
        if m.kind == Leave::Soft && busy() {
            log.write(json!({"event": "stays_for_background_tasks", "account": account, "reason": m.reason, "tasks": seen.lock().unwrap().tasks.len()}));
            return;
        }
        let called_off = |why: &str, m: &Move| log.write(json!({"event": "leave_called_off", "account": account, "reason": m.reason, "why": why}));
        if m.kind != Leave::Blocked {
            std::thread::sleep(LEAVE_GRACE);
            if user_messages.load(Ordering::SeqCst) != messages_before {
                return called_off("T3 sent another message", &m);
            }
            if !by_flag {
                let models = model_names(&seen.lock().unwrap().models);
                match recheck(&models, Data::Fresh) {
                    None => return called_off("fresh usage data says stay", &m),
                    Some(fresh) => m = fresh,
                }
            }
            if m.kind == Leave::Soft && busy() {
                return called_off("background tasks are running", &m);
            }
        }
        loop {
            if m.kind == Leave::Blocked {
                let (open, last) = {
                    let s = seen.lock().unwrap();
                    (s.turn_open(), s.last_result_ms)
                };
                let not_before = (last + ms(BLOCKED_GRACE)).max(promise().map_or(0, |at| at.saturating_sub(ms(PROMISE_CLOSE_BEFORE))));
                if open || now_ms() < not_before {
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
            }
            let mut guard = child_stdin.lock().unwrap();
            if guard.is_none() {
                return;
            }
            if m.kind != Leave::Blocked {
                if user_messages.load(Ordering::SeqCst) != messages_before {
                    return called_off("T3 sent another message", &m);
                }
                if promise().is_some() {
                    return called_off("a promise to T3 is running, its own leave closes the input", &m);
                }
                if seen.lock().unwrap().turn_open() {
                    // claude answers a finished background task; its result decides again.
                    return called_off("a turn is running", &m);
                }
            } else if seen.lock().unwrap().turn_open() {
                // A message got in while this thread was waiting for the lock.
                continue;
            }
            if let (Some(notice), Some(path)) = (&m.notice, &interrupted) {
                write_json(path, &json!({"account": account, "ts": now_ms(), "reason": m.reason, "tasks": [], "notice": notice}));
            }
            guard.take();
            break;
        }
        let closed = now_ms();
        log.write(json!({"event": "leaving_after_result", "account": account, "reason": m.reason, "kind": format!("{:?}", m.kind), "promised_ms": promise()}));
        // Without background tasks claude exits within seconds, and the router with it. A turn
        // still running (claude answering a finished background task) is let finish. Input closed
        // late (a turn ran close to the promised time): that later turn is what T3 goes by, claude
        // still gets a few seconds to exit by itself.
        // T3 writing to the closed input fails its turn only when the router exits: exit at once.
        loop {
            let (open, late, promised) = {
                let s = seen.lock().unwrap();
                (s.turn_open(), s.late_input, s.promised_ms.filter(|&at| at > closed))
            };
            let exit_at = promised.map_or(closed + 30_000, |at| at.saturating_sub(ms(PROMISE_EXIT_BEFORE)).max(closed + 5_000));
            if (now_ms() >= exit_at || late) && !open {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let tasks = seen.lock().unwrap().tasks.clone();
        if let (false, Some(path)) = (tasks.is_empty(), &interrupted) {
            write_json(path, &json!({"account": account, "ts": now_ms(), "reason": m.reason, "tasks": tasks, "notice": m.notice}));
        }
        if tasks.iter().any(|t| t["task_type"] == "local_bash") {
            end_claude_keep_commands(child_pid);
            log.write(json!({"event": "claude_ended_commands_kept", "account": account, "tasks": tasks}));
        } else {
            // The job object takes claude and its agents with the router.
            log.write(json!({"event": "claude_did_not_exit", "account": account, "tasks": tasks}));
        }
        tracker.finish();
        std::process::exit(0);
    });
}

/// A note for the model about what the last account switch interrupted, and about an account
/// that needs /login; read once.
fn take_interrupted_note(state: &Path, id: &str) -> Option<String> {
    let path = state.join("interrupted").join(format!("{id}.json"));
    let v = read_json(&path)?;
    let _ = fs::remove_file(&path);
    let tasks = v["tasks"].as_array().cloned().unwrap_or_default();
    let line = |t: &Value| format!("- {} {}: {}", t["task_type"].as_str().unwrap_or("task"), t["task_id"].as_str().unwrap_or("?"), t["description"].as_str().unwrap_or(""));
    let agents: Vec<String> = tasks.iter().filter(|t| t["task_type"] != "local_bash").map(line).collect();
    let commands: Vec<String> = tasks.iter().filter(|t| t["task_type"] == "local_bash").map(line).collect();
    let mut parts = Vec::new();
    if !agents.is_empty() {
        parts.push(format!(
            "These background agents were stopped with the previous process, their results will not arrive:\n{}\n\
             An agent's transcript is kept: you can continue it with SendMessage to its agent id, or start the work again.",
            agents.join("\n")
        ));
    }
    if !commands.is_empty() {
        parts.push(format!(
            "These background commands may still be running as separate processes; no completion notice will come for them:\n{}\n\
             Their output keeps going to %TEMP%\\claude\\<project folder>\\{id}\\tasks\\<task id>.output. Check it, and stop a command that is no longer needed.",
            commands.join("\n")
        ));
    }
    if let Some(notice) = v["notice"].as_str() {
        parts.push(notice.to_string());
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "Note from the account router: this conversation was moved to another Claude account ({}).\n\n{}\n\nBefore going on, tell the user about this.",
        v["reason"].as_str().unwrap_or("the previous one could not go on"),
        parts.join("\n\n")
    ))
}

/// The account a session last ran on, and the models it used within MODEL_MEMORY_MS.
fn read_session(state: &Path, id: &str, now: u64) -> (Option<String>, Vec<(String, u64)>) {
    let dir = state.join("sessions");
    if let Some(v) = read_json(&dir.join(format!("{id}.json"))) {
        // Older routers wrote a plain list without times: such models are not trusted.
        let models = v["models"]
            .as_object()
            .map(|m| m.iter().filter_map(|(k, t)| t.as_u64().filter(|&t| now.saturating_sub(t) < MODEL_MEMORY_MS).map(|t| (k.clone(), t))).collect())
            .unwrap_or_default();
        return (v["account"].as_str().map(str::to_string), models);
    }
    (fs::read_to_string(dir.join(format!("{id}.txt"))).ok().map(|s| s.trim().to_string()), Vec::new())
}

fn write_session(state: &Path, id: &str, account: &str, models: &[(String, u64)]) {
    let models: serde_json::Map<String, Value> = models.iter().map(|(m, t)| (m.clone(), json!(t))).collect();
    update_session(state, id, |v| {
        v["account"] = json!(account);
        v["models"] = Value::Object(models);
    });
}

/// Read-modify-write of `sessions/<id>.json`: the account and models, and for the strategy what the
/// thread spent (`burn`), where it was put (`home`) and when it last moved (`last_move_ms`).
fn update_session(state: &Path, id: &str, change: impl FnOnce(&mut Value)) {
    let path = state.join("sessions").join(format!("{id}.json"));
    let mut v = match read_json(&path).filter(Value::is_object) {
        Some(v) => v,
        // Being replaced right now: a second look; still unreadable, it is left as it is rather than
        // lose the account and models in it, unless it has been broken for a while.
        None if path.exists() => {
            std::thread::sleep(Duration::from_millis(50));
            match read_json(&path).filter(Value::is_object) {
                Some(v) => v,
                None if fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(10)) => json!({}),
                None => return,
            }
        }
        None => json!({}),
    };
    change(&mut v);
    write_json(&path, &v);
}

/// The list of live threads: `state/threads/<router pid>-<its start ms>.json` for every router
/// that runs a thread. Written when its account is chosen, so starts seconds apart see each other,
/// and as it spends; removed when it exits. Readers delete the files of routers that are gone
/// (killed, or the PC was switched off): their pid is not running, or belongs to a process that
/// started at another time.
fn threads_dir(state: &Path) -> PathBuf {
    state.join("threads")
}

/// When this process started (unix ms), if it is running.
#[cfg(windows)]
fn process_started_ms(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        let mut code = 0u32;
        let running = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE && GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) != 0;
        CloseHandle(h);
        // FILETIME counts 100 ns from 1601.
        let t = (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64) / 10_000;
        running.then(|| t.saturating_sub(11_644_473_600_000))
    }
}

#[cfg(not(windows))]
fn process_started_ms(pid: u32) -> Option<u64> {
    Path::new(&format!("/proc/{pid}")).exists().then_some(0)
}

/// The other threads live now (a call or a start within LIVE_MS, or a start held for later), as the
/// strategy sees them. The files of routers that are gone are deleted on the way.
fn live_threads(cfg: &Config, state: &Path, now: u64, own_session: Option<&str>) -> Vec<Thread> {
    let me = std::process::id();
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(threads_dir(state)) else { return out };
    for path in entries.flatten().map(|e| e.path()) {
        if path.extension().is_none_or(|x| x != "json") {
            // A write cut short (write_json's temporary file) or the choice lock.
            if path.extension().is_some_and(|x| x.to_string_lossy().starts_with("tmp")) && fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(600)) {
                let _ = fs::remove_file(&path);
            }
            continue;
        }
        // Being replaced right now: skipped this time.
        let Some(v) = read_json(&path) else { continue };
        let pid = v["pid"].as_u64().unwrap_or(0) as u32;
        if !process_started_ms(pid).is_some_and(|t| t.abs_diff(v["started_ms"].as_u64().unwrap_or(0)) < 2000) {
            let _ = fs::remove_file(&path);
            continue;
        }
        if pid == me || own_session.is_some_and(|s| v["session"].as_str() == Some(s)) {
            continue;
        }
        let index = |k: &Value| k.as_str().and_then(|n| cfg.accounts.iter().position(|a| a.name == n));
        let w = &v["waiting"];
        let waiting = index(&w["account"]).map(|a| (a, w["at_ms"].as_u64().unwrap_or(now), w["b"].as_f64().unwrap_or(strategy::B0_NEW)));
        let burn = Burn::from_json(&v["burn"]);
        if waiting.is_none() && now.saturating_sub(burn.last_ms.max(v["booked_ms"].as_u64().unwrap_or(0))) > strategy::LIVE_MS {
            continue;
        }
        // A held start books itself again at every look (RECHECK_MS at most); one that stopped looking (its
        // process is stuck or suspended) no longer holds a place.
        if waiting.is_some() && now.saturating_sub(v["updated_ms"].as_u64().unwrap_or(0)) > strategy::RECHECK_MS + 10 * 60_000 {
            continue;
        }
        let mut t = Thread::new(Kind::parse(v["kind"].as_str().unwrap_or("")), burn, v["fable"] == true);
        t.account = index(&v["account"]);
        t.waiting = waiting;
        out.push(t);
    }
    out
}

/// This router's thread in the list of live threads, and what it spends: the usage of every API call
/// in claude's output, priced as the limits count it (`strategy::call_cost`).
struct Tracker {
    path: PathBuf,
    state: PathBuf,
    /// The kept session: what the thread spent goes there too, for its next process.
    session: Option<String>,
    inner: Mutex<Tracked>,
}

struct Tracked {
    record: Value,
    burn: Burn,
    fable: bool,
    /// Messages counted lately, with their cost and when last seen: claude writes a message once per
    /// content block, its usage repeated.
    counted: Vec<(String, f64, u64)>,
    saved_ms: u64,
    booked: bool,
}

impl Tracker {
    fn new(state: &Path, session: Option<String>, kind: Kind, cwd: &str, burn: Burn, fable: bool) -> Tracker {
        let pid = std::process::id();
        let started = process_started_ms(pid).unwrap_or(0);
        let record = json!({"pid": pid, "started_ms": started, "session": session, "kind": kind.name(), "cwd": cwd,
            "account": null, "booked_ms": 0, "waiting": null});
        let _ = fs::create_dir_all(threads_dir(state));
        Tracker {
            // The start time in the name: a reader deleting the file of a router that is gone never hits the
            // file of a new router that got the same pid.
            path: threads_dir(state).join(format!("{pid}-{started}.json")),
            state: state.to_path_buf(),
            session,
            inner: Mutex::new(Tracked { record, burn, fable, counted: Vec::new(), saved_ms: 0, booked: false }),
        }
    }

    /// Puts the thread on an account in the list; a held start is promised there at `at_ms`, with
    /// this burn counted for it.
    fn book(&self, account: &str, waiting: Option<(u64, f64)>) {
        let mut t = self.inner.lock().unwrap();
        t.record["account"] = json!(account);
        t.record["booked_ms"] = json!(now_ms());
        t.record["waiting"] = waiting.map_or(Value::Null, |(at, b)| json!({"account": account, "at_ms": at, "b": b}));
        t.booked = true;
        self.write(&mut t, false);
    }

    fn write(&self, t: &mut Tracked, session_too: bool) {
        t.saved_ms = now_ms();
        t.record["updated_ms"] = json!(t.saved_ms);
        t.record["fable"] = json!(t.fable);
        t.record["burn"] = t.burn.to_json();
        if t.booked {
            write_json(&self.path, &t.record);
        }
        if let (true, Some(id)) = (session_too, &self.session) {
            let burn = t.burn.to_json();
            update_session(&self.state, id, |v| v["burn"] = burn);
        }
    }

    /// An assistant message of the main thread or an agent.
    fn on_message(&self, v: &Value) {
        let m = &v["message"];
        let (Some(model), Some(id)) = (m["model"].as_str(), m["id"].as_str()) else { return };
        if model.starts_with('<') || !m["usage"].is_object() {
            return;
        }
        let cost = strategy::call_cost(model, &m["usage"]);
        let fable = model.to_lowercase().contains("fable");
        let now = now_ms();
        let mut t = self.inner.lock().unwrap();
        // A message's blocks come within its response; many agents may answer in between.
        t.counted.retain(|c| now.saturating_sub(c.2) < COUNTED_MS);
        let before = t.counted.iter().position(|c| c.0 == id);
        let added = (cost - before.map_or(0.0, |i| t.counted[i].1)).max(0.0);
        match before {
            Some(i) => {
                t.counted[i].1 = t.counted[i].1.max(cost);
                t.counted[i].2 = now;
            }
            None => t.counted.push((id.to_string(), cost, now)),
        }
        if before.is_none() || added > 0.0 {
            t.burn.add(now, added, fable);
        }
        t.fable |= fable;
        if now.saturating_sub(t.saved_ms) >= SAVE_EVERY_MS {
            self.write(&mut t, true);
        }
    }

    fn on_fable_refused(&self) {
        let mut t = self.inner.lock().unwrap();
        t.burn.fable_refused_ms = now_ms();
        self.write(&mut t, true);
    }

    fn save(&self) {
        let mut t = self.inner.lock().unwrap();
        self.write(&mut t, true);
    }

    fn snapshot(&self) -> (Burn, bool) {
        let t = self.inner.lock().unwrap();
        (t.burn.clone(), t.fable)
    }

    /// The router exits: what the thread spent stays with its session, it leaves the list.
    fn finish(&self) {
        let mut t = self.inner.lock().unwrap();
        if !t.booked {
            return;
        }
        self.write(&mut t, true);
        t.booked = false;
        let _ = fs::remove_file(&self.path);
    }
}

fn read_snapshot(cfg: &Config) -> Result<Value, String> {
    fs::read_to_string(&cfg.usage_json)
        .map_err(|e| format!("cannot read uzalka snapshot: {e}"))
        .and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).map_err(|e| format!("bad uzalka snapshot: {e}")))
}

fn read_forced(state: &Path) -> Option<String> {
    fs::read_to_string(state.join("force-account.txt")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Every account (by index) and the other live threads, as the strategy sees them now.
fn strategy_world(cfg: &Config, state: &Path, snapshot: &Result<Value, String>, now: u64, session: Option<&str>) -> (Vec<Acc>, Vec<Thread>) {
    let accs = cfg.accounts.iter().map(|a| account_view(cfg, state, snapshot, a, now)).collect();
    (accs, live_threads(cfg, state, now, session))
}

fn rows_json(cfg: &Config, rows: &[strategy::Row]) -> Value {
    json!(rows.iter().map(|r| r.to_json(&cfg.accounts[r.acc].name)).collect::<Vec<_>>())
}

/// The strategy's account for a starting process.
enum Start {
    Run(usize, String),
    /// A new claude -p run no account admits now: it waits for the plan.
    Hold(Plan, String),
}

/// The strategy's choice when a process starts: a new T3 chat is placed; a T3 chat
/// that comes back (its process had ended) is judged as at a turn boundary, after its idle time; a
/// claude -p run goes through admission. None: no account can be judged, the default rules decide.
fn strategy_start(cfg: &Config, world: &World, me: &Thread, idle_ms: u64) -> Option<(Start, Value)> {
    let now = world.now;
    let name = |a: usize| cfg.accounts[a].name.clone();
    if me.kind == Kind::Cli {
        let (plan, rows) = world.plan(me)?;
        let in_h = |t: u64| (t.saturating_sub(now) as f64 / 3_600_000.0 * 10.0).round() / 10.0;
        let log = json!({"rule": "admission", "rows": rows_json(cfg, &rows), "plan": {"account": name(plan.acc), "in_h": in_h(plan.at), "admitted": plan.admitted}});
        if plan.admitted && plan.at <= now {
            return Some((Start::Run(plan.acc, "claude -p admitted: the 5-hour window carries it with the threads there".into()), log));
        }
        let why = if plan.admitted {
            format!("no 5-hour window carries this claude -p now; {} admits it in {} h", name(plan.acc), in_h(plan.at))
        } else {
            format!("no account admits this claude -p within 3 windows; the least loaded is {} in {} h", name(plan.acc), in_h(plan.at))
        };
        return Some((Start::Hold(plan, why), log));
    }
    if let Some(a) = me.account {
        let rows = world.rows(me, me.bhat(now, world.accs[a].cap[0]), strategy::R_STAY, None);
        let log = json!({"rule": "turn", "idle_min": idle_ms / 60_000, "rows": rows_json(cfg, &rows)});
        return Some(match world.at_turn(me, idle_ms) {
            Turn::Move { to, why, .. } => (Start::Run(to, format!("moves from {}: {why}", name(a))), log),
            Turn::Stay(why) => (Start::Run(a, format!("stays on the session's account: {why}")), log),
        });
    }
    let (a, why, rows) = world.place(me)?;
    Some((Start::Run(a, format!("new thread: {why}")), json!({"rule": "place", "rows": rows_json(cfg, &rows)})))
}

/// After a turn, by the strategy: leave only when the account is about to run out; a
/// cold move waits for the next start. An account that cannot serve is left in any case, as by the
/// default rules; when no account has room, T3 may resume the thread when the first one frees up.
#[allow(clippy::too_many_arguments)]
fn strategy_recheck(cfg: &Config, state: &Path, snapshot: &Result<Value, String>, allowed: &[usize], current: usize, tracker: &Tracker, models: &[String], own_models: &[String], session: Option<&str>, now: u64) -> Option<Move> {
    let (accs, others) = strategy_world(cfg, state, snapshot, now, session);
    let world = World { accs: &accs, allowed, others: &others, now };
    let (burn, fable) = tracker.snapshot();
    let mut me = Thread::new(Kind::T3, burn, fable || models.iter().any(|m| m.to_lowercase().contains("fable")));
    me.account = Some(current);
    me.home = Some(current);
    let here = &cfg.accounts[current];
    let own = score(cfg, state, snapshot, here, own_models, now);
    let notice = login_notice(here);
    // The thread starts again RESUME_AFTER_S later at the soonest and is judged anew then: at_turn leaves its
    // account only if that frees up more than 20 min later. A refused account that frees up sooner is waited
    // for, whatever is decided now, and another account freeing up helps only before that.
    let own_at = world.t_usable(current, &me);
    let (soon, guard) = (now + RESUME_AFTER_S * 1000, 20 * 60_000);
    let wait_own = blocked(&own) && own_at > now && own_at <= soon + guard;
    match world.at_turn(&me, 0) {
        Turn::Move { to, low, why, .. } if !wait_own => {
            // Low: under 5% of what the thread needs, it goes even while background tasks run. Fable short
            // alone does not end the background agents of a thread whose own model is not Fable.
            let v = &accs[current];
            let own_fable = own_models.iter().any(|m| m.to_lowercase().contains("fable"));
            let low = low && (own_fable || v.dead || (100.0 - v.u5).min(100.0 - v.u7) < strategy::R_STAY);
            let kind = match leave_kind(cfg, &own) {
                Leave::Soft if low && !blocked(&own) => Leave::Low,
                k => k,
            };
            Some(Move { reason: format!("next turn goes to {}: {why}", cfg.accounts[to].name), kind, target_has_quota: true, notice, resume_at_ms: None })
        }
        Turn::Stay(why) | Turn::Move { why, .. } if blocked(&own) => {
            // T3 resumes the thread when an account it would go to frees up, not every 90 s onto the same
            // refusal. A refusal the data does not show (own_at not ahead) gets no time from here.
            let first = world
                .first_usable(&me)
                .filter(|&(a, t)| a != current && t.max(soon) + guard < own_at)
                .or_else(|| wait_own.then_some((current, own_at)));
            let then = first.map(|(a, t)| format!("; {} frees up in {:.1} h", cfg.accounts[a].name, t.saturating_sub(now) as f64 / 3_600_000.0)).unwrap_or_default();
            Some(Move { reason: format!("this account cannot serve ({why}){then}"), kind: Leave::Blocked, target_has_quota: false, notice, resume_at_ms: first.map(|f| f.1) })
        }
        _ => None,
    }
}

/// For the model to pass on: the account's login is dead and needs /login.
fn login_notice(here: &Account) -> Option<String> {
    login_dead(here).then(|| {
        let dir = here.config_dir.display();
        format!("Claude account {} (folder {dir}) is signed out. Ask the user to sign it in again: run `claude` with CLAUDE_CONFIG_DIR={dir} and type /login.", here.name)
    })
}

/// Runs the real claude.exe untouched (environment included) and returns its exit code.
fn pass_through(cfg: &Config, args: &[OsString]) -> i32 {
    let mut cmd = Command::new(&cfg.claude_exe);
    cmd.args(args);
    hide_console(&mut cmd);
    cmd.status().ok().and_then(|s| s.code()).unwrap_or(1)
}

fn main() {
    let mut args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let explain = args.first().is_some_and(|a| a == "--router-explain");
    if explain {
        args.remove(0);
    }
    let text: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let exe = std::env::current_exe().unwrap_or_default();
    let home = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let state = home.join("state");
    for sub in ["live", "sessions", "backups", "usage", "interrupted", "threads"] {
        let _ = fs::create_dir_all(state.join(sub));
    }
    let log = Log { path: state.join("router.log") };
    let cfg = match load_config(&home.join("router.json")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("claude-router: {e}");
            std::process::exit(2);
        }
    };
    if same_file(&cfg.claude_exe, &exe) {
        eprintln!("claude-router: claude_exe in router.json points at the router itself");
        std::process::exit(2);
    }
    contain_children();

    // A `claude` started inside a chat comes here too. If its caller chose the account or
    // brought its own credentials, that is not the router's business.
    let incoming_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let mark = std::env::var(MARK_VAR).ok();
    let nested = mark.is_some();
    let picked_by_caller = nested && incoming_dir.as_deref().map(norm_path) != mark.as_deref().map(norm_path);
    let own_credentials = nested && CREDENTIAL_VARS.iter().any(|v| std::env::var_os(v).is_some());
    if (picked_by_caller || own_credentials) && !explain {
        log.write(json!({"event": "pass_through", "args": text, "config_dir": incoming_dir, "own_credentials": own_credentials}));
        std::process::exit(pass_through(&cfg, &args));
    }

    let now = now_ms();
    let cwd = std::env::current_dir().map(|p| norm_path(&p.to_string_lossy())).unwrap_or_default();
    let model = flag(&text, &["--model"]).unwrap_or_default();
    let resume = flag(&text, &["--resume", "-r"]);
    let new_session = flag(&text, &["--session-id"]);
    let persisted = !has_flag(&text, &["--no-session-persistence"]);
    let streaming = flag(&text, &["--input-format"]).as_deref() == Some("stream-json");
    let info_only = matches!(text.first().map(String::as_str), Some("--version" | "-v" | "--help" | "-h"));
    // T3's status check: shows the account's email, plan and quota, sends no prompt.
    let status_check = resume.is_none() && new_session.is_none() && !persisted && streaming && !has_flag(&text, &["-p", "--print"]);
    let face = cfg.face_account.filter(|_| info_only || status_check);
    let all: Vec<usize> = (0..cfg.accounts.len()).collect();
    let allowed: Vec<usize> = if face.is_some() { all.clone() } else { all.iter().copied().filter(|&i| allowed_here(&cfg.accounts[i], &cwd)).collect() };
    let session = resume.clone().or(new_session.clone());
    let (last_name, saved_models) = session.as_deref().map(|id| read_session(&state, id, now)).unwrap_or_default();
    let last_used = last_name.and_then(|name| cfg.accounts.iter().position(|a| a.name == name));
    let mut models: Vec<(String, u64)> = Some(model.clone()).into_iter().filter(|m| !m.is_empty()).map(|m| (m, now)).collect();
    for (m, t) in saved_models {
        if !models.iter().any(|(x, _)| *x == m) {
            models.push((m, t));
        }
    }
    let names = model_names(&models);
    let copies = session.as_deref().map(|id| find_copies(&cfg, id)).unwrap_or_default();
    let holder = pick_holder(&copies, last_used);
    let forced = read_forced(&state);

    // Usage data older than fresh_minutes is asked again before a real start decides on it.
    let fresh_ms = (cfg.fresh_minutes * 60_000.0) as u64;
    let thread_starts = !info_only && !status_check;
    let refreshed = thread_starts && refresh_stale(&cfg, &state, &allowed, &log, fresh_ms);
    let snapshot = read_snapshot(&cfg);
    let scores: Vec<Score> = cfg.accounts.iter().map(|a| score(&cfg, &state, &snapshot, a, &names, now_ms())).collect();

    // The thread as the strategy sees it: what it spent in earlier processes, its models, where it lives.
    // Only a T3 chat or a claude -p run is a thread; other starts (`claude mcp list`, `claude doctor`)
    // are neither listed nor held.
    let kind = if streaming { Kind::T3 } else { Kind::Cli };
    // Flags after `--` belong to another program (`claude mcp add x -- server -p 5432`).
    let own_args: Vec<String> = text.iter().take_while(|a| *a != "--").cloned().collect();
    let thread = thread_starts && (streaming || has_flag(&own_args, &["-p", "--print"]));
    // A fork is a thread of its own: it is listed and keeps what it spends, where it lives, under its new id.
    let own_id = if has_flag(&text, &["--fork-session"]) { new_session.clone().or(session.clone()) } else { session.clone() };
    let saved = own_id.as_deref().and_then(|id| read_json(&state.join("sessions").join(format!("{id}.json")))).unwrap_or(Value::Null);
    let holder_account = holder.map(|h| copies[h].account);
    let mut me = Thread::new(kind, Burn::from_json(&saved["burn"]), names.iter().any(|m| m.to_lowercase().contains("fable")));
    if kind == Kind::T3 {
        me.account = holder_account;
        me.home = saved["home"].as_str().and_then(|n| cfg.accounts.iter().position(|a| a.name == n)).or(holder_account);
        me.last_move_ms = saved["last_move_ms"].as_u64().unwrap_or(0);
    }
    // The transcript is written at every message: its time stands in for the last call of a thread
    // the router kept no record of.
    let last_call = holder.and_then(|h| copies[h].mtime.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64).max(me.burn.last_ms);
    let idle_ms = now.saturating_sub(last_call);
    let tracker = Arc::new(Tracker::new(&state, own_id.clone().filter(|_| persisted), kind, &cwd, me.burn.clone(), me.fable));
    let use_strategy = cfg.strategy && thread && face.is_none() && forced.is_none();
    let mut strategy_log;
    let mut held_since: Option<u64> = None;
    let (mut chosen, mut reason) = loop {
        // Chosen and booked under one lock: starts seconds apart see each other in the list.
        let (start, log_part) = locked(&threads_dir(&state).join("choose.lock"), || {
            let now = now_ms();
            let by_strategy = if use_strategy {
                let (accs, others) = strategy_world(&cfg, &state, &read_snapshot(&cfg), now, own_id.as_deref());
                strategy_start(&cfg, &World { accs: &accs, allowed: &allowed, others: &others, now }, &me, idle_ms)
            } else {
                None
            };
            let (start, log_part) = match (face, by_strategy) {
                (Some(f), _) if !blocked(&scores[f]) => (Start::Run(f, "status check or version: the face account".to_string()), Value::Null),
                (_, Some(s)) => s,
                _ => {
                    let (a, why) = choose(&cfg, &scores, &allowed, holder_account, forced.as_deref(), now);
                    (Start::Run(a, why), Value::Null)
                }
            };
            if thread && !explain {
                match &start {
                    Start::Run(a, _) => tracker.book(&cfg.accounts[*a].name, None),
                    Start::Hold(p, _) => tracker.book(&cfg.accounts[p.acc].name, Some((p.at, strategy::B0_NEW))),
                }
            }
            (start, log_part)
        });
        strategy_log = log_part;
        match start {
            Start::Run(a, why) => break (a, why),
            Start::Hold(plan, why) if explain => break (plan.acc, format!("{}: {why}", if cfg.cli_max_wait_ms == 0 { "would refuse" } else { "would wait" })),
            Start::Hold(plan, why) => {
                let now = now_ms();
                let first = held_since.is_none();
                let since = *held_since.get_or_insert(now);
                let left = (since + cfg.cli_max_wait_ms).saturating_sub(now);
                // What the caller sees: the run would start then (its caller may decide to wait or not).
                let clock = (plan.at / 60_000) % 1440;
                let why = if plan.admitted { format!("{why} (at {:02}:{:02} UTC)", clock / 60, clock % 60) } else { why };
                if left == 0 {
                    log.write(json!({"event": "start_given_up", "args": text, "cwd": cwd, "waited_min": (now - since) / 60_000, "why": why}));
                    tracker.finish();
                    let waited = if cfg.cli_max_wait_ms == 0 { "not waiting: cli_max_wait_minutes in router.json is 0".to_string() } else { format!("waited {} min", (now - since) / 60_000) };
                    eprintln!("claude-router: no Claude account has room for this run now: {why}; {waited}");
                    std::process::exit(1);
                }
                if first {
                    eprintln!("claude-router: no Claude account has room for this run now: {why}; waiting, at most {} min", left / 60_000);
                }
                // The held start counts on the account it is promised; it is looked at again then, or sooner.
                me.account = Some(plan.acc);
                me.waiting = Some((plan.acc, plan.at, strategy::B0_NEW));
                let wake = if plan.at > now { plan.at.min(now + strategy::RECHECK_MS) } else { now + strategy::RECHECK_MS };
                let sleep_ms = wake.saturating_sub(now).max(60_000).min(left);
                log.write(json!({"event": "start_held", "args": text, "cwd": cwd, "why": why, "wake_in_min": sleep_ms / 60_000, "strategy": strategy_log}));
                std::thread::sleep(Duration::from_millis(sleep_ms));
                refresh_stale(&cfg, &state, &allowed, &log, fresh_ms);
            }
        }
    };
    if let (None, Some(h)) = (&resume, holder) {
        // --session-id for a transcript that already exists (a retried first turn): claude.exe
        // continues it only where the file is, elsewhere it would start a blank chat.
        chosen = copies[h].account;
        reason = format!("session id already exists on {}, starting there", cfg.accounts[chosen].name);
    }
    let copy_from = holder.filter(|&h| resume.is_some() && copies[h].account != chosen);

    let decision = json!({
        "event": "start",
        "args": text,
        "cwd": cwd,
        "models": names,
        "resume": resume,
        "session_id": new_session,
        "incoming_config_dir": incoming_dir,
        "nested": nested,
        "refreshed": refreshed,
        "scores": cfg.accounts.iter().zip(&scores).map(|(a, s)| json!({
            "account": a.name,
            "allowed": allowed_here(a, &cwd),
            "left": s.as_ref().ok().map(|q| q.left),
            "weekly_reset_in_h": s.as_ref().ok().and_then(|q| q.weekly_reset_ms).map(|r| (r.saturating_sub(now) as f64 / 3_600_000.0 * 10.0).round() / 10.0),
            "detail": match s { Ok(q) => q.detail.clone(), Err(e) => e.clone() },
        })).collect::<Vec<_>>(),
        "copies": copies.iter().map(|c| json!({"account": cfg.accounts[c.account].name, "dir": c.slug_dir})).collect::<Vec<_>>(),
        "holder": holder.map(|h| cfg.accounts[copies[h].account].name.clone()),
        "chosen": cfg.accounts[chosen].name,
        "reason": reason,
        "copy_from": copy_from.map(|h| cfg.accounts[copies[h].account].name.clone()),
        "kind": kind.name(),
        "strategy": strategy_log,
        "live_threads": if thread_starts {
            // Also clears the list of routers that are gone, whichever rules choose.
            let others = live_threads(&cfg, &state, now_ms(), own_id.as_deref());
            json!(cfg.accounts.iter().enumerate().map(|(i, a)| json!({"account": a.name, "threads": others.iter().filter(|t| t.account == Some(i)).count()})).collect::<Vec<_>>())
        } else {
            Value::Null
        },
    });
    if explain {
        println!("{}", serde_json::to_string_pretty(&decision).unwrap_or_default());
        return;
    }

    if let (Some(h), Some(id)) = (copy_from, resume.as_deref()) {
        let src = &copies[h];
        let backup = state.join("backups").join(format!("{now}-{id}")).join(&cfg.accounts[chosen].name);
        match copy_session(&src.slug_dir, &cfg.accounts[chosen].config_dir, id, &backup) {
            Ok(dst) => log.write(json!({"event": "session_copied", "id": id, "from": src.slug_dir, "to": dst})),
            Err(e) => {
                // Without the transcript the new account would start a blank chat: stay put.
                log.write(json!({"event": "session_copy_failed", "id": id, "error": e.to_string()}));
                chosen = src.account;
                reason = format!("copy failed ({e}), stays on {}", cfg.accounts[chosen].name);
            }
        }
    }
    if thread {
        // The account may have changed after the choice (a session id that exists, a failed copy).
        tracker.book(&cfg.accounts[chosen].name, None);
    }
    if let (true, Some(id)) = (persisted, session.as_deref()) {
        write_session(&state, id, &cfg.accounts[chosen].name, &models);
    }
    if let (true, Some(id)) = (persisted, own_id.as_deref()) {
        if use_strategy && kind == Kind::T3 {
            let moved = holder_account.is_some_and(|h| h != chosen);
            let name = cfg.accounts[chosen].name.clone();
            update_session(&state, id, |v| {
                if moved || v["home"].is_null() {
                    v["home"] = json!(name);
                }
                if moved {
                    v["last_move_ms"] = json!(now_ms());
                }
            });
        }
    }
    if let Some(note) = resume.as_deref().and_then(|id| take_interrupted_note(&state, id)) {
        // T3 passes no system prompt of its own today; if it ever does, add to it.
        match text.iter().position(|a| a == "--append-system-prompt") {
            Some(i) if i + 1 < args.len() => {
                let mut joined = args[i + 1].clone();
                joined.push("\n\n");
                joined.push(&note);
                args[i + 1] = joined;
            }
            _ => args.extend([OsString::from("--append-system-prompt"), OsString::from(&note)]),
        }
        log.write(json!({"event": "interrupted_tasks_note_added", "id": resume}));
    }
    let mut decision = decision;
    decision["chosen"] = json!(cfg.accounts[chosen].name);
    decision["reason"] = json!(reason);
    log.write(decision);

    let overage_scope = scores[chosen].as_ref().ok().filter(|q| q.scoped.len() == 1).map(|q| q.scoped[0].clone());
    let cfg = Arc::new(cfg);
    // After each turn: would the next turn go elsewhere? Then this process ends at a quiet
    // moment, before the account runs dry in the middle of a turn.
    let recheck: Option<Arc<Recheck>> = (streaming && !status_check && !info_only).then(|| {
        let (cfg, state, log, allowed, current) = (Arc::clone(&cfg), state.clone(), log.clone(), allowed.clone(), chosen);
        let (tracker, session) = (Arc::clone(&tracker), own_id.clone());
        Arc::new(move |models: &[String], data: Data| {
            match data {
                Data::AsIs => {}
                Data::Fresh => {
                    refresh_stale(&cfg, &state, &allowed, &log, (cfg.fresh_minutes * 60_000.0) as u64);
                }
                Data::Newest => {
                    refresh_stale(&cfg, &state, &allowed, &log, 30_000);
                }
            }
            let snapshot = read_snapshot(&cfg);
            let now = now_ms();
            // The thread's own model says how hard to leave; its agents' models only make it move.
            let own_models: Vec<String> = if model.is_empty() { models.to_vec() } else { vec![model.clone()] };
            if cfg.strategy && read_forced(&state).is_none() {
                return strategy_recheck(&cfg, &state, &snapshot, &allowed, current, &tracker, models, &own_models, session.as_deref(), now);
            }
            let scores: Vec<Score> = cfg.accounts.iter().map(|a| score(&cfg, &state, &snapshot, a, models, now)).collect();
            let (next, why) = choose(&cfg, &scores, &allowed, Some(current), read_forced(&state).as_deref(), now);
            if next == current {
                return None;
            }
            let here = &cfg.accounts[current];
            let kind = leave_kind(&cfg, &score(&cfg, &state, &snapshot, here, &own_models, now));
            let target_has_quota = scores[next].as_ref().is_ok_and(|q| q.left >= cfg.switch_below_percent);
            if kind == Leave::Soft && !target_has_quota {
                return None;
            }
            let notice = login_notice(here);
            Some(Move { reason: format!("next turn goes to {}: {why}", cfg.accounts[next].name), kind, target_has_quota, notice, resume_at_ms: None })
        }) as Arc<Recheck>
    });
    let launch = Launch { cfg: &cfg, args, state: state.clone(), log: log.clone(), home, session: session.filter(|_| persisted), overage_scope, recheck, tracker: Arc::clone(&tracker) };
    let code = run(launch, &cfg.accounts[chosen], models);
    tracker.finish();
    log.write(json!({"event": "exit", "account": cfg.accounts[chosen].name, "code": code}));
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(name: &str, only: &[&str], exclude: &[&str]) -> Account {
        Account {
            name: name.into(),
            config_dir: PathBuf::from(format!(r"C:\x\.{name}")),
            only_paths: only.iter().map(|p| norm_path(p)).collect(),
            exclude_paths: exclude.iter().map(|p| norm_path(p)).collect(),
            cap: DOLLARS_PER_PERCENT.map(|x| x * 100.0),
        }
    }

    fn config(accounts: Vec<Account>) -> Config {
        Config {
            claude_exe: "c".into(),
            usage_json: "u".into(),
            max_snapshot_age_minutes: 120.0,
            fresh_minutes: 5.0,
            switch_below_percent: 10.0,
            new_chat_min_percent: 20.0,
            burn_soon_hours: 6.0,
            leave_with_tasks_below_percent: 2.0,
            face_account: None,
            route_nested: true,
            strategy: false,
            cli_max_wait_ms: 0,
            accounts,
        }
    }

    const H: u64 = 3_600_000;

    /// Quota with this much left and a weekly reset this many hours from 0.
    fn q(left: f64, reset_h: u64) -> Score {
        Ok(Quota { left, weekly_reset_ms: Some(reset_h * H), scoped: Vec::new(), detail: String::new() })
    }

    fn ok(left: f64) -> Score {
        q(left, 100)
    }

    fn models(m: &[&str]) -> Vec<String> {
        m.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_both_time_formats() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-10-04T07:40:00.300952+00:00"), Some(1_791_099_600_300));
        assert_eq!(parse_rfc3339("2026-10-04T09:40:00+02:00"), Some(1_791_099_600_000));
        assert_eq!(parse_time_ms(&json!(1791115200)), Some(1_791_115_200_000));
    }

    #[test]
    fn reads_flags_in_both_forms() {
        let args: Vec<String> = ["--model", "claude-fable-5-1", "--resume=abc", "--verbose", "--no-session-persistence"].iter().map(|s| s.to_string()).collect();
        assert_eq!(flag(&args, &["--model"]).as_deref(), Some("claude-fable-5-1"));
        assert_eq!(flag(&args, &["--resume", "-r"]).as_deref(), Some("abc"));
        assert_eq!(flag(&args, &["--session-id"]), None);
        assert!(has_flag(&args, &["--no-session-persistence"]));
        assert!(has_flag(&args, &["--resume"]));
        assert!(!has_flag(&args, &["-p", "--print"]));
    }

    #[test]
    fn folder_rules() {
        let work = account("work", &[r"D:\work\acme"], &[]);
        let personal = account("personal", &[], &["d:/work/acme"]);
        for (cwd, w, p) in [(r"d:\work\acme\app", true, false), (r"d:\work\acme", true, false), (r"d:\work\acme-other", false, true), (r"d:\projects\x", false, true)] {
            let cwd = norm_path(cwd);
            assert_eq!((allowed_here(&work, &cwd), allowed_here(&personal, &cwd)), (w, p), "{cwd}");
        }
    }

    #[test]
    fn model_scoped_window_counts_for_any_model_in_use() {
        let w = |kind: &str, scope: Option<&str>, used: f64| Window { kind: kind.into(), scope: scope.map(Into::into), used, resets_ms: None };
        let ws = [w("session", None, 50.0), w("weekly_all", None, 64.0), w("weekly_scoped", Some("fable"), 93.0)];
        assert_eq!(remaining(&ws, &models(&["claude-opus-5-5"]), 0).map(|r| r.0), Some(36.0));
        let fable = remaining(&ws, &models(&["claude-fable-5-1[1m]"]), 0).map(|r| r.0).unwrap();
        assert!((fable - 7.0).abs() < 1e-9);
        // An Opus thread whose agents run on Fable is limited by the Fable window too.
        let mixed = remaining(&ws, &models(&["claude-opus-5-5", "claude-fable-5-1"]), 0).map(|r| r.0).unwrap();
        assert!((mixed - 7.0).abs() < 1e-9);
        let reset = [Window { resets_ms: Some(5), ..w("session", None, 99.0) }];
        assert_eq!(remaining(&reset, &models(&["x"]), 10).map(|r| r.0), Some(100.0));
    }

    #[test]
    fn weekly_reset_rolls_over_a_past_reset() {
        let w = Window { kind: "weekly_all".into(), scope: None, used: 10.0, resets_ms: Some(5 * H) };
        assert_eq!(next_weekly_reset(&[w.clone()], 0), Some(5 * H));
        assert_eq!(next_weekly_reset(&[w], 6 * H), Some(5 * H + WEEK_MS));
    }

    #[test]
    fn uzalka_twins_share_quota() {
        let mut work = account("work", &[], &[]);
        work.config_dir = PathBuf::from(r"C:\Users\me\.claude-work");
        let snapshot = json!({"accounts": [
            {"kind": "claude", "path": "C:\\Users\\me\\.claude", "account_key": "k", "updated_ms": 1000,
             "windows": [{"kind": "session", "percent": 4, "scope": null, "resets_at": null}]},
            {"kind": "claude", "path": "C:\\Users\\me\\.claude-work", "account_key": "k", "updated_ms": null, "windows": null}
        ]});
        let (updated, reading) = uzalka_reading(&snapshot, &work).unwrap();
        let Reading::Windows(windows) = reading else { panic!("expected windows") };
        assert_eq!((updated, windows.len(), windows[0].used), (1000, 1, 4.0));
    }

    #[test]
    fn claude_usage_answer_is_read_like_uzalka() {
        // The shape claude.exe returned for get_usage on 2026-10-05.
        let limits = json!([
            {"kind":"session","group":"session","percent":0,"severity":"normal","resets_at":"2026-10-05T11:40:00.143031+00:00","scope":null,"is_active":false},
            {"kind":"weekly_all","group":"weekly","percent":74,"severity":"normal","resets_at":"2026-10-07T20:00:00.143057+00:00","scope":null,"is_active":true},
            {"kind":"weekly_scoped","group":"weekly","percent":74,"severity":"normal","resets_at":"2026-10-07T20:00:00.143339+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}
        ]);
        let ws = parse_windows(&limits);
        assert_eq!(ws.len(), 3);
        assert_eq!(ws[2].scope.as_deref(), Some("fable"));
        let dir = std::env::temp_dir().join(format!("router-usage-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("usage")).unwrap();
        let a = account("a", &[], &[]);
        save_usage(&dir, &a, &json!({"subscription_type": "max", "rate_limits_available": true, "rate_limits": {"limits": limits}}), 77);
        assert!(matches!(probe_reading(&dir, &a), Ok((77, Reading::Windows(w))) if w.len() == 3));
        save_usage(&dir, &a, &json!({"subscription_type": null, "rate_limits_available": false, "rate_limits": null}), 88);
        assert!(matches!(probe_reading(&dir, &a), Ok((88, Reading::SignedOut(_)))));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn live_event_overrides_older_snapshot() {
        let live = json!({"unified_windows": {"five_hour": {"utilization": 0.9, "resetsAt": 1}, "seven_day_fable": {"utilization": 0.5}}});
        let ws = live_windows(&live);
        assert!(ws.iter().any(|w| w.kind == "session" && (w.used - 90.0).abs() < 1e-9));
        assert!(ws.iter().any(|w| w.kind == "weekly_scoped" && w.scope.as_deref() == Some("fable")));
    }

    #[test]
    fn new_chat_spends_the_soonest_reset_first() {
        let cfg = config(vec![account("a", &[], &[]), account("b", &[], &[]), account("c", &[], &[])]);
        // b has less left than a, but its weekly quota resets first: spend it before it is lost.
        assert_eq!(choose(&cfg, &[q(26.0, 62), q(18.0, 1), q(90.0, 160)], &[0, 1, 2], None, None, 0).0, 0, "18% is under the new-chat minimum");
        assert_eq!(choose(&cfg, &[q(26.0, 62), q(22.0, 1), q(90.0, 160)], &[0, 1, 2], None, None, 0).0, 1);
        // Nothing has room for a new chat: the most left wins.
        assert_eq!(choose(&cfg, &[q(12.0, 62), q(15.0, 1), q(9.0, 160)], &[0, 1, 2], None, None, 0).0, 1);
        // Unknown reset times sort last.
        let unknown = Ok(Quota { left: 80.0, weekly_reset_ms: None, scoped: Vec::new(), detail: String::new() });
        assert_eq!(choose(&cfg, &[unknown, q(30.0, 100), q(90.0, 160)], &[0, 1, 2], None, None, 0).0, 1);
    }

    #[test]
    fn thread_moves_only_to_quota_about_to_reset() {
        let cfg = config(vec![account("a", &[], &[]), account("b", &[], &[])]);
        // The holder has room; b resets later: stay.
        assert_eq!(choose(&cfg, &[q(40.0, 10), q(90.0, 100)], &[0, 1], Some(0), None, 0).0, 0);
        // b resets in 3 h with 50% left, before the holder: move and spend it.
        assert_eq!(choose(&cfg, &[q(40.0, 100), q(50.0, 3)], &[0, 1], Some(0), None, 0).0, 1);
        // b resets in 8 h: too far to be worth a cache miss.
        assert_eq!(choose(&cfg, &[q(40.0, 100), q(50.0, 8)], &[0, 1], Some(0), None, 0).0, 0);
        // b resets soon but has too little to bother.
        assert_eq!(choose(&cfg, &[q(40.0, 100), q(15.0, 3)], &[0, 1], Some(0), None, 0).0, 0);
    }

    #[test]
    fn choice_is_sticky_until_threshold() {
        let cfg = config(vec![account("a", &[], &[]), account("b", &[], &[])]);
        assert_eq!(choose(&cfg, &[ok(30.0), ok(80.0)], &[0, 1], Some(0), None, 0).0, 0);
        assert_eq!(choose(&cfg, &[ok(5.0), ok(80.0)], &[0, 1], Some(0), None, 0).0, 1);
        assert_eq!(choose(&cfg, &[Err("rejected by the API".into()), ok(1.0)], &[0, 1], Some(0), None, 0).0, 1);
        assert_eq!(choose(&cfg, &[ok(30.0), ok(80.0)], &[0, 1], None, None, 0).0, 1);
        assert_eq!(choose(&cfg, &[ok(30.0), ok(80.0)], &[0, 1], Some(1), Some("a"), 0).0, 0);
        assert_eq!(choose(&cfg, &[ok(30.0), ok(80.0)], &[0], None, None, 0).0, 0);
        // Everyone is low: moving for a couple of percent is not worth a cache miss.
        assert_eq!(choose(&cfg, &[ok(6.0), ok(9.0)], &[0, 1], Some(0), None, 0).0, 0);
        assert_eq!(choose(&cfg, &[ok(6.0), ok(12.0)], &[0, 1], Some(0), None, 0).0, 1);
    }

    #[test]
    fn blocked_accounts_are_not_fallbacks() {
        let cfg = config(vec![account("a", &[], &[]), account("b", &[], &[])]);
        let rejected = || Err("rejected by the API, resets in 9 min".to_string());
        let no_data = || Err("quota data is 300 min old".to_string());
        assert_eq!(choose(&cfg, &[rejected(), no_data()], &[0, 1], Some(0), None, 0).0, 1);
        assert_eq!(choose(&cfg, &[rejected(), no_data()], &[0, 1], None, None, 0).0, 1);
        let signed_out = || Err("auth failure: uzalka: login expired".to_string());
        assert_eq!(choose(&cfg, &[signed_out(), no_data()], &[0, 1], Some(0), None, 0).0, 1);
        // Unknown quota alone is not a reason to move a session.
        assert_eq!(choose(&cfg, &[no_data(), no_data()], &[0, 1], Some(0), None, 0).0, 0);
        // Everyone blocked: a maybe-passing auth error beats a certain rejection.
        assert_eq!(choose(&cfg, &[rejected(), signed_out()], &[0, 1], None, None, 0).0, 1);
    }

    #[test]
    fn margin_does_not_hold_an_empty_account() {
        let cfg = config(vec![account("a", &[], &[]), account("b", &[], &[])]);
        assert_eq!(choose(&cfg, &[ok(0.5), ok(4.0)], &[0, 1], Some(0), None, 0).0, 1);
    }

    #[test]
    fn copy_refuses_to_overwrite_a_diverged_copy() {
        let root = std::env::temp_dir().join(format!("router-copy-test-{}", std::process::id()));
        let src = root.join("src").join("projects").join("slug");
        let dst_config = root.join("dst");
        let dst = dst_config.join("projects").join("slug");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("s.jsonl"), "a\nb\n").unwrap();
        fs::write(dst.join("s.jsonl"), "a\nX\n").unwrap();
        assert!(copy_session(&src, &dst_config, "s", &root.join("backup")).is_err());
        assert_eq!(fs::read_to_string(dst.join("s.jsonl")).unwrap(), "a\nX\n");
        fs::write(dst.join("s.jsonl"), "a\n").unwrap();
        copy_session(&src, &dst_config, "s", &root.join("backup")).unwrap();
        assert_eq!(fs::read_to_string(dst.join("s.jsonl")).unwrap(), "a\nb\n");
        assert_eq!(fs::read_to_string(root.join("backup").join("slug").join("s.jsonl")).unwrap(), "a\n");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn copy_into_a_shared_projects_folder_does_nothing() {
        let root = std::env::temp_dir().join(format!("router-shared-test-{}", std::process::id()));
        let src_projects = root.join("src").join("projects");
        let src = src_projects.join("slug");
        let dst_config = root.join("dst");
        fs::create_dir_all(src.join("s").join("subagents")).unwrap();
        fs::create_dir_all(&dst_config).unwrap();
        fs::write(src.join("s.jsonl"), "a\nb\n").unwrap();
        fs::write(src.join("s").join("subagents").join("agent-1.jsonl"), "x\n").unwrap();
        // The other account's `projects` is a junction to the same folder.
        let status = Command::new("cmd").args(["/C", "mklink", "/J"]).arg(dst_config.join("projects")).arg(&src_projects).stdout(Stdio::null()).status().unwrap();
        assert!(status.success());
        let backup = root.join("backup");
        copy_session(&src, &dst_config, "s", &backup).unwrap();
        assert_eq!(fs::read_to_string(src.join("s.jsonl")).unwrap(), "a\nb\n");
        assert!(src.join("s").join("subagents").join("agent-1.jsonl").exists());
        assert!(!backup.exists(), "nothing may be moved to backup");
        let _ = fs::remove_dir(dst_config.join("projects"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn asks_uzalka_hub_for_fresh_data() {
        let root = std::env::temp_dir().join(format!("router-uzalka-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        fs::write(root.join("config.json"), json!({"hub": {"enabled": true, "port": port, "key": "k1"}}).to_string()).unwrap();
        let mut cfg = config(vec![account("a", &[], &[])]);
        cfg.usage_json = root.join("usage.json");
        // A new Uzalka answers the snapshot, an old one has no such endpoint.
        let hub = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for answer in ["200 OK\r\nContent-Type: application/json\r\nContent-Length: 36\r\n\r\n{\"refreshed\":true,\"timed_out\":false}", "404 Not Found\r\nContent-Length: 21\r\n\r\n{\"error\":\"not found\"}"] {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = [0u8; 1024];
                let n = s.read(&mut buf).unwrap();
                requests.push(String::from_utf8_lossy(&buf[..n]).to_string());
                s.write_all(format!("HTTP/1.1 {answer}").as_bytes()).unwrap();
            }
            requests
        });
        assert_eq!(ask_uzalka(&cfg, 300_000).unwrap()["refreshed"], true);
        assert!(ask_uzalka(&cfg, 300_000).unwrap_err().starts_with("uzalka answered 404"));
        let requests = hub.join().unwrap();
        assert!(requests[0].starts_with("GET /v0/router/usage?max_age_ms=300000 HTTP/1.1\r\n"));
        assert!(requests[0].contains("Authorization: Bearer k1\r\n"));
        fs::write(root.join("config.json"), json!({"hub": {"enabled": false, "port": port, "key": "k1"}}).to_string()).unwrap();
        assert_eq!(ask_uzalka(&cfg, 1).unwrap_err(), "uzalka hub is off");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejections_block_the_account_or_only_the_model() {
        let dir = std::env::temp_dir().join(format!("router-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("live")).unwrap();
        let log = Log { path: dir.join("log") };
        let cfg = config(vec![account("a", &[], &[])]);
        let a = &cfg.accounts[0];
        let snapshot = Err("none".to_string());
        let allowed = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","overageStatus":"rejected","unifiedWindows":{"five_hour":{"utilization":0.07,"resetsAt":4102444800},"seven_day":{"utilization":0.5,"resetsAt":4102444800}}}}"#;
        assert!(on_rate_limit(allowed, a, &dir, &log, Some("fable")).is_none());
        let now = now_ms();
        assert!(score(&cfg, &dir, &snapshot, a, &models(&["claude-opus-5-5"]), now).is_ok());
        // The Fable bucket is refused: Opus may go on, Fable may not.
        let fable = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4102444800,"rateLimitType":"seven_day_overage_included"}}"#;
        assert!(on_rate_limit(fable, a, &dir, &log, Some("fable")).is_some());
        assert!(score(&cfg, &dir, &snapshot, a, &models(&["claude-opus-5-5"]), now).is_ok());
        assert!(rejected(&score(&cfg, &dir, &snapshot, a, &models(&["claude-opus-5-5", "claude-fable-5-1"]), now)));
        // The weekly window is refused: nothing goes.
        let weekly = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4102444800,"rateLimitType":"seven_day"}}"#;
        assert!(on_rate_limit(weekly, a, &dir, &log, Some("fable")).is_some());
        let live = read_json(&live_path(&dir, a)).unwrap();
        assert_eq!(live["rejected_until_ms"].as_u64(), Some(4_102_444_800_000));
        assert!(live["unified_windows"]["five_hour"].is_object());
        assert!(rejected(&score(&cfg, &dir, &snapshot, a, &models(&["claude-opus-5-5"]), now)));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn account_errors_in_a_chat_block_for_a_while() {
        let dir = std::env::temp_dir().join(format!("router-auth-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("live")).unwrap();
        let log = Log { path: dir.join("log") };
        let cfg = config(vec![account("a", &[], &[])]);
        let a = &cfg.accounts[0];
        let snapshot = Err("none".to_string());
        let ok_event = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.1,"resetsAt":4102444800},"seven_day":{"utilization":0.5,"resetsAt":4102444800}}}}"#;
        on_rate_limit(ok_event, a, &dir, &log, None);
        // What claude printed on 2026-10-05 when it could not see its login.
        let line = br#"{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Not logged in \u00b7 Please run /login"}]},"parent_tool_use_id":null,"error":"authentication_failed"}"#;
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(on_account_error(line, a, &dir, &log).as_deref(), Some("authentication_failed"));
        assert_eq!(line_model(line), None, "synthetic messages are not a model in use");
        let s = score(&cfg, &dir, &snapshot, a, &[], now_ms());
        assert!(blocked(&s), "{s:?}");
        assert!(!blocked(&score(&cfg, &dir, &snapshot, a, &[], now_ms() + AUTH_BLOCK_MS + 1)));
        // A request that went through afterwards clears it.
        std::thread::sleep(Duration::from_millis(5));
        on_rate_limit(ok_event, a, &dir, &log, None);
        assert!(!blocked(&score(&cfg, &dir, &snapshot, a, &[], now_ms())));
        // A server problem is not the account's fault.
        let overloaded = br#"{"type":"assistant","message":{"model":"<synthetic>","content":[]},"error":"overloaded"}"#;
        assert_eq!(on_account_error(overloaded, a, &dir, &log), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_the_model_of_an_assistant_line() {
        let line = br#"{"type":"assistant","message":{"model":"claude-fable-5-1","id":"msg_1","content":[]},"parent_tool_use_id":"toolu_1"}"#;
        assert_eq!(line_model(line).as_deref(), Some("claude-fable-5-1"));
    }

    #[test]
    fn interrupted_tasks_become_a_note_once() {
        let dir = std::env::temp_dir().join(format!("router-note-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("interrupted")).unwrap();
        write_json(&dir.join("interrupted").join("s1.json"), &json!({"tasks": [{"task_id": "a3bf", "task_type": "local_agent", "description": "bg sleeper"}]}));
        let note = take_interrupted_note(&dir, "s1").unwrap();
        assert!(note.contains("local_agent a3bf: bg sleeper"), "{note}");
        assert!(take_interrupted_note(&dir, "s1").is_none());
        // A command outlives the switch; a dead login is passed on to the user.
        write_json(&dir.join("interrupted").join("s2.json"), &json!({"reason": "next turn goes to b", "notice": "Claude account a is signed out.",
            "tasks": [{"task_id": "b6gk", "task_type": "local_bash", "description": "codex worker"}]}));
        let note = take_interrupted_note(&dir, "s2").unwrap();
        assert!(note.contains("may still be running") && note.contains(r"\s2\tasks\") && note.contains("local_bash b6gk: codex worker"), "{note}");
        assert!(note.contains("Claude account a is signed out.") && !note.contains("SendMessage"), "{note}");
        write_json(&dir.join("interrupted").join("s3.json"), &json!({"tasks": [], "notice": "sign in"}));
        assert!(take_interrupted_note(&dir, "s3").unwrap().contains("sign in"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refusals_are_lifted_by_newer_data_and_allowed_requests() {
        let dir = std::env::temp_dir().join(format!("router-lift-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("live")).unwrap();
        fs::create_dir_all(dir.join("usage")).unwrap();
        let log = Log { path: dir.join("log") };
        let cfg = config(vec![account("a", &[], &[])]);
        let a = &cfg.accounts[0];
        let snapshot = Err("none".to_string());
        let opus = models(&["claude-opus-5-5"]);
        let fable = models(&["claude-fable-5-1"]);
        // No overage scope known: claude's overage window is Fable's today.
        let overage = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4102444800,"rateLimitType":"seven_day_overage_included"}}"#;
        assert!(on_rate_limit(overage, a, &dir, &log, None).is_some());
        let session = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4102444800,"rateLimitType":"five_hour"}}"#;
        assert!(on_rate_limit(session, a, &dir, &log, None).is_some());
        // Extra usage lets requests through: not a refusal. Right after the refusal such an
        // answer may be a request that left before it: the refusal stands.
        let paid = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4102444800,"rateLimitType":"five_hour","overageStatus":"allowed"}}"#;
        assert!(on_rate_limit(paid, a, &dir, &log, None).is_none());
        assert!(read_json(&live_path(&dir, a)).unwrap()["rejected_until_ms"].is_u64());
        update_live(&dir, a, |l| l["rejected_ms"] = json!(now_ms() - LIFT_AFTER_MS - 1000));
        assert!(on_rate_limit(paid, a, &dir, &log, None).is_none());
        let live = read_json(&live_path(&dir, a)).unwrap();
        assert!(live["rejected_until_ms"].is_null(), "a later allowed request cleared the account refusal");
        assert_eq!(live["rejected_scopes"]["fable"].as_u64(), Some(4_102_444_800_000), "a model's refusal stays");
        assert_eq!(on_rate_limit(session, a, &dir, &log, None).as_deref(), Some("five_hour"));
        // Fable's agents refused again later: the account's own refusal time stays.
        let account_at = read_json(&live_path(&dir, a)).unwrap()["rejected_ms"].clone();
        std::thread::sleep(Duration::from_millis(5));
        assert!(on_rate_limit(overage, a, &dir, &log, None).is_some());
        let live = read_json(&live_path(&dir, a)).unwrap();
        assert!(live["rejected_ms"] == account_at && live["rejected_scope_ms"]["fable"].as_u64() > account_at.as_u64());
        let now = now_ms();
        assert!(rejected(&score(&cfg, &dir, &snapshot, a, &opus, now)));
        let usage = |session: f64, fable: f64, at: u64| {
            let limits = json!([{"kind": "session", "percent": session, "scope": null}, {"kind": "weekly_all", "percent": 50, "scope": null},
                {"kind": "weekly_scoped", "percent": fable, "scope": {"model": {"display_name": "Fable"}}}]);
            save_usage(&dir, a, &json!({"subscription_type": "max", "rate_limits": {"limits": limits}}), at);
        };
        // An older reading does not lift a refusal, nor one taken right after it, nor a later one
        // that still shows 100%.
        usage(30.0, 40.0, now - 60_000);
        assert!(rejected(&score(&cfg, &dir, &snapshot, a, &opus, now)));
        usage(30.0, 40.0, now + 1000);
        assert!(rejected(&score(&cfg, &dir, &snapshot, a, &opus, now + 2000)));
        let later = now + LIFT_AFTER_MS + 1000;
        usage(100.0, 100.0, later);
        assert!(rejected(&score(&cfg, &dir, &snapshot, a, &opus, later + 1000)));
        // A later reading with room: the reset came early.
        usage(30.0, 100.0, later);
        assert!(score(&cfg, &dir, &snapshot, a, &opus, later + 1000).is_ok());
        assert!(rejected(&score(&cfg, &dir, &snapshot, a, &fable, later + 1000)));
        usage(30.0, 40.0, later);
        assert!(score(&cfg, &dir, &snapshot, a, &fable, later + 1000).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn dead_login_leaves_at_once_a_passing_one_softly() {
        let root = std::env::temp_dir().join(format!("router-login-test-{}", std::process::id()));
        let mut a = account("a", &[], &[]);
        a.config_dir = root.join(".a");
        fs::create_dir_all(&a.config_dir).unwrap();
        fs::create_dir_all(root.join("state").join("live")).unwrap();
        let cfg = config(vec![account("x", &[], &[])]);
        let creds = |refresh: &str| fs::write(a.config_dir.join(".credentials.json"), json!({"claudeAiOauth": {"accessToken": "", "refreshToken": refresh, "expiresAt": 0}}).to_string()).unwrap();
        creds("rt-1");
        assert!(!login_dead(&a));
        creds("");
        assert!(login_dead(&a));
        let s = score(&cfg, &root.join("state"), &Err("none".into()), &a, &[], now_ms());
        assert!(blocked(&s) && s.as_ref().unwrap_err().contains("/login"), "{s:?}");
        assert_eq!(leave_kind(&cfg, &s), Leave::Blocked);
        assert_eq!(leave_kind(&cfg, &Err("auth failure in a chat 1 min ago (authentication_failed)".into())), Leave::Soft);
        assert_eq!(leave_kind(&cfg, &Err("rejected by the API, resets in 9 min".into())), Leave::Blocked);
        assert_eq!(leave_kind(&cfg, &ok(1.0)), Leave::Low);
        assert_eq!(leave_kind(&cfg, &ok(50.0)), Leave::Soft);
        assert_eq!(leave_kind(&cfg, &Err("quota data is 300 min old".into())), Leave::Soft);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refusals_for_t3_resume_soon() {
        let made = refusal_event("s1", "seven_day", 1_791_000_090);
        assert!(made.ends_with(b"\n"));
        let v: Value = serde_json::from_slice(&made).unwrap();
        let info = &v["rate_limit_info"];
        // What T3 needs to count a refused turn and resume it at resetsAt.
        assert_eq!((v["type"].as_str(), info["status"].as_str(), info["resetsAt"].as_u64(), info["rateLimitType"].as_str(), v["session_id"].as_str()),
            (Some("rate_limit_event"), Some("rejected"), Some(1_791_000_090), Some("seven_day"), Some("s1")));
        assert!(info["isUsingOverage"] == false && info["overageStatus"].is_null());
        assert_eq!(v["uuid"].as_str().map(str::len), Some(36));
        let other: Value = serde_json::from_slice(&refusal_event("s1", "seven_day", 1)).unwrap();
        assert_ne!(other["uuid"], v["uuid"]);
    }

    #[test]
    fn a_limited_turn_is_promised_to_t3_once_decided() {
        let dir = std::env::temp_dir().join(format!("router-decide-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let log = Log { path: dir.join("log") };
        let a = account("a", &[], &[]);
        let asked = Mutex::new(Vec::new());
        let answer = Mutex::new(None::<Move>);
        let mv = |kind, target_has_quota| Some(Move { reason: "next turn goes to b".into(), kind, target_has_quota, notice: None, resume_at_ms: None });
        let recheck = |_: &[String], data: Data| {
            asked.lock().unwrap().push(data);
            answer.lock().unwrap().take()
        };
        let result = br#"{"type":"result","subtype":"success","is_error":true,"session_id":"s9"}"#;
        let success = br#"{"type":"result","subtype":"success","is_error":false,"session_id":"s9"}"#;
        let seen = Mutex::new(Seen::default());
        let turn = |refused: &[&str], limit_error: bool| {
            let mut s = seen.lock().unwrap();
            s.refused = refused.iter().map(|k| k.to_string()).collect();
            s.limit_error = limit_error;
            s.pending = 1;
            s.last_write_ms = now_ms();
            s.answering = true;
        };
        let events = |e: &Option<Vec<u8>>| -> Vec<Value> {
            e.as_deref().unwrap_or_default().split(|&b| b == b'\n').filter(|l| !l.is_empty()).map(|l| serde_json::from_slice(l).unwrap()).collect()
        };
        // The thread's own model is refused (and its Fable agents): every refused kind resets soon.
        turn(&["five_hour", "seven_day_overage_included"], false);
        *answer.lock().unwrap() = mv(Leave::Blocked, true);
        let before = now_ms() / 1000;
        let (m, e) = decide_after_turn(&recheck, result, &seen, &dir, &log, &a, None);
        let ev = events(&e);
        assert_eq!(ev.iter().map(|v| v["rate_limit_info"]["rateLimitType"].as_str().unwrap()).collect::<Vec<_>>(), ["five_hour", "seven_day_overage_included"]);
        assert!(ev.iter().all(|v| v["session_id"] == "s9" && (before + RESUME_AFTER_S..=before + RESUME_AFTER_S + 1).contains(&v["rate_limit_info"]["resetsAt"].as_u64().unwrap())));
        assert!(matches!(m, Some((Move { kind: Leave::Blocked, .. }, false))));
        let promised = seen.lock().unwrap().promised_ms.unwrap();
        // The turn stays open for the router until its result is written out.
        assert!(seen.lock().unwrap().turn_open() && seen.lock().unwrap().refused.is_empty());
        assert_eq!(asked.lock().unwrap().pop(), Some(Data::Newest));
        // T3's queued message fails too, with claude's message only: promised again, on the data
        // just refreshed; T3 keeps the latest time, so does the router.
        std::thread::sleep(Duration::from_millis(5));
        turn(&[], true);
        *answer.lock().unwrap() = mv(Leave::Low, true);
        let (m, e) = decide_after_turn(&recheck, result, &seen, &dir, &log, &a, None);
        assert_eq!(events(&e)[0]["rate_limit_info"]["rateLimitType"], "five_hour");
        assert!(matches!(m, Some((Move { kind: Leave::Blocked, .. }, false))));
        assert!(seen.lock().unwrap().promised_ms.unwrap() > promised);
        assert_eq!(asked.lock().unwrap().pop(), Some(Data::AsIs));
        seen.lock().unwrap().promised_ms = None;
        // T3 steered into the turn: the result of the aborted part decides nothing, the refusal
        // waits for the end of the turn.
        let aborted = br#"{"type":"result","subtype":"success","is_error":false,"terminal_reason":"aborted_streaming","session_id":"s9"}"#;
        turn(&["five_hour"], true);
        seen.lock().unwrap().pending = 2;
        assert!(matches!(decide_after_turn(&recheck, aborted, &seen, &dir, &log, &a, None), (None, None)));
        assert!(asked.lock().unwrap().is_empty() && seen.lock().unwrap().refused == ["five_hour"]);
        // An interrupt (nothing steered in): T3 closes the process anyway, nothing is decided either.
        seen.lock().unwrap().pending = 1;
        assert!(matches!(decide_after_turn(&recheck, aborted, &seen, &dir, &log, &a, None), (None, None)));
        assert!(asked.lock().unwrap().is_empty());
        // A turn claude started itself decides on its own refusals, even with a message of T3 waiting.
        let own = br#"{"type":"result","subtype":"success","is_error":true,"origin":{"kind":"task-notification"},"session_id":"s9"}"#;
        turn(&["five_hour"], true);
        seen.lock().unwrap().pending = 1;
        *answer.lock().unwrap() = mv(Leave::Blocked, true);
        assert!(decide_after_turn(&recheck, own, &seen, &dir, &log, &a, None).1.is_some());
        assert_eq!(asked.lock().unwrap().pop(), Some(Data::Newest));
        // T3 counts those refusals in its waiting turn: they count again at its result.
        assert_eq!(seen.lock().unwrap().refused, ["five_hour"]);
        seen.lock().unwrap().promised_ms = None;
        // Only the Fable agents were refused and the thread went on: its result goes out at once,
        // no promise (T3 resumes failed turns only), a soft move.
        turn(&["seven_day_overage_included"], false);
        *answer.lock().unwrap() = mv(Leave::Soft, true);
        let (m, e) = decide_after_turn(&recheck, success, &seen, &dir, &log, &a, None);
        assert!(e.is_none() && matches!(m, Some((Move { kind: Leave::Soft, .. }, false))));
        assert_eq!(asked.lock().unwrap().pop(), Some(Data::AsIs));
        // No account with room: no promise, T3 waits for the real reset.
        turn(&["five_hour"], true);
        *answer.lock().unwrap() = mv(Leave::Blocked, false);
        assert!(decide_after_turn(&recheck, result, &seen, &dir, &log, &a, None).1.is_none());
        // ... unless another account frees up before this one: T3 is told that time. The router does
        // not wait for a promise that far ahead.
        turn(&["five_hour"], true);
        let later = now_ms() + 2 * H;
        *answer.lock().unwrap() = Some(Move { resume_at_ms: Some(later), ..mv(Leave::Blocked, false).unwrap() });
        let (m, e) = decide_after_turn(&recheck, result, &seen, &dir, &log, &a, None);
        assert_eq!(events(&e)[0]["rate_limit_info"]["resetsAt"].as_u64(), Some(later / 1000));
        assert!(matches!(m, Some((Move { kind: Leave::Blocked, .. }, false))) && seen.lock().unwrap().promised_ms.is_none());
        // One that frees up sooner than T3 could resume anyway: the usual promise.
        turn(&["five_hour"], true);
        *answer.lock().unwrap() = Some(Move { resume_at_ms: Some(now_ms()), ..mv(Leave::Blocked, false).unwrap() });
        let before = now_ms() / 1000;
        let (_, e) = decide_after_turn(&recheck, result, &seen, &dir, &log, &a, None);
        assert!((before + RESUME_AFTER_S..=before + RESUME_AFTER_S + 1).contains(&events(&e)[0]["rate_limit_info"]["resetsAt"].as_u64().unwrap()));
        assert!(seen.lock().unwrap().promised_ms.is_some());
        seen.lock().unwrap().promised_ms = None;
        // A short throttle: the newest data says stay.
        turn(&[], true);
        assert!(matches!(decide_after_turn(&recheck, result, &seen, &dir, &log, &a, None), (None, None)));
        assert_eq!(asked.lock().unwrap().pop(), Some(Data::Newest));
        // A plain turn is judged on the data as it is; the test flag forces a soft move.
        turn(&[], false);
        decide_after_turn(&recheck, result, &seen, &dir, &log, &a, None);
        assert_eq!(asked.lock().unwrap().pop(), Some(Data::AsIs));
        fs::write(dir.join("switch-after-turn"), "").unwrap();
        assert!(matches!(decide_after_turn(&recheck, result, &seen, &dir, &log, &a, None), (Some((Move { kind: Leave::Soft, .. }, true)), None)));
        assert!(seen.lock().unwrap().promised_ms.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn turns_end_as_t3_sees_them() {
        let end = |s: &str| ending(&serde_json::from_str(s).unwrap());
        let normal = end(r#"{"type":"result","subtype":"success","is_error":false,"origin":{"kind":"human"}}"#);
        let aborted = end(r#"{"type":"result","subtype":"success","is_error":false,"terminal_reason":"aborted_tools"}"#);
        let own = end(r#"{"type":"result","subtype":"success","is_error":false,"origin":{"kind":"task-notification"},"user_message_uuids":[]}"#);
        let own_with_message = end(r#"{"type":"result","subtype":"success","origin":{"kind":"task-notification"},"user_message_uuids":["u1"]}"#);
        assert!(!normal.failed && !normal.own && !aborted.failed && own.own && !own_with_message.own);
        assert!(end(r#"{"type":"result","subtype":"success","origin":{"kind":"peer"}}"#).own);
        assert!(end(r#"{"type":"result","subtype":"success","is_error":false,"api_error_status":429}"#).failed);
        assert!(end(r#"{"type":"result","subtype":"success","is_error":false,"terminal_reason":"api_error"}"#).failed);
        assert!(end(r#"{"type":"result","subtype":"error_during_execution","is_error":true}"#).failed);
        let mut s = Seen::default();
        let sent = |s: &mut Seen, n: u32| {
            s.pending += n;
            s.last_write_ms = now_ms();
        };
        // As the output loop does: what the result answers is taken when it is read.
        let out = |s: &mut Seen, e: &Ending| {
            let (goes_on, sent) = (s.goes_on(e), s.pending);
            s.result_out(goes_on, e.own, sent);
        };
        // Two messages sent close together, one turn, one result: nothing waits after it.
        sent(&mut s, 2);
        s.answering = true;
        assert!(!s.goes_on(&normal));
        out(&mut s, &normal);
        assert!(!s.turn_open() && s.pending == 0);
        // A message steered in: the aborted part goes on, its own result ends the turn.
        sent(&mut s, 1);
        sent(&mut s, 1);
        assert!(s.goes_on(&aborted));
        out(&mut s, &aborted);
        assert!(s.turn_open() && s.pending == 1);
        out(&mut s, &normal);
        assert!(!s.turn_open());
        // An interrupt: the aborted result ends the turn.
        sent(&mut s, 1);
        assert!(!s.goes_on(&aborted));
        out(&mut s, &aborted);
        assert!(!s.turn_open());
        // A message sent while the router held a read result is not answered by it.
        sent(&mut s, 1);
        let (goes_on, held) = (s.goes_on(&normal), s.pending);
        sent(&mut s, 1);
        s.result_out(goes_on, false, held);
        assert!(s.turn_open() && s.pending == 1);
        out(&mut s, &normal);
        // claude answers a finished background task while T3's message waits to run next, however
        // long that answer took.
        s.answering = true;
        sent(&mut s, 1);
        s.last_write_ms = now_ms() - WAITING_MS - 1000;
        assert!(s.goes_on(&own));
        out(&mut s, &own);
        assert!(s.turn_open() && s.pending == 1);
        // ... and the message folded into that turn: it shows in the result.
        assert!(!s.goes_on(&own_with_message));
        // claude compacting the context keeps the message waiting.
        s.last_result_ms = now_ms() - WAITING_MS - 1000;
        assert!(!s.turn_open());
        s.last_busy_ms = now_ms();
        assert!(s.turn_open());
        // A message claude never started on holds the turn open only for a while.
        s.last_busy_ms = 0;
        assert!(!s.turn_open() && !s.goes_on(&aborted));
        out(&mut s, &normal);
        assert_eq!(s.pending, 0);
    }

    #[test]
    fn file_prefix_is_compared_in_pieces() {
        let dir = std::env::temp_dir().join(format!("router-prefix-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let whole: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(dir.join("whole"), &whole).unwrap();
        fs::write(dir.join("start"), &whole[..2_500_000]).unwrap();
        assert!(file_starts_with(&dir.join("whole"), &dir.join("start")).unwrap());
        let mut changed = whole[..2_500_000].to_vec();
        changed[2_100_000] ^= 1;
        fs::write(dir.join("start"), &changed).unwrap();
        assert!(!file_starts_with(&dir.join("whole"), &dir.join("start")).unwrap());
        assert!(!file_starts_with(&dir.join("start"), &dir.join("whole")).unwrap(), "longer than the file");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sessions_remember_models_for_a_day() {
        let dir = std::env::temp_dir().join(format!("router-session-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("sessions")).unwrap();
        let now = 100 * H;
        write_session(&dir, "s", "a", &[("claude-opus-5-5".into(), now - H), ("claude-fable-5-1".into(), now - 25 * H)]);
        assert_eq!(read_session(&dir, "s", now), (Some("a".into()), vec![("claude-opus-5-5".to_string(), now - H)]));
        // The list an older router wrote has no times: its models are not trusted.
        write_json(&dir.join("sessions").join("s.json"), &json!({"account": "b", "models": ["claude-fable-5-1"]}));
        assert_eq!(read_session(&dir, "s", now), (Some("b".into()), Vec::new()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn live_updates_from_many_routers_are_not_lost() {
        let dir = std::env::temp_dir().join(format!("router-live-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("live")).unwrap();
        let a = account("a", &[], &[]);
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    for _ in 0..10 {
                        update_live(&dir, &a, |v| v["n"] = json!(v["n"].as_u64().unwrap_or(0) + 1));
                    }
                });
            }
        });
        assert_eq!(read_json(&live_path(&dir, &a)).unwrap()["n"].as_u64(), Some(80));
        assert!(!live_path(&dir, &a).with_extension("lock").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_list_of_threads_forgets_routers_that_are_gone() {
        let dir = std::env::temp_dir().join(format!("router-threads-test-{}", std::process::id()));
        let threads = threads_dir(&dir);
        fs::create_dir_all(&threads).unwrap();
        let cfg = config(vec![account("a", &[], &[]), account("b", &[], &[])]);
        let now = now_ms();
        let (sleeper, args): (&str, &[&str]) = if cfg!(windows) { ("ping", &["-n", "60", "127.0.0.1"]) } else { ("sleep", &["60"]) };
        let mut child = Command::new(sleeper).args(args).stdout(Stdio::null()).spawn().unwrap();
        let mut gone = Command::new(sleeper).args(if cfg!(windows) { &["-n", "1", "127.0.0.1"][..] } else { &["0"][..] }).stdout(Stdio::null()).spawn().unwrap();
        gone.wait().unwrap();
        let started = process_started_ms(child.id()).unwrap();
        let record = |name: &str, pid: u32, started_ms: u64, account: &str, last_ms: u64, waiting: Value| {
            let mut burn = Burn::default();
            if last_ms > 0 {
                burn.add(last_ms, 1.0, false);
            }
            // A held start that stopped looking again (its process stuck) has not written for two hours.
            let updated = if name == "stuck" { now - 2 * H } else { now };
            write_json(&threads.join(format!("{name}.json")), &json!({"pid": pid, "started_ms": started_ms, "session": name, "kind": "t3",
                "account": account, "booked_ms": 0, "updated_ms": updated, "burn": burn.to_json(), "fable": false, "waiting": waiting}));
        };
        record("live", child.id(), started, "a", now - 60_000, Value::Null);
        record("idle", child.id(), started, "b", now - strategy::LIVE_MS - 60_000, Value::Null);
        record("held", child.id(), started, "b", 0, json!({"account": "b", "at_ms": now + H, "b": 3.9}));
        record("stuck", child.id(), started, "a", 0, json!({"account": "a", "at_ms": now + H, "b": 3.9}));
        // The PC was restarted and the pid now belongs to a process that started at another time.
        record("reused", child.id(), started - H, "a", now - 60_000, Value::Null);
        record("killed", gone.id(), started, "a", now - 60_000, Value::Null);
        let me = std::process::id();
        record("mine", me, process_started_ms(me).unwrap(), "a", now - 60_000, Value::Null);
        record("twin", child.id(), started, "a", now - 60_000, Value::Null);
        // Writes cut short: an old one is deleted, a fresh one may be in progress.
        fs::write(threads.join("old.tmp1"), "{").unwrap();
        fs::File::options().write(true).open(threads.join("old.tmp1")).unwrap().set_modified(SystemTime::now() - Duration::from_secs(1200)).unwrap();
        fs::write(threads.join("new.tmp1"), "{").unwrap();

        let live = live_threads(&cfg, &dir, now, Some("twin"));
        let mut seen: Vec<_> = live.iter().map(|t| (t.account, t.waiting)).collect();
        seen.sort_by_key(|s| s.0);
        assert_eq!(seen, [(Some(0), None), (Some(1), Some((1, now + H, 3.9)))]);
        let mut left: Vec<String> = fs::read_dir(&threads).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["held.json", "idle.json", "live.json", "mine.json", "new.tmp1", "stuck.json", "twin.json"]);
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_thread_counts_each_message_once_and_leaves_the_list_on_exit() {
        let dir = std::env::temp_dir().join(format!("router-tracker-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("sessions")).unwrap();
        let t = Tracker::new(&dir, Some("s1".into()), Kind::T3, "D:/w", Burn::default(), false);
        let msg = |id: &str, model: &str, out: u64| json!({"type": "assistant", "message": {"id": id, "model": model,
            "usage": {"input_tokens": 0, "cache_read_input_tokens": 500000, "output_tokens": out}}});
        // Not in the list until it has an account.
        t.on_message(&msg("m1", "claude-opus-5-5", 1000));
        assert!(!t.path.exists());
        t.book("a", None);
        assert_eq!(read_json(&t.path).unwrap()["account"], "a");
        // claude writes a message once per content block with its usage repeated, the last one grown.
        t.on_message(&msg("m1", "claude-opus-5-5", 1000));
        t.on_message(&msg("m1", "claude-opus-5-5", 3000));
        t.on_message(&msg("m2", "claude-fable-5-1", 1000));
        t.on_message(&msg("m3", "<synthetic>", 1000));
        let (burn, fable) = t.snapshot();
        assert!((burn.cost - (3000.0 * 20.0 + 1000.0 * 50.0) / 1e6).abs() < 1e-12, "{}", burn.cost);
        assert!((burn.fable_cost - 0.05).abs() < 1e-12 && fable);
        t.save();
        assert!((read_json(&t.path).unwrap()["burn"]["cost"].as_f64().unwrap() - 0.11).abs() < 1e-9);
        t.finish();
        assert!(!t.path.exists());
        let kept = read_json(&dir.join("sessions").join("s1.json")).unwrap();
        assert!((Burn::from_json(&kept["burn"]).cost - 0.11).abs() < 1e-9);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_strategy_sees_a_refusal_as_a_full_window() {
        let dir = std::env::temp_dir().join(format!("router-view-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("live")).unwrap();
        let log = Log { path: dir.join("log") };
        let cfg = config(vec![account("a", &[], &[])]);
        let a = &cfg.accounts[0];
        let snapshot = Err("none".to_string());
        assert!(account_view(&cfg, &dir, &snapshot, a, now_ms()).unknown);
        let ok = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":4102444800},"seven_day":{"utilization":0.5,"resetsAt":4102444800},"seven_day_fable":{"utilization":0.75,"resetsAt":4102444800}}}}"#;
        on_rate_limit(ok, a, &dir, &log, Some("fable"));
        let v = account_view(&cfg, &dir, &snapshot, a, now_ms());
        assert!(!v.unknown && !v.dead);
        assert_eq!((v.u5, v.w5_end, v.u7, v.w7_end, v.uf), (25.0, Some(4_102_444_800_000), 50.0, Some(4_102_444_800_000), 75.0));
        let refused = |kind: &str, at: u64| format!(r#"{{"type":"rate_limit_event","rate_limit_info":{{"status":"rejected","resetsAt":{at},"rateLimitType":"{kind}"}}}}"#);
        // Fable refused to the agents: only the Fable limit is full.
        on_rate_limit(refused("seven_day_overage_included", 4102444800).as_bytes(), a, &dir, &log, Some("fable"));
        let v = account_view(&cfg, &dir, &snapshot, a, now_ms());
        assert_eq!((v.u5, v.u7, v.uf), (25.0, 50.0, 100.0));
        // The week refused, then Fable again (its agents ask every 30 s): the week stays full until the
        // reset the API named.
        on_rate_limit(refused("seven_day", 4000000000).as_bytes(), a, &dir, &log, Some("fable"));
        on_rate_limit(refused("seven_day_overage_included", 4102444800).as_bytes(), a, &dir, &log, Some("fable"));
        let v = account_view(&cfg, &dir, &snapshot, a, now_ms());
        assert_eq!((v.u5, v.u7, v.w7_end), (25.0, 100.0, Some(4_000_000_000_000)));
        // The 5-hour window refused.
        on_rate_limit(refused("five_hour", 4000000000).as_bytes(), a, &dir, &log, Some("fable"));
        let v = account_view(&cfg, &dir, &snapshot, a, now_ms());
        assert_eq!((v.u5, v.w5_end, v.u7), (100.0, Some(4_000_000_000_000), 50.0));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn after_a_refusal_the_strategy_waits_for_a_reset_close_by_and_leaves_softly_for_fable() {
        let dir = std::env::temp_dir().join(format!("router-recheck-test-{}", std::process::id()));
        fs::create_dir_all(dir.join("live")).unwrap();
        let log = Log { path: dir.join("log") };
        let mut cfg = config(vec![account("a", &[], &[]), account("b", &[], &[])]);
        cfg.strategy = true;
        let snapshot = Err("none".to_string());
        let room = br#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.3,"resetsAt":4102444800},"seven_day":{"utilization":0.5,"resetsAt":4102444800}}}}"#;
        on_rate_limit(room, &cfg.accounts[0], &dir, &log, Some("fable"));
        on_rate_limit(room, &cfg.accounts[1], &dir, &log, Some("fable"));
        let refused = |kind: &str, at_s: u64| format!(r#"{{"type":"rate_limit_event","rate_limit_info":{{"status":"rejected","resetsAt":{at_s},"rateLimitType":"{kind}"}}}}"#);
        let tracker = Tracker::new(&dir, None, Kind::T3, "D:/w", Burn::default(), false);
        let opus = models(&["claude-opus-5-5"]);
        let recheck = |models: &[String]| strategy_recheck(&cfg, &dir, &snapshot, &[0, 1], 0, &tracker, models, &opus, None, now_ms());
        // The 5-hour window of a is refused and resets in 15 min: T3 resumes the thread then, on a.
        let soon_s = now_ms() / 1000 + 15 * 60;
        on_rate_limit(refused("five_hour", soon_s).as_bytes(), &cfg.accounts[0], &dir, &log, Some("fable"));
        let m = recheck(&opus).unwrap();
        assert!(m.kind == Leave::Blocked && !m.target_has_quota && m.resume_at_ms == Some(soon_s * 1000), "{}", m.reason);
        // In 21 min: the thread would start again in 90 s, under 20 min before the reset, and stay; so it
        // waits for the reset too.
        let in21_s = now_ms() / 1000 + 21 * 60;
        on_rate_limit(refused("five_hour", in21_s).as_bytes(), &cfg.accounts[0], &dir, &log, Some("fable"));
        let m = recheck(&opus).unwrap();
        assert!(!m.target_has_quota && m.resume_at_ms == Some(in21_s * 1000), "{}", m.reason);
        // It resets in 2 h: the thread goes to b now.
        on_rate_limit(refused("five_hour", soon_s + 2 * 3600).as_bytes(), &cfg.accounts[0], &dir, &log, Some("fable"));
        let m = recheck(&opus).unwrap();
        assert!(m.kind == Leave::Blocked && m.target_has_quota && m.resume_at_ms.is_none() && m.reason.contains("goes to b"), "{}", m.reason);
        // A refusal the strategy cannot see (a weekly limit of Opus alone): no time for T3 from here, it
        // waits for the reset claude named.
        let unseen = std::env::temp_dir().join(format!("router-recheck-test-{}-3", std::process::id()));
        fs::create_dir_all(unseen.join("live")).unwrap();
        on_rate_limit(room, &cfg.accounts[0], &unseen, &log, Some("fable"));
        on_rate_limit(room, &cfg.accounts[1], &unseen, &log, Some("fable"));
        on_rate_limit(refused("seven_day_opus", 4102444800).as_bytes(), &cfg.accounts[0], &unseen, &log, Some("fable"));
        let m = strategy_recheck(&cfg, &unseen, &snapshot, &[0, 1], 0, &tracker, &opus, &opus, None, now_ms()).unwrap();
        assert!(m.kind == Leave::Blocked && !m.target_has_quota && m.resume_at_ms.is_none(), "{}", m.reason);
        let _ = fs::remove_dir_all(unseen);
        // An Opus thread whose agents were refused Fable on a (whose own windows have room): it leaves for
        // b, softly, not ending its background agents.
        let fresh = std::env::temp_dir().join(format!("router-recheck-test-{}-2", std::process::id()));
        fs::create_dir_all(fresh.join("live")).unwrap();
        on_rate_limit(room, &cfg.accounts[0], &fresh, &log, Some("fable"));
        on_rate_limit(room, &cfg.accounts[1], &fresh, &log, Some("fable"));
        on_rate_limit(refused("seven_day_overage_included", 4102444800).as_bytes(), &cfg.accounts[0], &fresh, &log, Some("fable"));
        let with_agents = models(&["claude-opus-5-5", "claude-fable-5-1"]);
        let m = strategy_recheck(&cfg, &fresh, &snapshot, &[0, 1], 0, &tracker, &with_agents, &opus, None, now_ms()).unwrap();
        assert!(m.kind == Leave::Soft && m.reason.contains("goes to b"), "{}", m.reason);
        // A Fable thread there needs the Fable room itself: it leaves even while background tasks run.
        let fable = models(&["claude-fable-5-1"]);
        let m = strategy_recheck(&cfg, &fresh, &snapshot, &[0, 1], 0, &tracker, &fable, &fable, None, now_ms()).unwrap();
        assert!(m.kind != Leave::Soft, "{}", m.reason);
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(fresh);
    }
}
