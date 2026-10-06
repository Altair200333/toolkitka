#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod geo;
mod hub;
mod icon;
mod persistence;
mod providers;

use config::Kind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AccountUsage {
    id: String,
    account_key: Option<String>,
    path: String,
    kind: Kind,
    name: String,
    custom: bool,
    hidden: bool,
    duplicate_of: Option<String>,
    email: Option<String>,
    plan: Option<String>,
    credits: Option<String>,
    windows: Vec<providers::UsageWindow>,
    /// provider response `windows` were derived from; served by the T3 hub
    #[serde(default, skip_serializing_if = "Value::is_null")]
    raw: Value,
    error: Option<String>,
    /// true when `windows` come from the last successful fetch, not this one
    stale: bool,
    updated_ms: Option<u64>,
}

impl AccountUsage {
    fn from_account(acc: &config::Account) -> Self {
        Self {
            id: acc.id.clone(),
            account_key: acc.account_key.clone(),
            path: acc.path.clone(),
            kind: acc.kind,
            name: acc.name.clone(),
            custom: acc.custom,
            hidden: acc.hidden,
            duplicate_of: acc.duplicate_of.clone(),
            email: None,
            plan: None,
            credits: None,
            windows: Vec::new(),
            raw: Value::Null,
            error: None,
            stale: false,
            updated_ms: None,
        }
    }

    fn apply(&mut self, u: providers::ProviderUsage) {
        self.email = u.email;
        self.plan = u.plan;
        self.credits = u.credits;
        self.windows = u.windows;
        self.raw = u.raw;
    }

    fn restore(&mut self, cache: &HashMap<String, (providers::ProviderUsage, u64)>) {
        // Aliases carry their identity but only the current primary carries usage.
        if self.duplicate_of.is_none() {
            if let Some((usage, timestamp)) =
                self.account_key.as_ref().and_then(|key| cache.get(key))
            {
                self.apply(usage.clone());
                self.updated_ms = Some(*timestamp);
                self.stale = true;
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Snapshot {
    schema_version: u32,
    generated_ms: u64,
    accounts: Vec<AccountUsage>,
    /// set when refresh is blocked by the geo guard (message for the UI)
    paused: Option<String>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            schema_version: 1,
            generated_ms: 0,
            accounts: Vec::new(),
            paused: None,
        }
    }
}

#[derive(Default)]
struct AppState {
    snapshot: Mutex<Snapshot>,
    /// last known tray icon rect: (x, y, w, h) in physical pixels
    tray_rect: Mutex<Option<(i32, i32, i32, i32)>>,
    /// Last successful fetch per known provider identity -> (usage, unix ms).
    cache: Mutex<HashMap<String, (providers::ProviderUsage, u64)>>,
    /// per-account backoff: don't fetch again until this unix ms, plus the
    /// error that caused it (shown to the user while cooling down)
    cooldown: Mutex<HashMap<String, (u64, String)>>,
    refreshing: AtomicBool,
    /// suppresses hide-on-blur while the user drags the window
    dragging: AtomicBool,
    /// unix ms of the last refresh start — popup-open refreshes are
    /// throttled against this
    last_refresh_ms: AtomicU64,
    hub_stats: hub::HubStats,
    /// why the T3 hub endpoint is not serving (bind failure etc.)
    hub_error: Mutex<Option<String>>,
}

impl AppState {
    fn load() -> Self {
        match persistence::load() {
            Ok(Some(snapshot)) => {
                Self::restore(snapshot, config::list_accounts(&config::load_config()))
            }
            Ok(None) => Self::default(),
            Err(error) => {
                eprintln!("usage snapshot read: {error}");
                Self::default()
            }
        }
    }

    fn restore(snapshot: Snapshot, accounts: Vec<config::Account>) -> Self {
        let mut cache = HashMap::new();
        for old in snapshot.accounts {
            let (Some(key), Some(timestamp)) = (old.account_key, old.updated_ms) else {
                continue;
            };
            if cache.get(&key).is_some_and(|(_, ts)| *ts >= timestamp) {
                continue;
            }
            cache.insert(
                key,
                (
                    providers::ProviderUsage {
                        email: old.email,
                        plan: old.plan,
                        credits: old.credits,
                        windows: old.windows,
                        raw: old.raw,
                    },
                    timestamp,
                ),
            );
        }
        // Do not retain disk data for an unknown or no-longer-signed-in account.
        cache.retain(|key, _| {
            accounts.iter().any(|account| account.account_key.as_ref() == Some(key))
        });
        let accounts = accounts
            .iter()
            .map(|account| {
                let mut item = AccountUsage::from_account(account);
                item.restore(&cache);
                item
            })
            .collect();
        Self {
            snapshot: Mutex::new(Snapshot {
                accounts,
                ..snapshot
            }),
            cache: Mutex::new(cache),
            ..Self::default()
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("uzalka/0.1")
        .build()
        .expect("http client")
}

fn update_tray(app: &AppHandle, snapshot: &Snapshot) {
    let visible: Vec<&AccountUsage> = snapshot
        .accounts
        .iter()
        .filter(|a| !a.hidden && a.duplicate_of.is_none())
        .collect();
    // Overall usage across accounts: average of each account's main weekly
    // limit (sum of used percents normalized to the combined capacity).
    let weekly: Vec<f64> = visible
        .iter()
        .filter_map(|a| {
            a.windows
                .iter()
                .find(|w| w.label == "Weekly")
                .or_else(|| a.windows.iter().find(|w| w.label.starts_with("Weekly")))
                .map(|w| w.percent)
        })
        .collect();
    let percent = if weekly.is_empty() {
        None
    } else {
        Some(weekly.iter().sum::<f64>() / weekly.len() as f64)
    };
    let rgba = icon::render(percent);

    let mut tooltip = String::new();
    if let Some(msg) = &snapshot.paused {
        tooltip.push_str(&format!("⏸ {}\n", msg));
    }
    if let Some(p) = percent {
        tooltip.push_str(&format!("Total weekly: {:.0}%\n", p));
    }
    for a in &visible {
        let kind = match a.kind {
            Kind::Claude => "Claude",
            Kind::Codex => "Codex",
        };
        if a.windows.is_empty() {
            let e = a.error.as_deref().unwrap_or("no data");
            tooltip.push_str(&format!("{} [{}]: {}\n", a.name, kind, e));
        } else {
            let parts: Vec<String> = a
                .windows
                .iter()
                .map(|w| format!("{} {:.0}%", w.label, w.percent))
                .collect();
            let stale = if a.stale { " (stale)" } else { "" };
            tooltip.push_str(&format!(
                "{} [{}]: {}{}\n",
                a.name,
                kind,
                parts.join(" · "),
                stale
            ));
        }
    }
    if tooltip.is_empty() {
        tooltip = "Uzalka: no accounts".to_string();
    }

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_icon(Some(Image::new_owned(rgba, 32, 32)));
        let _ = tray.set_tooltip(Some(tooltip.trim_end()));
    }
}

/// A login problem of one config dir only; a twin dir may still be signed in.
fn login_error(e: &str) -> bool {
    e.contains("run /login") || e.starts_with("credentials:")
}

/// Whether an attempt through the next dir of an account replaces the result
/// kept so far: a success always does; otherwise the primary's error stays,
/// unless it is only its own dir's login problem (a signed-out primary must
/// not hide that a signed-in twin got rate limited).
fn twin_takes_over(kept: Option<&Result<providers::ProviderUsage, String>>, attempt_ok: bool) -> bool {
    attempt_ok || kept.map_or(true, |r| matches!(r, Err(e) if login_error(e)))
}

async fn refresh_all(app: &AppHandle) {
    let state: State<AppState> = app.state();
    if state.refreshing.swap(true, Ordering::SeqCst) {
        return; // a refresh is already in flight
    }
    state.last_refresh_ms.store(now_ms(), Ordering::SeqCst);

    let cfg = config::load_config();
    let accounts = config::list_accounts(&cfg);
    let client = http_client();
    let mut results: Vec<AccountUsage> = Vec::new();
    let mut fetched_any = false;

    // Geo guard: never hit provider APIs from a blocked country, so the
    // user doesn't accidentally get flagged/logged out. Unknown location
    // also blocks (fail-safe).
    let verdict = geo::check(&client).await;
    let paused: Option<String> = if verdict.allowed {
        None
    } else {
        Some(match (&verdict.country, &verdict.ip) {
            (Some(c), Some(ip)) => format!("Refresh paused — {} IP detected ({})", c, ip),
            (Some(c), None) => format!("Refresh paused — {} IP detected", c),
            _ => "Refresh paused — can't verify IP location".to_string(),
        })
    };

    for acc in accounts {
        let mut item = AccountUsage::from_account(&acc);
        item.restore(&state.cache.lock().unwrap());
        let fetchable = !acc.hidden && acc.duplicate_of.is_none();
        let cooldown_key = acc.account_key.as_deref().unwrap_or(&acc.id);

        if fetchable {
            if let Some(msg) = &paused {
                item.error = Some(msg.clone());
                results.push(item);
                continue;
            }
            let cooled = {
                let cd = state.cooldown.lock().unwrap();
                cd.get(cooldown_key)
                    .filter(|(until, _)| *until > now_ms())
                    .cloned()
            };
            if let Some((until, reason)) = cooled {
                // keep showing the real cause; only the retry time is new info
                let mins = (until.saturating_sub(now_ms()) + 59_999) / 60_000;
                item.error = Some(format!("{reason} (retrying in {mins}m)"));
            } else {
                // stagger requests instead of a parallel burst
                if fetched_any {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                }
                fetched_any = true;
                // the primary dir first, then its visible twins (same account)
                let mut res: Option<Result<providers::ProviderUsage, String>> = None;
                for path in std::iter::once(&acc.path).chain(acc.fallbacks.iter()) {
                    let dir = PathBuf::from(path);
                    // A login can change while geo/other accounts are being fetched.
                    let mut attempt = if config::account_key(&dir, acc.kind) != acc.account_key {
                        Err("account changed during refresh — retry to load current login".into())
                    } else {
                        match acc.kind {
                            Kind::Claude => providers::fetch_claude(&client, &dir).await,
                            Kind::Codex => providers::fetch_codex(&client, &dir).await,
                        }
                    };
                    if attempt.is_ok() && config::account_key(&dir, acc.kind) != acc.account_key {
                        attempt = Err("account changed during refresh — retry to load current login".into());
                    }
                    let done = attempt.is_ok();
                    if twin_takes_over(res.as_ref(), done) {
                        res = Some(attempt);
                    }
                    if done {
                        break;
                    }
                }
                let res = res.expect("at least the primary dir is tried");
                match res {
                    Ok(u) => {
                        let timestamp = now_ms();
                        item.apply(u.clone());
                        item.stale = false;
                        item.updated_ms = Some(timestamp);
                        if let Some(key) = &acc.account_key {
                            state.cache.lock().unwrap().insert(key.clone(), (u, timestamp));
                        }
                        state.cooldown.lock().unwrap().remove(cooldown_key);
                    }
                    Err(e) => {
                        let low = e.to_lowercase();
                        let backoff_ms: u64 = if low.contains("429") || low.contains("rate limit") {
                            5 * 60 * 1000
                        } else if low.contains("refresh failed") {
                            15 * 60 * 1000
                        } else {
                            0
                        };
                        if backoff_ms > 0 {
                            state.cooldown.lock().unwrap().insert(
                                cooldown_key.to_string(),
                                (now_ms() + backoff_ms, e.clone()),
                            );
                        }
                        item.error = Some(e);
                    }
                }
            }
        }
        results.push(item);
    }

    let snap = Snapshot {
        schema_version: 1,
        generated_ms: now_ms(),
        accounts: results,
        paused,
    };
    if let Err(error) = persistence::save(&snap) {
        eprintln!("usage snapshot write: {error}");
    }
    *state.snapshot.lock().unwrap() = snap.clone();
    update_tray(app, &snap);
    let _ = app.emit("snapshot", &snap);
    state.refreshing.store(false, Ordering::SeqCst);
}

// ------------------------------------------------------------- commands ----

#[tauri::command]
fn get_snapshot(state: State<AppState>) -> Snapshot {
    state.snapshot.lock().unwrap().clone()
}

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Uzalka";

#[tauri::command]
fn get_autostart() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .and_then(|k| k.get_value::<String, _>(RUN_VALUE))
        .is_ok()
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_value(RUN_VALUE, &format!("\"{}\"", exe.display()))
            .map_err(|e| e.to_string())?;
    } else {
        let _ = key.delete_value(RUN_VALUE);
    }
    Ok(())
}

#[derive(Serialize)]
struct HubInfo {
    enabled: bool,
    url: String,
    key: String,
    error: Option<String>,
    requests: u64,
    unauthorized: u64,
    last_request_ms: u64,
}

#[tauri::command]
fn get_hub_info(state: State<AppState>) -> HubInfo {
    let hub = config::load_config().hub;
    HubInfo {
        enabled: hub.enabled,
        url: format!("http://127.0.0.1:{}", hub.port),
        key: hub.key,
        error: state.hub_error.lock().unwrap().clone(),
        requests: state.hub_stats.requests.load(Ordering::SeqCst),
        unauthorized: state.hub_stats.unauthorized.load(Ordering::SeqCst),
        last_request_ms: state.hub_stats.last_request_ms.load(Ordering::SeqCst),
    }
}

#[tauri::command]
fn begin_drag(app: AppHandle, state: State<AppState>) {
    state.dragging.store(true, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.start_dragging();
    }
}

#[tauri::command]
async fn refresh_now(app: AppHandle) {
    refresh_all(&app).await;
}

#[tauri::command]
async fn add_custom_path(app: AppHandle, path: String) -> Result<(), String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err("Folder not found".into());
    }
    if config::detect_kind(dir).is_none() {
        return Err("No .credentials.json (Claude) or auth.json (Codex) in this folder".into());
    }
    let mut cfg = config::load_config();
    if !cfg.custom_paths.contains(&path) {
        cfg.custom_paths.push(path);
        config::save_config(&cfg)?;
    }
    refresh_all(&app).await;
    Ok(())
}

#[tauri::command]
async fn remove_custom_path(app: AppHandle, path: String) -> Result<(), String> {
    let mut cfg = config::load_config();
    cfg.custom_paths.retain(|p| p != &path);
    config::save_config(&cfg)?;
    refresh_all(&app).await;
    Ok(())
}

#[tauri::command]
async fn set_hidden(app: AppHandle, id: String, hidden: bool) -> Result<(), String> {
    let mut cfg = config::load_config();
    if hidden {
        if !cfg.hidden.contains(&id) {
            cfg.hidden.push(id);
        }
    } else {
        cfg.hidden.retain(|h| h != &id);
    }
    config::save_config(&cfg)?;
    refresh_all(&app).await;
    Ok(())
}

// ----------------------------------------------------------------- main ----

/// Place the popup near the tray icon, fully on-screen (above a bottom
/// taskbar, below a top one). Falls back to the bottom-right corner of the
/// primary monitor when the tray rect is unknown.
fn position_window(app: &AppHandle, win: &WebviewWindow) {
    let state: State<AppState> = app.state();
    let rect = *state.tray_rect.lock().unwrap();

    let size = win.outer_size().unwrap_or(tauri::PhysicalSize::new(330, 430));
    let (w, h) = (size.width as i32, size.height as i32);

    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());
    let (mx, my, mw, mh) = monitor
        .map(|m| {
            (
                m.position().x,
                m.position().y,
                m.size().width as i32,
                m.size().height as i32,
            )
        })
        .unwrap_or((0, 0, 1920, 1080));

    const M: i32 = 8; // margin
    let (x, y) = match rect {
        Some((rx, ry, rw, rh)) => {
            let x = (rx + rw - w).clamp(mx + M, mx + mw - w - M);
            let y = if ry - my > mh / 2 {
                ry - h - M // taskbar at bottom -> popup above it
            } else {
                ry + rh + M // taskbar at top -> popup below it
            };
            (x, y.clamp(my + M, my + mh - h - M))
        }
        None => (mx + mw - w - 16, my + mh - h - 72),
    };
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            position_window(app, &win);
            let _ = win.show();
            let _ = win.set_focus();
            // opportunistic refresh on open, throttled so spamming the
            // tray doesn't hammer the APIs
            let state: State<AppState> = app.state();
            let last = state.last_refresh_ms.load(Ordering::SeqCst);
            if now_ms().saturating_sub(last) >= 60_000 {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { refresh_all(&app).await });
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            toggle_window(app);
        }))
        .manage(AppState::load())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            begin_drag,
            get_autostart,
            set_autostart,
            get_hub_info,
            refresh_now,
            add_custom_path,
            remove_custom_path,
            set_hidden
        ])
        .setup(|app| {
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&refresh, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(Image::new_owned(icon::render(Some(0.0)), 32, 32))
                .tooltip("Uzalka: loading…")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "refresh" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move { refresh_all(&app).await });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        let (rx, ry) = match rect.position {
                            tauri::Position::Physical(p) => (p.x, p.y),
                            tauri::Position::Logical(p) => (p.x as i32, p.y as i32),
                        };
                        let (rw, rh) = match rect.size {
                            tauri::Size::Physical(s) => (s.width as i32, s.height as i32),
                            tauri::Size::Logical(s) => (s.width as i32, s.height as i32),
                        };
                        let state: State<AppState> = app.state();
                        *state.tray_rect.lock().unwrap() = Some((rx, ry, rw, rh));
                        toggle_window(app);
                    }
                })
                .build(app)?;

            update_tray(
                app.handle(),
                &app.state::<AppState>().snapshot.lock().unwrap(),
            );

            // poll loop
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    refresh_all(&handle).await;
                    let secs = config::load_config().poll_seconds.max(120);
                    tokio::time::sleep(Duration::from_secs(secs)).await;
                }
            });

            hub::start(app.handle().clone());

            Ok(())
        })
        .on_window_event(|win, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = win.hide();
            }
            tauri::WindowEvent::Focused(false) => {
                let state: State<AppState> = win.app_handle().state();
                if !state.dragging.load(Ordering::SeqCst) {
                    let _ = win.hide();
                }
            }
            tauri::WindowEvent::Focused(true) => {
                let state: State<AppState> = win.app_handle().state();
                state.dragging.store(false, Ordering::SeqCst);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running uzalka");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(path: &str, key: Option<&str>) -> config::Account {
        config::Account {
            id: path.into(),
            path: path.into(),
            account_key: key.map(str::to_string),
            kind: Kind::Claude,
            name: path.into(),
            custom: false,
            hidden: false,
            duplicate_of: None,
            fallbacks: Vec::new(),
        }
    }

    fn saved(path: &str, key: Option<&str>, timestamp: u64) -> AccountUsage {
        let mut item = AccountUsage::from_account(&account(path, key));
        item.updated_ms = Some(timestamp);
        item.stale = true;
        item.error = Some("usage API rate limited (HTTP 429)".into());
        item.windows.push(providers::UsageWindow {
            label: "Weekly".into(),
            percent: 42.0,
            kind: Some("weekly_all".into()),
            scope: None,
            resets_at: serde_json::Value::Null,
        });
        item
    }

    #[test]
    fn restored_success_follows_identity_to_current_primary_and_keeps_aliases() {
        let old = Snapshot {
            generated_ms: 300,
            accounts: vec![
                saved("old", Some("claude:one"), 100),
                saved("old-twin", Some("claude:one"), 200),
            ],
            paused: Some("geo paused".into()),
            ..Snapshot::default()
        };
        let mut hidden_primary = account("new-primary", Some("claude:one"));
        hidden_primary.hidden = true;
        let mut duplicate = account("new-twin", Some("claude:one"));
        duplicate.hidden = true;
        duplicate.duplicate_of = Some("new-primary".into());
        let state = AppState::restore(old, vec![hidden_primary, duplicate]);
        let snapshot = state.snapshot.lock().unwrap();
        assert_eq!(snapshot.generated_ms, 300);
        assert_eq!(snapshot.paused.as_deref(), Some("geo paused"));
        assert_eq!(snapshot.accounts.len(), 2);
        assert_eq!(snapshot.accounts[0].path, "new-primary");
        assert_eq!(snapshot.accounts[0].updated_ms, Some(200));
        assert_eq!(snapshot.accounts[0].windows[0].percent, 42.0);
        assert!(snapshot.accounts[0].stale);
        assert_eq!(snapshot.accounts[1].account_key.as_deref(), Some("claude:one"));
        assert!(snapshot.accounts[1].windows.is_empty());
    }

    #[test]
    fn changed_or_unknown_login_never_inherits_path_cache() {
        let old = Snapshot {
            accounts: vec![
                saved("same-path", Some("claude:old"), 100),
                saved("unknown", None, 100),
            ],
            ..Snapshot::default()
        };
        let state = AppState::restore(
            old,
            vec![account("same-path", Some("claude:new")), account("unknown", None)],
        );
        assert!(state.cache.lock().unwrap().is_empty());
        for item in &state.snapshot.lock().unwrap().accounts {
            assert!(item.windows.is_empty());
            assert_eq!(item.updated_ms, None);
        }
    }

    #[test]
    fn empty_successful_usage_is_restored_by_timestamp() {
        let mut old_account = saved("path", Some("claude:one"), 100);
        old_account.windows.clear();
        old_account.plan = Some("Max 20x".into());
        let old = Snapshot {
            accounts: vec![old_account],
            ..Snapshot::default()
        };
        let state = AppState::restore(old, vec![account("path", Some("claude:one"))]);
        let snapshot = state.snapshot.lock().unwrap();
        assert_eq!(snapshot.accounts[0].updated_ms, Some(100));
        assert_eq!(snapshot.accounts[0].plan.as_deref(), Some("Max 20x"));
    }

    #[test]
    fn signed_out_primary_does_not_hide_a_twins_error() {
        let signed_out: Result<providers::ProviderUsage, String> =
            Err("signed out — run /login in Claude Code with this account".into());
        let limited: Result<providers::ProviderUsage, String> =
            Err("usage API rate limited (HTTP 429)".into());
        assert!(twin_takes_over(None, false), "the primary's own attempt is always kept");
        assert!(twin_takes_over(Some(&signed_out), false));
        assert!(twin_takes_over(Some(&Err("credentials: no accessToken".into())), false));
        assert!(!twin_takes_over(Some(&limited), false), "a real account error stays");
        assert!(twin_takes_over(Some(&limited), true), "a success always wins");
    }
}
