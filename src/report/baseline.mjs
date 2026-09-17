#!/usr/bin/env node
// Merge the per-screen audit reports from a report dir into the ratchet
// baseline. This is the only sanctioned way to change the baseline.
//
// The gate summary is computed in the walker and embedded as `.gate`.
// Validate it against the findings before accepting its unchanged values.
// True merge: a filtered run (e.g.
// `--flow payments`) updates only the screens it walked.
//
// Only run this to ACCEPT current counts (initial baseline, or after a
// fix lowers them). Commit the result alongside the change that earned it.
//
//   aloud baseline <report-dir> [--baseline <file>]
//
// With no args, the report dir and baseline come from the resolved
// config (env ALOUD_CONFIG): <out>/android and baseline.android, or the
// iOS pair when the report dir ends in "ios".

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateBaseline, validateTreeReport } from "./validation.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--baseline");

const cfg = process.env.ALOUD_CONFIG
  ? JSON.parse(readFileSync(process.env.ALOUD_CONFIG, "utf8"))
  : null;

const reportDir = positional[0]
  ? resolve(positional[0])
  : cfg?.out
    ? join(cfg.out, "android")
    : null;
if (!reportDir) {
  console.error("usage: aloud baseline <report-dir> [--baseline <file>]");
  process.exit(1);
}
const isIos = /ios\/?$/.test(reportDir);
const baselinePath = opt("baseline", isIos ? cfg?.baseline?.ios : cfg?.baseline?.android);
if (!baselinePath) {
  console.error("no baseline path: pass --baseline <file> or set ALOUD_CONFIG");
  process.exit(1);
}

if (!existsSync(reportDir)) {
  console.error(`No reports found at ${reportDir} — run the audit walk first.`);
  process.exit(1);
}

const baseline = validateBaseline(existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : {}, baselinePath);
const updated = [];
const files = readdirSync(reportDir)
  .filter((f) => f.endsWith(".tree.json"))
  .sort();

for (const file of files) {
  const report = validateTreeReport(JSON.parse(readFileSync(join(reportDir, file), "utf8")), file);
  baseline[report.screen] = report.gate;
  updated.push(report.screen);
}

if (updated.length === 0) {
  console.error("No gate reports found — nothing written.");
  process.exit(1);
}

const untouched = Object.keys(baseline).filter((s) => !updated.includes(s));
if (untouched.length > 0) {
  console.warn(
    `note: ${untouched.length} screen(s) kept from the existing baseline (not in this run): ` +
      `${untouched.join(", ")}. If a screen was renamed or removed, prune its entry manually.`,
  );
}

const sorted = Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`baseline updated for ${updated.length} screen(s) → ${baselinePath}`);
