use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub custom_paths: Vec<String>,
    #[serde(default)]
    pub hidden: Vec<String>,
    #[serde(default = "default_poll")]
    pub poll_seconds: u64,
    /// Local endpoint that T3 Code polls as a "CLIProxyAPI hub" (see hub.rs).
    #[serde(default)]
    pub hub: HubConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            custom_paths: Vec::new(),
            hidden: Vec::new(),
            poll_seconds: default_poll(),
            hub: HubConfig::default(),
        }
    }
}

fn default_poll() -> u64 {
    1800
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubConfig {
    #[serde(default = "default_hub_enabled")]
    pub enabled: bool,
    /// Bound on 127.0.0.1 only.
    #[serde(default = "default_hub_port")]
    pub port: u16,
    /// Management key T3 must present; generated on first start when empty.
    #[serde(default)]
    pub key: String,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            enabled: default_hub_enabled(),
            port: default_hub_port(),
            key: String::new(),
        }
    }
}

fn default_hub_enabled() -> bool {
    true
}

fn default_hub_port() -> u16 {
    8318
}

fn config_file() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("uzalka").join("config.json")
}

pub fn load_config() -> AppConfig {
    let path = config_file();
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let path = config_file();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize)]
pub struct Account {
    pub id: String,
    /// Stable provider identity shared by config-dir aliases; never a token.
    pub account_key: Option<String>,
    pub path: String,
    pub kind: Kind,
    pub name: String,
    pub custom: bool,
    pub hidden: bool,
    /// Set when this config dir is signed in to the same provider account as
    /// another entry (value = that entry's name).
    pub duplicate_of: Option<String>,
    /// Visible twins of a primary entry (same provider account), tried in
    /// order when fetching through the primary's own dir fails.
    pub fallbacks: Vec<String>,
}

pub fn detect_kind(dir: &Path) -> Option<Kind> {
    if dir.join(".credentials.json").is_file() {
        Some(Kind::Claude)
    } else if dir.join("auth.json").is_file() {
        Some(Kind::Codex)
    } else {
        None
    }
}

fn account_id(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn account_name(path: &Path) -> String {
    let base = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    base.trim_start_matches('.').to_string()
}

/// Discovered (default-path) accounts + custom-path accounts from config.
pub fn list_accounts(cfg: &AppConfig) -> Vec<Account> {
    let mut out: Vec<Account> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    let push = |dir: PathBuf, custom: bool, out: &mut Vec<Account>, seen: &mut Vec<String>| {
        let Some(kind) = detect_kind(&dir) else { return };
        let id = account_id(&dir);
        if seen.contains(&id) {
            return;
        }
        seen.push(id.clone());
        out.push(Account {
            account_key: account_key(&dir, kind),
            hidden: cfg.hidden.contains(&id),
            name: account_name(&dir),
            path: dir.to_string_lossy().to_string(),
            id,
            kind,
            custom,
            duplicate_of: None,
            fallbacks: Vec::new(),
        });
    };

    if let Some(home) = dirs::home_dir() {
        if let Ok(entries) = fs::read_dir(&home) {
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_dir()
                        && p.file_name()
                            .map(|n| {
                                let n = n.to_string_lossy();
                                n.starts_with(".claude") || n.starts_with(".codex")
                            })
                            .unwrap_or(false)
                })
                .collect();
            dirs.sort();
            for d in dirs {
                push(d, false, &mut out, &mut seen);
            }
        }
    }

    for p in &cfg.custom_paths {
        push(PathBuf::from(p), true, &mut out, &mut seen);
    }

    // Group entries signed in to the same provider account. One entry per
    // group is the primary (the card that is shown and fetched): the first
    // visible one in path order, so hiding an entry in settings hands the
    // card to its twin. The other visible twins become fallbacks.
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, acc) in out.iter().enumerate() {
        let Some(key) = &acc.account_key else {
            continue;
        };
        groups.entry(key.clone()).or_default().push(i);
    }
    for members in groups.values() {
        if members.len() < 2 {
            continue;
        }
        let primary = members
            .iter()
            .copied()
            .find(|&i| !out[i].hidden)
            .unwrap_or(members[0]);
        let primary_name = out[primary].name.clone();
        for &i in members {
            if i == primary {
                continue;
            }
            out[i].duplicate_of = Some(primary_name.clone());
            if !out[i].hidden {
                let twin = out[i].path.clone();
                out[primary].fallbacks.push(twin);
            }
        }
    }

    out
}

/// Path to the `.claude.json` for a Claude config dir. The default `~/.claude`
/// install keeps it next to the dir (`~/.claude.json`); CLAUDE_CONFIG_DIR
/// setups keep it inside.
pub fn claude_config_json(dir: &Path) -> Option<PathBuf> {
    let inside = dir.join(".claude.json");
    if inside.is_file() {
        return Some(inside);
    }
    if dir.file_name().is_some_and(|n| n == ".claude") {
        let sibling = dir.parent()?.join(".claude.json");
        if sibling.is_file() {
            return Some(sibling);
        }
    }
    None
}

/// Stable identity of the signed-in account (not the config dir).
pub fn account_key(dir: &Path, kind: Kind) -> Option<String> {
    let identity = account_identity(dir, kind)?;
    if identity.trim().is_empty() {
        return None;
    }
    let provider = match kind {
        Kind::Claude => "claude",
        Kind::Codex => "codex",
    };
    Some(format!("{provider}:{identity}"))
}

fn account_identity(dir: &Path, kind: Kind) -> Option<String> {
    match kind {
        Kind::Claude => {
            let v: Value =
                serde_json::from_str(&fs::read_to_string(claude_config_json(dir)?).ok()?).ok()?;
            v.pointer("/oauthAccount/accountUuid")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    v.pointer("/oauthAccount/emailAddress")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
        }
        Kind::Codex => {
            let v: Value =
                serde_json::from_str(&fs::read_to_string(dir.join("auth.json")).ok()?).ok()?;
            v.pointer("/tokens/account_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
    }
}
