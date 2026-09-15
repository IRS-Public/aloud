import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createVoiceOverCapturer, normalizeVoiceOverForComparison, parseVoiceOverCapture } from "../src/ios/voiceover-capture.mjs";
import { loadConfig } from "../src/config.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const expected = { requestId: "request-1", screen: "checkout", bundleId: "org.example.app", maxSteps: 2 };
const capture = (overrides = {}) => ({
  schemaVersion: 1, source: "voiceover", status: "captured", ...expected,
  runtime: "Version 27.0 (Build 24A1)", voiceOverWasEnabled: false, voiceOverRestored: true,
  coverage: { complete: false, start: "current-focus", reason: "step-limit", maxSteps: 2, elapsedMs: 1500 },
  steps: ["Balance $1,234.50; 2.5%", "Same label Button", "Same label Button"]
    .map((utterance, sequence) => ({ sequence, action: sequence ? "forward" : "current", utterance })),
  ...overrides,
});
const encode = (result, requestId = expected.requestId) =>
  `ALOUD-VOICEOVER:${requestId}:${Buffer.from(JSON.stringify(result)).toString("base64")}\n`;

test("real iOS 27 captures retain announcements, missing initial speech, repeats and scroll order", () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, "test/fixtures/voiceover-ios27.json")));
  for (const result of Object.values(fixture.captures)) {
    assert.deepEqual(parseVoiceOverCapture(encode(result, result.requestId), {
      requestId: result.requestId, screen: result.screen, bundleId: result.bundleId, maxSteps: result.coverage.maxSteps,
    }), result);
  }
  const speech = (mode) => fixture.captures[mode].steps.map((step) => step.utterance);
  assert.equal(speech("modal")[0], "VoiceOver on");
  assert.ok(speech("modal").includes("Dismiss modal Button"));
  assert.ok(!speech("modal").includes("Modal details Heading"), "do not fill missing speech with computed content");
  assert.ok(speech("modal").filter((s) => s === "Modal value 12.50").length > 1);
  assert.deepEqual(speech("scroll").slice(1), Array.from({ length: 12 }, (_, i) => `Scroll row ${i + 1} Button`));
  assert.ok(speech("dynamic").some((s) => /^Live count \d+$/.test(s)));
  assert.ok(speech("repeated").filter((s) => s.includes("Same label")).length >= 2);
  assert.equal(fixture.captures.repeated.voiceOverWasEnabled, true);
  assert.equal(fixture.captures.repeated.voiceOverRestored, true);
  for (const failure of Object.values(fixture.failures)) {
    assert.throws(() => parseVoiceOverCapture(encode(failure, failure.requestId), failure),
      new RegExp(`capture failed \\(${failure.error.code}\\)`));
  }
});

test("real speech keeps raw values, order, repeated labels and explicit partial coverage", () => {
  const progress = `ALOUD-VOICEOVER-STEP:${expected.requestId}:e30=\n`;
  const result = parseVoiceOverCapture(progress + encode(capture()), expected);
  assert.deepEqual(result, capture());
  assert.equal(result.coverage.complete, false);
  assert.equal(result.steps[1].utterance, result.steps[2].utterance);
  assert.throws(() => parseVoiceOverCapture(progress, expected), /exactly one capture record/);
});

test("speech timeout records preserve prior speech and never imply traversal completion", () => {
  for (const sequence of [0, 1, 2]) {
    const result = capture();
    result.coverage.reason = "speech-timeout";
    result.steps = result.steps.slice(0, sequence);
    result.steps.push({ sequence, action: sequence ? "forward" : "current", utterance: null,
      error: { domain: "XCUIVoiceOverServiceErrorDomain", code: 3, description: "No speech available" } });
    assert.deepEqual(parseVoiceOverCapture(encode(result), expected), result);
  }
});

test("initial reads can be retried without moving focus and missing initial speech stays explicit", () => {
  const error = { domain: "XCUIVoiceOverServiceErrorDomain", code: 3, description: "No speech available" };
  for (const reads of [0, 1, 2]) {
    const result = capture();
    result.steps[0].readErrors = Array(reads).fill(error);
    assert.deepEqual(parseVoiceOverCapture(encode(result), expected), result);
  }
  const result = capture();
  result.steps[0] = { sequence: 0, action: "current", utterance: null, error, readErrors: Array(3).fill(error) };
  assert.deepEqual(parseVoiceOverCapture(encode(result), expected), result);
  assert.equal(result.coverage.complete, false);
  for (const readErrors of [[], [error], Array(4).fill(error), [null, null, null]]) {
    const invalid = structuredClone(result);
    invalid.steps[0].readErrors = readErrors;
    assert.throws(() => parseVoiceOverCapture(encode(invalid), expected));
  }
  result.steps[1].readErrors = [error];
  assert.throws(() => parseVoiceOverCapture(encode(result), expected), /retry evidence/);
});

test("a time budget can stop between steps without pretending the step budget was exhausted", () => {
  const result = capture();
  result.coverage.reason = "time-limit";
  result.coverage.elapsedMs = 120_100;
  result.steps = result.steps.slice(0, 1);
  assert.deepEqual(parseVoiceOverCapture(encode(result), expected), result);
});

test("missing, stale, duplicate, malformed, host-app and unsupported records fail closed", () => {
  const good = encode(capture());
  for (const log of ["", good + good, encode(capture(), "stale-request"),
    encode(capture({ requestId: "stale-request" })), encode(capture({ screen: "home" })),
    encode(capture({ bundleId: "org.aloud.voiceover.HostApp" })),
    encode(capture({ schemaVersion: 2 })), encode(capture({ source: "computed-voiceover" })),
    encode(capture({ status: "skipped" })), encode(capture({ voiceOverRestored: false })),
    encode(capture({ runtime: "" })), encode(capture({ steps: null })),
    `ALOUD-VOICEOVER:${expected.requestId}:not-json!`,
  ]) assert.throws(() => parseVoiceOverCapture(log, expected));
});

test("successful XCTest execution with a native rejection is still a capture failure", () => {
  const failure = { schemaVersion: 1, source: "voiceover", status: "failed", ...expected,
    error: { code: "target-unavailable", message: "Target app must already be running" } };
  assert.throws(() => parseVoiceOverCapture(encode(failure), expected), /capture failed \(target-unavailable\)/);
  assert.throws(() => parseVoiceOverCapture(encode({ ...failure, screen: "wrong" }), expected), /does not match/);
  assert.throws(() => parseVoiceOverCapture(encode({ ...failure, error: null }), expected), /invalid.*failure/);
});

test("contradictory stopping reasons, gaps, errors and fabricated completion are rejected", () => {
  const mutations = [
    (r) => { r.coverage.complete = true; },
    (r) => { r.coverage.start = "first-element"; },
    (r) => { r.coverage.reason = "end-of-screen"; },
    (r) => { r.coverage.maxSteps = 3; },
    (r) => { r.coverage.elapsedMs = -1; },
    (r) => { r.steps.pop(); },
    (r) => { r.steps[1].sequence = 2; },
    (r) => { r.steps[0].action = "forward"; },
    (r) => { r.steps[1].utterance = null; },
    (r) => { r.steps[1].utterance = 42; },
    (r) => { r.steps[1].error = {}; },
    (r) => { r.coverage.reason = "speech-timeout"; },
    (r) => { r.coverage.reason = "time-limit"; },
  ];
  for (const mutate of mutations) {
    const result = capture();
    mutate(result);
    assert.throws(() => parseVoiceOverCapture(encode(result), expected));
  }
});

test("comparison normalization is explicit, conservative and does not mutate raw speech", () => {
  const raw = ["Cafe\u0301 Heading", "$1,234.50; 2.5%", "Same label", "Same label", "a\n b"];
  assert.deepEqual(normalizeVoiceOverForComparison(raw), raw);
  const normalized = normalizeVoiceOverForComparison(raw, "unicode-nfc-v1");
  assert.equal(normalized[0], "Café Heading");
  assert.deepEqual(normalized.slice(1), raw.slice(1));
  assert.equal(raw[0], "Cafe\u0301 Heading");
  assert.notDeepEqual(normalizeVoiceOverForComparison(["Order status Heading"]), ["Order status, heading"]);
  assert.throws(() => normalizeVoiceOverForComparison(raw, "strip-punctuation"));
});

function rig(t, { fail, xcode = "Xcode 27.0\nBuild version 18A1", corrupt = false } = {}) {
  const out = mkdtempSync(join(tmpdir(), "aloud-voiceover-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const calls = [];
  const run = (tool, args, options) => {
    calls.push({ tool, args, options });
    if (fail === tool || fail === args[0]) {
      throw Object.assign(new Error("mock failure"), { stdout: "partial output", stderr: "capture failed" });
    }
    if (args[0] === "-version") return xcode;
    if (args[0] !== "test-without-building") return "ok";
    const env = options.env;
    return encode(capture({
      requestId: env.TEST_RUNNER_ALOUD_VO_REQUEST_ID,
      screen: corrupt ? "wrong-screen" : env.TEST_RUNNER_ALOUD_VO_SCREEN,
      bundleId: env.TEST_RUNNER_ALOUD_VO_BUNDLE_ID,
    }), env.TEST_RUNNER_ALOUD_VO_REQUEST_ID);
  };
  return { out, calls, create: () => createVoiceOverCapturer({ out, udid: "device-1", bundleId: expected.bundleId, maxSteps: 2, run }) };
}

test("builds once, captures screens with unique identities and retains raw/toolchain evidence", (t) => {
  const r = rig(t);
  const capturer = r.create();
  const first = capturer.capture("checkout");
  const second = capturer.capture("settings");
  assert.notEqual(first.requestId, second.requestId);
  assert.match(first.toolchain.xcode, /Xcode 27/);
  assert.equal(first.toolchain.simulatorUdid, "device-1");
  assert.equal(r.calls.filter((c) => c.args[0] === "build-for-testing").length, 1);
  for (const call of r.calls.filter((c) => c.args[0] === "test-without-building")) {
    assert.ok(call.args.includes("platform=iOS Simulator,id=device-1"));
    assert.ok(call.args.includes("-resultBundlePath"));
    assert.equal(call.options.env.TEST_RUNNER_ALOUD_VO_MAX_STEPS, "2");
  }
  assert.deepEqual(JSON.parse(readFileSync(join(r.out, "voiceover/checkout.json"))), first);
  const before = r.calls.length;
  assert.throws(() => capturer.capture("../escaped"), /screen/i);
  assert.equal(r.calls.length, before);
});

test("unsupported Xcode, native failures and invalid records never substitute computed output", (t) => {
  for (const fail of ["-version", "xcodegen", "build-for-testing", "test-without-building"]) {
    const r = rig(t, { fail });
    assert.throws(() => r.create().capture("checkout"), /VoiceOver .* failed/);
    assert.equal(existsSync(join(r.out, "voiceover/checkout.json")), false);
  }
  for (const xcode of ["", "Xcode 26.6", "malformed"]) {
    const r = rig(t, { xcode });
    assert.throws(() => r.create(), /needs Xcode 27/);
    assert.equal(r.calls.length, 1);
  }
  const r = rig(t, { corrupt: true });
  assert.throws(() => r.create().capture("checkout"), /does not match/);
  assert.equal(existsSync(join(r.out, "voiceover/checkout.json")), false);
});

test("real speech is opt-in; invalid modes and unbounded step budgets are rejected", () => {
  assert.equal(loadConfig().ios.voiceOver, "computed");
  assert.equal(loadConfig().ios.voiceOverMaxSteps, 20);
  assert.equal(loadConfig(undefined, { ios: { voiceOver: "real", voiceOverMaxSteps: 100 } }).ios.voiceOver, "real");
  for (const voiceOver of [true, null, "native", ""]) {
    assert.throws(() => loadConfig(undefined, { ios: { voiceOver } }), /ios.voiceOver/);
  }
  for (const voiceOverMaxSteps of [0, 101, -1, 2.5, "20", null, Infinity]) {
    assert.throws(() => loadConfig(undefined, { ios: { voiceOverMaxSteps } }), /voiceOverMaxSteps/);
  }
});

test("CLI forwards real speech settings and allows overriding real back to computed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aloud-voiceover-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bash"), '#!/usr/bin/env node\nconsole.log(require("fs").readFileSync(process.env.ALOUD_CONFIG, "utf8"));\n', { mode: 0o755 });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ app: { ios: { bundleId: expected.bundleId } }, ios: { voiceOver: "real" } }));
  const cli = (args) => spawnSync(process.execPath, [join(ROOT, "bin/aloud.mjs"), "ios", "--config", config,
    "--out", join(dir, "out"), ...args], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` },
  });
  const real = cli(["--voiceover", "real", "--voiceover-max-steps", "5", "--no-gate"]);
  assert.equal(real.status, 0, real.stderr);
  assert.equal(JSON.parse(real.stdout).ios.voiceOver, "real");
  assert.equal(JSON.parse(real.stdout).ios.voiceOverMaxSteps, 5);
  assert.equal(JSON.parse(cli(["--voiceover", "computed"]).stdout).ios.voiceOver, "computed");
  assert.notEqual(cli(["--voiceover-max-steps", "NaN"]).status, 0);
});

function report(t, { gate = false, mutate = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aloud-voiceover-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const treeGate = { errors: 0, ruleIds: [] };
  const voiceOver = { ...capture(), toolchain: { xcode: "Xcode 27.0", simulatorUdid: "device-1" } };
  voiceOver.steps[0].utterance = '<script>"$1,234.50"</script>';
  const transcript = { screen: "checkout", source: "voiceover", voiceOver,
    transcript: voiceOver.steps.map((step) => step.utterance) };
  mutate(transcript);
  writeFileSync(join(dir, "checkout.tree.json"), JSON.stringify({ screen: "checkout", gate: treeGate, violations: [] }));
  writeFileSync(join(dir, "checkout.transcript.json"), JSON.stringify(transcript));
  const baseline = join(dir, "baseline.json");
  writeFileSync(baseline, JSON.stringify({ checkout: treeGate }));
  const result = spawnSync(process.execPath, [join(ROOT, "src/report/report.mjs"), "--dir", dir,
    "--baseline", baseline, ...(gate ? ["--gate"] : [])], { encoding: "utf8", env: { ...process.env, ALOUD_CONFIG: "" } });
  return { ...result, dir };
}

test("partial real speech produces honest summary/HTML but fails a requested gate", (t) => {
  for (const gate of [false, true]) {
    const result = report(t, { gate });
    assert.equal(result.status, gate ? 1 : 0, result.stderr);
    const summary = JSON.parse(readFileSync(join(result.dir, "summary.json")));
    assert.equal(summary.screens.checkout.transcriptSource, "voiceover");
    assert.equal(summary.screens.checkout.voiceOver.coverage.complete, false);
    const html = readFileSync(join(result.dir, "index.html"), "utf8");
    assert.match(html, /VoiceOver said/);
    assert.match(html, /Review · partial VoiceOver/);
    assert.match(html, /Partial traversal/);
    assert.match(html, /Tree pass/);
    assert.match(html, /voiceover\/checkout.json/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /TalkBack said|Computed VoiceOver|<script>"/);
    if (gate) assert.match(result.stderr, /VoiceOver traversal is partial/);
  }
});

test("report refuses raw/transcript disagreement, missing provenance and invented complete coverage", (t) => {
  for (const mutate of [
    (r) => { r.transcript.pop(); },
    (r) => { delete r.voiceOver; },
    (r) => { delete r.voiceOver.toolchain; },
    (r) => { r.voiceOver.screen = "other"; },
    (r) => { r.voiceOver.coverage.complete = true; },
    (r) => { r.source = "computed-voiceover"; },
  ]) {
    const result = report(t, { mutate });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(result.dir, "summary.json")), false);
  }
});
