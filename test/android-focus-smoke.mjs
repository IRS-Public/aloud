// Native acceptance suite; run with a companion APK, fixture APK, and a working TTS engine installed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { adb, shell } from "../src/android/adb.mjs";
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
  for (const mode of ["nested", "scroll", "dialog"]) {
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

  await launch("permission");
  const denied = adb(["logcat", "-d", "-s", "ALOUD_PERMISSION:I", "*:S"]);
  writeFileSync(join(out, "permission.log"), denied);
  assert.match(denied, /result=-17,data=receiver-not-invoked/);
  results.untrustedApp = "denied";

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
    assert.throws(() => execFileSync("bash", ["src/android/run.sh", "--pass", "transcript", "--no-gate"], {
      env: { ...process.env, ALOUD_CONFIG: config }, timeout: 60000, stdio: "pipe",
    }));
    assert.deepEqual(settings(), before);
    assert.equal(shell("cat", "/data/user_de/0/com.android.talkback/shared_prefs/com.android.talkback_preferences.xml"), prefs);
    assert.equal(existsSync(join(root, "android/accessibility-state.json")), false);
    results[`restoreAfterFailureOriginally${enabled ? "On" : "Off"}`] = "verified";
  }
} finally {
  restoreAccessibilityState(originalFile);
  assert.deepEqual(settings(), original.settings);
  results.originalSettingsRestored = true;
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results));
