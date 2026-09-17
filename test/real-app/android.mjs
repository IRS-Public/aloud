// External-app CLI acceptance. Use only a disposable emulator: installs and clears the pinned Wikipedia app.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { adb, shell, uiDump } from "../../src/android/adb.mjs";
import { parseUiDump } from "../../src/android/ui-tree.mjs";
import { findTalkBack } from "../../src/android/talkback.mjs";
import { saveAccessibilityState, restoreAccessibilityState } from "../../src/android/accessibility-state.mjs";
const pin = JSON.parse(readFileSync(new URL("./wikipedia.json", import.meta.url))).android;
const out = resolve(process.env.ALOUD_REAL_APP_OUT ?? "aloud-report/real-app-android");
mkdirSync(out, { recursive: true });
assert.equal(shell("getprop", "ro.kernel.qemu"), "1", "requires a disposable emulator");
const apk = process.env.ALOUD_WIKIPEDIA_APK;
assert.ok(apk, "download the pinned APK and set ALOUD_WIKIPEDIA_APK");
assert.equal(createHash("sha256").update(readFileSync(apk)).digest("hex"), pin.sha256, "Wikipedia APK differs from the pinned build");
const keys = ["enabled_accessibility_services", "accessibility_enabled", "tts_default_synth", "tts_default_rate", "tts_default_pitch", "tts_default_locale", "tts_enabled_plugins"];
const settings = () => Object.fromEntries(keys.map((k) => [k, shell("settings", "get", "secure", k)]));
const pkg = findTalkBack(), state = join(out, "original-state.json");
assert.equal(pkg, "com.android.talkback", "install the pinned Aloud companion first");
const original = saveAccessibilityState(state, pkg, { tts: true });
const prefsPath = `/data/user_de/0/${pkg}/shared_prefs/${pkg}_preferences.xml`;
const prefs = () => { try { return shell("cat", prefsPath); } catch { return null; } };
const results = { app: pin, runtime: { fingerprint: shell("getprop", "ro.build.fingerprint"), node: process.version }, cases: {} };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function nodes() { return parseUiDump(uiDump()); } // Preparation only: never invoke UiAutomation during capture.
function tap(label) {
  const matches = nodes().filter((n) => n.text === label || n["content-desc"] === label);
  assert.ok(matches.length, `cannot find Wikipedia control: ${label}`);
  const b = matches[0].bounds;
  shell("input", "tap", String(Math.round((b.x1 + b.x2) / 2)), String(Math.round((b.y1 + b.y2) / 2)));
}
function capture(id, expected, nav = { mode: "current-screen", screenId: id }, { atf = true, expectedFailure } = {}) {
  const before = settings(), beforePrefs = prefs(), root = join(out, id), config = root + ".json";
  writeFileSync(config, JSON.stringify({ out: root, app: { name: "Wikipedia", android: { package: pin.package, activity: pin.activity } },
    android: { talkBackMaxSteps: 200 }, nav }));
  try {
    const log = execFileSync(process.execPath, ["bin/aloud.mjs", "android", "--config", config,
      ...(atf ? ["--atf"] : ["--pass", "transcript"]), "--talkback", "focus", "--tts", "logging", "--no-gate"], { encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(root + ".log", log);
    assert.ok(!expectedFailure, "a previously unsupported case now captures; review and promote its coverage");
    const screen = JSON.parse(readFileSync(join(root, "android/summary.json"))).screens[id];
    if (atf) {
      assert.equal(screen.androidAtf.status, "completed");
      assert.equal(screen.androidAtf.checks.length, 6);
    }
    assert.equal(screen.talkBackFocus.coverage.complete, true);
    assert.equal(screen.talkBackFocus.loggingTts.complete, true);
    if (atf) {
      const native = JSON.parse(readFileSync(join(root, `android/atf/${id}.capture.json`)));
      assert.ok(native.nodes.some((n) => expected.test(n.text ?? "") || expected.test(n.description ?? "")), "captured wrong screen");
    } else {
      const transcript = JSON.parse(readFileSync(join(root, `android/${id}.transcript.json`)));
      assert.ok(transcript.transcript.some((line) => expected.test(line)), "speech must contain target content");
    }
    results.cases[id] = { status: "captured", nodes: screen.androidAtf?.nodeCount, utterances: screen.utterances,
      atfChecks: screen.androidAtf?.checks, coverage: screen.talkBackFocus.coverage, loggingTts: screen.talkBackFocus.loggingTts };
    console.log(`${id}: ${screen.androidAtf?.nodeCount} nodes, ${screen.utterances} utterances`);
  } catch (error) {
    writeFileSync(root + ".log", `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.stack}`);
    results.cases[id] = { status: "failed", error: error.message };
    if (!expectedFailure) throw error;
    assert.match(String(error.stderr), expectedFailure);
    const envelope = JSON.parse(readFileSync(join(root, `android/atf/${id}.json`)));
    assert.equal(envelope.complete, false);
    assert.throws(() => execFileSync(process.execPath, ["src/report/report.mjs", "--dir", join(root, "android")], { stdio: "pipe" }));
    results.cases[id] = { status: "unsupported", reason: envelope.error, rejectionVerified: true };
    console.log(`${id}: unsupported capture rejected (${envelope.error})`);
  } finally {
    assert.deepEqual(settings(), before, "CLI changed accessibility/TTS settings");
    assert.equal(prefs(), beforePrefs, "CLI changed TalkBack preferences");
    results.cases[id].stateRestored = true;
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  }
}
try {
  adb(["install", "-r", "-g", apk]);
  shell("pm", "clear", pin.package);
  shell("am", "start", "-W", "-n", pin.package + "/" + pin.activity);
  await pause(3500);
  capture("onboarding-1", /All the world's knowledge/);
  capture("onboarding-2", /All the world's knowledge/);
  tap("Forward"); await pause(2000);
  capture("privacy", /Data & Privacy/);
  tap("Forward"); await pause(1000);
  tap("Forward"); await pause(1000);
  tap("Skip"); await pause(3000);
  for (const [id, title, expected, expectedFailure] of [
    ["short-article", "Abacheri", /Abacheri/, undefined],
    ["long-article", "Hello_world", /Hello|world/i, /node-limit/],
  ]) {
    const manifest = join(out, id + "-screens.json");
    writeFileSync(manifest, JSON.stringify([{ id: "article", screens: [{ id, url: `https://en.wikipedia.org/wiki/${title}`, settleMs: 10000 }] }]));
    capture(id, expected, { mode: "deeplinks", screens: manifest }, { expectedFailure });
  }
} finally {
  restoreAccessibilityState(state);
  assert.deepEqual(settings(), { ...original.settings, ...original.ttsSettings });
  results.originalStateRestored = true;
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
}
console.log("Wikipedia Android validation passed");
