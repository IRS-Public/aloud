#!/usr/bin/env node
// Turn the USWDS accessibility harness's requirements-report/report.json into
// one aloud findings document per component (docs/harness-integration.md).
//
//   node harness-to-findings.mjs requirements-report/report.json findings/ \
//     [testing/support/known-issues.mjs]
//
// The optional third argument is the harness's known-issue registry; with it,
// each issue carries the registry's kind and plain-language summary. Set
// USWDS_VERSION to state the product version. Writes <out-dir>/<component>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Harness criterion status -> findings status. Anything else throws.
export const STATUS_MAP = Object.freeze({
  met: "met",
  // A named person recorded, in the component's reviews.csv, a judgment of
  // what the checks cannot settle; the note names them and what they found.
  "human-reviewed": "human-reviewed",
  // The checks keep wording nobody has judged yet, so a person decides.
  "awaiting-review": "partly-tested",
  "partly-tested": "partly-tested",
  "not-met": "failing",
  "not-met-known-issue": "known-defect",
  "platform-limitation": "platform-limitation",
  incomplete: "incomplete",
  untested: "untested",
  unreviewed: "unreviewed",
  "consumer-responsibility": "page-level",
  "not-triggered": "not-triggered",
  // The standard's own interpretation satisfies the row; the harness's reason
  // cites it, and no check is counted.
  "standard-interpretation": "standard-interpretation",
});

// WCAG rows are in the OpenACR catalog. "project" rows (USWDS's own
// requirements, such as APG-RADIO) are not, so they stay in the harness report.
function inCatalog({ criterion, profile }) {
  if (["section508", "additional-wcag21", "additional-wcag22"].includes(profile)) return true;
  if (profile === "project") return false;
  throw new Error(`${criterion}: unknown harness profile "${profile}"`);
}

// A failure affects all of the functionality only when every check for the
// criterion failed or is switched off for a known defect, and none passed in
// any environment. A check that never ran shows nothing either way, so it
// keeps the share at "some".
const failingShare = (checks) =>
  checks.every((check) => ["failing", "known-issue"].includes(check.status) && check.passedIn.length === 0)
    ? "all"
    : "some";

// Where a failing check passed, so the reader can tell where it failed.
const passedWhere = ({ passedIn }) => (passedIn.length ? `passed only in ${passedIn.join(", ")}` : "passed nowhere");

// The row's reason is a scope statement written as a claim ("Every control
// works from the keyboard"), or for rows no check can fail, a triage reason.
// A scope statement is labeled so the ACR never states it as a result.
const TRIAGED = new Set(["not-triggered", "consumer-responsibility", "unreviewed"]);
const reasonNote = (row) => (TRIAGED.has(row.status) ? row.reason : `Scope of the checks, not a result: ${row.reason}`);

// A "shared" row's reason ends with what each site writes and checks itself,
// which is the site's part, not a scope the checks cover: its own note.
const SITE_CONTENT = "Left to each site: ";
const reasonNotes = (row) => {
  const at = row.coverage === "shared" ? row.reason.indexOf(SITE_CONTENT) : -1;
  if (at < 0) return [reasonNote(row)];
  return [reasonNote({ ...row, reason: row.reason.slice(0, at).trim() }), row.reason.slice(at).trim()];
};

function toFinding(row, issuesByName) {
  const status = STATUS_MAP[row.status];
  if (!status) throw new Error(`${row.criterion}: unknown harness status "${row.status}"`);
  if (status === "standard-interpretation") {
    if (!row.reason) throw new Error(`${row.criterion}: a standard-interpretation row needs a reason that cites the interpretation`);
    return { criterion: row.criterion, component: "web", status, notes: [row.reason] };
  }
  const finding = { criterion: row.criterion, component: "web", status };
  if (status === "failing" || status === "known-defect") finding.failingShare = failingShare(row.checks);
  const names = [...new Set(row.checks.flatMap((check) => check.issues))];
  if (names.length) {
    finding.issues = names.map((id) => {
      const known = issuesByName.get(id);
      const summary = known?.summary ?? `Known issue ${id}; see the harness requirements report.`;
      return known?.kind ? { id, kind: known.kind, summary } : { id, summary };
    });
  }
  // Older harness reports used "human-reviewed" for approved wording alone.
  if (row.status === "human-reviewed" && !row.review) {
    throw new Error(`${row.criterion}: a human-reviewed row needs the review it rests on`);
  }
  const notes = row.reason ? reasonNotes(row) : [];
  if (row.status === "awaiting-review") {
    notes.push("The tests keep the wording as written; whether it is clear awaits a person's review");
  }
  if (row.status === "human-reviewed") {
    notes.push(`Reviewed by ${row.review.reviewer} on ${row.review.date}: ${row.review.judgment}`);
  }
  const failing = row.checks.filter((check) => check.status === "failing");
  if (failing.length) {
    notes.push(`Failing checks: ${failing.map((check) => `${check.id} (${passedWhere(check)})`).join(", ")}`);
  }
  const missing = [...new Set(row.checks.flatMap((check) => [...check.missingIn, ...check.skippedIn]))];
  if (missing.length) notes.push(`Some tests did not run in: ${missing.join(", ")}`);
  // A feature an environment does not have, such as high contrast in Safari,
  // leaves its tests nothing to verify there; those results are not evidence.
  for (const id of new Set(row.checks.flatMap((check) => check.absentFeatures ?? []))) {
    const where = new Set(row.checks.filter((check) => check.absentFeatures?.includes(id)).flatMap((check) => check.absentIn));
    notes.push(`Not applicable in ${[...where].join(", ")}: ${issuesByName.get(id)?.summary ?? id}`);
  }
  if (notes.length) finding.notes = notes;
  // Each check is evidence; environments lists where its tests ran.
  if (row.checks.length) {
    finding.evidence = row.checks.map((check) =>
      check.environments.length ? { id: check.id, environments: check.environments } : { id: check.id });
  }
  return finding;
}

// report: the parsed report.json. Returns [{ component, findings }].
export function harnessToFindings(report, { knownIssues = [], runUrl, version } = {}) {
  if (!Array.isArray(report?.components) || !report.run) throw new Error("not a harness report.json");
  if (report.run.unhandledErrors) throw new Error("the harness run had unhandled errors; fix the run first");
  // With known bugs switched on (RUN_KNOWN_BUGS=1), known defects and platform
  // limitations show up as plain failures with no issue named.
  if (report.run.knownBugsEnabled) throw new Error("the harness run switched known bugs on; draft from a regular run");
  const issuesByName = new Map(knownIssues.map((issue) => [issue.name, issue]));
  const { commit, workingTreeDirty, finishedAt, environments } = report.run;
  const provenance = {
    ...(commit && commit !== "unknown" ? { commit, workingTreeDirty } : {}),
    ...(runUrl ? { runUrl } : {}),
    date: (finishedAt ?? report.generatedAt).slice(0, 10),
    tools: [{ name: "USWDS accessibility harness" }],
  };
  const notes = [`Tested in: ${environments.length ? environments.join(", ") : "no environment"}`];
  return report.components.map(({ component, criteria }) => ({
    component,
    findings: {
      schemaVersion: 1,
      product: { name: `USWDS ${component}`, ...(version ? { version } : {}) },
      provenance,
      components: ["web"],
      findings: criteria.filter(inCatalog).map((row) => toFinding(row, issuesByName)),
      notes,
      evaluationMethods:
        "The USWDS accessibility harness ran automated browser, screen reader, and high contrast " +
        "tests on the component's example pages; each finding is one row of its requirements report.",
    },
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [reportFile, outDir, registry] = process.argv.slice(2);
  if (!reportFile || !outDir) throw new Error("usage: harness-to-findings.mjs <report.json> <out-dir> [known-issues.mjs]");
  const knownIssues = registry ? (await import(pathToFileURL(resolve(registry)).href)).knownIssues : [];
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = process.env;
  const runUrl = server && repo && run ? `${server}/${repo}/actions/runs/${run}` : undefined;
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  mkdirSync(outDir, { recursive: true });
  const version = process.env.USWDS_VERSION || undefined;
  for (const { component, findings } of harnessToFindings(report, { knownIssues, runUrl, version })) {
    writeFileSync(join(outDir, `${component}.json`), `${JSON.stringify(findings, null, 2)}\n`);
  }
}
