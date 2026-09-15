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
