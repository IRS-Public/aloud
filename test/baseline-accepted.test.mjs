/**
 * Accepted findings in baselines (src/report/accepted.mjs): the schema and
 * its validation, the `aloud baseline` merge and flags (--accept, --prune),
 * preservation across re-baselining, and how the reasons reach
 * summary.json, the evidence page, and the OpenACR draft. An accepted
 * failure must never read as a pass. Device-free.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACCEPTED_KINDS,
  MAX_ACCEPTED_SUMMARY_LENGTH,
  parseAcceptFlags,
  unexplainedRuleIds,
  validateAccepted,
} from "../src/report/accepted.mjs";
import { mergeBaseline } from "../src/report/baseline-merge.mjs";
import { renderReportHtml } from "../src/report/html.mjs";
import { readBaseline } from "../src/report/validation.mjs";
import {
  ALOUD_MAX_NOTE_LENGTH,
  aloudFindings,
  aloudMaxNoteLength,
  buildAloudAcr,
  normalizeAudit,
} from "../src/acr/from-aloud.mjs";
import { TRUNCATION_MARKER, buildAcr, validateFindings } from "../src/acr/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "native-interactive-unlabeled";
const SIZE = "native-target-size-minimum";
const OLD = "native-touch-target-small";
const bug = { ruleId: LABEL, kind: "product-bug", summary: "The close button has no label", issue: "APP-12" };
const gap = {
  ruleId: SIZE,
  kind: "platform-gap",
  summary: "The system date picker draws 20dp arrows",
  issue: "https://example.com/issues/7",
};
const twoRules = { errors: 3, ruleIds: [LABEL, SIZE] };

describe("accepted entry validation", () => {
  it("accepts every kind, with or without an issue", () => {
    for (const kind of ACCEPTED_KINDS) {
      assert.doesNotThrow(() => validateAccepted([{ ruleId: LABEL, kind, summary: "Known for now" }], [LABEL], "a"));
    }
    assert.doesNotThrow(() => validateAccepted([bug, gap], twoRules.ruleIds, "a"));
    assert.doesNotThrow(() => validateAccepted([], [], "a"));
    // "e.g. the" is still one sentence.
    assert.doesNotThrow(() =>
      validateAccepted([{ ...bug, summary: "Icons, e.g. the close button, have no label" }], [LABEL], "a"));
  });

  const invalid = [
    ["a non-array list", {}, /must be an array/],
    ["a non-object entry", ["x"], /must be an object/],
    ["an unknown field", [{ ...bug, note: "x" }], /unknown field\(s\) note/],
    ["a rule id the catalog does not know", [{ ...bug, ruleId: "made-up-rule" }], /not a rule in src\/rules\/catalog\.mjs/],
    ["a rule id the screen does not baseline", [{ ...bug, ruleId: "native-image-button-unlabeled" }], /not one of this screen's baselined rule ids/],
    ["an unknown kind", [{ ...bug, kind: "wontfix" }], /kind must be one of product-bug, platform-gap, accepted-risk/],
    ["a missing kind", [{ ruleId: LABEL, summary: "x" }], /kind must be one of/],
    ["an empty summary", [{ ...bug, summary: " " }], /non-empty sentence/],
    ["a padded summary", [{ ...bug, summary: " padded" }], /must not start or end with spaces/],
    ["an over-long summary", [{ ...bug, summary: "a".repeat(MAX_ACCEPTED_SUMMARY_LENGTH + 1) }], /141 characters; keep it to one sentence of at most 140/],
    ["two sentences", [{ ...bug, summary: "No label. Fix planned" }], /single sentence/],
    ["a line break", [{ ...bug, summary: "No label\nat all" }], /single sentence/],
    ["an issue with spaces", [{ ...bug, issue: "APP 12" }], /tracker id with no spaces/],
    ["a non-http issue link", [{ ...bug, issue: "javascript://x" }], /http\(s\) URLs/],
    ["the same rule twice", [bug, { ...bug, kind: "accepted-risk" }], /more than once/],
  ];
  for (const [name, accepted, message] of invalid) {
    it(`rejects ${name}`, () => {
      assert.throws(() => validateAccepted(accepted, twoRules.ruleIds, "home.accepted"), message);
    });
  }

  it("allows exactly 140 characters", () => {
    const summary = "a".repeat(MAX_ACCEPTED_SUMMARY_LENGTH);
    assert.doesNotThrow(() => validateAccepted([{ ...bug, summary }], [LABEL], "a"));
  });
});

describe("baseline schema", () => {
  it("keeps old baselines without accepted reasons valid and unchanged", () => {
    const old = { home: twoRules, settings: { errors: 0, ruleIds: [] } };
    assert.deepEqual(readBaseline(old).baseline, old);
  });

  it("carries valid accepted reasons and rejects invalid ones, naming the screen", () => {
    const withReasons = { home: { ...twoRules, accepted: [bug] } };
    assert.deepEqual(readBaseline(withReasons).baseline, withReasons);
    assert.throws(
      () => readBaseline({ home: { ...twoRules, accepted: [{ ...bug, kind: "later" }] } }, "b.json"),
      /b\.json screen "home"\.accepted\[0\]\.kind must be one of/,
    );
    assert.throws(() => readBaseline({ home: { errors: 0, ruleIds: [], accepted: [bug] } }), /not one of this screen's/);
  });

  it("drops a reason for a reclassified rule id along with the id", () => {
    const legacy = {
      home: { errors: 2, ruleIds: [LABEL, OLD], accepted: [bug, { ruleId: OLD, kind: "accepted-risk", summary: "Old 48dp rule" }] },
    };
    const { baseline, migrated } = readBaseline(legacy);
    assert.deepEqual(baseline.home, { errors: 1, ruleIds: [LABEL], accepted: [bug] });
    assert.equal(migrated.length, 1);
  });

  it("lists baselined rule ids with no accepted reason", () => {
    assert.deepEqual(
      unexplainedRuleIds({ home: { ...twoRules, accepted: [bug] }, clean: { errors: 0, ruleIds: [] } }),
      [{ screen: "home", ruleIds: [SIZE] }],
    );
  });
});

describe("--accept flag parsing", () => {
  it("returns null without --accept and the entry with it, trimmed", () => {
    assert.equal(parseAcceptFlags({}), null);
    assert.deepEqual(
      parseAcceptFlags({ accept: "home:native-interactive-unlabeled", kind: " product-bug ", summary: " No label ", issue: " APP-1 " }),
      { screen: "home", entry: { ruleId: LABEL, kind: "product-bug", summary: "No label", issue: "APP-1" } },
    );
    assert.deepEqual(
      parseAcceptFlags({ accept: "home:x", kind: "platform-gap", summary: "s" }).entry,
      { ruleId: "x", kind: "platform-gap", summary: "s" },
    );
  });

  it("refuses partial or stray flags instead of ignoring them", () => {
    assert.throws(() => parseAcceptFlags({ kind: "product-bug" }), /--kind only apply with --accept/);
    assert.throws(() => parseAcceptFlags({ summary: "s", issue: "i" }), /--summary, --issue only apply/);
    assert.throws(() => parseAcceptFlags({ accept: "home", kind: "product-bug", summary: "s" }), /<screen>:<ruleId>/);
    assert.throws(() => parseAcceptFlags({ accept: "a:b:c", kind: "product-bug", summary: "s" }), /<screen>:<ruleId>/);
    assert.throws(() => parseAcceptFlags({ accept: "home:x" }), /needs --kind and --summary/);
    assert.throws(() => parseAcceptFlags({ accept: "home:x", kind: "product-bug", summary: "" }), /needs --summary/);
  });
});

describe("mergeBaseline", () => {
  it("keeps accepted reasons for rule ids that still fire and drops the rest", () => {
    const existing = { home: { ...twoRules, accepted: [bug, gap] } };
    const result = mergeBaseline(existing, { home: { errors: 1, ruleIds: [LABEL] } });
    assert.deepEqual(result.baseline, { home: { errors: 1, ruleIds: [LABEL], accepted: [bug] } });
    assert.deepEqual(result.dropped, [{ screen: "home", ruleId: SIZE }]);
    assert.deepEqual(result.unexplained, []);
  });

  it("keeps screens it did not cover exactly as written, unless pruning", () => {
    const other = { errors: 4, ruleIds: [LABEL, OLD], accepted: [bug] };
    const existing = { home: twoRules, other };
    const kept = mergeBaseline(existing, { home: twoRules });
    assert.deepEqual(kept.baseline.other, other);
    assert.deepEqual(kept.kept, ["other"]);
    assert.deepEqual(kept.migrated.map(({ screen }) => screen), ["other"]);
    const pruned = mergeBaseline(existing, { home: twoRules }, { prune: true });
    assert.deepEqual(Object.keys(pruned.baseline), ["home"]);
    assert.deepEqual(pruned.pruned, ["other"]);
    assert.deepEqual(pruned.migrated, []);
  });

  it("adds and replaces one accepted reason, sorted by rule id", () => {
    const first = mergeBaseline({}, { home: twoRules }, { accept: { screen: "home", entry: gap } });
    assert.deepEqual(first.baseline.home.accepted, [gap]);
    assert.deepEqual(first.unexplained, [{ screen: "home", ruleIds: [LABEL] }]);
    const second = mergeBaseline(first.baseline, { home: twoRules }, { accept: { screen: "home", entry: bug } });
    assert.deepEqual(second.baseline.home.accepted, [bug, gap]);
    const replaced = { ...gap, kind: "accepted-risk", summary: "Shipping with the small arrows" };
    const third = mergeBaseline(second.baseline, { home: twoRules }, { accept: { screen: "home", entry: replaced } });
    assert.deepEqual(third.baseline.home.accepted, [bug, replaced]);
  });

  it("can accept a reason on a screen this run did not cover", () => {
    const result = mergeBaseline({ other: twoRules }, { home: { errors: 0, ruleIds: [] } }, { accept: { screen: "other", entry: bug } });
    assert.deepEqual(result.baseline.other, { ...twoRules, accepted: [bug] });
  });

  it("refuses an accept for an unknown screen, an ungated rule, a reclassified rule, or a bad entry", () => {
    const merge = (accept, existing = {}) => () => mergeBaseline(existing, { home: twoRules }, { accept });
    assert.throws(merge({ screen: "nope", entry: bug }), /screen "nope", which is not in baseline or this run/);
    assert.throws(merge({ screen: "home", entry: { ...bug, ruleId: "native-image-button-unlabeled" } }),
      /does not gate \(its baselined rule ids: native-interactive-unlabeled, native-target-size-minimum\)/);
    assert.throws(merge({ screen: "old", entry: { ...bug, ruleId: OLD } }, { old: { errors: 1, ruleIds: [OLD] } }),
      /does not gate \(its baselined rule ids: none\)/);
    assert.throws(merge({ screen: "home", entry: { ...bug, kind: "later" } }), /accepted reason \(home:native-interactive-unlabeled\)\.kind/);
    // Pruned screens are gone before the accept applies.
    assert.throws(
      () => mergeBaseline({ other: twoRules }, { home: twoRules }, { prune: true, accept: { screen: "other", entry: bug } }),
      /screen "other"/,
    );
  });

  it("validates the existing baseline and refuses an empty run", () => {
    assert.throws(() => mergeBaseline({ home: { ...twoRules, accepted: [{ ...bug, kind: "x" }] } }, { home: twoRules }), /kind/);
    assert.throws(() => mergeBaseline({}, {}), /No gate reports found/);
  });
});

// ── the CLI, end to end ──

const violation = (ruleId) => ({ ruleId, severity: "error", wcag: "4.1.2", criteria: ["4.1.2"], detail: "no label" });
const treeReport = (screen, ruleIds) => ({
  screen,
  violations: ruleIds.map(violation),
  gate: { errors: ruleIds.length, ruleIds },
});

function fixture(t, { reports, baseline }) {
  const cwd = mkdtempSync(join(tmpdir(), "aloud-accepted-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const out = join(cwd, "android");
  mkdirSync(out);
  const baselinePath = join(cwd, "baseline.json");
  const writeReports = (list) => {
    for (const file of ["0.tree.json", "1.tree.json"]) rmSync(join(out, file), { force: true });
    list.forEach((report, index) => writeFileSync(join(out, `${index}.tree.json`), JSON.stringify(report)));
  };
  writeReports(reports);
  if (baseline !== undefined) writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  const readBaselineFile = () => (existsSync(baselinePath) ? readFileSync(baselinePath, "utf8") : null);
  const aloud = (command, ...args) => spawnSync(process.execPath, [
    join(ROOT, "bin/aloud.mjs"), command,
    ...(command === "report" ? ["--dir", out] : [out]),
    "--baseline", baselinePath, "--out", join(cwd, "config"), ...args,
  ], { cwd, encoding: "utf8", env: { ...process.env, ALOUD_CONFIG: "" } });
  return { out, baselinePath, readBaselineFile, writeReports, aloud };
}

const ok = (result) => assert.equal(result.status, 0, result.stdout + result.stderr);

describe("aloud baseline with accepted reasons", () => {
  it("records a reason with --accept and keeps it across a re-baseline", (t) => {
    const f = fixture(t, { reports: [treeReport("home", [LABEL])], baseline: undefined });
    const first = f.aloud("baseline");
    ok(first);
    assert.match(first.stderr, /warning: 1 baselined rule id\(s\) have no accepted reason: home: native-interactive-unlabeled/);

    const accepted = f.aloud("baseline", "--accept", `home:${LABEL}`, "--kind", "product-bug",
      "--summary", "The close button has no label", "--issue", "APP-12");
    ok(accepted);
    assert.match(accepted.stdout, /accepted home:native-interactive-unlabeled as product-bug/);
    assert.doesNotMatch(accepted.stderr, /no accepted reason/);
    const written = { home: { errors: 1, ruleIds: [LABEL], accepted: [bug] } };
    assert.deepEqual(JSON.parse(f.readBaselineFile()), written);

    // A plain re-run keeps the reason while the rule still fires.
    ok(f.aloud("baseline"));
    assert.deepEqual(JSON.parse(f.readBaselineFile()), written);

    // Once the finding is fixed, the reason goes with it, and says so.
    f.writeReports([treeReport("home", [])]);
    const fixed = f.aloud("baseline");
    ok(fixed);
    assert.match(fixed.stderr, /dropped 1 accepted reason\(s\) for rule ids that no longer fire: home:native-interactive-unlabeled/);
    assert.deepEqual(JSON.parse(f.readBaselineFile()), { home: { errors: 0, ruleIds: [] } });
  });

  it("passes a summary that starts with a dash through as a value", (t) => {
    const f = fixture(t, { reports: [treeReport("home", [LABEL])], baseline: undefined });
    ok(f.aloud("baseline", "--accept", `home:${LABEL}`, "--kind", "accepted-risk", "--summary=-Known for launch"));
    assert.equal(JSON.parse(f.readBaselineFile()).home.accepted[0].summary, "-Known for launch");
  });

  const refusals = [
    ["an unknown kind", ["--accept", `home:${LABEL}`, "--kind", "wontfix", "--summary", "x"], /kind must be one of/],
    ["an over-long summary", ["--accept", `home:${LABEL}`, "--kind", "product-bug", "--summary", "a".repeat(141)], /141 characters/],
    ["a stray --kind", ["--kind", "product-bug"], /--kind only apply with --accept/],
    ["a missing --summary", ["--accept", `home:${LABEL}`, "--kind", "product-bug"], /needs --summary/],
    ["a rule the screen does not gate", ["--accept", `home:${SIZE}`, "--kind", "product-bug", "--summary", "x"], /does not gate/],
    ["an unknown screen", ["--accept", `nope:${LABEL}`, "--kind", "product-bug", "--summary", "x"], /screen "nope"/],
    ["two --accept flags", ["--accept", `home:${LABEL}`, "--accept", `home:${SIZE}`, "--kind", "product-bug", "--summary", "x"],
      /--accept given more than once/],
  ];
  for (const [name, args, message] of refusals) {
    it(`refuses ${name} and leaves the baseline unchanged`, (t) => {
      const f = fixture(t, { reports: [treeReport("home", [LABEL])], baseline: { home: { errors: 1, ruleIds: [LABEL] } } });
      const before = f.readBaselineFile();
      const result = f.aloud("baseline", ...args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, message);
      assert.equal(f.readBaselineFile(), before);
    });
  }

  it("refuses an existing baseline with an invalid accepted entry, for baseline and gate alike", (t) => {
    const f = fixture(t, {
      reports: [treeReport("home", [LABEL])],
      baseline: { home: { errors: 1, ruleIds: [LABEL], accepted: [{ ...bug, ruleId: SIZE }] } },
    });
    const before = f.readBaselineFile();
    const baseline = f.aloud("baseline");
    assert.equal(baseline.status, 1, baseline.stdout + baseline.stderr);
    assert.match(baseline.stderr, /not one of this screen's baselined rule ids/);
    assert.equal(f.readBaselineFile(), before);
    const gated = f.aloud("report", "--gate");
    assert.equal(gated.status, 1, gated.stdout + gated.stderr);
    assert.doesNotMatch(gated.stdout, /508 gate passed/);
  });

  it("prunes screens this run did not cover only with --prune", (t) => {
    const f = fixture(t, {
      reports: [treeReport("home", [])],
      baseline: { home: { errors: 0, ruleIds: [] }, renamed: { errors: 1, ruleIds: [LABEL] } },
    });
    const kept = f.aloud("baseline");
    ok(kept);
    assert.match(kept.stderr, /kept from the existing baseline \(not in this run\): renamed\. .*re-run with --prune/);
    assert.deepEqual(Object.keys(JSON.parse(f.readBaselineFile())), ["home", "renamed"]);
    const pruned = f.aloud("baseline", "--prune");
    ok(pruned);
    assert.match(pruned.stderr, /--prune removed 1 screen\(s\) not in this run: renamed/);
    assert.deepEqual(JSON.parse(f.readBaselineFile()), { home: { errors: 0, ruleIds: [] } });
  });
});

describe("aloud report with accepted reasons", () => {
  it("puts current accepted reasons in summary.json and the evidence page, with or without --gate", (t) => {
    const stale = { ruleId: SIZE, kind: "accepted-risk", summary: "Stale reason" };
    const f = fixture(t, {
      reports: [treeReport("home", [LABEL]), treeReport("clean", [])],
      baseline: {
        home: { errors: 2, ruleIds: [LABEL, SIZE], accepted: [bug, stale] },
        clean: { errors: 0, ruleIds: [] },
      },
    });
    for (const args of [[], ["--gate"]]) {
      ok(f.aloud("report", ...args));
      const summary = JSON.parse(readFileSync(join(f.out, "summary.json"), "utf8"));
      // Only the reason for the error this run still found.
      assert.deepEqual(summary.screens.home.accepted, [bug]);
      assert.equal(summary.screens.clean.accepted, undefined);
      const html = readFileSync(join(f.out, "index.html"), "utf8");
      assert.match(html, /Accepted in the baseline \(1\)/);
      assert.match(html, /The close button has no label/);
      assert.match(html, /Tracked as <code>APP-12<\/code>/);
      assert.doesNotMatch(html, /Stale reason/);
      // The screen still fails: a reason explains an error, it does not excuse it.
      assert.match(html, /badge-fail">Fail · 1 error/);
    }
    // The summary is valid ACR input, and the reason reaches the draft.
    const acr = buildAloudAcr({
      android: normalizeAudit(JSON.parse(readFileSync(join(f.out, "summary.json"), "utf8"))),
      ios: null, appName: "Example", productVersion: "1", date: "2026-09-30",
    });
    const row = acr.chapters.success_criteria_level_a.criteria.find((c) => c.num === "4.1.2").components[0].adherence;
    assert.equal(row.level, "partially-supports");
    assert.match(row.notes, /Known issues: native-interactive-unlabeled on Android home \(product-bug\): Accepted in the baseline: The close button has no label \(tracked as APP-12\)/);
  });

  it("summarizes without a baseline file as before", (t) => {
    const f = fixture(t, { reports: [treeReport("home", [LABEL])], baseline: undefined });
    ok(f.aloud("report"));
    const summary = JSON.parse(readFileSync(join(f.out, "summary.json"), "utf8"));
    assert.equal(summary.screens.home.accepted, undefined);
  });
});

describe("evidence page", () => {
  const screen = (accepted) => ({
    screen: "home",
    title: "Home",
    source: "talkback",
    transcript: [],
    violations: [violation(LABEL), violation(SIZE)],
    gate: twoRules,
    ...(accepted ? { accepted } : {}),
  });
  const render = (s) => renderReportHtml({ screens: { home: s }, ids: ["home"], generated: "2026-09-30T00:00:00.000Z", shots: new Set(), audioManifest: null });

  it("lists each accepted reason with its kind, rule, and tracker link", () => {
    const html = render(screen([bug, gap]));
    assert.match(html, /<h3>Accepted in the baseline \(2\)<\/h3>/);
    assert.match(html, /They still count as errors in the gate and as failures in the OpenACR draft/);
    assert.match(html, /Product bug<\/span> <code class="rule">native-interactive-unlabeled<\/code>/);
    assert.match(html, /Platform gap<\/span> <code class="rule">native-target-size-minimum<\/code>/);
    assert.match(html, /Tracked in <a href="https:\/\/example\.com\/issues\/7">/);
    // The only URL is the tracker link; the page still loads nothing external.
    assert.deepEqual(html.match(/https?:\/\/[^"<\s]+/g), ["https://example.com/issues/7", "https://example.com/issues/7"]);
  });

  it("escapes reasons and omits the section when there are none", () => {
    const html = render(screen([{ ...bug, summary: "<img src=x> has no label" }]));
    assert.match(html, /&lt;img src=x&gt; has no label/);
    assert.doesNotMatch(html, /<img src=x>/);
    assert.doesNotMatch(render(screen()), /Accepted in the baseline/);
  });
});

describe("OpenACR findings from accepted reasons", () => {
  const audit = (screens) => normalizeAudit({ generated: "2026-09-30T00:00:00.000Z", screens });
  const doc = (screens) => aloudFindings({ android: audit(screens), ios: null, appName: "Example", productVersion: "1" });
  const acr = (screens) => buildAloudAcr({ android: audit(screens), ios: null, appName: "Example", productVersion: "1", date: "2026-09-30" });
  const findingFor = (d, num) => d.findings.find((f) => f.criterion === num);
  const level = (a, chapter, num) => a.chapters[chapter].criteria.find((c) => c.num === num).components[0].adherence;

  it("keeps product bugs and accepted risks failing, with the reasons as issues", () => {
    for (const kind of ["product-bug", "accepted-risk"]) {
      const d = doc({ home: { errors: 1, ruleIds: [LABEL], accepted: [{ ...bug, kind }] } });
      const f = findingFor(d, "4.1.2");
      assert.equal(f.status, "failing");
      assert.equal(f.failingShare, "some");
      assert.deepEqual(f.issues, [{
        id: "native-interactive-unlabeled on Android home",
        kind,
        summary: "Accepted in the baseline: The close button has no label (tracked as APP-12)",
      }]);
      assert.doesNotThrow(() => validateFindings(d));
      assert.equal(level(acr({ home: { errors: 1, ruleIds: [LABEL], accepted: [{ ...bug, kind }] } }), "success_criteria_level_a", "4.1.2").level,
        "partially-supports");
    }
  });

  it("states one issue for a reason shared across screens, with a URL as its link", () => {
    const d = doc({
      a: { errors: 1, ruleIds: [SIZE], accepted: [gap] },
      b: { errors: 1, ruleIds: [SIZE], accepted: [gap] },
      c: { errors: 1, ruleIds: [SIZE], accepted: [{ ...gap, kind: "product-bug", summary: "Our own chip is 20dp" }] },
    });
    assert.deepEqual(findingFor(d, "2.5.8").issues, [
      { id: "native-target-size-minimum on Android a, Android b", kind: "platform-gap",
        summary: "Accepted in the baseline: The system date picker draws 20dp arrows", url: "https://example.com/issues/7" },
      { id: "native-target-size-minimum on Android c", kind: "product-bug",
        summary: "Accepted in the baseline: Our own chip is 20dp", url: "https://example.com/issues/7" },
    ]);
    assert.equal(findingFor(d, "2.5.8").status, "failing");
  });

  it("leaves a criterion whose failures are all platform gaps for a person, never supported", () => {
    const screens = { home: { errors: 1, ruleIds: [SIZE], accepted: [gap] }, other: { errors: 0, ruleIds: [] } };
    const f = findingFor(doc(screens), "2.5.8");
    assert.equal(f.status, "platform-limitation");
    assert.equal(f.failingShare, undefined);
    assert.match(f.notes.join(" "), /accepted in the baseline as a platform gap/);
    const row = level(acr(screens), "success_criteria_level_aa", "2.5.8");
    assert.equal(row.level, "not-evaluated");
    assert.match(row.notes, /Known issues: native-target-size-minimum on Android home \(platform-gap\)/);
    assert.match(row.notes, /https:\/\/example\.com\/issues\/7/);
  });

  it("keeps the criterion failing when any failure is not an accepted platform gap", () => {
    const f = findingFor(doc({
      home: { errors: 1, ruleIds: [SIZE], accepted: [gap] },
      pay: { errors: 1, ruleIds: [SIZE] },
    }), "2.5.8");
    assert.equal(f.status, "failing");
    assert.equal(f.issues.length, 1);
  });

  it("ignores reasons for other criteria and never supports a criterion because of a reason", () => {
    const d = doc({ home: { errors: 1, ruleIds: [LABEL], accepted: [bug] } });
    assert.equal(findingFor(d, "2.5.8").status, "met");
    assert.equal(findingFor(d, "2.5.8").issues, undefined);
    for (const f of d.findings) if (f.issues) assert.notEqual(f.status, "met");
  });

  it("rejects malformed accepted reasons in audit input", () => {
    assert.throws(() => audit({ home: { errors: 1, ruleIds: [LABEL], accepted: [{ ...bug, kind: "later" }] } }),
      /invalid audit \(input home\): accepted\[0\]\.kind must be one of/);
    assert.throws(() => audit({ home: { errors: 1, ruleIds: [LABEL], accepted: [gap] } }), /not one of this screen's baselined rule ids/);
    assert.throws(() => audit({ home: { errors: 1, ruleIds: [LABEL], accepted: "yes" } }), /accepted must be an array/);
  });

  it("drops a reason for a reclassified rule id with the id", () => {
    const screens = {
      home: { errors: 1, ruleIds: [OLD], accepted: [{ ruleId: OLD, kind: "product-bug", summary: "Old 48dp rule" }] },
    };
    const f = findingFor(doc(screens), "2.5.8");
    assert.equal(f.status, "incomplete");
    assert.equal(f.issues, undefined);
  });

  it("grows the note cap by the reasons, so they never push out the coverage caveat", () => {
    const screens = {};
    for (let i = 0; i < 60; i++) {
      screens[`screen-${i}`] = {
        errors: 1,
        ruleIds: [SIZE],
        accepted: [{ ruleId: SIZE, kind: "product-bug", summary: `Row ${i} uses a 20dp chip that the design team will enlarge`, issue: `APP-${i}` }],
      };
    }
    const d = doc(screens);
    assert.ok(aloudMaxNoteLength(d) > ALOUD_MAX_NOTE_LENGTH);
    const row = level(acr(screens), "success_criteria_level_aa", "2.5.8");
    assert.equal(row.level, "partially-supports");
    assert.ok(row.notes.length <= aloudMaxNoteLength(d));
    assert.match(row.notes, /Row 59 uses a 20dp chip/);
    assert.match(row.notes, /part of this criterion only/);
    assert.match(row.notes, /A human review must complete the rest/);
    // A saved findings document rebuilds the same with the same cap.
    const saved = JSON.parse(JSON.stringify(d));
    assert.deepEqual(buildAcr(saved, { date: "2026-09-30", maxNoteLength: aloudMaxNoteLength(saved) }), acr(screens));
    assert.equal(aloudMaxNoteLength(doc({ home: { errors: 0, ruleIds: [] } })), ALOUD_MAX_NOTE_LENGTH);
    assert.ok(!row.notes.includes(TRUNCATION_MARKER) || row.notes.indexOf("Screens with violations") < row.notes.indexOf(TRUNCATION_MARKER));
  });
});
