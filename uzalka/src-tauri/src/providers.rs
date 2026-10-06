use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageWindow {
    pub label: String,
    pub percent: f64,
    pub kind: Option<String>,
    pub scope: Option<Value>,
    /// ISO string (Claude) or unix seconds (Codex); frontend normalizes.
    pub resets_at: Value,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ProviderUsage {
    pub email: Option<String>,
    pub plan: Option<String>,
    pub credits: Option<String>,
    pub windows: Vec<UsageWindow>,
    /// The provider's usage response as received (no tokens in it); the T3
    /// hub hands it out verbatim.
    pub raw: Value,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.uzalka-tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- Claude ----

pub async fn fetch_claude(client: &reqwest::Client, dir: &Path) -> Result<ProviderUsage, String> {
    let cred_path = dir.join(".credentials.json");
    let raw = fs::read_to_string(&cred_path).map_err(|e| format!("credentials: {e}"))?;
    let mut creds: Value = serde_json::from_str(&raw).map_err(|e| format!("credentials: {e}"))?;

    let oauth = creds
        .get("claudeAiOauth")
        .ok_or("credentials: no claudeAiOauth")?;
    let mut access = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .ok_or("credentials: no accessToken")?
        .to_string();
    let expires_at = oauth.get("expiresAt").and_then(Value::as_u64).unwrap_or(0);

    if expires_at < now_ms() + 60_000 {
        // Claude Code blanks both tokens when it signs out or a refresh fails
        let refresh = oauth
            .get("refreshToken")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if refresh.is_empty() {
            return Err("signed out — run /login in Claude Code with this account".into());
        }
        let resp = client
            .post("https://console.anthropic.com/v1/oauth/token")
            .json(&json!({
                "grant_type": "refresh_token",
                "refresh_token": refresh,
                "client_id": CLAUDE_CLIENT_ID,
            }))
            .send()
            .await
            .map_err(|e| format!("refresh: {e}"))?;
        if !resp.status().is_success() {
            // main.rs keys its 15-minute backoff on "refresh failed"
            return Err(format!(
                "login expired, token refresh failed (HTTP {}) — run /login in Claude Code with this account",
                resp.status().as_u16()
            ));
        }
        let tok: Value = resp.json().await.map_err(|e| format!("refresh: {e}"))?;
        let new_access = tok
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or("refresh: no access_token")?
            .to_string();
        let o = creds
            .get_mut("claudeAiOauth")
            .and_then(Value::as_object_mut)
            .unwrap();
        o.insert("accessToken".into(), json!(new_access));
        if let Some(rt) = tok.get("refresh_token").and_then(Value::as_str) {
            o.insert("refreshToken".into(), json!(rt));
        }
        if let Some(exp) = tok.get("expires_in").and_then(Value::as_u64) {
            o.insert("expiresAt".into(), json!(now_ms() + exp * 1000));
        }
        atomic_write(
            &cred_path,
            &serde_json::to_string_pretty(&creds).map_err(|e| e.to_string())?,
        )?;
        access = new_access;
    }

    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(&access)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("usage: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        return Err(match code {
            401 | 403 => {
                format!("token rejected (HTTP {code}) — run /login in Claude Code with this account")
            }
            429 => "usage API rate limited (HTTP 429)".to_string(),
            _ => format!("usage: HTTP {code}"),
        });
    }
    let data: Value = resp.json().await.map_err(|e| format!("usage: {e}"))?;

    let windows = claude_windows(&data);

    // email from .claude.json (inside the dir, or ~/.claude.json for the
    // default install), plan from credentials tier
    let email = crate::config::claude_config_json(dir)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            v.pointer("/oauthAccount/emailAddress")
                .and_then(Value::as_str)
                .map(String::from)
        });
    let tier = creds
        .pointer("/claudeAiOauth/rateLimitTier")
        .and_then(Value::as_str)
        .unwrap_or("");
    let sub = creds
        .pointer("/claudeAiOauth/subscriptionType")
        .and_then(Value::as_str)
        .unwrap_or("");
    let plan = if tier.contains("max_20x") {
        Some("Max 20x".to_string())
    } else if tier.contains("max_5x") {
        Some("Max 5x".to_string())
    } else if !sub.is_empty() {
        let mut c = sub.chars();
        Some(c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default())
    } else {
        None
    };

    Ok(ProviderUsage { email, plan, credits: None, windows, raw: data })
}

fn valid_percent(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|p| p.is_finite() && *p >= 0.0)
}

fn claude_windows(data: &Value) -> Vec<UsageWindow> {
    let mut windows = Vec::new();
    if let Some(limits) = data.get("limits").and_then(Value::as_array) {
        for limit in limits {
            let Some(percent) = valid_percent(limit.get("percent")) else {
                continue;
            };
            let kind = limit.get("kind").and_then(Value::as_str);
            let label = match kind.unwrap_or("") {
                "session" => "Session (5h)".to_string(),
                "weekly_all" => "Weekly".to_string(),
                "weekly_scoped" => {
                    let model = limit
                        .pointer("/scope/model/display_name")
                        .and_then(Value::as_str)
                        .unwrap_or("model");
                    format!("Weekly · {model}")
                }
                other => other.to_string(),
            };
            windows.push(UsageWindow {
                label,
                percent,
                kind: kind.map(str::to_string),
                scope: limit.get("scope").filter(|v| !v.is_null()).cloned(),
                resets_at: limit.get("resets_at").cloned().unwrap_or(Value::Null),
            });
        }
    } else {
        // fallback for older response shape
        for (key, label, kind) in [
            ("five_hour", "Session (5h)", "session"),
            ("seven_day", "Weekly", "weekly_all"),
        ] {
            if let Some(window) = data.get(key) {
                let Some(percent) = valid_percent(window.get("utilization")) else {
                    continue;
                };
                windows.push(UsageWindow {
                    label: label.to_string(),
                    percent,
                    kind: Some(kind.to_string()),
                    scope: None,
                    resets_at: window.get("resets_at").cloned().unwrap_or(Value::Null),
                });
            }
        }
    }
    windows
}

// ----------------------------------------------------------------- Codex ----

fn jwt_exp_seconds(token: &str) -> Option<u64> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("exp").and_then(Value::as_u64)
}

fn window_label(seconds: u64, prefix: &str) -> String {
    if seconds <= 6 * 3600 {
        format!("{prefix}Session (5h)")
    } else if seconds >= 6 * 86400 {
        format!("{prefix}Weekly")
    } else {
        format!("{prefix}{}h", seconds / 3600)
    }
}

pub async fn fetch_codex(client: &reqwest::Client, dir: &Path) -> Result<ProviderUsage, String> {
    let auth_path = dir.join("auth.json");
    let raw = fs::read_to_string(&auth_path).map_err(|e| format!("auth.json: {e}"))?;
    let mut auth: Value = serde_json::from_str(&raw).map_err(|e| format!("auth.json: {e}"))?;

    let tokens = auth.get("tokens").ok_or("auth.json: no tokens")?;
    let mut access = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("auth.json: no access_token")?
        .to_string();
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let exp = jwt_exp_seconds(&access).unwrap_or(0);
    if exp * 1000 < now_ms() + 60_000 {
        let refresh = tokens
            .get("refresh_token")
            .and_then(Value::as_str)
            .ok_or("token expired, no refresh token — sign in to Codex with this account")?
            .to_string();
        let resp = client
            .post("https://auth.openai.com/oauth/token")
            .json(&json!({
                "client_id": CODEX_CLIENT_ID,
                "grant_type": "refresh_token",
                "refresh_token": refresh,
                "scope": "openid profile email",
            }))
            .send()
            .await
            .map_err(|e| format!("refresh: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "token refresh failed (HTTP {}) — sign in to Codex with this account",
                resp.status().as_u16()
            ));
        }
        let tok: Value = resp.json().await.map_err(|e| format!("refresh: {e}"))?;
        let new_access = tok
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or("refresh: no access_token")?
            .to_string();
        let t = auth
            .get_mut("tokens")
            .and_then(Value::as_object_mut)
            .unwrap();
        t.insert("access_token".into(), json!(new_access));
        for key in ["refresh_token", "id_token"] {
            if let Some(v) = tok.get(key).and_then(Value::as_str) {
                t.insert(key.into(), json!(v));
            }
        }
        atomic_write(
            &auth_path,
            &serde_json::to_string_pretty(&auth).map_err(|e| e.to_string())?,
        )?;
        access = new_access;
    }

    let mut req = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(&access);
    if !account_id.is_empty() {
        req = req.header("chatgpt-account-id", &account_id);
    }
    let resp = req.send().await.map_err(|e| format!("usage: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("usage: HTTP {}", resp.status().as_u16()));
    }
    let data: Value = resp.json().await.map_err(|e| format!("usage: {e}"))?;

    let mut windows = Vec::new();
    let mut push_window = |w: &Value, prefix: &str| {
        let Some(w) = w.as_object().filter(|_| !w.is_null()) else { return };
        let Some(percent) = valid_percent(w.get("used_percent")) else {
            return;
        };
        let secs = w
            .get("limit_window_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        windows.push(UsageWindow {
            label: window_label(secs, prefix),
            percent,
            kind: None,
            scope: None,
            resets_at: w.get("reset_at").cloned().unwrap_or(Value::Null),
        });
    };

    // only the global windows; per-model additional_rate_limits are noise
    if let Some(rl) = data.get("rate_limit") {
        if let Some(p) = rl.get("primary_window") {
            push_window(p, "");
        }
        if let Some(s) = rl.get("secondary_window") {
            push_window(s, "");
        }
    }

    let email = data.get("email").and_then(Value::as_str).map(String::from);
    let plan = data.get("plan_type").and_then(Value::as_str).map(|p| {
        let mut c = p.chars();
        c.next()
            .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
            .unwrap_or_default()
    });
    let credits = data
        .pointer("/credits/balance")
        .and_then(Value::as_str)
        .and_then(|b| b.parse::<f64>().ok())
        .filter(|b| *b > 0.0)
        .map(|b| format!("{b:.0}"));

    Ok(ProviderUsage { email, plan, credits, windows, raw: data })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_limits_preserve_kind_scope_and_ignore_invalid_percent() {
        let scope = json!({"model": {"id": null, "display_name": "Fable"}, "surface": null});
        let windows = claude_windows(&json!({"limits": [
            {"kind": "session", "percent": 0, "resets_at": null, "scope": null},
            {"kind": "weekly_all", "percent": 2, "resets_at": "2026-09-10T00:00:00Z", "scope": null},
            {"kind": "weekly_scoped", "percent": 4, "scope": scope},
            {"kind": "weekly_scoped", "percent": null},
            {"kind": "weekly_scoped"},
            {"kind": "weekly_scoped", "percent": "0"},
            {"kind": "weekly_scoped", "percent": -1}
        ]}));
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].percent, 0.0);
        assert_eq!(windows[0].kind.as_deref(), Some("session"));
        assert_eq!(windows[1].kind.as_deref(), Some("weekly_all"));
        assert_eq!(windows[2].kind.as_deref(), Some("weekly_scoped"));
        assert_eq!(windows[2].scope.as_ref(), Some(&scope));
    }

    #[test]
    fn legacy_claude_limits_have_kinds_without_fabricated_zero() {
        let windows = claude_windows(&json!({
            "five_hour": {"utilization": 5},
            "seven_day": {"utilization": 10}
        }));
        assert_eq!(windows[0].kind.as_deref(), Some("session"));
        assert_eq!(windows[1].kind.as_deref(), Some("weekly_all"));
        assert!(claude_windows(&json!({"five_hour": {}, "seven_day": {"utilization": null}})).is_empty());
    }
}
