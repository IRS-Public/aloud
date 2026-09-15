// Real Xcode 27 simulator checks; excluded from device-free *.test.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createVoiceOverCapturer } from "../src/ios/voiceover-capture.mjs";

const cases = ["repeated", "modal", "scroll", "dynamic"];
const selected = process.env.ALOUD_VO_SMOKE_CASE;
assert.ok(!selected || cases.includes(selected), "unknown native smoke fixture");
const out = resolve(process.env.ALOUD_SMOKE_OUT ?? "aloud-report/voiceover-smoke");
mkdirSync(out, { recursive: true });
const sh = (tool, args) => execFileSync(tool, args, { encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
const simctl = (...args) => sh("xcrun", ["simctl", ...args]);
const devices = JSON.parse(simctl("list", "devices", "available", "-j")).devices;
const device = Object.entries(devices).filter(([runtime]) => /iOS-27/.test(runtime))
  .flatMap(([, list]) => list).find((d) => d.name.includes("iPhone") && d.isAvailable);
assert.ok(device, "install an iOS 27 iPhone simulator runtime first");
if (device.state !== "Booted") simctl("boot", device.udid);
simctl("bootstatus", device.udid, "-b");
const bundleId = "org.aloud.voiceover.VoiceOverFixture";
const capturer = createVoiceOverCapturer({ out, udid: device.udid, bundleId, maxSteps: 12 });
const buildDir = join(out, "voiceover/build");
try {
  const log = sh("xcodebuild", [
    "build", "-project", join(out, "voiceover/harness/AloudVoiceOver.xcodeproj"),
    "-scheme", "AloudVoiceOverFixture", "-destination", `platform=iOS Simulator,id=${device.udid}`,
    "-derivedDataPath", buildDir, "CODE_SIGNING_ALLOWED=NO",
  ]);
  writeFileSync(join(out, "voiceover/fixture-build.log"), log);
} catch (err) {
  writeFileSync(join(out, "voiceover/fixture-build.log"), `${err.stdout}\n${err.stderr}`);
  throw err;
}
simctl("install", device.udid, join(buildDir, "Build/Products/Debug-iphonesimulator/VoiceOverFixture.app"));
for (const mode of selected ? [selected] : cases) {
  try { simctl("terminate", device.udid, bundleId); } catch { /* not running */ }
  simctl("launch", device.udid, bundleId);
  // Prepare a non-launch screen in a separate test. Capture must preserve
  // this state. simctl openurl can show a system confirmation dialog.
  const prepLog = execFileSync("xcodebuild", [
    "test-without-building", "-project", join(out, "voiceover/harness/AloudVoiceOver.xcodeproj"),
    "-scheme", "AloudVoiceOver", "-destination", `platform=iOS Simulator,id=${device.udid}`,
    "-derivedDataPath", buildDir, "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=NO",
    "-only-testing:AloudVoiceOverUITests/FixtureTests/testNavigateFixture",
  ], { encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TEST_RUNNER_ALOUD_VO_FIXTURE_MODE: mode } });
  writeFileSync(join(out, `voiceover/prepare-${mode}.log`), prepLog);
  const result = capturer.capture(mode);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.voiceOverRestored, true);
  assert.equal(result.voiceOverWasEnabled, mode === "repeated", "must preserve the fixture's initial VoiceOver state");
  const lines = result.steps.flatMap((step) => step.utterance === null ? [] : [step.utterance]);
  console.log(`${mode}: ${result.coverage.reason}, ${JSON.stringify(lines)}`);
  assert.ok(lines.length > 0, `${mode} must capture actual speech`);
  assert.ok(lines.every((line) => !/Aloud test host|Launch screen must/.test(line)), "must preserve target's navigated state");
  if (mode === "repeated") {
    assert.ok(lines.filter((line) => line.includes("Same label")).length >= 2, "duplicate labels must be retained");
    assert.ok(lines.some((line) => line.includes("1,234.50")), "meaningful numeric punctuation must survive capture");
  } else if (mode === "modal") {
    assert.ok(lines.some((line) => line.includes("Modal details")), "must read the presented modal");
  } else if (mode === "scroll") {
    assert.ok(lines.some((line) => line.includes("Scroll row")), "must capture scrollable content without claiming complete coverage");
  } else {
    assert.ok(lines.some((line) => line.includes("Live count")), "must retain dynamic values");
  }
}
if (!selected || selected === "repeated") {
  // The app can still report foreground while SpringBoard's Open/Cancel
  // dialog is speaking. This is the native regression for the first spike.
  simctl("openurl", device.udid, "aloud-voiceover-fixture://repeated");
  assert.throws(() => capturer.capture("system-alert"), /VoiceOver capture failed \(system-alert\)/);
  assert.match(readFileSync(join(out, "voiceover/system-alert.log"), "utf8"), /ALOUD-VOICEOVER:/);
  assert.equal(existsSync(join(out, "voiceover/system-alert.json")), false);
  simctl("terminate", device.udid, bundleId);
  assert.throws(() => capturer.capture("stopped-target"), /VoiceOver capture failed \(target-unavailable\)/);
  assert.equal(existsSync(join(out, "voiceover/stopped-target.json")), false);
  console.log("System alert and unavailable target rejected.");
}
console.log(`VoiceOver simulator smoke passed: ${selected ?? "all four fixtures"}, initial service state preserved.`);
