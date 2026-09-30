import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RULE = "native-interactive-unlabeled";
const OTHER_RULE = "native-target-size-minimum";
const clean = { errors: 0, ruleIds: [] };
const oneError = { errors: 1, ruleIds: [RULE] };
const finding = (ruleId = RULE, severity = "error") => ({ ruleId, severity });
const tree = (overrides = {}) => ({
  screen: "home", violations: [finding()], gate: oneError, ...overrides,
});

function fixture(t, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "aloud-report-validation-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const out = join(cwd, options.platform ?? "android");
  mkdirSync(out);
  const reports = options.reports ?? [tree()];
  for (const [index, report] of reports.entries()) {
    writeFileSync(join(out, `${index}.tree.json`), JSON.stringify(report));
  }
  const baselinePath = join(cwd, "baseline.json");
  const baseline = Object.hasOwn(options, "baseline") ? options.baseline : { home: oneError };
  if (baseline !== undefined) writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  const readBaseline = () => existsSync(baselinePath) ? readFileSync(baselinePath, "utf8") : null;
  const run = (command, gate = true) => spawnSync(process.execPath, [
    join(ROOT, "bin/aloud.mjs"), command,
    ...(command === "report" ? ["--dir", out, ...(gate ? ["--gate"] : [])] : [out]),
    "--baseline", baselinePath, "--out", join(cwd, "config"),
  ], { cwd, encoding: "utf8", env: { ...process.env, ALOUD_CONFIG: "" } });
  return { out, readBaseline, run };
}

function rejectsWithoutBaselineWrite(f) {
  const before = f.readBaseline();
  const report = f.run("report");
  const baseline = f.run("baseline");
  assert.deepEqual({
    reportExit: report.status,
    baselineExit: baseline.status,
    baselineUnchanged: f.readBaseline() === before,
  }, { reportExit: 1, baselineExit: 1, baselineUnchanged: true },
  `report:\n${report.stdout}${report.stderr}\nbaseline:\n${baseline.stdout}${baseline.stderr}`);
  assert.doesNotMatch(report.stdout, /508 gate passed/);
}

describe("CLI baseline validation", () => {
  const invalidBaselines = [
    ["a null root", null],
    ["an array root", []],
    ["an array entry", { home: [] }],
    ["a missing error count", { home: { ruleIds: [RULE] } }],
    ...["invalid", null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((errors) =>
      [`error count ${JSON.stringify(errors)}`, { home: { errors, ruleIds: [RULE] } }]),
    ...[null, RULE, {}].map((ruleIds) =>
      [`rule collection ${JSON.stringify(ruleIds)}`, { home: { errors: 1, ruleIds } }]),
    ...[[RULE, RULE], [""], ["   "], [1]].map((ruleIds) =>
      [`rule IDs ${JSON.stringify(ruleIds)}`, { home: { errors: 2, ruleIds } }]),
    ["rules with zero errors", { home: { errors: 0, ruleIds: [RULE] } }],
    ["errors without rules", { home: { errors: 1, ruleIds: [] } }],
    ["more unique rules than errors", { home: { errors: 1, ruleIds: [RULE, OTHER_RULE] } }],
  ];

  for (const [name, baseline] of invalidBaselines) {
    it(`rejects ${name} when gating or accepting a baseline`, (t) => {
      rejectsWithoutBaselineWrite(fixture(t, { baseline }));
    });
  }

  it("validates untouched entries before accepting a filtered update", (t) => {
    rejectsWithoutBaselineWrite(fixture(t, {
      baseline: { home: oneError, settings: { errors: "invalid", ruleIds: [RULE] } },
    }));
  });
});

describe("CLI ordinary tree evidence validation", () => {
  const invalidReports = [
    ["an error hidden by a zero-error gate", tree({ gate: clean })],
    ["a gate error absent from the findings", tree({ violations: [] })],
    ["equal counts with different rule IDs", tree({ gate: { errors: 1, ruleIds: [OTHER_RULE] } })],
    ["duplicate gate rule IDs", tree({ violations: [finding(), finding()], gate: { errors: 2, ruleIds: [RULE, RULE] } })],
    ["a malformed violations collection", tree({ violations: {} })],
    ["an unrecognized finding severity", tree({ violations: [finding(RULE, "warning")], gate: clean })],
    ["a finding with an empty rule ID", tree({ violations: [finding("")] })],
    ["a nonnumeric gate count", tree({ gate: { errors: "invalid", ruleIds: [RULE] } })],
    ["an invalid screen ID", tree({ screen: "../home" })],
  ];
  for (const [name, report] of invalidReports) {
    it(`rejects ${name} in reports and baseline acceptance`, (t) => {
      rejectsWithoutBaselineWrite(fixture(t, {
        reports: [report], baseline: { home: { errors: 2, ruleIds: [RULE, OTHER_RULE] } },
      }));
    });
  }

  it("validates contradictory evidence even without the regression gate", (t) => {
    const f = fixture(t, { reports: [tree({ gate: clean })] });
    const result = f.run("report", false);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(existsSync(join(f.out, "summary.json")), false);
    assert.equal(existsSync(join(f.out, "index.html")), false);
  });

  it("does not accept a valid early report when a later tree has no gate", (t) => {
    const f = fixture(t, {
      reports: [tree({ screen: "first", violations: [], gate: clean }), { screen: "later", violations: [] }],
      baseline: { first: oneError, later: clean },
    });
    rejectsWithoutBaselineWrite(f);
  });

  it("does not create a baseline from a partially valid batch", (t) => {
    const f = fixture(t, {
      reports: [tree({ screen: "first" }), tree({ screen: "later", gate: clean })],
      baseline: undefined,
    });
    const result = f.run("baseline");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(f.readBaseline(), null);
  });
});

describe("valid ordinary evidence remains compatible", () => {
  for (const platform of ["android", "ios"]) {
    it(`accepts ${platform} repeated errors and report-only warnings with unordered rule IDs`, (t) => {
      const labelRule = platform === "ios" ? "ios-interactive-unlabeled" : RULE;
      const sizeRule = platform === "ios" ? "ios-target-size-minimum" : OTHER_RULE;
      const warningRule = platform === "ios" ? "ios-duplicate-speakable" : "native-duplicate-speakable";
      const gate = { errors: 3, ruleIds: [sizeRule, labelRule] };
      const f = fixture(t, {
        platform,
        reports: [tree({ violations: [finding(labelRule), finding(labelRule), finding(sizeRule), finding(warningRule, "warn")], gate })],
        baseline: { home: { errors: 4, ruleIds: [labelRule, sizeRule] }, untouched: clean },
      });
      const result = f.run("report");
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const summary = JSON.parse(readFileSync(join(f.out, "summary.json"), "utf8"));
      assert.equal(summary.screens.home.errors, 3);
      assert.equal(summary.screens.home.warns, 1);
      assert.deepEqual(Object.keys(summary.screens), ["home"]);
      const accepted = f.run("baseline");
      assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
      assert.deepEqual(JSON.parse(f.readBaseline()), { home: gate, untouched: clean });
    });
  }

  it("creates a baseline for clean checked evidence with only warnings", (t) => {
    const f = fixture(t, {
      reports: [tree({ violations: [finding("native-duplicate-speakable", "warn")], gate: clean })],
      baseline: undefined,
    });
    const accepted = f.run("baseline");
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.deepEqual(JSON.parse(f.readBaseline()), { home: clean });
    const result = f.run("report");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /508 gate passed/);
  });
});

describe("evidence from before the target-size reclassification", () => {
  // The 48dp/44pt ids used to be 2.5.8 errors; they are now report-only
  // guideline warnings, and native-target-size-minimum gates 2.5.8.
  const OLD = "native-touch-target-small";
  const NEW = "native-target-size-minimum";

  it("gates a fresh clean run against an old baseline that accepted 48dp errors", (t) => {
    const f = fixture(t, {
      reports: [tree({ violations: [finding(OLD, "warn")], gate: clean })],
      baseline: { home: { errors: 2, ruleIds: [OLD] } },
    });
    const result = f.run("report");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /508 gate passed/);
    assert.match(result.stderr, /lists native-touch-target-small as gating error\(s\) on 1 screen\(s\) \(home\)/);
  });

  it("keeps holding every other rule an old baseline accepted, at the fewest errors the entry proves", (t) => {
    // 3 errors across two rules, one of them retired: the entry proves only
    // one label error, so a second one fails, with a hint to re-accept.
    const baseline = { home: { errors: 3, ruleIds: [RULE, OLD] } };
    const one = fixture(t, { reports: [tree()], baseline });
    const passed = one.run("report");
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stderr, /allows one error per remaining rule id \(home 3 -> 1\)/);
    const two = fixture(t, { reports: [tree({ violations: [finding(), finding()], gate: { errors: 2, ruleIds: [RULE] } })], baseline });
    const result = two.run("report");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /home: 2 error\(s\), baseline allows 1 \(the entry predates the target-size reclassification/);
  });

  it("states each migrated entry's new allowance, not a fixed one per retired id", (t) => {
    const f = fixture(t, {
      reports: [tree({ violations: [], gate: clean })],
      baseline: { home: { errors: 3, ruleIds: [OLD] } },
    });
    const result = f.run("report");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /\(home 3 -> 0\)/);
    assert.doesNotMatch(result.stderr, /one fewer/);
  });

  it("fails a screen that newly violates the 24dp rule, even where the old baseline accepted 48dp errors", (t) => {
    const f = fixture(t, {
      reports: [tree({ violations: [finding(NEW), finding(OLD, "warn")], gate: { errors: 1, ruleIds: [NEW] } })],
      baseline: { home: { errors: 1, ruleIds: [OLD] } },
    });
    const result = f.run("report");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /new rule id\(s\) native-target-size-minimum/);
  });

  it("keeps untouched old entries exactly as written when accepting a baseline", (t) => {
    // Rewriting `other` as { errors: 3, ruleIds: [RULE] } would erase the
    // only record that its 2.5.8 was never checked at 24dp, and the OpenACR
    // draft would then report 2.5.8 as supported there.
    const other = { errors: 4, ruleIds: [RULE, OLD] };
    const f = fixture(t, {
      reports: [tree({ violations: [finding(NEW)], gate: { errors: 1, ruleIds: [NEW] } })],
      baseline: { home: { errors: 1, ruleIds: [OLD] }, other },
    });
    const accepted = f.run("baseline");
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.match(accepted.stderr, /on 1 screen\(s\) \(other\).*keeps those entries as written/);
    assert.deepEqual(JSON.parse(f.readBaseline()), { home: { errors: 1, ruleIds: [NEW] }, other });
  });

  it("reads an old tree report but will not gate or baseline it", (t) => {
    // The old walker wrote the 48dp finding as a 2.5.8 error.
    const old = { ruleId: OLD, severity: "error", wcag: "2.5.8", criteria: ["2.5.8"], detail: "touch target 32x32dp (minimum 48x48dp)" };
    const f = fixture(t, {
      reports: [tree({ violations: [finding(), old], gate: { errors: 2, ruleIds: [OLD, RULE] } })],
      baseline: { home: { errors: 2, ruleIds: [OLD, RULE] } },
    });
    const summarized = f.run("report", false);
    assert.equal(summarized.status, 0, summarized.stdout + summarized.stderr);
    const summary = JSON.parse(readFileSync(join(f.out, "summary.json"), "utf8"));
    assert.deepEqual(
      { errors: summary.screens.home.errors, warns: summary.screens.home.warns, ruleIds: summary.screens.home.ruleIds },
      { errors: 1, warns: 1, ruleIds: [RULE] },
    );
    assert.deepEqual(summary.screens.home.uncheckedCriteria, ["2.5.8"]);
    const html = readFileSync(join(f.out, "index.html"), "utf8");
    assert.match(html, /predates the current target-size rules, so WCAG 2\.5\.8 was not checked/);
    assert.match(html, /Platform guideline · no WCAG criterion/);

    const gated = f.run("report");
    assert.equal(gated.status, 1, gated.stdout + gated.stderr);
    assert.match(gated.stderr, /home: tree report predates the current target-size rules, so WCAG 2\.5\.8 was not checked/);

    const before = f.readBaseline();
    const accepted = f.run("baseline");
    assert.equal(accepted.status, 1, accepted.stdout + accepted.stderr);
    assert.match(accepted.stderr, /re-run the tree pass before accepting a baseline/);
    assert.equal(f.readBaseline(), before);
  });

  it("reads an old tree report's 48dp finding written before findings carried criteria", (t) => {
    const old = { ruleId: OLD, severity: "error", wcag: "2.5.8", detail: "touch target 32x32dp (minimum 48x48dp)" };
    const f = fixture(t, { reports: [tree({ violations: [old], gate: { errors: 1, ruleIds: [OLD] } })] });
    assert.equal(f.run("report", false).status, 0);
    const summary = JSON.parse(readFileSync(join(f.out, "summary.json"), "utf8"));
    assert.deepEqual(summary.screens.home.errors, 0);
    assert.deepEqual(summary.screens.home.uncheckedCriteria, ["2.5.8"]);
  });
});
