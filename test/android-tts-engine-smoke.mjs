// Queue/pressure/process-death acceptance using Android's real TTS service and callbacks.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { adb, shell } from "../src/android/adb.mjs";
import { saveAccessibilityState, restoreAccessibilityState } from "../src/android/accessibility-state.mjs";
import { enable, disable, findTalkBack } from "../src/android/talkback.mjs";
import { collectClientTtsEvidence } from "../src/android/tts-capture.mjs";
import { accountTts, parseTtsJournal, TTS_ENGINE } from "../src/android/tts-evidence.mjs";
const out = resolve(process.env.ALOUD_TTS_ENGINE_OUT ?? "aloud-report/tts-engine-smoke");
const pkg = "org.irs_public.aloud.ttsfixture", statusPath = `/data/user_de/0/${pkg}/files/status.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });
const state = join(out, "original-state.json"), results = {};
saveAccessibilityState(state, findTalkBack(), { tts: true });
const buffer = adb(["logcat", "-b", "main", "-g"]).match(/ring buffer is (\d+)\s*(KiB|MiB|KB|MB)/);
assert.ok(buffer, "cannot determine original logcat capacity");
const originalBuffer = buffer[1] + (buffer[2].startsWith("M") ? "M" : "K");
async function status(mode, terminal = "completed") {
  for (let i = 0; i < 900; i++) {
    let value;
    try { value = JSON.parse(shell("cat", statusPath)); } catch {}
    if (value?.mode === mode) {
      if (value.stage === "error" || value.stage === "incomplete") throw new Error(JSON.stringify(value));
      if (value.stage === terminal || value.stage === "completed") return value;
    }
    await sleep(200);
  }
  throw new Error(`${mode}: fixture timed out`);
}
async function launch(mode) {
  shell("am", "force-stop", pkg);
  shell("rm", "-f", statusPath);
  shell("am", "start", "-n", pkg + "/.MainActivity", "--es", "mode", mode);
}
function collect(s) {
  const evidence = collectClientTtsEvidence(s.clientSession, pkg, out);
  writeFileSync(join(out, s.mode + ".json"), JSON.stringify(evidence));
  return evidence;
}
try {
  enable({ tts: "logging" });
  disable();
  for (const mode of ["volume", "flush", "interruption"]) {
    if (mode === "volume") {
      adb(["logcat", "-b", "main", "-G", "64K"]);
      shell("log", "-t", "ALOUD_TTS_PRESSURE", "start-marker");
    }
    await launch(mode);
    if (mode === "volume") {
      // Exceed the ring buffer while requests and callbacks are still being recorded.
      shell("sh", "-c", "'i=0; while [ $i -lt 2500 ]; do log -t ALOUD_TTS_PRESSURE repeated-output-to-exceed-the-logcat-buffer-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done'");
    }
    const s = await status(mode);
    const evidence = collect(s);
    const a = accountTts(evidence, { requestId: s.requestId, screen: mode, requireDone: mode === "volume" });
    assert.equal(a.complete, true, JSON.stringify(a.problems));
    assert.equal(a.requests.length, s.planned);
    assert.equal(new Set(a.requests.map((r) => r.dispatchId)).size, s.planned);
    assert.equal(new Set(a.requests.map((r) => r.utteranceId)).size, 1);
    if (mode === "volume") {
      const log = adb(["logcat", "-b", "main", "-d", "-s", "ALOUD_TTS_PRESSURE:I", "*:S"]);
      writeFileSync(join(out, "pressure.log"), log);
      assert.doesNotMatch(log, /start-marker/);
      assert.equal(a.requests.every((r) => r.engineReceived), true);
      adb(["logcat", "-b", "main", "-G", originalBuffer]);
    } else {
      assert.ok(a.requests.some((r) => r.terminal === "stop"));
      assert.ok(a.queueEvents.length > 0);
      if (mode === "flush") assert.ok(a.requests.some((r) => r.terminal === "stop" && !r.engineReceived));
    }
    results[mode] = { requests: a.requests.length, complete: true, received: a.requests.filter((r) => r.engineReceived).length };
    console.log(`${mode}: ${a.requests.length} requests accounted for`);
  }
  for (const mode of ["engine-death", "client-death"]) {
    await launch(mode);
    const s = await status(mode, "ready");
    shell("am", "force-stop", mode === "engine-death" ? TTS_ENGINE : pkg);
    await sleep(1000);
    const evidence = collect(s);
    // All planned requests were fsynced before the fixture announced readiness.
    const requestRows = evidence.client.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
      .filter((r) => r.kind === "request" && r.data.text);
    assert.equal(requestRows.length, s.planned);
    let incomplete = false;
    try { incomplete = !accountTts(evidence).complete; } catch { incomplete = true; }
    assert.equal(incomplete, true, "process death must not become successful accounting");
    results[mode] = { preservedRequests: requestRows.length, incomplete: true };
    // A fresh client session can recover without rewriting the interrupted evidence.
    await launch("recovery");
    const recovered = await status("recovery");
    assert.notEqual(recovered.clientSession, s.clientSession);
    const a = accountTts(collect(recovered), { requireDone: true });
    assert.equal(a.complete, true, JSON.stringify(a.problems));
    results[mode].recovery = "verified";
    console.log(`${mode}: retained ${requestRows.length} requests as incomplete; new session recovered`);
  }
} finally {
  shell("am", "force-stop", pkg);
  adb(["logcat", "-b", "main", "-G", originalBuffer]);
  restoreAccessibilityState(state);
  results.originalStateRestored = true;
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results));
