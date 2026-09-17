import assert from "node:assert/strict";
import { test } from "node:test";
import { accountTts, parseTtsJournal, TTS_ENGINE } from "../src/android/tts-evidence.mjs";
const cs = "11111111-1111-4111-8111-111111111111", es = "22222222-2222-4222-8222-222222222222";
const scope = { requestId: "request", screen: "screen", sequence: 1, serviceSession: "talkback" };
const stringify = (rows) => rows.map(JSON.stringify).join("\n") + "\n";
function journal(producer, session, rows) {
  return [{ kind: "header", data: { producer, pid: 100, uid: producer === "client" ? 10123 : 10124,
    packageName: producer === "client" ? "com.android.talkback" : TTS_ENGINE, output: "synthetic-silence" } }, ...rows]
    .map((r, i) => ({ schemaVersion: 1, session, event: i + 1, uptimeMs: i + 1, ...r }));
}
function fixture({ terminal = "done", received = true } = {}) {
  const id = cs + ":1", metadata = { dispatchId: id, clientSession: cs, originalUtteranceId: "same-native-id", scope };
  const client = journal("client", cs, [
    { kind: "request", data: { dispatchId: id, operation: "speak", text: 'same text: "🙂"\nagain', queueMode: 1, wireId: id, metadata } },
    { kind: "return", data: { dispatchId: id, result: 0 } },
    ...(terminal === "done" ? [{ kind: "start", data: { dispatchId: id, interrupted: false } }] : []),
    ...(terminal ? [{ kind: terminal, data: { dispatchId: id, interrupted: terminal === "stop" } }] : []),
  ]);
  const engines = received ? [journal("engine", es, [
    { kind: "received", data: { dispatchId: id, metadata, text: client[1].data.text, callerUid: 10123 } },
    { kind: "synthesis-start", data: { dispatchId: id, result: 0 } },
    { kind: "synthesis-complete", data: { dispatchId: id, result: 0, bytes: 3840, output: "synthetic-silence" } },
  ])] : [];
  return { client, engines };
}
const pack = ({ client, engines }) => ({ schemaVersion: 1, client: stringify(client), engines: engines.map(stringify) });

test("pairs exact Unicode text and distinguishes silent synthesis from playback completion", () => {
  const result = accountTts(pack(fixture()), { requireDone: true });
  assert.equal(result.complete, true);
  assert.equal(result.output, "synthetic-silence");
  assert.equal(result.requests[0].terminal, "done");
  assert.equal(result.requests[0].engineReceived, true);
});
test("accounts for a queued request stopped before the engine received it", () => {
  const evidence = pack(fixture({ terminal: "stop", received: false }));
  const result = accountTts(evidence);
  assert.equal(result.complete, true);
  assert.equal(result.requests[0].engineReceived, false);
  assert.equal(result.requests[0].terminal, "stop");
  assert.equal(accountTts(evidence, { requireDone: true }).complete, false);
});
test("retains unresolved requests after process death", () => {
  const result = accountTts(pack(fixture({ terminal: null })));
  assert.equal(result.complete, false);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].terminal, "unresolved");
});
for (const [name, mutate] of Object.entries({
  "changed engine text": (f) => { f.engines[0][1].data.text = "different"; },
  "wrong caller UID": (f) => { f.engines[0][1].data.callerUid++; },
  "event gap": (f) => { f.client[2].event++; },
  "dispatch gap": (f) => { f.client[1].data.dispatchId = cs + ":3"; },
  "wrong screen identity": (f) => { f.engines[0][1].data.metadata = { ...f.engines[0][1].data.metadata, scope: { ...scope, screen: "wrong" } }; },
  "different engine": (f) => { f.engines[0][0].data.packageName = "other.engine"; },
  "duplicate engine journal": (f) => { f.engines.push(f.engines[0]); },
})) test(`rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => accountTts(pack(f))); });
for (const [name, mutate] of Object.entries({
  "missing engine receipt": (f) => { f.engines = []; },
  "missing callback": (f) => { f.client.pop(); },
  "missing synthesis completion": (f) => { f.engines[0].pop(); },
  "failed synthesis": (f) => { f.engines[0].at(-1).data.result = -1; },
})) test(`never marks ${name} complete`, () => { const f = fixture(); mutate(f); assert.equal(accountTts(pack(f)).complete, false); });
test("rejects journal truncation even when the last JSON object is valid", () => {
  assert.throws(() => parseTtsJournal(pack(fixture()).client.trimEnd(), "client"), /truncated journal/);
});

test("revalidates authentic native focus, repeated labels, hints, and independent receipts", async () => {
  const { readFileSync } = await import("node:fs");
  const { validateTalkBackFocusCapture, focusTranscript } = await import("../src/android/talkback-focus.mjs");
  const root = new URL("./fixtures/logging-tts-android14/", import.meta.url);
  const capture = JSON.parse(readFileSync(new URL("capture.json", root)));
  capture.loggingTts = { schemaVersion: 1, client: readFileSync(new URL("client.jsonl", root), "utf8"),
    engines: [readFileSync(new URL("engine.jsonl", root), "utf8")] };
  validateTalkBackFocusCapture(capture);
  assert.equal(focusTranscript(capture).filter((t) => /SAME LABEL/.test(t)).length, 2);
  for (const mutate of [
    (c) => { c.commands[4].tts.firstEvent = c.commands[3].tts.firstEvent; },
    (c) => { c.commands[4].tts.clientSession = es; },
    (c) => { c.loggingTts.engines = []; },
    (c) => { c.loggingTts.client = c.loggingTts.client.replace('"packageName":"com.android.talkback"', '"packageName":"another.client"'); },
    (c) => { c.commands[3].speech[0].text = "changed"; },
  ]) {
    const changed = structuredClone(capture); mutate(changed);
    assert.throws(() => validateTalkBackFocusCapture(changed));
  }
});

test("requires explicit focus configuration for the logging engine", async () => {
  const { loadConfig } = await import("../src/config.mjs");
  assert.equal(loadConfig(null).android.tts, "system");
  assert.throws(() => loadConfig(null, { android: { tts: "logging" } }), /requires.*focus/);
  assert.throws(() => loadConfig(null, { android: { tts: "unknown" } }), /tts must be/);
  assert.equal(loadConfig(null, { android: { tts: "logging", talkBack: "focus" } }).android.tts, "logging");
});

test("restores present and absent TTS settings before accessibility is re-enabled", async (t) => {
  const { saveAccessibilityState, restoreAccessibilityState, TTS_KEYS } = await import("../src/android/accessibility-state.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "tts-restore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json"), calls = [];
  const values = { ...Object.fromEntries(TTS_KEYS.map((k) => [k, "null"])), tts_default_synth: "prior.engine",
    tts_default_rate: "137", accessibility_enabled: "1", enabled_accessibility_services: "another/Service" };
  const original = { ...values };
  const runShell = (...a) => {
    calls.push(a);
    if (a[0] === "settings") {
      if (a[1] === "get") return values[a[3]];
      if (a[1] === "delete") values[a[3]] = "null";
      if (a[1] === "put") values[a[3]] = a[4].slice(1, -1);
    }
    return "";
  };
  saveAccessibilityState(file, null, { tts: true, preferences: false, runShell });
  for (const k of Object.keys(values)) values[k] = "changed";
  restoreAccessibilityState(file, { runShell });
  assert.deepEqual(values, original);
  const engine = calls.findIndex((a) => a[1] === "put" && a[3] === "tts_default_synth");
  const enabled = calls.findIndex((a) => a[1] === "put" && a[3] === "enabled_accessibility_services");
  assert.ok(engine >= 0 && enabled > engine);
});

for (const mutation of ["none", "missing-engine", "truncated-log", "changed-transcript", "downgraded-source"]) {
  test(`persisted logging report: ${mutation}`, async (t) => {
    const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { focusTranscript } = await import("../src/android/talkback-focus.mjs");
    const root = new URL("./fixtures/logging-tts-android14/", import.meta.url);
    const c = JSON.parse(readFileSync(new URL("capture.json", root)));
    c.loggingTts = { schemaVersion: 1, client: readFileSync(new URL("client.jsonl", root), "utf8"),
      engines: [readFileSync(new URL("engine.jsonl", root), "utf8")] };
    const transcript = focusTranscript(c);
    if (mutation === "missing-engine") c.loggingTts.engines = [];
    if (mutation === "truncated-log") c.loggingTts.client = c.loggingTts.client.trimEnd();
    if (mutation === "changed-transcript") transcript.pop();
    if (mutation === "downgraded-source") { c.speechSource = "talkback-tts-request-listener"; delete c.loggingTts; }
    const out = mkdtempSync(join(tmpdir(), "tts-report-"));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    writeFileSync(join(out, "nested.transcript.json"), JSON.stringify({ screen: c.screen, source: "talkback-focus", transcript, talkBackFocus: c }));
    writeFileSync(join(out, "capture-requirements.json"), JSON.stringify({ schemaVersion: 1, talkBackFocus: true, loggingTts: true }));
    const result = spawnSync(process.execPath, ["src/report/report.mjs", "--dir", out], {
      env: { ...process.env, ALOUD_CONFIG: "" }, encoding: "utf8",
    });
    assert.equal(result.status === 0, mutation === "none", result.stderr);
    if (mutation === "none") {
      const summary = JSON.parse(readFileSync(join(out, "summary.json")));
      assert.equal(summary.screens.nested.talkBackFocus.loggingTts.requests, 9);
      assert.match(readFileSync(join(out, "index.html"), "utf8"), /No spoken audio was generated/);
    }
  });
}

// Diagnosis mode overrides pref_log_overlay=false in the pinned TalkBack build.
// Native capture must turn diagnosis mode itself off to preserve screenshots.
test("native capture preferences disable diagnostic overlays while startup retains diagnosis logging", async () => {
  const { prefsXml } = await import("../src/android/talkback.mjs");
  assert.match(prefsXml({ diagnosis: false }), /name="pref_diagnosis_mode" value="false"/);
  assert.match(prefsXml({ diagnosis: false }), /name="pref_log_overlay" value="false"/);
  assert.match(prefsXml(), /name="pref_diagnosis_mode" value="true"/);
});
