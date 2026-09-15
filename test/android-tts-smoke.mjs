// Native logging-engine acceptance: companion + recording-engine + focus-fixture APKs installed.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { shell } from "../src/android/adb.mjs";
import { enable, disable, findTalkBack } from "../src/android/talkback.mjs";
import { saveAccessibilityState, restoreAccessibilityState, TTS_KEYS, stopTalkBack } from "../src/android/accessibility-state.mjs";
import { createFocusCapturer, focusTranscript } from "../src/android/talkback-focus.mjs";
import { validateFocusTts } from "../src/android/tts-evidence.mjs";
const out = resolve(process.env.ALOUD_TTS_SMOKE_OUT ?? "aloud-report/tts-smoke");
mkdirSync(out, { recursive: true });
const state = join(out, "original-state.json"), target = "org.irs_public.aloud.fixture", results = {};
const original = saveAccessibilityState(state, findTalkBack(), { tts: true });
const keys = [...TTS_KEYS, "accessibility_enabled", "enabled_accessibility_services"];
const settings = () => Object.fromEntries(keys.map((k) => [k, shell("settings", "get", "secure", k)]));
try {
  enable({ tts: "logging" });
  for (const mode of (process.env.ALOUD_TTS_SMOKE_MODES ?? "nested,scroll,dialog").split(",")) {
    shell("am", "force-stop", target);
    shell("am", "start", "-n", target + "/.MainActivity", "--es", "mode", mode);
    await new Promise((r) => setTimeout(r, 3500));
    const capture = await createFocusCapturer({ out, target, loggingTts: true })(mode);
    const accounting = validateFocusTts(capture);
    assert.equal(accounting.complete, true);
    assert.equal(accounting.requests.every((r) => r.engineReceived && r.terminal === "done"), true);
    const transcript = focusTranscript(capture);
    if (mode === "nested") {
      assert.equal(transcript.filter((t) => /SAME LABEL/.test(t)).length, 2);
      assert.match(transcript.join("\n"), /disabled/i);
    } else if (mode === "scroll") assert.equal(transcript.filter((t) => /^ROW \d+,/.test(t)).length, 30);
    else assert.match(transcript.join("\n"), /Dialog value 12.50/);
    results[mode] = { complete: true, requests: accounting.requests.length, utterances: transcript.length };
    console.log(`${mode}: every captured request has a completed engine receipt`);
  }
  if (!process.env.ALOUD_TTS_SMOKE_MODES) {
    disable(); stopTalkBack(findTalkBack());
    const priorEngine = original.ttsSettings.tts_default_synth;
    if (priorEngine === "null") shell("settings", "delete", "secure", "tts_default_synth");
    else shell("settings", "put", "secure", "tts_default_synth", priorEngine);
    shell("settings", "put", "secure", "tts_default_rate", "137");
    shell("settings", "put", "secure", "tts_default_pitch", "93");
    for (const fail of [false, true]) {
      shell("am", "force-stop", target);
      shell("am", "start", "-n", target + "/.MainActivity", "--es", "mode", "nested");
      const before = settings();
      const prefsPath = "/data/user_de/0/com.android.talkback/shared_prefs/com.android.talkback_preferences.xml";
      const prefs = shell("cat", prefsPath);
      const root = join(out, fail ? "runner-failure" : "runner-success");
      const config = root + ".json";
      writeFileSync(config, JSON.stringify({ out: root, app: { android: { package: target } },
        android: { talkBack: "focus", tts: "logging", talkBackMaxSteps: fail ? 1 : 80 },
        nav: { mode: "current-screen", screenId: "nested" } }));
      let error, log;
      try { log = execFileSync("bash", ["src/android/run.sh", "--no-gate"], {
        env: { ...process.env, ALOUD_CONFIG: config }, timeout: 120000, stdio: "pipe" }); }
      catch (e) { error = e; log = String(e.stdout ?? "") + String(e.stderr ?? ""); }
      writeFileSync(root + ".log", log);
      if (fail) assert.match(String(error?.stderr), /incomplete TalkBack traversal/);
      else {
        assert.ifError(error);
        const summary = JSON.parse(readFileSync(join(root, "android/summary.json")));
        assert.equal(summary.screens.nested.talkBackFocus.loggingTts.complete, true);
        assert.match(readFileSync(join(root, "android/index.html"), "utf8"), /No spoken audio was generated/);
      }
      assert.deepEqual(settings(), before);
      assert.equal(shell("cat", prefsPath), prefs);
      results[fail ? "restoreAfterFailure" : "restoreAfterSuccess"] = "verified";
    }
    const before = settings(), root = join(out, "runner-signal"), config = root + ".json";
    writeFileSync(config, JSON.stringify({ out: root, app: { android: { package: target } },
      android: { talkBack: "focus", tts: "logging" }, nav: { mode: "current-screen", screenId: "signal" } }));
    shell("am", "force-stop", target);
    shell("am", "start", "-n", target + "/.MainActivity", "--es", "mode", "scroll");
    const child = spawn("bash", ["src/android/run.sh", "--pass", "transcript", "--no-gate"], {
      env: { ...process.env, ALOUD_CONFIG: config }, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "", signaled = false;
    child.stdout.on("data", (b) => { log += b; }); child.stderr.on("data", (b) => { log += b; });
    const ended = new Promise((r, reject) => { child.on("error", reject); child.on("close", r); });
    const commands = join(root, "android/talkback-focus/signal.commands.jsonl");
    for (let i = 0; i < 400; i++) {
      if (existsSync(commands) && readFileSync(commands, "utf8").trim()) {
        process.kill(-child.pid, "SIGTERM"); signaled = true; break;
      }
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!signaled && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
    const code = await ended;
    writeFileSync(root + ".log", log);
    assert.equal(signaled, true, log);
    assert.equal(code, 143, log);
    assert.deepEqual(settings(), before);
    const firstCommand = JSON.parse(readFileSync(commands, "utf8").split("\n")[0]);
    assert.ok(existsSync(join(root, "android/tts-logging", firstCommand.tts.clientSession, "client.jsonl")));
    results.restoreAfterSignal = "verified";
  }
} finally {
  restoreAccessibilityState(state);
  results.originalStateRestored = true;
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results));
