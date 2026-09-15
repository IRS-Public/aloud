import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVoiceOverCapturer, normalizeVoiceOverForComparison, parseVoiceOverCapture } from "../src/ios/voiceover-capture.mjs";

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

test("real speech keeps raw values, order, repeated labels and explicit partial coverage", () => {
  const result = parseVoiceOverCapture(encode(capture()), expected);
  assert.deepEqual(result, capture());
  assert.equal(result.coverage.complete, false);
  assert.equal(result.steps[1].utterance, result.steps[2].utterance);
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
