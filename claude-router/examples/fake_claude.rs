//! Test stand-in for claude.exe, for running the router end to end without spending quota.
//!
//! On every request it reads `<CLAUDE_CONFIG_DIR>/fake.json`:
//! `{"usage": <get_usage answer>, "turn": ["<output line>"], "result": "<result line>", "command": "<cmd /C line>",
//!   "wake": {"after_ms": N, "turn": [...], "result": "..."}, "stream": false}`.
//! A user message plays `turn` (`$SID` becomes the session id) and then `result`; `command` is
//! started as a background command first and, like claude, the fake waits for it before exiting.
//! Like claude 2.1.288, messages that arrive within BATCH_MS of each other run as one turn with one
//! result, and a message that arrives during a turn runs after it. `wake` is a turn the fake starts
//! on its own N ms after the first result (a background task finished). Each turn opens with a
//! `message_start` stream event, as T3 asks for partial messages (`"stream": false` turns it off).
//! What it was started with and what it got goes to `<CLAUDE_CONFIG_DIR>/fake.log`.

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const BATCH_MS: u64 = 300;

fn main() {
    let dir = PathBuf::from(std::env::var("CLAUDE_CONFIG_DIR").unwrap_or_default());
    let conf = || serde_json::from_str::<Value>(&std::fs::read_to_string(dir.join("fake.json")).unwrap_or_default()).unwrap_or(json!({}));
    let log = |s: &str| {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("fake.log")) {
            let _ = writeln!(f, "{} {s}", std::process::id());
        }
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    log(&format!("start {}", serde_json::to_string(&args).unwrap_or_default()));
    let sid = args
        .iter()
        .position(|a| a == "--resume" || a == "--session-id")
        .and_then(|i| args.get(i + 1).cloned())
        .unwrap_or_else(|| "fake-session".into());
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut out = std::io::stdout();
    let usage_answer = |v: &Value, out: &mut std::io::Stdout| {
        let answer = json!({"type": "control_response", "response": {"subtype": "success", "request_id": v["request_id"], "response": conf()["usage"]}});
        let _ = writeln!(out, "{answer}");
        let _ = out.flush();
    };
    // Lines are kept as written: claude puts "type" first, and the router relies on it.
    let text = |v: &Value| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()).replace("$SID", &sid);
    let play = |turn: &Value, result: &Value, out: &mut std::io::Stdout| {
        if conf()["stream"] != false {
            let _ = writeln!(out, r#"{{"type":"stream_event","event":{{"type":"message_start","message":{{"model":"claude-opus-5-5"}}}},"session_id":"{sid}","parent_tool_use_id":null}}"#);
            let _ = out.flush();
        }
        for l in turn.as_array().into_iter().flatten() {
            // `{"pause_ms":N}` stands for a model that works N ms without output.
            if let Some(ms) = serde_json::from_str::<Value>(&text(l)).ok().and_then(|v| v["pause_ms"].as_u64()) {
                std::thread::sleep(Duration::from_millis(ms));
                continue;
            }
            let _ = writeln!(out, "{}", text(l));
            let _ = out.flush();
            std::thread::sleep(Duration::from_millis(50));
        }
        let result = if result.is_null() { json!(r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"$SID"}"#) } else { result.clone() };
        let _ = writeln!(out, "{}", text(&result));
        let _ = out.flush();
    };
    let mut background = None;
    let mut wake_at: Option<Instant> = None;
    let mut results = 0;
    loop {
        let line = match wake_at {
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(l) => l,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    wake_at = None;
                    let w = conf()["wake"].clone();
                    log("wake turn");
                    play(&w["turn"], &w["result"], &mut out);
                    continue;
                }
                Err(_) => break,
            },
            None => match rx.recv() {
                Ok(l) => l,
                Err(_) => break,
            },
        };
        let v: Value = serde_json::from_str(&line).unwrap_or(json!({}));
        if v["type"] == "control_request" && v["request"]["subtype"] == "get_usage" {
            usage_answer(&v, &mut out);
        } else if v["type"] == "user" {
            // Messages sent close together run as one turn.
            let mut members = 1;
            while let Ok(next) = rx.recv_timeout(Duration::from_millis(BATCH_MS)) {
                let n: Value = serde_json::from_str(&next).unwrap_or(json!({}));
                if n["type"] == "user" {
                    members += 1;
                } else if n["type"] == "control_request" && n["request"]["subtype"] == "get_usage" {
                    usage_answer(&n, &mut out);
                }
            }
            log(&format!("user message batch of {members}"));
            let c = conf();
            if let Some(cmd) = c["command"].as_str() {
                if let Ok(child) = Command::new("cmd").args(["/C", cmd]).spawn() {
                    let _ = std::fs::write(dir.join("bg.pid"), child.id().to_string());
                    background = Some(child);
                    let tasks = json!({"type": "system", "subtype": "background_tasks_changed", "session_id": sid,
                        "tasks": [{"task_id": "bfake1", "task_type": "local_bash", "description": "fake command"}]});
                    let _ = writeln!(out, "{tasks}");
                }
            }
            play(&c["turn"], &c["result"], &mut out);
            log("result");
            results += 1;
            if results == 1 {
                if let Some(ms) = c["wake"]["after_ms"].as_u64() {
                    wake_at = Some(Instant::now() + Duration::from_millis(ms));
                }
            }
        }
    }
    log("stdin closed");
    if let Some(mut child) = background {
        // claude does not exit while its background tasks run.
        let _ = child.wait();
    }
    log("exit");
}
