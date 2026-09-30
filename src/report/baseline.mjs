#!/usr/bin/env node
// Merge the per-screen audit reports from a report dir into the ratchet
// baseline. This is the only sanctioned way to change the baseline.
//
// The gate summary is computed in the walker and embedded as `.gate`.
// Validate it against the findings before accepting its unchanged values.
// Android ATF reports are recomputed from their native evidence first,
// exactly as `aloud report` does (see tree-report.mjs).
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
// iOS pair when the report dir is named "ios" or ends in "-ios" (see
// platform.mjs).

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliArgs } from "../cli-args.mjs";
import { platformForReportDir } from "./platform.mjs";
import { readTreeReport } from "./tree-report.mjs";
import { migrationNote, readBaseline } from "./validation.mjs";

const { opt, positionals } = cliArgs(
  "baseline.mjs",
  { baseline: { type: "string" } },
  { allowPositionals: true },
);
// One report dir per run: a second one would be silently ignored.
if (positionals.length > 1) {
  console.error("usage: aloud baseline <report-dir> [--baseline <file>]");
  process.exit(1);
}

const cfg = process.env.ALOUD_CONFIG
  ? JSON.parse(readFileSync(process.env.ALOUD_CONFIG, "utf8"))
  : null;

const reportDir = positionals[0]
  ? resolve(positionals[0])
  : cfg?.out
    ? join(cfg.out, "android")
    : null;
if (!reportDir) {
  console.error("usage: aloud baseline <report-dir> [--baseline <file>]");
  process.exit(1);
}
const platform = platformForReportDir(reportDir);
if (platform === "web") {
  console.error("Experimental web evidence is report-only; baselines are not enabled");
  process.exit(1);
}
const isIos = platform === "ios";
const baselinePath = opt("baseline", isIos ? cfg?.baseline?.ios : cfg?.baseline?.android);
if (!baselinePath) {
  console.error("no baseline path: pass --baseline <file> or set ALOUD_CONFIG");
  process.exit(1);
}

if (!existsSync(reportDir)) {
  console.error(`No reports found at ${reportDir} — run the audit walk first.`);
  process.exit(1);
}

// Validate the existing file first. Screens this run does not cover are
// written back exactly as they were: an entry from before a rule
// reclassification is the only record that a criterion was never checked
// on that screen at the current rule (the OpenACR draft reads it and
// leaves the criterion unevaluated), so rewriting it in the current
// classification would turn that gap into a silent pass.
const existing = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
const { migrated } = readBaseline(existing, baselinePath);
const baseline = { ...existing };
const updated = [];
const files = readdirSync(reportDir)
  .filter((f) => f.endsWith(".tree.json"))
  .sort();

for (const file of files) {
  // The same reading `aloud report` uses: ATF reports are recomputed from
  // their native evidence, so their gate is the current one.
  const report = readTreeReport(JSON.parse(readFileSync(join(reportDir, file), "utf8")), file, { isIos });
  // An ordinary report from before the touch-target reclassification
  // holds no evidence for the rule that now gates 2.5.8; accepting it
  // would bless counts nobody measured.
  if (report.uncheckedCriteria) {
    console.error(
      `${report.screen}: ${file} predates the current target-size rules, so WCAG ` +
        `${report.uncheckedCriteria.join(", ")} was not checked — re-run the tree pass before accepting a baseline.`,
    );
    process.exit(1);
  }
  baseline[report.screen] = report.gate;
  updated.push(report.screen);
}

if (updated.length === 0) {
  console.error("No gate reports found — nothing written.");
  process.exit(1);
}

const note = migrationNote(
  migrated.filter(({ screen }) => !updated.includes(screen)),
  baselinePath,
  "This run keeps those entries as written; include those screens in a run to rewrite them.",
);
if (note) console.warn(note);

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
