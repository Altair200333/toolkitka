//! "CLIProxyAPI hub" endpoint for T3 Code.
//!
//! T3 Code (Settings → Providers → "Add a CLIProxyAPI hub") polls a hub for the
//! quota of every account it pools and shows them in its usage-limits panel.
//! Uzalka already has that data, so it answers the three management calls T3
//! makes, from the in-memory snapshot, without ever proxying anything upstream:
//!
//!   GET  /v0/management/auth-files                  -> { files: [...] }
//!   POST /v0/management/api-call { auth_index, url } -> { status_code, body: "<provider json>" }
//!   POST /v0/management/reset-quota                  -> { status: "ok" }
//!
//! One more for the account router (claude-router), which must not pick an
//! account on old data:
//!
//!   GET  /v0/router/usage?max_age_ms=300000          -> usage.json snapshot
//!
//! All with `Authorization: Bearer <key>` (or `X-Management-Key`). Bound to
//! 127.0.0.1 only. Configure in config.json under `hub` (enabled/port/key);
//! T3 gets the URL and key from the settings view.

use crate::{config, now_ms, refresh_all, AccountUsage, AppState, Kind};
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// A hub poll refreshes usage when the last refresh is older than this.
const STALE_AFTER_MS: u64 = 5 * 60 * 1000;
/// Data older than this is reported as unavailable instead of served.
const MAX_AGE_MS: u64 = 24 * 3600 * 1000;
/// The router waits at most this long for a refresh, then gets what there is.
const ROUTER_WAIT: Duration = Duration::from_secs(45);
/// How often a busy port is tried again.
const BIND_RETRY: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct HubStats {
    pub requests: AtomicU64,
    pub unauthorized: AtomicU64,
    pub last_request_ms: AtomicU64,
}

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    key: String,
}

pub fn start(app: AppHandle) {
    let mut cfg = config::load_config();
    if !cfg.hub.enabled {
        return;
    }
    if cfg.hub.key.is_empty() {
        cfg.hub.key = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        if let Err(error) = config::save_config(&cfg) {
            set_error(&app, format!("could not save hub key: {error}"));
            return;
        }
    }
    let port = cfg.hub.port;
    let ctx = Ctx {
        app: app.clone(),
        key: cfg.hub.key,
    };
    tauri::async_runtime::spawn(async move {
        let router = Router::new()
            .route("/healthz", get(healthz))
            .route("/v0/management/auth-files", get(auth_files))
            .route("/v0/management/api-call", post(api_call))
            .route("/v0/management/reset-quota", post(reset_quota))
            .route("/v0/router/usage", get(router_usage))
            .fallback(not_found)
            .with_state(ctx.clone());
        // A Uzalka that is just restarting may still hold the port for a moment.
        let listener = loop {
            match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => break listener,
                Err(error) => {
                    set_error(&ctx.app, format!("cannot listen on 127.0.0.1:{port}: {error} (retrying)"));
                    tokio::time::sleep(BIND_RETRY).await;
                }
            }
        };
        *ctx.app.state::<AppState>().hub_error.lock().unwrap() = None;
        if let Err(error) = axum::serve(listener, router).await {
            set_error(&ctx.app, format!("hub stopped: {error}"));
        }
    });
}

fn set_error(app: &AppHandle, message: String) {
    eprintln!("t3 hub: {message}");
    let state: tauri::State<AppState> = app.state();
    *state.hub_error.lock().unwrap() = Some(message);
}

// ------------------------------------------------------------------ auth ----

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn presented_key(headers: &HeaderMap) -> &str {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            let (scheme, rest) = v.split_once(' ')?;
            scheme.eq_ignore_ascii_case("bearer").then_some(rest)
        });
    bearer
        .or_else(|| headers.get("x-management-key").and_then(|v| v.to_str().ok()))
        .map(str::trim)
        .unwrap_or("")
}

/// Counts the request and rejects it unless it carries the management key.
fn gate(ctx: &Ctx, headers: &HeaderMap) -> Result<(), Response> {
    let state: tauri::State<AppState> = ctx.app.state();
    state.hub_stats.requests.fetch_add(1, Ordering::SeqCst);
    state.hub_stats.last_request_ms.store(now_ms(), Ordering::SeqCst);
    if !ctx.key.is_empty() && constant_time_eq(presented_key(headers).as_bytes(), ctx.key.as_bytes()) {
        Ok(())
    } else {
        state.hub_stats.unauthorized.fetch_add(1, Ordering::SeqCst);
        Err(reply(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" })))
    }
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

// -------------------------------------------------------------- handlers ----

async fn healthz(State(ctx): State<Ctx>) -> Response {
    let state: tauri::State<AppState> = ctx.app.state();
    reply(
        StatusCode::OK,
        json!({
            "ok": true,
            "requests": state.hub_stats.requests.load(Ordering::SeqCst),
            "unauthorized": state.hub_stats.unauthorized.load(Ordering::SeqCst),
            "last_request_ms": state.hub_stats.last_request_ms.load(Ordering::SeqCst),
        }),
    )
}

async fn auth_files(State(ctx): State<Ctx>, headers: HeaderMap) -> Response {
    if let Err(rejected) = gate(&ctx, &headers) {
        return rejected;
    }
    maybe_refresh(&ctx.app);
    let files: Vec<Value> = exposed_accounts(&ctx.app).iter().map(auth_file).collect();
    reply(StatusCode::OK, json!({ "files": files }))
}

async fn api_call(State(ctx): State<Ctx>, headers: HeaderMap, body: Bytes) -> Response {
    if let Err(rejected) = gate(&ctx, &headers) {
        return rejected;
    }
    let request: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return reply(StatusCode::BAD_REQUEST, json!({ "error": "invalid json" })),
    };
    let auth_index = ["auth_index", "authIndex", "AuthIndex"]
        .iter()
        .find_map(|key| request.get(*key).and_then(Value::as_str))
        .unwrap_or("");
    let url = request.get("url").and_then(Value::as_str).unwrap_or("");
    let Some(account) = exposed_accounts(&ctx.app)
        .into_iter()
        .find(|a| a.name == auth_index)
    else {
        return reply(StatusCode::NOT_FOUND, json!({ "error": "unknown auth_index" }));
    };
    let (status_code, body) = upstream_reply(&account, url);
    reply(
        StatusCode::OK,
        json!({
            "status_code": status_code,
            "header": { "Content-Type": ["application/json"] },
            "body": body.to_string(),
        }),
    )
}

async fn reset_quota(State(ctx): State<Ctx>, headers: HeaderMap) -> Response {
    if let Err(rejected) = gate(&ctx, &headers) {
        return rejected;
    }
    reply(StatusCode::OK, json!({ "status": "ok" }))
}

/// Unlike the T3 calls, this one waits: when the last refresh started longer
/// than `max_age_ms` ago it refreshes first, and a refresh already running is
/// waited for. The reply is the snapshot as in usage.json, plus `refreshed`
/// (a refresh finished before the reply) and `timed_out`.
async fn router_usage(State(ctx): State<Ctx>, headers: HeaderMap, uri: Uri) -> Response {
    if let Err(rejected) = gate(&ctx, &headers) {
        return rejected;
    }
    let app = ctx.app.clone();
    let refreshing = || app.state::<AppState>().refreshing.load(Ordering::SeqCst);
    let last = app.state::<AppState>().last_refresh_ms.load(Ordering::SeqCst);
    let stale = now_ms().saturating_sub(last) >= max_age_ms(uri.query());
    let refreshed = stale || refreshing();
    let wait = async {
        if stale {
            // Dropping the waiter on timeout/disconnect must not cancel the refresh.
            let app = app.clone();
            let _ = tauri::async_runtime::spawn(async move { refresh_all(&app).await }).await;
        }
        while refreshing() {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    let timed_out = tokio::time::timeout(ROUTER_WAIT, wait).await.is_err();
    let snapshot = app.state::<AppState>().snapshot.lock().unwrap().clone();
    let mut body = serde_json::to_value(&snapshot).unwrap_or_else(|_| json!({}));
    body["refreshed"] = json!(refreshed && !timed_out);
    body["timed_out"] = json!(timed_out);
    reply(StatusCode::OK, body)
}

fn max_age_ms(query: Option<&str>) -> u64 {
    query
        .unwrap_or("")
        .split('&')
        .find_map(|pair| pair.strip_prefix("max_age_ms="))
        .and_then(|v| v.parse().ok())
        .unwrap_or(STALE_AFTER_MS)
}

async fn not_found() -> Response {
    reply(StatusCode::NOT_FOUND, json!({ "error": "not found" }))
}

// ------------------------------------------------------------------ data ----

/// Kick a refresh when the snapshot is stale; the reply still comes from
/// the current snapshot because T3 gives a hub only 15 s per request.
fn maybe_refresh(app: &AppHandle) {
    let state: tauri::State<AppState> = app.state();
    let last = state.last_refresh_ms.load(Ordering::SeqCst);
    if now_ms().saturating_sub(last) >= STALE_AFTER_MS && !state.refreshing.load(Ordering::SeqCst) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { refresh_all(&app).await });
    }
}

/// One entry per real account: hidden ones and twins stay out (T3 merges
/// by provider + email anyway).
fn exposed_accounts(app: &AppHandle) -> Vec<AccountUsage> {
    let state: tauri::State<AppState> = app.state();
    let snapshot = state.snapshot.lock().unwrap();
    snapshot
        .accounts
        .iter()
        .filter(|a| !a.hidden && a.duplicate_of.is_none())
        .cloned()
        .collect()
}

fn provider_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Claude => "claude",
        Kind::Codex => "codex",
    }
}

fn auth_file(a: &AccountUsage) -> Value {
    let mut file = json!({
        "id": format!("{}.json", a.name),
        "auth_index": a.name,
        "provider": provider_name(a.kind),
        "disabled": false,
    });
    if let Some(email) = &a.email {
        file["email"] = json!(email);
    }
    if a.kind == Kind::Codex {
        let mut id_token = Map::new();
        if let Some(id) = a.account_key.as_deref().and_then(|k| k.strip_prefix("codex:")) {
            id_token.insert("chatgpt_account_id".into(), json!(id));
        }
        if let Some(plan) = &a.plan {
            id_token.insert("chatgpt_plan_type".into(), json!(plan.to_lowercase()));
        }
        file["id_token"] = Value::Object(id_token);
    }
    file
}

/// What CLIProxyAPI's `/api-call` would report for the upstream request T3
/// asked for: (status_code, body).
fn upstream_reply(a: &AccountUsage, url: &str) -> (u16, Value) {
    if a.kind == Kind::Codex && url.contains("rate-limit-reset-credits") {
        return (200, json!({ "credits": [] }));
    }
    let fresh = a.updated_ms.is_some_and(|t| now_ms().saturating_sub(t) < MAX_AGE_MS);
    if (a.windows.is_empty() && a.raw.is_null()) || !fresh {
        let error = a
            .error
            .clone()
            .unwrap_or_else(|| "uzalka has no data for this account yet".to_string());
        return (503, json!({ "error": error }));
    }
    match a.kind {
        Kind::Claude if url.contains("api.anthropic.com/api/oauth/usage") => (200, claude_body(a)),
        Kind::Codex if url.contains("chatgpt.com/backend-api/wham/usage") => (200, codex_body(a)),
        _ => (404, json!({ "error": format!("uzalka hub does not proxy {url}") })),
    }
}

/// The Anthropic usage response, with `five_hour`/`seven_day`/`limits`
/// filled in from the parsed windows when the response lacks them (T3
/// reads the first two for the main bars and `limits` for per-model ones).
fn claude_body(a: &AccountUsage) -> Value {
    let mut body = a.raw.as_object().cloned().unwrap_or_default();
    for (kind, key) in [("session", "five_hour"), ("weekly_all", "seven_day")] {
        if body.get(key).map_or(true, Value::is_null) {
            if let Some(w) = a.windows.iter().find(|w| w.kind.as_deref() == Some(kind)) {
                body.insert(
                    key.into(),
                    json!({ "utilization": w.percent, "resets_at": w.resets_at }),
                );
            }
        }
    }
    if body.get("limits").map_or(true, Value::is_null) {
        let limits: Vec<Value> = a
            .windows
            .iter()
            .filter(|w| w.kind.is_some())
            .map(|w| {
                json!({
                    "kind": w.kind,
                    "percent": w.percent,
                    "resets_at": w.resets_at,
                    "scope": w.scope,
                })
            })
            .collect();
        body.insert("limits".into(), Value::Array(limits));
    }
    Value::Object(body)
}

/// The ChatGPT usage response; rebuilt from the windows when the raw
/// response is missing (snapshot written by an older Uzalka).
fn codex_body(a: &AccountUsage) -> Value {
    if a.raw.get("rate_limit").is_some_and(|v| !v.is_null()) {
        return a.raw.clone();
    }
    let mut primary = None;
    let mut secondary = None;
    for w in &a.windows {
        let seconds: u64 = if w.label.starts_with("Session") {
            5 * 3600
        } else if w.label == "Weekly" {
            7 * 86400
        } else {
            w.label.trim_end_matches('h').parse::<u64>().map(|h| h * 3600).unwrap_or(0)
        };
        let mut window = Map::new();
        window.insert("used_percent".into(), json!(w.percent));
        window.insert("reset_at".into(), w.resets_at.clone());
        if seconds > 0 {
            window.insert("limit_window_seconds".into(), json!(seconds));
        }
        let window = Value::Object(window);
        if seconds <= 6 * 3600 && primary.is_none() {
            primary = Some(window);
        } else if secondary.is_none() {
            secondary = Some(window);
        } else if primary.is_none() {
            primary = Some(window);
        }
    }
    let mut body = Map::new();
    if let Some(plan) = &a.plan {
        body.insert("plan_type".into(), json!(plan.to_lowercase()));
    }
    body.insert(
        "rate_limit".into(),
        json!({ "primary_window": primary, "secondary_window": secondary }),
    );
    Value::Object(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::UsageWindow;

    fn account(kind: Kind, windows: Vec<UsageWindow>, raw: Value) -> AccountUsage {
        AccountUsage {
            id: "id".into(),
            account_key: Some(match kind {
                Kind::Claude => "claude:uuid".to_string(),
                Kind::Codex => "codex:acct-1".to_string(),
            }),
            path: "p".into(),
            kind,
            name: "acc".into(),
            custom: false,
            hidden: false,
            duplicate_of: None,
            email: Some("a@b.c".into()),
            plan: Some("Max 20x".into()),
            credits: None,
            windows,
            raw,
            error: None,
            stale: false,
            updated_ms: Some(now_ms()),
        }
    }

    fn window(label: &str, kind: Option<&str>, percent: f64, resets_at: Value) -> UsageWindow {
        UsageWindow {
            label: label.into(),
            percent,
            kind: kind.map(str::to_string),
            scope: None,
            resets_at,
        }
    }

    #[test]
    fn claude_body_fills_main_windows_and_limits_when_raw_is_missing() {
        let a = account(
            Kind::Claude,
            vec![
                window("Session (5h)", Some("session"), 28.0, json!("2026-09-07T07:40:00Z")),
                window("Weekly", Some("weekly_all"), 20.0, json!("2026-09-07T15:00:00Z")),
            ],
            Value::Null,
        );
        let (status, body) = upstream_reply(&a, "https://api.anthropic.com/api/oauth/usage");
        assert_eq!(status, 200);
        assert_eq!(body["five_hour"]["utilization"], json!(28.0));
        assert_eq!(body["seven_day"]["resets_at"], json!("2026-09-07T15:00:00Z"));
        assert_eq!(body["limits"].as_array().unwrap().len(), 2);
        assert_eq!(body["limits"][1]["kind"], json!("weekly_all"));
    }

    #[test]
    fn claude_body_keeps_raw_and_only_adds_missing_keys() {
        let raw = json!({
            "limits": [{"kind": "session", "percent": 5, "resets_at": null, "scope": null}],
            "extra": true
        });
        let a = account(
            Kind::Claude,
            vec![window("Session (5h)", Some("session"), 5.0, Value::Null)],
            raw.clone(),
        );
        let (_, body) = upstream_reply(&a, "https://api.anthropic.com/api/oauth/usage");
        assert_eq!(body["limits"], raw["limits"]);
        assert_eq!(body["extra"], json!(true));
        assert_eq!(body["five_hour"]["utilization"], json!(5.0));
        assert!(body.get("seven_day").is_none());
    }

    #[test]
    fn codex_body_prefers_raw_and_rebuilds_windows_otherwise() {
        let raw = json!({"plan_type": "pro", "rate_limit": {"primary_window": {"used_percent": 1}}});
        let with_raw = account(Kind::Codex, Vec::new(), raw.clone());
        assert_eq!(upstream_reply(&with_raw, "https://chatgpt.com/backend-api/wham/usage").1, raw);

        let rebuilt = account(
            Kind::Codex,
            vec![window("Weekly", None, 86.0, json!(1789197401))],
            Value::Null,
        );
        let (status, body) = upstream_reply(&rebuilt, "https://chatgpt.com/backend-api/wham/usage");
        assert_eq!(status, 200);
        assert!(body["rate_limit"]["primary_window"].is_null());
        assert_eq!(body["rate_limit"]["secondary_window"]["used_percent"], json!(86.0));
        assert_eq!(body["rate_limit"]["secondary_window"]["limit_window_seconds"], json!(604800));
        assert_eq!(body["plan_type"], json!("max 20x"));
    }

    #[test]
    fn unavailable_unknown_and_credits_replies() {
        let mut stale = account(Kind::Claude, Vec::new(), Value::Null);
        stale.error = Some("signed out".into());
        assert_eq!(upstream_reply(&stale, "https://api.anthropic.com/api/oauth/usage").0, 503);
        let mut old = account(Kind::Claude, vec![window("Weekly", Some("weekly_all"), 1.0, Value::Null)], Value::Null);
        old.updated_ms = Some(now_ms() - MAX_AGE_MS - 1);
        assert_eq!(upstream_reply(&old, "https://api.anthropic.com/api/oauth/usage").0, 503);
        let ok = account(Kind::Claude, vec![window("Weekly", Some("weekly_all"), 1.0, Value::Null)], Value::Null);
        assert_eq!(upstream_reply(&ok, "https://example.com/x").0, 404);
        let codex = account(Kind::Codex, Vec::new(), Value::Null);
        let (status, body) = upstream_reply(&codex, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
        assert_eq!((status, body["credits"].as_array().unwrap().len()), (200, 0));
    }

    #[test]
    fn router_max_age_from_query() {
        assert_eq!(max_age_ms(Some("max_age_ms=60000")), 60_000);
        assert_eq!(max_age_ms(Some("x=1&max_age_ms=0")), 0);
        assert_eq!(max_age_ms(Some("max_age_ms=bad")), STALE_AFTER_MS);
        assert_eq!(max_age_ms(None), STALE_AFTER_MS);
    }

    #[test]
    fn auth_file_shape_and_key_check() {
        let codex = account(Kind::Codex, Vec::new(), Value::Null);
        let file = auth_file(&codex);
        assert_eq!(file["id"], json!("acc.json"));
        assert_eq!(file["provider"], json!("codex"));
        assert_eq!(file["id_token"]["chatgpt_account_id"], json!("acct-1"));
        assert_eq!(file["id_token"]["chatgpt_plan_type"], json!("max 20x"));
        let claude = auth_file(&account(Kind::Claude, Vec::new(), Value::Null));
        assert!(claude.get("id_token").is_none());

        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer  secret ".parse().unwrap());
        assert_eq!(presented_key(&headers), "secret");
        headers.clear();
        headers.insert("x-management-key", "alt".parse().unwrap());
        assert_eq!(presented_key(&headers), "alt");
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
