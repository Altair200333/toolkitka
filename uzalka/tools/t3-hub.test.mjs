#!/usr/bin/env node
// t3-hub.test.mjs — black-box check of Uzalka's T3 hub (src-tauri/src/hub.rs) against the
// contract T3 Code expects. The shape checks mirror the Effect schemas in T3's
// apps/server/src/usage/cliproxyApi.ts (AuthFiles, ApiResponse, ClaudeUsage, CodexUsage).
// Run with Uzalka running:   node tools/t3-hub.test.mjs
// Port and key come from %APPDATA%\uzalka\config.json (`hub`); env UZALKA_HUB_PORT /
// UZALKA_HUB_KEY override them.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const appData = process.env.APPDATA || path.join(process.env.HOME || "", "AppData", "Roaming");
const uzalkaDir = path.join(appData, "uzalka");
const hubCfg = JSON.parse(fs.readFileSync(path.join(uzalkaDir, "config.json"), "utf8")).hub || {};
const port = Number(process.env.UZALKA_HUB_PORT || hubCfg.port || 8318);
const key = process.env.UZALKA_HUB_KEY || hubCfg.key;
if (!key) {
  console.error("no hub key: start Uzalka once so it generates one (config.json -> hub.key)");
  process.exit(2);
}
const snapshot = JSON.parse(fs.readFileSync(path.join(uzalkaDir, "usage.json"), "utf8"));

let failures = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passes += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function request(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: p,
        headers: {
          ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const auth = { Authorization: `Bearer ${key}` };
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStrOrNull = (v) => v === null || typeof v === "string";
const isNumOrNull = (v) => v === null || isNum(v);

// Mirrors T3's ClaudeUsage schema.
function validateClaude(u) {
  const problems = [];
  for (const k of ["five_hour", "seven_day"]) {
    const w = u[k];
    if (w === undefined || w === null) continue;
    if (!isNum(w.utilization)) problems.push(`${k}.utilization not a number`);
    if (!isStrOrNull(w.resets_at)) problems.push(`${k}.resets_at not string|null`);
  }
  if (u.limits !== undefined) {
    if (!Array.isArray(u.limits)) problems.push("limits not an array");
    else
      u.limits.forEach((l, i) => {
        if (typeof l.kind !== "string") problems.push(`limits[${i}].kind not a string`);
        if (l.percent !== undefined && !isNumOrNull(l.percent)) problems.push(`limits[${i}].percent`);
        if (l.resets_at !== undefined && !isStrOrNull(l.resets_at)) problems.push(`limits[${i}].resets_at`);
        if (l.scope !== undefined && l.scope !== null) {
          const m = l.scope.model;
          if (m !== undefined && m !== null && typeof m.display_name !== "string")
            problems.push(`limits[${i}].scope.model.display_name`);
        }
      });
  }
  return problems;
}

// Mirrors T3's CodexUsage schema.
function validateCodex(u) {
  const problems = [];
  if (u.plan_type !== undefined && typeof u.plan_type !== "string") problems.push("plan_type");
  if (u.rate_limit === undefined) problems.push("rate_limit missing");
  else if (u.rate_limit !== null) {
    for (const k of ["primary_window", "secondary_window"]) {
      const w = u.rate_limit[k];
      if (w === undefined || w === null) continue;
      if (!isNum(w.used_percent)) problems.push(`${k}.used_percent`);
      if (w.reset_at !== undefined && !isNumOrNull(w.reset_at)) problems.push(`${k}.reset_at`);
      if (w.limit_window_seconds !== undefined && !isNum(w.limit_window_seconds))
        problems.push(`${k}.limit_window_seconds`);
    }
  }
  return problems;
}

async function main() {
  console.log(`hub http://127.0.0.1:${port}`);

  console.log("auth");
  let r = await request("GET", "/v0/management/auth-files");
  check("no key -> 401", r.status === 401, `got ${r.status}`);
  r = await request("GET", "/v0/management/auth-files", { headers: { Authorization: "Bearer nope" } });
  check("wrong key -> 401", r.status === 401, `got ${r.status}`);
  r = await request("GET", "/v0/management/auth-files", { headers: { "X-Management-Key": key } });
  check("X-Management-Key accepted", r.status === 200, `got ${r.status}`);
  r = await request("GET", "/healthz");
  check("healthz open", r.status === 200 && r.json && r.json.ok === true);

  console.log("auth-files");
  r = await request("GET", "/v0/management/auth-files", { headers: auth });
  check("200 json", r.status === 200 && r.json && Array.isArray(r.json.files), `status ${r.status}`);
  const files = (r.json && r.json.files) || [];
  const expected = snapshot.accounts.filter(
    (a) => !a.hidden && !a.duplicate_of && (a.kind === "claude" || a.kind === "codex"),
  );
  check(
    `one file per visible account (${expected.length})`,
    files.length === expected.length,
    `got ${files.length}`,
  );
  for (const f of files) {
    const ok =
      typeof f.id === "string" &&
      typeof f.auth_index === "string" &&
      (f.provider === "claude" || f.provider === "codex") &&
      (f.email === undefined || typeof f.email === "string") &&
      typeof f.disabled === "boolean" &&
      (f.id_token === undefined || typeof f.id_token === "object");
    check(`file ${f.auth_index} matches AuthFile schema`, ok, JSON.stringify(f));
  }
  const twins = snapshot.accounts.filter((a) => a.duplicate_of).map((a) => a.name);
  check(
    `twins not exposed (${twins.join(", ") || "none"})`,
    !files.some((f) => twins.includes(f.auth_index)),
  );

  console.log("api-call");
  for (const f of files) {
    const url =
      f.provider === "codex"
        ? "https://chatgpt.com/backend-api/wham/usage"
        : "https://api.anthropic.com/api/oauth/usage";
    r = await request("POST", "/v0/management/api-call", {
      headers: auth,
      body: {
        auth_index: f.auth_index,
        method: "GET",
        url,
        header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" },
      },
    });
    const okEnvelope =
      r.status === 200 && r.json && isNum(r.json.status_code) && typeof r.json.body === "string";
    check(`${f.auth_index}: ApiResponse envelope`, okEnvelope, r.text.slice(0, 200));
    if (!okEnvelope) continue;
    const acc = expected.find((a) => a.name === f.auth_index);
    const hasData =
      acc && (acc.windows.length > 0 || acc.raw) && acc.updated_ms && Date.now() - acc.updated_ms < 86400000;
    if (!hasData) {
      check(`${f.auth_index}: no data -> upstream 503`, r.json.status_code === 503);
      continue;
    }
    check(`${f.auth_index}: upstream 200`, r.json.status_code === 200, `got ${r.json.status_code}`);
    let parsed;
    try {
      parsed = JSON.parse(r.json.body);
    } catch {
      check(`${f.auth_index}: body is JSON`, false);
      continue;
    }
    const problems = f.provider === "codex" ? validateCodex(parsed) : validateClaude(parsed);
    check(`${f.auth_index}: body matches T3 ${f.provider} schema`, problems.length === 0, problems.join("; "));
    // Percentages must round-trip from the snapshot.
    if (f.provider === "claude") {
      const session = acc.windows.find((w) => w.kind === "session");
      const weekly = acc.windows.find((w) => w.kind === "weekly_all");
      if (session) check(`${f.auth_index}: five_hour = ${session.percent}%`, parsed.five_hour && parsed.five_hour.utilization === session.percent);
      if (weekly) check(`${f.auth_index}: seven_day = ${weekly.percent}%`, parsed.seven_day && parsed.seven_day.utilization === weekly.percent);
      const scoped = acc.windows.filter((w) => w.kind === "weekly_scoped").length;
      check(`${f.auth_index}: ${scoped} scoped weekly limit(s) kept`, parsed.limits.filter((l) => l.kind === "weekly_scoped").length === scoped);
    } else {
      const wins = [parsed.rate_limit.primary_window, parsed.rate_limit.secondary_window].filter(Boolean);
      check(`${f.auth_index}: ${acc.windows.length} window(s) exported`, wins.length === acc.windows.length);
      for (const w of acc.windows) {
        check(`${f.auth_index}: window ${w.label} = ${w.percent}% with reset epoch`, wins.some((x) => x.used_percent === w.percent && x.reset_at === w.resets_at));
      }
      r = await request("POST", "/v0/management/api-call", {
        headers: auth,
        body: { auth_index: f.auth_index, method: "GET", url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", header: {} },
      });
      check(`${f.auth_index}: credits -> empty list`, r.status === 200 && r.json.status_code === 200 && JSON.parse(r.json.body).credits.length === 0);
    }
  }
  r = await request("POST", "/v0/management/api-call", {
    headers: auth,
    body: { auth_index: files[0] && files[0].auth_index, method: "GET", url: "https://example.com/x", header: {} },
  });
  check("unknown upstream url -> status_code 404", r.status === 200 && r.json && r.json.status_code === 404);
  r = await request("POST", "/v0/management/api-call", {
    headers: auth,
    body: { auth_index: "no-such-account", method: "GET", url: "https://api.anthropic.com/api/oauth/usage", header: {} },
  });
  check("unknown auth_index -> http 404", r.status === 404);

  console.log("misc");
  r = await request("POST", "/v0/management/reset-quota", { headers: auth, body: { auth_index: "codex" } });
  check("reset-quota -> ok", r.status === 200 && r.json && r.json.status === "ok");
  r = await request("GET", "/v0/management/config", { headers: auth });
  check("unknown route -> 404", r.status === 404);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("test crashed:", err);
  process.exit(2);
});
