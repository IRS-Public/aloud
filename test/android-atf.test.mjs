import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { load } from "js-yaml";
import { execFileSync } from "node:child_process";
import { ATF_CHECKS, atfFindings, atfSummary, atfTreeNodes, sha256, validateAtfEvidence, validateAtfSummary } from "../src/android/atf-evidence.mjs";
import { runChecks } from "../src/android/ui-tree.mjs";
import { createAtfCapturer } from "../src/android/atf-capture.mjs";
import { loadConfig } from "../src/config.mjs";
import { buildAcr, CATALOG_ID, normalizeAudit } from "../src/report/openacr.mjs";
const require = createRequire(import.meta.url);
const catalog = load(readFileSync(join(dirname(require.resolve("@openacr/openacr/package.json")), "catalog", `${CATALOG_ID}.yaml`), "utf8"));

function fixture(mode = "bad") {
  const dir = new URL(`./fixtures/atf-android14/${mode}/`, import.meta.url);
  const e = JSON.parse(readFileSync(new URL("evidence.json", dir)));
  e.capture.raw = readFileSync(new URL("capture.json", dir), "utf8");
  e.verification.raw = readFileSync(new URL("verify.json", dir), "utf8");
  return e;
}
function edit(e, fn, phases = ["capture", "verification"]) {
  for (const phase of phases) {
    const record = e[phase], value = JSON.parse(record.raw); fn(value);
    record.raw = JSON.stringify(value) + "\n";
    record.receipt.bytes = Buffer.byteLength(record.raw); record.receipt.sha256 = sha256(record.raw);
  }
  return e;
}
function tree(e) {
  const n = validateAtfEvidence(e), violations = runChecks(atfTreeNodes(n), { densityDpi: n.densityDpi, appPackage: n.target });
  const errors = violations.filter((v) => v.severity === "error");
  return { screen: e.screen, treeSource: "accessibility-node-info", androidAtf: e, violations,
    gate: { errors: errors.length, ruleIds: [...new Set(errors.map((v) => v.ruleId))].sort() } };
}
test("authentic ATF fixtures trigger each selected check and correct every finding", () => {
  const bad = validateAtfEvidence(fixture()), good = validateAtfEvidence(fixture("good"));
  for (const [i, c] of bad.checks.entries()) {
    assert.equal(c.ruleId, ATF_CHECKS[i].ruleId);
    assert.ok(c.results.some((r) => ["ERROR", "WARNING"].includes(r.type)), c.ruleId);
    assert.ok(good.checks[i].results.every((r) => r.type === "NOT_RUN"), c.ruleId);
  }
  assert.ok(atfSummary(fixture()).checks.some((c) => c.results.NOT_RUN > 0));
  assert.ok(atfSummary(fixture()).unselected.every((c) => c.status === "not-selected"));
});
test("native rich fields and duplicate element identities remain distinct", () => {
  const s = validateAtfEvidence(fixture());
  for (const [key, value] of [["hintText", "Email address"], ["stateDescription", "Queued"], ["paneTitle", "Account options"], ["roleDescription", "status control"]]) {
    assert.ok(s.nodes.some((n) => n[key] === value)); assert.ok(s.nodes.some((n) => n[key] === null));
  }
  const duplicate = s.nodes.filter((n) => n.text === "TRANSFER");
  assert.equal(duplicate.length, 2); assert.notEqual(duplicate[0].id, duplicate[1].id);
  const t = tree(fixture()), findings = atfFindings(s, t.violations);
  for (const id of ["atf-speakable-text-present", "atf-touch-target-size", "atf-duplicate-speakable-text"]) {
    assert.ok(findings.find((f) => f.ruleId === id).potentialDuplicates.length, id);
  }
  const nativeEdit = s.nodes.find((n) => n.editable); nativeEdit.text = ""; nativeEdit.description = null;
  assert.ok(!runChecks(atfTreeNodes(s), { densityDpi: s.densityDpi, appPackage: s.target }).some((v) => v.nativeId === nativeEdit.id && v.ruleId.endsWith("unlabeled")));
});

for (const [name, mutate] of [
  ["failed capture", (e) => edit(e, (v) => { v.status = "failed"; v.error = "screen changed"; })],
  ["missing check", (e) => edit(e, (v) => v.checks.pop())],
  ["failed check", (e) => edit(e, (v) => { v.checks[0].status = "failed"; })],
  ["framework version", (e) => edit(e, (v) => { v.framework.version = "latest"; })],
  ["result without element", (e) => edit(e, (v) => { v.checks[0].results[0].elementId = "999"; })],
  ["invented result type", (e) => edit(e, (v) => { v.checks[0].results[0].type = "PASS"; })],
  ["invented unsupported property", (e) => edit(e, (v) => { v.runtime.sdk = 26; v.propertySupport.stateDescription = false; v.propertySupport.paneTitle = false; })],
  ["disconnected graph", (e) => edit(e, (v) => { v.nodes[0].children = []; v.nodes[0].childCount = 0; })],
  ["wrong node target", (e) => edit(e, (v) => { v.nodes[3].packageName = "other.app"; })],
  ["changed screen", (e) => edit(e, (v) => { v.nodes[3].text = "Changed"; }, ["verification"])],
  ["changed process", (e) => { e.targetPidAfter = "9999"; }],
  ["changed companion", (e) => edit(e, (v) => { v.pid++; }, ["verification"])],
  ["raw truncation", (e) => { e.capture.raw = e.capture.raw.slice(0, -3); }],
  ["receipt mismatch", (e) => { e.capture.receipt.sha256 = "0".repeat(64); }],
  ["missing verification", (e) => { delete e.verification; }],
]) test(`ATF rejects ${name}`, () => { const e = fixture(); mutate(e); assert.throws(() => validateAtfEvidence(e)); });

test("ATF configuration is explicit and typed", () => {
  assert.equal(loadConfig().android.atf, false);
  assert.equal(loadConfig(undefined, { android: { atf: true } }).android.atf, true);
  assert.throws(() => loadConfig(undefined, { android: { atf: "true" } }), /atf must be a boolean/);
});
test("missing companion preserves failed capture and cannot create native success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aloud-atf-"));
  try {
    const capture = createAtfCapturer({ out: dir, target: "test.app", startupAttempts: 1, sleep: async () => {},
      runShell: () => "123", runAdb: () => "Broadcast completed: result=0", takeScreenshot: () => assert.fail("no screenshot expected") });
    await assert.rejects(capture("missing"), /companion unavailable/);
    assert.equal(JSON.parse(readFileSync(join(dir, "atf/missing.json"))).complete, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("persisted report revalidates native checks, overlaps, raw hashes, and expected screens", () => {
  const dir = mkdtempSync(join(tmpdir(), "aloud-atf-report-")), e = fixture(), t = tree(e);
  const report = () => execFileSync(process.execPath, ["src/report/report.mjs", "--dir", dir], { env: { ...process.env, ALOUD_CONFIG: "" }, stdio: "pipe" });
  const write = () => writeFileSync(join(dir, `${e.screen}.tree.json`), JSON.stringify(t));
  try {
    write(); writeFileSync(join(dir, "capture-requirements.json"), JSON.stringify({ schemaVersion: 1, androidAtf: true, atfScreens: [e.screen] }));
    report();
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"))).screens[e.screen];
    assert.equal(summary.androidAtf.checks.length, 6); assert.equal(summary.errors, t.gate.errors);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    assert.match(html, /Skipped results are not passes/); assert.match(html, /Potential overlap/); assert.match(html, /status control/);
    t.androidAtf.capture.raw = t.androidAtf.capture.raw.slice(0, -1); write(); assert.throws(report);
    t.androidAtf = fixture(); t.gate.errors = 0; write(); assert.throws(report);
    Object.assign(t, tree(fixture())); delete t.androidAtf; delete t.treeSource; write(); assert.throws(report);
    Object.assign(t, tree(fixture())); write();
    writeFileSync(join(dir, "capture-requirements.json"), JSON.stringify({ schemaVersion: 1, androidAtf: true, atfScreens: [e.screen, "never-captured"] }));
    assert.throws(report);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ATF summaries preserve skipped checks and cannot add OpenACR conformance coverage", () => {
  const s = atfSummary(fixture()); validateAtfSummary(s);
  const base = { catalog, appName: "Fixture", productVersion: "1", date: "2026-09-15", android: { screens: {
    native: { errors: 0, ruleIds: [], utterances: null },
  } } };
  const before = buildAcr(base);
  base.android.screens.native.androidAtf = s;
  normalizeAudit(base.android);
  const after = buildAcr(base);
  assert.deepEqual(after.chapters, before.chapters);
  assert.match(after.notes, /ATF 4.1.1/); assert.match(after.notes, /neither counts as a pass/);
  for (const mutate of [(v) => v.checks.pop(), (v) => { v.reportOnly = false; }, (v) => { v.checks[0].results.NOT_RUN = -1; }]) {
    const changed = structuredClone(s); mutate(changed); assert.throws(() => validateAtfSummary(changed));
  }
});
