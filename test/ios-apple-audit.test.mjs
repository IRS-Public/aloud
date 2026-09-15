import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAppleAuditor, parseAppleAudit } from "../src/ios/apple-audit.mjs";
import { loadConfig } from "../src/config.mjs";
import { renderReportHtml } from "../src/report/html.mjs";

const expected = { requestId: "request-123", screen: "checkout", bundleId: "example.app" };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const issue = () => ({
  typeMask: "1", types: ["contrast"], compactDescription: "Low contrast",
  detailedDescription: "Review the foreground and background colors.", element: {
    label: "Continue", identifier: "continue", frame: { x: 0, y: 0, width: 100, height: 44 },
  },
});
const record = (extra = {}) => ({
  schemaVersion: 1, source: "apple-accessibility-audit", status: "completed",
  auditTypes: "all", ...expected, issues: [issue()], ...extra,
});
const encode = (result, requestId = expected.requestId) =>
  `2026-09-15 XCTest: ALOUD-APPLE-AUDIT:${requestId}:${Buffer.from(JSON.stringify(result)).toString("base64")}\n`;

test("accepts real Apple simulator findings captured in the smoke workflow", () => {
  const real = JSON.parse(readFileSync(join(ROOT, "test/fixtures/apple-audit-ios.json")));
  const parsed = parseAppleAudit(encode(real, real.requestId), real);
  assert.equal(parsed.issues.length, 2);
  assert.deepEqual(parsed.issues.map((issue) => issue.types), [["dynamicType"], ["contrast"]]);
});

test("Apple audit accepts completed checks with findings, zero findings, and unavailable elements", () => {
  for (const issues of [[issue()], [], [{ ...issue(), element: null }]]) {
    const result = record({ issues });
    assert.deepEqual(parseAppleAudit(`unrelated output\n${encode(result)}more output`, expected), result);
  }
});

test("Apple audit rejects missing, duplicate, stale, skipped, partial and mismatched results", () => {
  const good = encode(record());
  for (const log of ["", good + good, encode(record(), "old-request"),
    encode(record({ requestId: "other" })), encode(record({ screen: "another-screen" })),
    encode(record({ bundleId: "org.aloud.audit.AuditHost" })),
    encode(record({ status: "skipped" })), encode(record({ auditTypes: "contrast" })),
    encode(record({ schemaVersion: 2 })), encode(record({ source: "computed-voiceover" })),
    `ALOUD-APPLE-AUDIT:${expected.requestId}:garbage!`,
  ]) assert.throws(() => parseAppleAudit(log, expected));
});

test("Apple audit rejects corrupt issue payloads instead of treating them as zero findings", () => {
  for (const issues of [null, {}, [null], [{}], [{ ...issue(), types: [] }],
    [{ ...issue(), typeMask: "NaN" }], [{ ...issue(), compactDescription: "" }],
    [{ ...issue(), element: {} }], [{ ...issue(), element: { ...issue().element, frame: { x: 0, y: 0, width: -1, height: 20 } } }],
  ]) assert.throws(() => parseAppleAudit(encode(record({ issues })), expected));
});

function rig(t, { fail, malformed = false } = {}) {
  const out = mkdtempSync(join(tmpdir(), "aloud-apple-test-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const calls = [];
  const run = (tool, args, options) => {
    calls.push({ tool, args, options });
    if (fail === tool || fail === args[0]) {
      const error = new Error("mock infrastructure failure");
      error.stdout = "partial output";
      error.stderr = "test process died";
      throw error;
    }
    if (args[0] !== "test-without-building") return "build ok";
    const env = options.env;
    return encode(record({
      requestId: env.TEST_RUNNER_ALOUD_AUDIT_REQUEST_ID,
      screen: malformed ? "stale-screen" : env.TEST_RUNNER_ALOUD_AUDIT_SCREEN,
      bundleId: env.TEST_RUNNER_ALOUD_AUDIT_BUNDLE_ID,
    }), env.TEST_RUNNER_ALOUD_AUDIT_REQUEST_ID);
  };
  return { out, calls, create: () => createAppleAuditor({ out, udid: "device-1", bundleId: expected.bundleId, run }) };
}

test("builds once, captures every screen with independent identities, retains raw evidence", (t) => {
  const r = rig(t);
  const auditor = r.create();
  assert.equal(auditor.capture("checkout").issues.length, 1);
  assert.equal(auditor.capture("settings").screen, "settings");
  assert.equal(r.calls.filter((c) => c.args[0] === "build-for-testing").length, 1);
  const captures = r.calls.filter((c) => c.args[0] === "test-without-building");
  assert.equal(captures.length, 2);
  assert.notEqual(captures[0].options.env.TEST_RUNNER_ALOUD_AUDIT_REQUEST_ID, captures[1].options.env.TEST_RUNNER_ALOUD_AUDIT_REQUEST_ID);
  assert.ok(captures.every((c) => c.args.includes("platform=iOS Simulator,id=device-1")));
  assert.ok(captures.every((c) => c.args.includes("-resultBundlePath")));
  assert.equal(JSON.parse(readFileSync(join(r.out, "apple-audit/checkout.json"))).bundleId, expected.bundleId);
  assert.throws(() => auditor.capture("../escaped"), /screen/i);
  assert.equal(r.calls.length, 4, "invalid screen IDs must not execute a process");
});

test("build, tool, test and evidence failures stop capture and preserve diagnostics", (t) => {
  for (const fail of ["xcodegen", "build-for-testing", "test-without-building"]) {
    const r = rig(t, { fail });
    assert.throws(() => r.create().capture("checkout"), /Apple audit.*failed/);
    assert.equal(existsSync(join(r.out, "apple-audit/checkout.json")), false);
    const logName = fail === "xcodegen" ? "generate" : fail === "build-for-testing" ? "build" : "checkout";
    assert.match(readFileSync(join(r.out, `apple-audit/${logName}.log`), "utf8"), /test process died/);
  }
  const r = rig(t, { malformed: true });
  assert.throws(() => r.create().capture("checkout"), /does not match/);
  assert.equal(existsSync(join(r.out, "apple-audit/checkout.json")), false);
});

test("native audit is opt-in and rejects malformed configuration", () => {
  assert.equal(loadConfig().ios.appleAudit, false);
  assert.equal(loadConfig(undefined, { ios: { appleAudit: true } }).ios.appleAudit, true);
  for (const value of ["true", 1, null, []]) {
    assert.throws(() => loadConfig(undefined, { ios: { appleAudit: value } }), /ios.appleAudit/);
  }
});

test("native report labels findings for review, escapes content, and keeps computed speech explicit", () => {
  const native = record();
  native.issues[0].compactDescription = '<script>alert("unsafe")</script>';
  const screen = {
    source: "computed-voiceover", transcript: ["Continue, button"],
    gate: { errors: 0, ruleIds: [] }, violations: [], appleAudit: native,
  };
  const html = renderReportHtml({ screens: { checkout: screen }, ids: ["checkout"], generated: "today", shots: new Set() });
  assert.match(html, /Apple accessibility audit \(1\)/);
  assert.match(html, /Review · 1 Apple finding/);
  assert.match(html, /Tree pass/);
  assert.match(html, /do not affect the tree-check gate or OpenACR/);
  assert.match(html, /computed, not recorded/);
  assert.match(html, /apple-audit\/checkout.json/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("the public CLI forwards --apple-audit through the resolved config to the iOS leg", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aloud-apple-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bash"), `#!/usr/bin/env node
const fs = require("node:fs");
console.log(fs.readFileSync(process.env.ALOUD_CONFIG, "utf8"));
`, { mode: 0o755 });
  const cfg = join(dir, "aloud.config.json");
  writeFileSync(cfg, JSON.stringify({ app: { ios: { bundleId: expected.bundleId } } }));
  const result = spawnSync(process.execPath, [join(ROOT, "bin/aloud.mjs"), "ios", "--config", cfg,
    "--out", join(dir, "out"), "--apple-audit", "--no-gate"], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ios.appleAudit, true);
});

test("report aggregation preserves native review counts without treating them as tree-gate errors", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aloud-apple-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gate = { errors: 0, ruleIds: [] };
  writeFileSync(join(dir, "checkout.tree.json"), JSON.stringify({ screen: "checkout", gate, violations: [], appleAudit: record() }));
  writeFileSync(join(dir, "checkout.transcript.json"), JSON.stringify({
    screen: "checkout", source: "computed-voiceover", transcript: ["Continue, button"],
  }));
  const baseline = join(dir, "baseline.json");
  writeFileSync(baseline, JSON.stringify({ checkout: gate }));
  const result = spawnSync(process.execPath, [join(ROOT, "src/report/report.mjs"),
    "--dir", dir, "--baseline", baseline, "--gate"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(readFileSync(join(dir, "summary.json")));
  assert.deepEqual(summary.screens.checkout.appleAudit, { status: "completed", issues: 1, reportOnly: true });
  assert.equal(summary.screens.checkout.errors, 0);
  assert.match(readFileSync(join(dir, "index.html"), "utf8"), /Review · 1 Apple finding/);
});
