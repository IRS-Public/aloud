import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInteractionCapturer, validateInteractionScenario, validateInteractionResponse,
  evaluateInteractionExpectations, validateInteractionTts } from "../src/android/talkback-interaction.mjs";
import { validateFocusResponse } from "../src/android/talkback-focus.mjs";
import { TALKBACK_COMMIT } from "../src/android/talkback-companion/patch.mjs";
import { accountTts } from "../src/android/tts-evidence.mjs";

const target = "org.irs_public.aloud.fixture";
const node = (checked = false, id = "node-0") => ({ id, packageName: target, windowId: 3,
  className: "android.widget.RadioButton", text: "$1,257.93", description: "1257 dollars and 93 cents",
  enabled: true, checkable: true, checked, selected: false, clickable: true, focusable: true,
  accessibilityFocused: true, childCount: 0, stateDescriptionSupported: true, stateDescription: "" });
const response = (action = "activate", sequence = 1) => ({ schemaVersion: 1, source: "talkback-focus",
  interactionVersion: 1, talkbackCommit: TALKBACK_COMMIT, requestId: "request-1", screen: "radio", target,
  session: "service-1", pid: 45, runtime: "14", windowId: 3, sequence, action, elapsedMs: 1000,
  status: action === "hello" ? "ready" : action === "activate" ? "observed" : "focused",
  actionDispatched: action !== "hello", before: node(), after: node(action === "activate"),
  focusEvents: ["hello", "activate"].includes(action) ? [] : [node()],
  signals: [], speech: action === "first" ? [{ utteranceId: "u1", text: "1257 dollars and 93 cents, not checked" }] : [],
  stateEvents: [] });
const expected = (r) => ({ ...r, expectedNodeId: r.before.id });

test("silent activation is an observation, not a speech or selected-state verdict", () => {
  const r = response();
  validateInteractionResponse(r, expected(r));
  assert.deepEqual(evaluateInteractionExpectations(r, { checked: true }), { passed: true, failures: [] });
  assert.equal(evaluateInteractionExpectations(r, { speechIncludes: ["checked"] }).passed, false);
  r.after.checked = false;
  assert.equal(evaluateInteractionExpectations(r, { checked: true }).passed, false);
  assert.throws(() => validateFocusResponse(r, expected(r)), /invalid/);
});

test("silent focus is preserved only by the interaction validator", () => {
  const r = response("next");
  validateInteractionResponse(r, expected(r));
  assert.throws(() => validateFocusResponse(r, expected(r)), /focus and speech/);
});

for (const [name, mutate] of Object.entries({
  "old companion": (r) => delete r.interactionVersion,
  "missing checked": (r) => delete r.after.checked,
  "wrong checked type": (r) => { r.after.checked = "true"; },
  "stale intended node": (r) => { r.before.id = "another"; },
  "moved focus": (r) => { r.after.id = "another"; },
  "lost accessibility focus": (r) => { r.after.accessibilityFocused = false; },
  "wrong target": (r) => { r.after.packageName = "another.app"; },
  "service restarted": (r) => { r.pid++; },
  "changed session": (r) => { r.session = "restarted"; },
  "sequence gap": (r) => { r.sequence++; },
  "wrong window": (r) => { r.windowId++; },
  "guessed navigation success": (r) => { r.status = "edge"; r.signals = ["edge"]; r.after.checked = false; },
  "missing dispatch": (r) => delete r.actionDispatched,
  "unsupported stateDescription invented": (r) => { r.after.stateDescriptionSupported = false; },
  "too many state events": (r) => { r.stateEvents = new Array(201).fill(null); },
})) test(`rejects ${name}`, () => {
  const r = response(), e = expected(r);
  // Expected identity must not share mutable nested data with the response.
  e.expectedNodeId = "node-0";
  mutate(r); assert.throws(() => validateInteractionResponse(r, e));
});

test("content changes on a sibling retain their source and do not prove activation", () => {
  const r = response(); r.after.checked = false;
  r.stateEvents.push({ type: "TYPE_WINDOW_CONTENT_CHANGED", eventTime: 100, observedAt: 101,
    windowId: 3, packageName: target, contentChangeTypes: 1, source: node(false, "sibling") });
  validateInteractionResponse(r, expected(r));
  assert.equal(evaluateInteractionExpectations(r, { checked: true }).passed, false);
  assert.equal(r.stateEvents[0].source.id, "sibling");
});

test("speech assertions are case insensitive and confined to actual utterances in this step", () => {
  const r = response("first");
  assert.equal(evaluateInteractionExpectations(r, { speechIncludes: ["1257 DOLLARS AND 93 CENTS"] }).passed, true);
  assert.equal(evaluateInteractionExpectations(r, { speechIncludes: ["1257 dollars and 53 cents"] }).passed, false);
  r.speech = [{ text: "1257 dollars" }, { text: "and 93 cents" }];
  assert.equal(evaluateInteractionExpectations(r, { speechIncludes: ["1257 dollars and 93 cents"] }).passed, false);
});

test("state speech exclusions distinguish checked/selected from their negative phrases", () => {
  const r = response();
  const e = { speechIncludes: ["CHECKED"], speechExcludes: ["Not checked", "Unchecked"] };
  r.speech = [{ text: "not checked" }];
  assert.equal(evaluateInteractionExpectations(r, e).passed, false);
  r.speech = [{ text: "checked" }];
  assert.equal(evaluateInteractionExpectations(r, e).passed, true);
  r.speech = [{ text: "unselected" }];
  assert.equal(evaluateInteractionExpectations(r, { speechIncludes: ["selected"], speechExcludes: ["unselected", "not selected"] }).passed, false);
});

for (const scenario of [
  { id: "radio", steps: [] }, { id: "../radio", steps: [{ action: "next" }] },
  { id: "radio", steps: [{ action: "click" }] }, { id: "radio", steps: [{ action: "activate", retry: true }] },
  { id: "radio", steps: [{ action: "next", expect: { checked: "true" } }] },
  { id: "radio", steps: [{ action: "next", expect: { speechIncludes: [""] } }] },
  { id: "radio", steps: [{ action: "next", expect: { speechExcludes: [3] } }] },
  { id: "radio", steps: new Array(101).fill({ action: "next" }) },
]) test(`rejects malformed scenario ${JSON.stringify(scenario).slice(0, 110)}`, () => {
  assert.throws(() => validateInteractionScenario(scenario));
});

function harness(t, { mode = "normal", speech = true } = {}) {
  const out = mkdtempSync(join(tmpdir(), "aloud-interaction-")); t.after(() => rmSync(out, { recursive: true, force: true }));
  const calls = []; let checked = false, helloCount = 0;
  const capture = createInteractionCapturer({ out, target, startupAttempts: 3, sleep: async () => {},
    provenance: { commit: "controller-repo", workingTreeDirty: true },
    runShell: () => mode === "restart" && calls.length >= 2 ? "21" : "20",
    runAdb(args) {
      if (args[0] === "logcat") return "raw logcat";
      const value = (name) => args[args.indexOf(name) + 1];
      const action = value("op"); calls.push(action);
      if (action === "hello" && mode === "cold" && ++helloCount === 1) return "Broadcast completed: result=0";
      if (action === "activate" && mode === "timeout") throw new Error("adb command timeout; outcome unknown");
      const r = response(action, Number(value("sequence")));
      r.requestId = value("requestId"); r.before.checked = checked;
      if (action === "activate") {
        assert.equal(value("expectedNodeId"), "node-0");
        if (mode !== "unrelated") checked = true;
        if (mode === "rejected") { r.status = "activation-target-mismatch"; r.actionDispatched = false; }
      }
      r.after.checked = checked;
      if (mode === "bad-source") r.after.packageName = "com.android.systemui";
      if (!speech) r.speech = [];
      return `Broadcast completed: result=200, data="${Buffer.from(JSON.stringify(r)).toString("base64")}"`;
    },
  });
  return { out, calls, capture, saved: () => JSON.parse(readFileSync(join(out, "talkback-interaction/radio.json"))) };
}

test("fixed scenario observes selection and keeps app provenance unknown", async (t) => {
  const h = harness(t);
  const result = await h.capture({ id: "radio", steps: [
    { action: "first", expect: { checked: false, speechIncludes: ["1257 dollars and 93 cents"] } },
    { action: "activate", expect: { checked: true, checkable: true } },
  ] });
  assert.equal(result.complete, true); assert.equal(result.observationComplete, true);
  assert.equal(result.provenance.commit, null); assert.equal(result.appIdentity.sourceCommit, null);
  assert.deepEqual(h.calls, ["hello", "first", "activate"]);
  assert.equal(h.saved().commands[2].speech.length, 0);
});

test("silent speech assertion fails separately with complete observations and raw receipts", async (t) => {
  const h = harness(t, { speech: false });
  await assert.rejects(h.capture({ id: "radio", steps: [{ action: "activate", expect: { checked: true, speechIncludes: ["checked"] } }] }),
    (error) => error.result.observationComplete && !error.result.assertions.passed && /speechIncludes/.test(error.message));
  assert.equal(h.saved().complete, false);
  assert.match(readFileSync(join(h.out, "talkback-interaction/radio.broadcasts.txt"), "utf8"), /# activate/);
});

test("wrong state stops before later activation and retains unrelated observation", async (t) => {
  const h = harness(t, { mode: "unrelated" });
  await assert.rejects(h.capture({ id: "radio", steps: [
    { action: "activate", expect: { checked: true } }, { action: "activate" },
  ] }), /assertion failed/);
  assert.equal(h.saved().observationComplete, false);
  assert.deepEqual(h.calls, ["hello", "activate"]);
});

for (const mode of ["timeout", "rejected", "restart", "bad-source"]) test(`controller ${mode} retains failure without retrying activation`, async (t) => {
  const h = harness(t, { mode });
  await assert.rejects(h.capture({ id: "radio", steps: [{ action: "activate" }] }));
  assert.equal(h.saved().complete, false);
  assert.ok(h.calls.filter((a) => a === "activate").length <= 1);
  assert.match(readFileSync(join(h.out, "talkback-interaction/radio.logcat.txt"), "utf8"), /raw logcat/);
});

test("only initial hello is retried for cold companion readiness", async (t) => {
  const h = harness(t, { mode: "cold" });
  await h.capture({ id: "radio", steps: [{ action: "activate" }] });
  assert.deepEqual(h.calls, ["hello", "hello", "activate"]);
});

test("zero-speech logging journals remain valid only with exact command boundaries", () => {
  const command = response("activate", 0), session = "11111111-1111-4111-8111-111111111111";
  const scope = { requestId: command.requestId, screen: command.screen, sequence: 0, serviceSession: command.session };
  const rows = [
    { kind: "header", data: { producer: "client", pid: command.pid, uid: 1234, packageName: "com.android.talkback", output: "synthetic-silence" } },
    { kind: "command-begin", data: { scope } }, { kind: "command-end", data: { scope } },
  ].map((r, index) => ({ schemaVersion: 1, session, event: index + 1, uptimeMs: index + 1, ...r }));
  command.tts = { schemaVersion: 1, engine: "org.irs_public.aloud.tts", clientSession: session,
    output: "synthetic-silence", error: null, firstEvent: 2, lastEvent: 3 };
  const capture = { requestId: command.requestId, screen: command.screen, commands: [command],
    loggingTts: { schemaVersion: 1, client: rows.map(JSON.stringify).join("\n") + "\n", engines: [] } };
  assert.equal(validateInteractionTts(capture).requests.length, 0);
  command.tts.lastEvent = 2;
  assert.throws(() => validateInteractionTts(capture), /boundaries/);
});

for (const mode of ["rejected", "synthesis-error"]) test(`logged ${mode} cannot pass from listener speech alone`, () => {
  const command = response("activate", 0), cs = "11111111-1111-4111-8111-111111111111", es = "22222222-2222-4222-8222-222222222222";
  const id = `${cs}:1`, utteranceId = "u1", spoken = "checked";
  const scope = { requestId: command.requestId, screen: command.screen, sequence: 0, serviceSession: command.session };
  const metadata = { dispatchId: id, clientSession: cs, originalUtteranceId: utteranceId, scope };
  const pack = (producer, session, rows) => [{ kind: "header", data: { producer, pid: command.pid, uid: 1234,
    packageName: producer === "client" ? "com.android.talkback" : "org.irs_public.aloud.tts", output: "synthetic-silence" } }, ...rows]
    .map((row, i) => JSON.stringify({ schemaVersion: 1, session, event: i + 1, uptimeMs: i + 1, ...row })).join("\n") + "\n";
  const rows = [
    { kind: "command-begin", data: { scope } },
    { kind: "request", data: { dispatchId: id, operation: "speak", text: spoken, queueMode: 1, wireId: id, metadata } },
    { kind: "return", data: { dispatchId: id, result: mode === "rejected" ? -1 : 0 } },
    ...(mode === "synthesis-error" ? [{ kind: "error", data: { dispatchId: id, interrupted: false } }] : []),
    { kind: "command-end", data: { scope } },
  ];
  command.speech = [{ utteranceId, text: spoken }];
  command.tts = { schemaVersion: 1, engine: "org.irs_public.aloud.tts", clientSession: cs,
    output: "synthetic-silence", error: null, firstEvent: 2, lastEvent: rows.length + 1 };
  const capture = { requestId: command.requestId, screen: command.screen, commands: [command], loggingTts: {
    schemaVersion: 1, client: pack("client", cs, rows), engines: mode === "rejected" ? [] : [pack("engine", es, [
      { kind: "received", data: { dispatchId: id, metadata, text: spoken, callerUid: 1234 } },
      { kind: "synthesis-error", data: { dispatchId: id, result: -1 } },
    ])],
  } };
  assert.equal(accountTts(capture.loggingTts).complete, true, "raw accounting faithfully accounts for failure");
  assert.equal(evaluateInteractionExpectations(command, { speechIncludes: ["checked"] }).passed, true);
  assert.throws(() => validateInteractionTts(capture), /dispatch or synthesis failed/);
});
