// End-to-end runs of the strategy ("strategy": "fable_spread") against examples/fake_claude.exe: the list of live
// threads, the spread of new threads, the admission of claude -p. No quota is spent.
// Usage: node e2e/strategy.mjs [scenario ...]   (cargo build --release --example fake_claude first)
// Each scenario gets its own folder under %TEMP%\rfake-strategy\<name> with a copy of the router.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../target/release", import.meta.url));
const ROUTER = path.join(ROOT, "claude-router.exe");
const FAKE = path.join(ROOT, "examples", "fake_claude.exe");
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Uzalka-style usage: session window resetting in `resetH` hours, weekly window in `weeklyDays` days.
function usage(session, weekly, weeklyDays, fable, resetH = 2) {
  const now = Date.now();
  const w = now + weeklyDays * 86400e3;
  return {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      limits: [
        { kind: "session", percent: session, resets_at: iso(now + resetH * 3600e3), scope: null },
        { kind: "weekly_all", percent: weekly, resets_at: iso(w), scope: null },
        { kind: "weekly_scoped", percent: fable, resets_at: iso(w), scope: { model: { id: null, display_name: "Fable" } } },
      ],
    },
  };
}
// An assistant message with its usage, written twice like claude does (once per content block).
const spent = (id, out) => {
  const line = JSON.stringify({ type: "assistant", message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "done" }],
    usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 50000, output_tokens: out } }, parent_tool_use_id: null, session_id: "$SID" });
  return [line, line];
};

function setup(name, a, b, extra = {}) {
  const dir = path.join(os.tmpdir(), "rfake-strategy", name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ["bin", "acc-a", "acc-b", "work"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.copyFileSync(ROUTER, path.join(dir, "bin", "claude.exe"));
  const config = {
    claude_exe: FAKE,
    usage_json: path.join(dir, "uz", "usage.json"),
    fresh_minutes: 5,
    strategy: "fable_spread",
    accounts: [
      { name: "a", config_dir: path.join(dir, "acc-a") },
      { name: "b", config_dir: path.join(dir, "acc-b") },
    ],
    ...extra,
  };
  fs.writeFileSync(path.join(dir, "bin", "router.json"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(dir, "acc-a", "fake.json"), JSON.stringify(a));
  fs.writeFileSync(path.join(dir, "acc-b", "fake.json"), JSON.stringify(b));
  return dir;
}

const state = (dir, ...p) => path.join(dir, "bin", "state", ...p);
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const records = (dir) => {
  const d = state(dir, "threads");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => ({ file: f, ...readJson(path.join(d, f)) })) : [];
};
const log = (dir) =>
  (fs.existsSync(state(dir, "router.log")) ? fs.readFileSync(state(dir, "router.log"), "utf8") : "")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const starts = (dir) => log(dir).filter((e) => e.event === "start");

// A T3 chat: stream-json in and out. Returns a handle to send a message, close the input, wait for the exit.
function chat(dir, sid) {
  const args = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--model", "claude-opus-5-5", "--session-id", sid];
  const child = spawn(path.join(dir, "bin", "claude.exe"), args, { cwd: path.join(dir, "work"), stdio: ["pipe", "pipe", "pipe"] });
  let results = 0;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        if (JSON.parse(line).type === "result") results++;
      } catch {}
    }
  });
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  return {
    child,
    send: () => child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null, session_id: sid }) + "\n"),
    results: () => results,
    close: async () => {
      child.stdin.end();
      return Promise.race([exited, sleep(20000).then(() => "timeout")]);
    },
  };
}

// A nested claude -p run. Resolves with its exit code and stderr.
function print(dir, extraArgs = []) {
  const child = spawn(path.join(dir, "bin", "claude.exe"), [...extraArgs, "-p", "hi", "--model", "claude-opus-5-5"], { cwd: path.join(dir, "work"), stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.end();
  const done = new Promise((r) => child.on("exit", (code) => r({ code, out, err: err.trim() })));
  return { child, done };
}

const until = async (cond, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(200);
  }
  return false;
};

const room = (session) => ({ usage: usage(session, 50, 2, 10), turn: [] });

const SCENARIOS = {
  // A chat is in the list from its start, with what it spent; it leaves the list on exit, the spend stays with
  // its session.
  async booked_and_removed() {
    const dir = setup("booked_and_removed", { usage: usage(30, 50, 2, 10), turn: [...spent("msg_1", 1000), ...spent("msg_2", 500)] }, room(30));
    const sid = "5e55a0b1-0000-4000-8000-000000000001";
    const c = chat(dir, sid);
    const listed = await until(() => records(dir).length === 1);
    c.send();
    await until(() => c.results() === 1);
    await sleep(500);
    const during = records(dir);
    const code = await c.close();
    const session = readJson(state(dir, "sessions", `${sid}.json`));
    // Opus 5.5: (10 * 4 + 2000 * 4 * 1.25 + 1500 * 20) / 1e6 per message pair counted once
    const want = (2 * 10 * 4 + 2 * 2000 * 4 * 1.25 + 1500 * 20) / 1e6;
    return {
      listed_at_start: listed,
      during: during.map((r) => ({ account: r.account, kind: r.kind, session: r.session, cost: r.burn?.cost })),
      exit: code,
      after: records(dir).length,
      session_burn: session?.burn?.cost,
      session_home: session?.home,
      want_cost: want,
      ok: listed && during.length === 1 && during[0].session === sid && records(dir).length === 0
        && Math.abs((session?.burn?.cost ?? 0) - want) < 1e-6 && session?.home === during[0].account,
    };
  },

  // Two new chats started together on two equal accounts: the second sees the first in the list and goes to the
  // other account.
  async two_starts_spread() {
    const dir = setup("two_starts_spread", room(30), room(30));
    const c1 = chat(dir, "5e55a0b1-0000-4000-8000-000000000011");
    const c2 = chat(dir, "5e55a0b1-0000-4000-8000-000000000012");
    await until(() => starts(dir).length === 2);
    const chosen = starts(dir).map((e) => ({ chosen: e.chosen, reason: e.reason, threads: e.strategy?.rows?.map((r) => `${r.account}:${r.threads}`) }));
    await Promise.all([c1.close(), c2.close()]);
    return { chosen, after: records(dir).length, ok: chosen.length === 2 && chosen[0].chosen !== chosen[1].chosen && records(dir).length === 0 };
  },

  // A claude -p when both 5-hour windows are at 90% for 2 more hours: no window carries it now, it would be refused
  // (the default; with cli_max_wait_minutes it would wait for the reset). Asked with --router-explain, nothing runs.
  async cli_would_wait() {
    const dir = setup("cli_would_wait", room(90), room(90));
    const r = await print(dir, ["--router-explain"]).done;
    const d = JSON.parse(r.out);
    return { reason: d.reason, plan: d.strategy?.plan, ok: r.code === 0 && d.reason.startsWith("would refuse") && d.strategy.plan.admitted && Math.abs(d.strategy.plan.in_h - 2) < 0.15 };
  },

  // The same for real, with the default cli_max_wait_minutes (0): the run is refused at once, with the time it
  // could start, and leaves no record.
  async cli_given_up() {
    const dir = setup("cli_given_up", room(90), room(90));
    const r = await print(dir).done;
    const ran = ["a", "b"].some((a) => {
      const f = path.join(dir, `acc-${a}`, "fake.log");
      return fs.existsSync(f) && fs.readFileSync(f, "utf8").split("\n").some((l) => l.includes('"-p"'));
    });
    return { code: r.code, err: r.err, events: log(dir).map((e) => e.event), ran, ok: r.code === 1 && /no Claude account has room.*at \d\d:\d\d UTC.*not waiting/.test(r.err) && !ran && records(dir).length === 0 };
  },

  // Not a thread (`claude mcp add`, its `-p` belongs to the server after `--`): never held or refused, even when no
  // window would take a claude -p.
  async not_a_thread() {
    const dir = setup("not_a_thread", room(90), room(90));
    const child = spawn(path.join(dir, "bin", "claude.exe"), ["mcp", "add", "pg", "--", "npx", "srv", "-p", "5432"], { cwd: path.join(dir, "work"), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    const code = await Promise.race([new Promise((r) => child.on("exit", r)), sleep(20000).then(() => "timeout")]);
    const start = starts(dir)[0];
    return { code, kind: start?.kind, strategy: start?.strategy, ok: code === 0 && start?.strategy === null && records(dir).length === 0 };
  },

  // A held claude -p is in the list as promised on an account; killed (like a PC switched off), it is dropped by
  // the next router that reads the list.
  async held_then_killed() {
    const dir = setup("held_then_killed", room(90), room(90), { cli_max_wait_minutes: 360 });
    const p = print(dir);
    const held = await until(() => records(dir).some((r) => r.waiting));
    const rec = records(dir)[0];
    const seenBy = await print(dir, ["--router-explain"]).done;
    const promisedSeen = JSON.parse(seenBy.out).live_threads;
    execFileSync("taskkill", ["/PID", String(p.child.pid), "/T", "/F"]);
    const killed = await p.done;
    const before = records(dir).length;
    const after = JSON.parse((await print(dir, ["--router-explain"]).done).out).live_threads;
    return {
      held,
      record: rec && { account: rec.account, kind: rec.kind, waiting: rec.waiting && { account: rec.waiting.account, in_h: Math.round((rec.waiting.at_ms - Date.now()) / 360e3) / 10 } },
      told_caller: killed.err,
      seen_while_held: promisedSeen,
      records_after_kill: before,
      seen_after_kill: after,
      left_after_reader: records(dir).length,
      ok: held && /waiting, at most 360 min/.test(killed.err) && promisedSeen.some((t) => t.threads === 1) && before === 1 && after.every((t) => t.threads === 0) && records(dir).length === 0,
    };
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
const results = [];
for (const n of names) {
  try {
    results.push({ name: n, ...(await SCENARIOS[n]()) });
  } catch (e) {
    results.push({ name: n, ok: false, error: String(e?.stack ?? e) });
  }
}
console.log(JSON.stringify(results, null, 1));
console.log(results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name}`).join("\n"));
