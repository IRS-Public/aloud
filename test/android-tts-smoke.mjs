// Native logging-engine acceptance: companion + recording-engine + focus-fixture APKs installed.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shell } from "../src/android/adb.mjs";
import { enable, findTalkBack } from "../src/android/talkback.mjs";
import { saveAccessibilityState, restoreAccessibilityState } from "../src/android/accessibility-state.mjs";
import { createFocusCapturer, focusTranscript } from "../src/android/talkback-focus.mjs";
import { validateFocusTts } from "../src/android/tts-evidence.mjs";
const out = resolve(process.env.ALOUD_TTS_SMOKE_OUT ?? "aloud-report/tts-smoke");
mkdirSync(out, { recursive: true });
const state = join(out, "original-state.json"), target = "org.irs_public.aloud.fixture", results = {};
saveAccessibilityState(state, findTalkBack(), { tts: true });
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
} finally {
  restoreAccessibilityState(state);
  results.originalStateRestored = true;
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results));
