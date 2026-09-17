// Native acceptance: pinned companion and controlled fixture APK installed on Android 14 userdebug.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { adb, shell } from "../src/android/adb.mjs";
import { enable, disable, findTalkBack } from "../src/android/talkback.mjs";
import { saveAccessibilityState, restoreAccessibilityState, stopTalkBack } from "../src/android/accessibility-state.mjs";
import { ATF_ACTION, createAtfCapturer } from "../src/android/atf-capture.mjs";
import { atfFindings, atfSummary, atfTreeNodes, validateAtfEvidence } from "../src/android/atf-evidence.mjs";
import { runChecks } from "../src/android/ui-tree.mjs";
const out = resolve(process.env.ALOUD_ATF_SMOKE_OUT ?? "aloud-report/atf-smoke");
mkdirSync(out, { recursive: true });
const state = join(out, "original-state.json"), target = "org.irs_public.aloud.fixture", results = {};
const original = saveAccessibilityState(state, findTalkBack(), { tts: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = ["enabled_accessibility_services", "accessibility_enabled", "tts_default_synth", "tts_default_rate", "tts_default_pitch", "tts_default_locale", "tts_enabled_plugins"];
const settings = () => Object.fromEntries(keys.map((k) => [k, shell("settings", "get", "secure", k)]));
const prefsPath = "/data/user_de/0/com.android.talkback/shared_prefs/com.android.talkback_preferences.xml";
async function launch(mode) {
  shell("am", "force-stop", target); shell("am", "start", "-n", target + "/.MainActivity", "--es", "mode", mode);
  await pause(3500);
}
const capture = (extra = {}) => createAtfCapturer({ out, target, ...extra });
try {
  enable({ diagnosis: false });
  for (const mode of ["bad", "good", "empty"]) {
    await launch("atf-" + mode);
    const e = await capture()(mode), n = validateAtfEvidence(e), summary = atfSummary(e);
    for (const c of n.checks) {
      const findings = c.results.filter((r) => ["ERROR", "WARNING"].includes(r.type));
      if (mode === "bad") assert.ok(findings.length > 0, c.ruleId);
      else assert.equal(findings.length, 0, c.ruleId);
    }
    if (mode !== "empty") {
      for (const [key, value] of [["hintText", "Email address"], ["stateDescription", "Queued"], ["paneTitle", "Account options"], ["roleDescription", "status control"]]) {
        assert.ok(n.nodes.some((node) => node[key] === value), key);
        assert.ok(n.nodes.some((node) => node[key] === null), `unset ${key}`);
      }
    } else {
      const touch = summary.checks.find((c) => c.ruleId === "atf-touch-target-size");
      assert.equal(touch.results.NOT_RUN, n.nodes.length);
    }
    if (mode === "bad") {
      const tree = runChecks(atfTreeNodes(n), { appPackage: target, densityDpi: n.densityDpi });
      for (const rule of ["atf-speakable-text-present", "atf-touch-target-size", "atf-duplicate-speakable-text"]) {
        assert.ok(atfFindings(n, tree).find((f) => f.ruleId === rule).potentialDuplicates.length, rule);
      }
      const receipt = e.capture.receipt;
      const stale = shell("am", "broadcast", "-a", ATF_ACTION, "-p", "com.android.talkback", "--es", "requestId", e.requestId,
        "--es", "screen", e.screen, "--es", "target", target, "--es", "phase", "capture");
      assert.match(stale, /result=409/); assert.ok(receipt.sha256);
      results.staleRequest = "rejected";
    }
    results[mode] = { checks: summary.checks, nodes: n.nodes.length };
    console.log(`${mode}: six native checks verified (${n.nodes.length} nodes)`);
  }
  await launch("atf-dynamic");
  await assert.rejects(capture()("dynamic"), /ATF capture failed/); results.dynamicScreen = "rejected";
  await launch("atf-good");
  await assert.rejects(capture({ takeScreenshot: () => shell("am", "start", "-W", "-a", "android.settings.SETTINGS") })("target-change"), /ATF capture failed/);
  results.targetChange = "rejected";
  await launch("atf-good");
  await assert.rejects(capture({ takeScreenshot: () => {
    shell("am", "force-stop", target); shell("am", "start", "-n", target + "/.MainActivity");
  } })("process-change"), /target process changed/);
  results.processChange = "rejected";
  await launch("atf-good");
  await assert.rejects(capture({ takeScreenshot: () => stopTalkBack(findTalkBack()) })("service-stopped"), /companion unavailable/);
  results.serviceStopped = "rejected";
  enable({ diagnosis: false }); await launch("permission");
  const permission = adb(["logcat", "-d", "-s", "ALOUD_ATF_PERMISSION:I", "*:S"]);
  writeFileSync(join(out, "permission.log"), permission);
  assert.match(permission, /result=-17,data=receiver-not-invoked/); results.untrustedApp = "denied";
  await launch("atf-good");
  const remoteDir = "/data/user_de/0/com.android.talkback/files/aloud-atf";
  shell("chmod", "500", remoteDir);
  try { await assert.rejects(capture()("write-failure"), /ATF capture failed/); results.writeFailure = "rejected"; }
  finally { shell("chmod", "700", remoteDir); }
  console.log("Stale requests, screen/process changes, service loss, app permission, and write failure rejected");

  disable(); stopTalkBack(findTalkBack());
  for (const failure of [false, true]) {
    await launch(failure ? "atf-dynamic" : "atf-good");
    const before = settings(), prefs = shell("cat", prefsPath);
    const root = join(out, failure ? "runner-failure" : "runner-success"), config = root + ".json";
    writeFileSync(config, JSON.stringify({ out: root, app: { android: { package: target } }, nav: { mode: "current-screen", screenId: "native" } }));
    let error, log;
    try { log = execFileSync(process.execPath, ["bin/aloud.mjs", "android", "--config", config, "--atf", "--pass", "tree", "--no-gate"],
      { stdio: "pipe", timeout: 90000 }); }
    catch (e) { error = e; log = String(e.stdout ?? "") + String(e.stderr ?? ""); }
    writeFileSync(root + ".log", log);
    if (failure) {
      assert.match(String(error?.stderr), /ATF capture failed/);
      assert.throws(() => execFileSync(process.execPath, ["src/report/report.mjs", "--dir", join(root, "android")],
        { env: { ...process.env, ALOUD_CONFIG: "" }, stdio: "pipe" }));
    } else {
      assert.ifError(error);
      const summary = JSON.parse(readFileSync(join(root, "android/summary.json")));
      assert.equal(summary.screens.native.androidAtf.checks.length, 6);
      assert.match(readFileSync(join(root, "android/index.html"), "utf8"), /Skipped results are not passes/);
    }
    assert.deepEqual(settings(), before); assert.equal(shell("cat", prefsPath), prefs);
    results[failure ? "restoreAfterFailure" : "restoreAfterSuccess"] = "verified";
  }
  // Exercise the pass ordering and shared requirements with all three companion modes enabled.
  await launch("nested");
  {
    const before = settings(), prefs = shell("cat", prefsPath), root = join(out, "runner-combined"), config = root + ".json";
    writeFileSync(config, JSON.stringify({ out: root, app: { android: { package: target } },
      nav: { mode: "current-screen", screenId: "combined" } }));
    let log;
    try {
      log = execFileSync(process.execPath, ["bin/aloud.mjs", "android", "--config", config, "--atf", "--talkback", "focus", "--tts", "logging", "--no-gate"],
        { stdio: "pipe", timeout: 150000 });
    } catch (e) { writeFileSync(root + ".log", String(e.stdout ?? "") + String(e.stderr ?? "")); throw e; }
    writeFileSync(root + ".log", log);
    const summary = JSON.parse(readFileSync(join(root, "android/summary.json"))).screens.combined;
    assert.equal(summary.androidAtf.checks.length, 6);
    assert.equal(summary.talkBackFocus.loggingTts.complete, true);
    assert.deepEqual(settings(), before); assert.equal(shell("cat", prefsPath), prefs);
    results.combinedAtfFocusLoggingTts = "verified";
    console.log("Combined ATF, focus traversal, and logging TTS passed with exact state restoration");
  }
  await launch("atf-good");
  const before = settings(), prefs = shell("cat", prefsPath), root = join(out, "runner-signal"), config = root + ".json";
  writeFileSync(config, JSON.stringify({ out: root, app: { android: { package: target } }, android: { atf: true },
    nav: { mode: "current-screen", screenId: "signal" } }));
  const child = spawn("bash", ["src/android/run.sh", "--pass", "tree", "--no-gate"], {
    env: { ...process.env, ALOUD_CONFIG: config }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "", signaled = false;
  child.stdout.on("data", (b) => { log += b; }); child.stderr.on("data", (b) => { log += b; });
  const ended = new Promise((r, reject) => { child.on("error", reject); child.on("close", r); });
  for (let i = 0; i < 400; i++) {
    if (log.includes("TalkBack enabled")) { process.kill(-child.pid, "SIGTERM"); signaled = true; break; }
    if (child.exitCode !== null) break;
    await pause(50);
  }
  if (!signaled && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  const code = await ended; writeFileSync(root + ".log", log);
  assert.ok(signaled); assert.equal(code, 143); assert.deepEqual(settings(), before); assert.equal(shell("cat", prefsPath), prefs);
  results.restoreAfterSignal = "verified";
  console.log("Full runner success, failure, and SIGTERM restored exact settings and preferences");
} finally {
  restoreAccessibilityState(state);
  assert.deepEqual(settings(), { ...original.settings, ...original.ttsSettings });
  results.originalStateRestored = true;
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
}
console.log("ATF native acceptance passed");
