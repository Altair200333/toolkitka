// End-to-end runs of the router against examples/fake_claude.exe: no quota is spent.
// Usage: node e2e/drive.mjs [scenario ...]   (cargo build --release --example fake_claude first)
// Each scenario gets its own folder under %TEMP%\rfake\<name> with a copy of the router.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../target/release", import.meta.url));
const ROUTER = path.join(ROOT, "claude-router.exe");
const FAKE = path.join(ROOT, "examples", "fake_claude.exe");
const nowS = () => Math.floor(Date.now() / 1000);
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(session, weekly, weeklyDays, fable) {
  const now = Date.now();
  const w = now + weeklyDays * 86400e3;
  return {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      limits: [
        { kind: "session", percent: session, resets_at: iso(now + 2 * 3600e3), scope: null },
        { kind: "weekly_all", percent: weekly, resets_at: iso(w), scope: null },
        { kind: "weekly_scoped", percent: fable, resets_at: iso(w), scope: { model: { id: null, display_name: "Fable" } } },
      ],
    },
  };
}
const refusal = (type, inS) => ({
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", resetsAt: nowS() + inS, rateLimitType: type, overageStatus: "rejected", isUsingOverage: false },
  uuid: "11111111-2222-4333-8444-555555555555",
  session_id: "$SID",
});
const limitError = { type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 3pm" }] }, parent_tool_use_id: null, error: "rate_limit", session_id: "$SID" };
const failed = { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "You've hit your session limit", session_id: "$SID" };
const said = (model, parent) => ({ type: "assistant", message: { model, role: "assistant", content: [{ type: "text", text: "done" }] }, parent_tool_use_id: parent, session_id: "$SID" });

const SCENARIOS = {
  // claude reports the refusal with an event: T3 should hear "resets in 90 s", the router leaves within seconds.
  event_refusal: { a: { usage: usage(30, 50, 2, 10), turn: [refusal("five_hour", 3 * 3600), limitError], result: failed } },
  // Only the assistant error, no event (claude sends one per 30 s at most): the router asks fresh data and adds the event.
  error_only: {
    a: { usage: usage(30, 50, 2, 10), turn: [limitError], result: failed },
    afterStart: (dir) => patch(dir, "a", { usage: usage(100, 50, 2, 10) }),
    waitBeforeMessage: 33000,
  },
  // A refusal while a background command runs: the command must outlive claude, the next start must mention it.
  blocked_with_command: {
    a: { usage: usage(30, 50, 2, 10), turn: [refusal("five_hour", 3 * 3600), limitError], result: failed, command: "ping -n 120 127.0.0.1 > nul" },
    second: true,
  },
  // Fable agents refused in an Opus thread: the event goes to T3 unchanged, the thread moves softly.
  fable_agents: {
    a: { usage: usage(30, 50, 2, 10), turn: [said("claude-fable-5-1", "toolu_1"), refusal("seven_day_overage_included", 3 * 86400), said("claude-opus-5-5", null)] },
  },
  // A rate_limit error while the data shows room (a short throttle): nothing is added, the router stays.
  throttle: { a: { usage: usage(30, 50, 2, 10), turn: [limitError], result: failed }, waitBeforeMessage: 33000, closeAfter: 20000 },
  // The realistic timing: data older than 30 s when the refused turn ends, so it is refreshed first.
  stale_data_event: { a: { usage: usage(30, 50, 2, 10), turn: [refusal("five_hour", 3 * 3600), limitError], result: failed }, waitBeforeMessage: 33000 },
  // Uzalka takes the connection and never answers, from the start: the start may wait only UZALKA_TIMEOUT.
  slow_uzalka_start: { a: { usage: usage(30, 50, 2, 10), turn: [said("claude-opus-5-5", null)] }, slowHub: "start", closeAfter: 30000 },
  // Uzalka hangs only by the end of the refused turn; right after the refusal the data still shows room.
  slow_uzalka: { a: { usage: usage(30, 50, 2, 10), turn: [refusal("five_hour", 3 * 3600), limitError], result: failed }, waitBeforeMessage: 33000, slowHub: "later", closeAfter: 200000 },
  // T3's queued message after a refusal runs long: the router must not end claude in the middle of it.
  long_queued_turn: {
    a: { usage: usage(30, 50, 2, 10), turn: [refusal("five_hour", 3 * 3600), limitError], result: failed },
    waitBeforeMessage: 33000,
    queued: { after: 5000, change: { turn: [JSON.stringify(said("claude-opus-5-5", null)), JSON.stringify({ pause_ms: 75000 }), JSON.stringify(said("claude-opus-5-5", null))], result: null } },
    closeAfter: 200000,
  },
  // T3 sends a queued message 5 s after the refused turn; it fails too, with claude's message only.
  queued_after_refusal: {
    a: { usage: usage(30, 50, 2, 10), turn: [refusal("five_hour", 3 * 3600), limitError], result: failed },
    waitBeforeMessage: 33000,
    queued: { after: 5000, change: { turn: [JSON.stringify(limitError)] } },
  },
  // A refusal while a background command runs, with the realistic timing.
  stale_data_command: {
    a: { usage: usage(30, 50, 2, 10), turn: [refusal("five_hour", 3 * 3600), limitError], result: failed, command: "ping -n 150 127.0.0.1 > nul" },
    waitBeforeMessage: 33000,
  },
  // A short throttle on an account with 8% left: promise (limit_error + Soft). T3's queued
  // message then runs on that account for 100 s and ends with a limit after the promised time.
  // Uzalka answers in 4 s, as it does in real life.
  review_queued_ends_limited: {
    a: { usage: usage(30, 50, 2, 10), turn: [limitError], result: failed },
    waitBeforeMessage: 33000,
    delayHub: 4000,
    afterStartPatch: { usage: usage(92, 50, 2, 10) },
    queued: { after: 5000, change: { turn: [JSON.stringify(said("claude-opus-5-5", null)), JSON.stringify({ pause_ms: 100000 }), JSON.stringify(limitError)], result: JSON.stringify(failed) } },
    closeAfter: 200000,
  },
  // Same promise, T3's queued message runs a normal 11.7-min turn on the account with 8% left.
  review_queued_cap: {
    a: { usage: usage(30, 50, 2, 10), turn: [limitError], result: failed },
    waitBeforeMessage: 33000,
    delayHub: 1,
    afterStartPatch: { usage: usage(92, 50, 2, 10) },
    queued: { after: 5000, change: { turn: [JSON.stringify(said("claude-opus-5-5", null)), JSON.stringify({ pause_ms: 700000 }), JSON.stringify(said("claude-opus-5-5", null))], result: null } },
    closeAfter: 800000,
  },
  // Fable agents refused in an Opus thread, data older than 30 s, Uzalka hung: no promise is
  // possible (the thread's own model has room), so the result must not wait for a refresh.
  review_fable_agents_result_held: {
    a: { usage: usage(30, 50, 2, 10), turn: [said("claude-fable-5-1", "toolu_1"), refusal("seven_day_overage_included", 3 * 86400), said("claude-opus-5-5", null)] },
    waitBeforeMessage: 33000,
    slowHub: "later",
    closeAfter: 40000,
  },
  // Two queued messages after a refusal: the first runs 40 s and fails on the limit, the second follows
  // 5 s after its result. Both must reach claude; the router leaves by the latest promise.
  two_queued: {
    a: { usage: usage(30, 50, 2, 10), turn: [refusal("five_hour", 3 * 3600), limitError], result: failed },
    waitBeforeMessage: 33000,
    queued: [
      { after: 5000, change: { turn: [JSON.stringify(said("claude-opus-5-5", null)), JSON.stringify({ pause_ms: 40000 }), JSON.stringify(limitError)] } },
      { after: 5000, change: { turn: [JSON.stringify(limitError)] } },
    ],
    closeAfter: 200000,
  },
};
const limitedTurn = { turn: [JSON.stringify(refusal("five_hour", 3 * 3600)), JSON.stringify(limitError)], result: JSON.stringify(failed) };
const wake = {
  after_ms: 20000,
  turn: [
    JSON.stringify({ type: "system", subtype: "task_notification", task_id: "bfake2", status: "completed", summary: "fake agent done", session_id: "$SID" }),
    JSON.stringify(said("claude-opus-5-5", null)),
    JSON.stringify({ pause_ms: 2000 }),
  ],
  result: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "noted", origin: { kind: "task-notification" }, session_id: "$SID" }),
};
const thinkingTurn = { turn: [JSON.stringify({ pause_ms: 55000 }), JSON.stringify(said("claude-opus-5-5", null))], result: null, command: null };
Object.assign(SCENARIOS, {
  // Two messages close together (T3: a message and its steer) -> claude runs them as one turn with one
  // result. Then T3's next message fails on the limit while account b has room: promised and left as usual.
  r3_batch_then_limit: { a: { usage: usage(30, 50, 2, 10), turn: [said("claude-opus-5-5", null)] }, double: true, queued: { after: 5000, change: limitedTurn }, closeAfter: 120000 },
  // The promise setup above (short throttle, 8% left -> promise) with a background command. 20 s after the
  // result a background task finishes and claude answers it on its own (2 s); T3's next message arrives
  // during that answer, runs after it and thinks 55 s. Its result must reach T3.
  r3_wake_eats_count: {
    a: { usage: usage(30, 50, 2, 10), turn: [limitError], result: failed, wake, command: "ping -n 150 127.0.0.1 > nul" },
    afterStartPatch: { usage: usage(92, 50, 2, 10) },
    waitBeforeMessage: 33000,
    queued: { after: 21000, change: thinkingTurn },
    closeAfter: 150000,
  },
});
// T3's message whose first output comes late. The same promise setup (short throttle on an
// account with 8% left -> promise 90 s); the silence before the first output is longer than WAITING_MS.
const apiRetry = (n) => JSON.stringify({ type: "system", subtype: "api_retry", attempt: n, max_retries: 10, retry_delay_ms: 100000, error_status: 529, error: "overloaded", session_id: "$SID" });
const compacting = JSON.stringify({ type: "system", subtype: "status", status: "compacting", session_id: "$SID" });
const startLine = JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { model: "claude-opus-5-5" } }, session_id: "$SID", parent_tool_use_id: null });
const pause = (ms) => JSON.stringify({ pause_ms: ms });
const lateFirstLine = (busy) => ({ stream: false, turn: [...busy, startLine, JSON.stringify(said("claude-opus-5-5", null)), JSON.stringify(limitError)], result: JSON.stringify(failed) });
const throttled8 = { a: { usage: usage(30, 50, 2, 10), turn: [limitError], result: failed }, waitBeforeMessage: 33000, delayHub: 4000, afterStartPatch: { usage: usage(92, 50, 2, 10) } };
Object.assign(SCENARIOS, {
  // claude retries the request twice, 100 s each, before the first output: the turn must stay open.
  r4_retry_silent: { ...throttled8, queued: { after: 5000, change: lateFirstLine([apiRetry(1), pause(100000), apiRetry(2), pause(100000)]) }, closeAfter: 400000 },
  // claude compacts the context for 210 s (a notice every 30 s) before the first output.
  r4_compacting: { ...throttled8, queued: { after: 5000, change: lateFirstLine(Array.from({ length: 7 }, () => [compacting, pause(30000)]).flat()) }, closeAfter: 400000 },
  // claude's own turn (a background task finished) runs 200 s; T3's message arrives 1 s into it, runs
  // after it and shows its first line 15 s later. The input must stay open until its result.
  r4_long_wake: {
    a: {
      usage: usage(30, 50, 2, 10), turn: [limitError], result: failed, command: "ping -n 400 127.0.0.1 > nul",
      wake: { ...wake, turn: [wake.turn[0], wake.turn[1], pause(200000)] },
    },
    afterStartPatch: { usage: usage(92, 50, 2, 10) },
    waitBeforeMessage: 33000,
    queued: { after: 21000, change: { stream: false, turn: [pause(15000), startLine, JSON.stringify(said("claude-opus-5-5", null)), pause(20000), JSON.stringify(said("claude-opus-5-5", null))], result: null, command: null } },
    closeAfter: 400000,
  },
});
// T3 puts every rate_limit_event into its active turn, so the 3-day
// reset of the agents refused in claude's own turn lands in T3's waiting turn; when that turn fails on the
// limit the router must answer with "resets in 90 s" for both kinds (see t3_resume_in_s of its result).
const wakeRefused = {
  after_ms: 20000,
  turn: [
    JSON.stringify({ type: "system", subtype: "task_notification", task_id: "bfake2", status: "completed", summary: "fake agent done", session_id: "$SID" }),
    JSON.stringify(said("claude-opus-5-5", null)),
    pause(4000),
    JSON.stringify(said("claude-fable-5-1", "toolu_1")),
    JSON.stringify(refusal("seven_day_overage_included", 3 * 86400)),
    JSON.stringify(said("claude-opus-5-5", null)),
    pause(2000),
  ],
  result: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "noted", origin: { kind: "task-notification" }, session_id: "$SID" }),
};
SCENARIOS.r5_own_refusal_then_limit = {
  a: { usage: usage(30, 50, 2, 10), turn: [said("claude-opus-5-5", null)], wake: wakeRefused },
  queued: { after: 21000, change: { turn: [JSON.stringify(refusal("five_hour", 3 * 3600)), JSON.stringify(limitError)], result: JSON.stringify(failed) } },
  closeAfter: 150000,
};
const B = { usage: usage(10, 20, 5, 10), turn: [said("claude-opus-5-5", null)] };

// Output lines go to the fake as text, keys in claude's order ("type" first).
const asText = (f) => ({ ...f, turn: f.turn?.map((l) => JSON.stringify(l)), result: f.result && JSON.stringify(f.result) });

function patch(dir, acct, change) {
  const f = path.join(dir, `acc-${acct}`, "fake.json");
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), ...change }));
}

function setup(name, sc) {
  const dir = path.join(os.tmpdir(), "rfake", name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ["bin", "acc-a", "acc-b", "work"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.copyFileSync(ROUTER, path.join(dir, "bin", "claude.exe"));
  const config = {
    claude_exe: FAKE,
    usage_json: path.join(dir, "uz", "usage.json"),
    fresh_minutes: 5,
    accounts: [
      { name: "a", config_dir: path.join(dir, "acc-a") },
      { name: "b", config_dir: path.join(dir, "acc-b") },
    ],
  };
  fs.writeFileSync(path.join(dir, "bin", "router.json"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(dir, "acc-a", "fake.json"), JSON.stringify(asText(sc.a)));
  fs.writeFileSync(path.join(dir, "acc-b", "fake.json"), JSON.stringify(asText(B)));
  return dir;
}

// A hub that takes connections and never answers, like a hung Uzalka.
async function hungHub() {
  const server = net.createServer((s) => s.on("error", () => {}));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const point = (dir) => {
    fs.mkdirSync(path.join(dir, "uz"), { recursive: true });
    fs.writeFileSync(path.join(dir, "uz", "config.json"), JSON.stringify({ hub: { enabled: true, port: server.address().port, key: "k" } }));
  };
  return { server, point };
}

// A hub that answers 200 {} after `ms` (Uzalka refreshes in about 4 s); usage.json is not written.
async function delayHub(ms) {
  const server = net.createServer((s) => {
    s.on("data", () => {});
    s.on("error", () => {});
    setTimeout(() => s.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"), ms);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const point = (dir) => {
    fs.mkdirSync(path.join(dir, "uz"), { recursive: true });
    fs.writeFileSync(path.join(dir, "uz", "config.json"), JSON.stringify({ hub: { enabled: true, port: server.address().port, key: "k" } }));
  };
  return { server, point };
}

async function runOnce(dir, sc, sid, resume) {
  const args = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--model", "claude-opus-5-5", resume ? "--resume" : "--session-id", sid];
  const started = Date.now();
  const child = spawn(path.join(dir, "bin", "claude.exe"), args, { cwd: path.join(dir, "work"), stdio: ["pipe", "pipe", "pipe"] });
  const out = [];
  let sentAt = null;
  let buf = "";
  let results = 0;
  // Refused kinds of the T3 turn running now: kind -> resetsAt (a new message starts a new turn).
  let resets = {};
  const message = () => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null, session_id: sid }) + "\n";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const v = JSON.parse(line);
        const t = sentAt ? Date.now() - sentAt : null;
        const e = { t, type: v.type, subtype: v.subtype };
        if (v.type === "rate_limit_event") {
          Object.assign(e, { resets_in_s: v.rate_limit_info.resetsAt - nowS(), promise_t: v.rate_limit_info.resetsAt * 1000 - sentAt, kind: v.rate_limit_info.rateLimitType, uuid: v.uuid });
          if (v.rate_limit_info.status === "rejected") resets[v.rate_limit_info.rateLimitType ?? "unknown"] = v.rate_limit_info.resetsAt;
        }
        // Like T3: a failed turn resumes at the latest reset among the kinds refused in it.
        if (v.type === "result" && Object.keys(resets).length) e.t3_resume_in_s = Math.max(...Object.values(resets)) - nowS();
        if (v.type === "assistant") Object.assign(e, { model: v.message?.model, error: v.error });
        out.push(e);
        const queued = v.type === "result" && [sc.queued ?? []].flat()[results++];
        if (queued && !resume) {
          // Like T3: the queued message goes out a few seconds after the turn ends.
          setTimeout(() => {
            patch(dir, "a", queued.change);
            out.push({ t: Date.now() - sentAt, type: "driver: queued message sent" });
            resets = {};
            child.stdin.write(message());
          }, queued.after);
        }
      } catch {
        out.push({ raw: line.slice(0, 120) });
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((r) => child.on("exit", (code) => r({ code, at: sentAt ? Date.now() - sentAt : Date.now() - started })));
  await sleep(1500);
  if (!resume && sc.afterStart) sc.afterStart(dir);
  await sleep(Math.max(0, (resume ? 0 : sc.waitBeforeMessage ?? 0) - 1500));
  sentAt = Date.now();
  child.stdin.write(message());
  if (sc.double && !resume) {
    child.stdin.write(message());
    out.push({ t: 0, type: "driver: second message sent at once" });
  }
  const limit = resume ? 3000 : sc.closeAfter ?? 100000;
  let exit = await Promise.race([exited, sleep(limit).then(() => null)]);
  let closedByDriver = false;
  if (!exit) {
    closedByDriver = true;
    child.stdin.end();
    exit = await Promise.race([exited, sleep(10000).then(() => null)]);
    if (!exit) child.kill();
  }
  // The router must be gone before the latest reset it promised T3 (T3 keeps the latest and resumes then).
  const promises = out.filter((e) => e.promise_t !== undefined && e.resets_in_s < 600).map((e) => e.promise_t);
  const margin_s = promises.length && exit ? Math.round((Math.max(...promises) - exit.at) / 100) / 10 : null;
  return { exit, closedByDriver, out, stderr: stderr.trim(), margin_s };
}

function alive(pid) {
  try {
    return execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).includes(String(pid));
  } catch {
    return false;
  }
}

function report(dir) {
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  const log = read(path.join(dir, "bin", "state", "router.log"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map(({ event, kind, reason, why, chosen, in_s, tasks, error, account }) => ({ event, account, chosen, kind, in_s, why, reason, tasks: Array.isArray(tasks) ? tasks.length : tasks, error }));
  const fakeLog = (a) =>
    read(path.join(dir, `acc-${a}`, "fake.log"))
      .split("\n")
      .filter((l) => l && !l.includes("--no-session-persistence"))
      .map((l) => l.slice(0, 400));
  return { log, fake_a: fakeLog("a"), fake_b: fakeLog("b") };
}

async function scenario(name) {
  const sc = SCENARIOS[name];
  const dir = setup(name, sc);
  const hub = sc.slowHub ? await hungHub() : sc.delayHub ? await delayHub(sc.delayHub) : null;
  if (sc.slowHub === "start") hub.point(dir);
  if (sc.slowHub === "later") sc.afterStart = hub.point;
  if (sc.delayHub) sc.afterStart = (d) => { hub.point(d); if (sc.afterStartPatch) patch(d, "a", sc.afterStartPatch); };
  else if (sc.afterStartPatch) sc.afterStart = (d) => patch(d, "a", sc.afterStartPatch);
  const sid = "5e55a0b1-0000-4000-8000-" + String(Date.now()).slice(-12).padStart(12, "0");
  const first = await runOnce(dir, sc, sid, false);
  hub?.server.close();
  const res = { name, first };
  const pidFile = path.join(dir, "acc-a", "bg.pid");
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    res.command_alive_after_router = alive(pid);
    res.command_pid = pid;
  }
  const interrupted = path.join(dir, "bin", "state", "interrupted", `${sid}.json`);
  res.interrupted_file = fs.existsSync(interrupted) ? JSON.parse(fs.readFileSync(interrupted, "utf8")) : null;
  if (sc.second) res.second = await runOnce(dir, sc, sid, true);
  res.report = report(dir);
  if (res.command_pid && alive(res.command_pid)) {
    try {
      execFileSync("taskkill", ["/PID", String(res.command_pid), "/T", "/F"]);
    } catch {}
  }
  return res;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
const results = await Promise.all(names.map(scenario));
console.log(JSON.stringify(results, null, 1));
