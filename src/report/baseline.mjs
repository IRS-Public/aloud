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
//   aloud baseline <report-dir> [--baseline <file>] [--prune] [--allow-mixed]
//     [--accept <screen>:<ruleId> --kind <kind> --summary "..." [--issue <ref>]]
//
// Accepted reasons (src/report/accepted.mjs) already in the baseline carry
// over for rule ids that still fire. --accept adds or replaces one, after
// the merge. --prune drops screens this run did not cover (renamed or
// removed screens) instead of keeping them. The merge itself is
// mergeBaseline in baseline-merge.mjs.
//
// Like `aloud report`, it refuses tree reports from different runs
// (another commit, uncommitted changes, another aloud or CI run; see
// src/provenance.mjs combineProvenance): a baseline drawn from two
// versions of the app ratchets against counts nobody measured together.
// --allow-mixed accepts them anyway, with a warning.
//
// With no args, the report dir and baseline come from the resolved
// config (env ALOUD_CONFIG): <out>/android and baseline.android, or the
// iOS pair when the report dir is named "ios" or ends in "-ios" (see
// platform.mjs).

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cliArgs } from "../cli-args.mjs";
import { parseAcceptFlags } from "./accepted.mjs";
import { mergeBaseline } from "./baseline-merge.mjs";
import { platformForReportDir } from "./platform.mjs";
import { readTreeReport } from "./tree-report.mjs";
import { migrationNote, readEvidenceProvenance } from "./validation.mjs";
import { combineProvenance } from "../provenance.mjs";

const USAGE =
  "usage: aloud baseline <report-dir> [--baseline <file>] [--prune] [--allow-mixed] " +
  '[--accept <screen>:<ruleId> --kind <kind> --summary "..." [--issue <ref>]]';

const { opt, flag, positionals } = cliArgs(
  "baseline.mjs",
  {
    baseline: { type: "string" },
    prune: { type: "boolean" },
    "allow-mixed": { type: "boolean" },
    accept: { type: "string" },
    kind: { type: "string" },
    summary: { type: "string" },
    issue: { type: "string" },
  },
  { allowPositionals: true },
);
// One report dir per run: a second one would be silently ignored.
if (positionals.length > 1) {
  console.error(USAGE);
  process.exit(1);
}

// Check the accept flags before reading anything, so a typo never
// half-runs.
let accept;
try {
  accept = parseAcceptFlags({ accept: opt("accept"), kind: opt("kind"), summary: opt("summary"), issue: opt("issue") });
} catch (error) {
  console.error(`aloud baseline: ${error.message}`);
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
  console.error(USAGE);
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

// Screens this run does not cover are written back exactly as they were
// (see baseline-merge.mjs). The existing file is validated first, and
// every report is read before anything is written.
const existing = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
const gates = {};
const files = readdirSync(reportDir)
  .filter((f) => f.endsWith(".tree.json"))
  .sort();

// Each tree report's provenance, checked for one run after the loop.
const sources = [];
for (const file of files) {
  // The same reading `aloud report` uses: ATF reports are recomputed from
  // their native evidence, so their gate is the current one.
  const raw = JSON.parse(readFileSync(join(reportDir, file), "utf8"));
  sources.push({ file, provenance: readEvidenceProvenance(raw, file) });
  const report = readTreeReport(raw, file, { isIos });
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
  gates[report.screen] = report.gate;
}

if (Object.keys(gates).length === 0) {
  console.error("No gate reports found — nothing written.");
  process.exit(1);
}

// One baseline describes one version of the app: refuse tree reports from
// different runs before writing anything, unless explicitly allowed.
try {
  const provenance = combineProvenance(sources, { allowMixed: flag("allow-mixed"), what: `report dir ${reportDir}` });
  if (provenance?.mixed) {
    console.warn(`warning: --allow-mixed: ${reportDir} combines evidence from ${provenance.mixed.length} different runs`);
  }
} catch (error) {
  console.error(`aloud baseline: ${error.message}`);
  process.exit(1);
}

let result;
try {
  result = mergeBaseline(existing, gates, { prune: flag("prune"), accept, field: baselinePath });
} catch (error) {
  console.error(`aloud baseline: ${error.message}`);
  process.exit(1);
}
const { baseline, updated, kept, pruned, dropped, migrated, unexplained } = result;

const note = migrationNote(
  migrated,
  baselinePath,
  "This run keeps those entries as written; include those screens in a run to rewrite them.",
);
if (note) console.warn(note);

if (kept.length > 0) {
  console.warn(
    `note: ${kept.length} screen(s) kept from the existing baseline (not in this run): ` +
      `${kept.join(", ")}. If a screen was renamed or removed, re-run with --prune to drop it.`,
  );
}
if (pruned.length > 0) {
  console.warn(`note: --prune removed ${pruned.length} screen(s) not in this run: ${pruned.join(", ")}.`);
}
if (dropped.length > 0) {
  console.warn(
    `note: dropped ${dropped.length} accepted reason(s) for rule ids that no longer fire: ` +
      `${dropped.map(({ screen, ruleId }) => `${screen}:${ruleId}`).join(", ")}.`,
  );
}
// A warning, not a failure: baselines from before accepted reasons have
// none, and must keep working.
if (unexplained.length > 0) {
  const count = unexplained.reduce((n, { ruleIds }) => n + ruleIds.length, 0);
  console.warn(
    `warning: ${count} baselined rule id(s) have no accepted reason: ` +
      `${unexplained.map(({ screen, ruleIds }) => `${screen}: ${ruleIds.join(", ")}`).join("; ")}. ` +
      'Record why with --accept <screen>:<ruleId> --kind product-bug|platform-gap|accepted-risk --summary "...".',
  );
}

writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
if (accept) console.log(`accepted ${accept.screen}:${accept.entry.ruleId} as ${accept.entry.kind}`);
console.log(`baseline updated for ${updated.length} screen(s) → ${baselinePath}`);
