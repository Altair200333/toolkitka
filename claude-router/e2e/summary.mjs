// Short view of drive.mjs output: node e2e/summary.mjs < result.json
import fs from "node:fs";

const r = JSON.parse(fs.readFileSync(0, "utf8"));
const clean = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)));
for (const s of r) {
  console.log(`=== ${s.name}  exit ${JSON.stringify(s.first.exit)}  closed by driver: ${s.first.closedByDriver}${s.first.stderr ? "  stderr " + s.first.stderr : ""}`);
  for (const o of s.first.out) console.log("  out", clean(o));
  if ("command_alive_after_router" in s) console.log("  command alive after router:", s.command_alive_after_router);
  if (s.interrupted_file) console.log("  interrupted file: tasks", s.interrupted_file.tasks.length, "notice", s.interrupted_file.notice);
  if (s.first.margin_s !== null) console.log("  router gone before the promised reset by", s.first.margin_s, "s");
  if (s.second) console.log("  second run exit", JSON.stringify(s.second.exit));
  for (const l of s.report.log) console.log("  log", clean(l).slice(0, 260));
  for (const l of s.report.fake_b) console.log("  fake_b", l.slice(0, 260));
}
