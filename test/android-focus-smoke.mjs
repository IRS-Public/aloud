// Native acceptance suite; run with a companion APK, fixture APK, and a working TTS engine installed.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { ADB, adb, shell } from "../src/android/adb.mjs";
import { enable, disable, findTalkBack } from "../src/android/talkback.mjs";
import { saveAccessibilityState, restoreAccessibilityState } from "../src/android/accessibility-state.mjs";
import { createFocusCapturer, focusTranscript } from "../src/android/talkback-focus.mjs";

const out = resolve(process.env.ALOUD_SMOKE_OUT ?? "aloud-report/focus-smoke");
const target = "org.irs_public.aloud.fixture";
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const originalFile = join(out, "original-state.json");
const original = saveAccessibilityState(originalFile, findTalkBack());
const results = {};
async function launch(mode) {
  shell("am", "force-stop", target);
  shell("am", "start", "-n", `${target}/.MainActivity`, "--es", "mode", mode);
  await sleep(3500);
}
function settings() {
  return Object.fromEntries(Object.keys(original.settings).map((k) => [k, shell("settings", "get", "secure", k)]));
}
try {
  enable();
  for (const mode of (process.env.ALOUD_SMOKE_ONLY_FAILURES ? [] : ["nested", "scroll", "dialog"])) {
    await launch(mode);
    const capture = await createFocusCapturer({ out, target, maxSteps: 80 })(mode);
    assert.equal(capture.coverage.complete, true);
    const first = capture.commands.findIndex((c) => c.action === "first");
    const focuses = capture.commands.slice(first).filter((c) => c.status === "focused").map((c) => c.after);
    if (mode === "nested") {
      const duplicates = focuses.filter((f) => f.text.toLowerCase() === "same label");
      assert.equal(duplicates.length, 2);
      assert.notEqual(duplicates[0].id, duplicates[1].id);
      assert.ok(focuses.some((f) => f.enabled === false && /unavailable/i.test(f.text)));
      assert.match(focusTranscript(capture).join("\n"), /disabled/i);
    } else if (mode === "scroll") {
      const rows = focuses.map((f) => f.text.match(/^ROW (\d+)$/)?.[1]).filter(Boolean).map(Number);
      assert.deepEqual(rows, Array.from({ length: 30 }, (_, i) => i + 1));
      assert.ok(capture.commands.some((c) => c.signals.includes("scroll-complete")));
    } else {
      assert.match(focusTranscript(capture).join("\n"), /Dialog value 12.50/);
      assert.doesNotMatch(focusTranscript(capture).join("\n"), /SAME LABEL/);
    }
    results[mode] = { commands: capture.commands.length, focuses: focuses.length, utterances: focusTranscript(capture).length };
    console.log(`${mode}: native boundaries verified, ${focuses.length} focuses`);
  }
  await launch("nested");
  await assert.rejects(createFocusCapturer({ out, target, maxSteps: 1 })("truncated"), /incomplete.*step-limit/);
  assert.equal(JSON.parse(readFileSync(join(out, "talkback-focus/truncated.json"))).coverage.complete, false);
  results.truncated = "rejected";

  await launch("nested");
  let changed = false;
  await assert.rejects(createFocusCapturer({ out, target, runAdb: (args, opts) => {
    if (!changed && args.includes("next")) {
      changed = true;
      shell("am", "start", "-a", "android.settings.SETTINGS");
    }
    return adb(args, opts);
  } })("app-change"), /incomplete.*(target-changed|window-changed)/);
  results.appChange = "rejected";

  await launch("nested");
  let restarted = false;
  await assert.rejects(createFocusCapturer({ out, target, runAdb: (args, opts) => {
    const output = adb(args, opts);
    if (!restarted && args.includes("first")) {
      restarted = true;
      shell("am", "force-stop", target);
      shell("am", "start", "-n", `${target}/.MainActivity`);
    }
    return output;
  } })("process-change"), /incomplete.*target-process-changed/);
  results.processChange = "rejected";

  await launch("nested");
  let serviceRestarted = false;
  await assert.rejects(createFocusCapturer({ out, target, runAdb: (args, opts) => {
    const output = adb(args, opts);
    if (!serviceRestarted && args.includes("first")) {
      serviceRestarted = true;
      enable();
    }
    return output;
  } })("service-restart"), /incomplete.*(companion|session)/);
  results.serviceRestart = "rejected";

  await launch("permission");
  const denied = adb(["logcat", "-d", "-s", "ALOUD_PERMISSION:I", "*:S"]);
  writeFileSync(join(out, "permission.log"), denied);
  assert.match(denied, /result=-17,data=receiver-not-invoked/);
  results.untrustedApp = "denied";

  // Invalid subsequent commands must not act on another controller's capture.
  const rejected = shell("am", "broadcast", "-a", "org.irs_public.aloud.TALKBACK_COMMAND", "-p", "com.android.talkback",
    "--es", "op", "next", "--es", "requestId", "stale-controller", "--es", "screen", "fixture",
    "--es", "target", target, "--ei", "sequence", "999", "--es", "session", "wrong-session");
  writeFileSync(join(out, "stale-command.txt"), rejected);
  assert.match(rejected, /result=409/);
  results.staleCommand = "rejected";

  // Exercise the real shell runner's EXIT trap with TalkBack originally enabled and disabled.
  for (const enabled of [true, false]) {
    if (enabled) enable(); else disable();
    const before = settings();
    const prefs = shell("cat", "/data/user_de/0/com.android.talkback/shared_prefs/com.android.talkback_preferences.xml");
    await launch("nested");
    const config = join(out, `runner-${enabled}.json`);
    const root = join(out, `runner-${enabled}`);
    writeFileSync(config, JSON.stringify({ out: root, app: { android: { package: target } },
      android: { talkBack: "focus", talkBackMaxSteps: 1 }, nav: { mode: "current-screen", screenId: "limited" } }));
    try {
      execFileSync("bash", ["src/android/run.sh", "--pass", "transcript", "--no-gate"], {
        env: { ...process.env, ALOUD_CONFIG: config }, timeout: 60000, stdio: "pipe",
      });
      assert.fail("truncated runner unexpectedly passed");
    } catch (error) {
      writeFileSync(join(out, `runner-${enabled}.log`), String(error.stdout ?? "") + String(error.stderr ?? ""));
      assert.match(String(error.stderr), /incomplete TalkBack traversal/);
    }
    assert.deepEqual(settings(), before);
    assert.equal(shell("cat", "/data/user_de/0/com.android.talkback/shared_prefs/com.android.talkback_preferences.xml"), prefs);
    assert.equal(existsSync(join(root, "android/accessibility-state.json")), false);
    results[`restoreAfterFailureOriginally${enabled ? "On" : "Off"}`] = "verified";
  }
  await launch("nested");
  const successBefore = settings();
  const successConfig = join(out, "runner-success.json");
  writeFileSync(successConfig, JSON.stringify({ out: join(out, "runner-success"), app: { android: { package: target } },
    android: { talkBack: "focus", talkBackMaxSteps: 40 }, nav: { mode: "current-screen", screenId: "nested" } }));
  const successLog = execFileSync("bash", ["src/android/run.sh", "--no-gate"], {
    env: { ...process.env, ALOUD_CONFIG: successConfig }, timeout: 90000, stdio: "pipe",
  });
  writeFileSync(join(out, "runner-success.log"), successLog);
  assert.deepEqual(settings(), successBefore);
  assert.ok(String(successLog).indexOf("tree pass") < String(successLog).indexOf("transcript pass"));
  const successSummary = JSON.parse(readFileSync(join(out, "runner-success/android/summary.json")));
  assert.equal(successSummary.screens.nested.talkBackFocus.coverage.complete, true);
  assert.equal(existsSync(join(out, "runner-success/android/shots/nested.png")), true);
  results.restoreAfterSuccess = "verified";
  // Send TERM to the runner and its device-command child once the native session is active.
  await launch("scroll");
  const signalBefore = settings();
  const signalRoot = join(out, "runner-signal");
  const signalConfig = join(out, "runner-signal.json");
  writeFileSync(signalConfig, JSON.stringify({ out: signalRoot, app: { android: { package: target } },
    android: { talkBack: "focus", talkBackMaxSteps: 80 }, nav: { mode: "current-screen", screenId: "signal" } }));
  const child = spawn("bash", ["src/android/run.sh", "--pass", "transcript", "--no-gate"], {
    env: { ...process.env, ALOUD_CONFIG: signalConfig }, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let signalLog = "";
  child.stdout.on("data", (b) => { signalLog += b; });
  child.stderr.on("data", (b) => { signalLog += b; });
  const closed = new Promise((r, reject) => { child.on("error", reject); child.on("close", (code, signal) => r({ code, signal })); });
  let signaled = false;
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(signalRoot, "android/talkback-focus/signal.commands.jsonl"))) {
      process.kill(-child.pid, "SIGTERM"); signaled = true; break;
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  if (!signaled && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  const signalResult = await closed;
  writeFileSync(join(out, "runner-signal.log"), signalLog);
  assert.equal(signaled, true, "runner never reached capture before signal test");
  assert.equal(signalResult.code, 143, signalLog);
  assert.deepEqual(settings(), signalBefore);
  results.restoreAfterSignal = "verified";

  // An unrelated app notification must not become part of a passing screen transcript.
  enable();
  await launch("nested");
  let notification;
  await assert.rejects(createFocusCapturer({ out, target, runAdb: (args, opts) => {
    if (!notification && args.includes("next")) {
      const post = spawn(ADB, ["shell", "sh", "-c",
        "'sleep 0.3; cmd notification post -t AloudInterrupt aloud-interrupt External-interruption'"], { stdio: "ignore" });
      notification = new Promise((resolve) => {
        post.on("error", () => resolve(-1)); post.on("close", resolve);
      });
    }
    return adb(args, opts);
  } })("external-notification"), /incomplete.*external-notification/);
  assert.equal(await notification, 0, "notification injection failed");
  results.externalNotification = "rejected";

} finally {
  restoreAccessibilityState(originalFile);
  assert.deepEqual(settings(), original.settings);
  results.originalSettingsRestored = true;
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results));
