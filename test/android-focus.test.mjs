import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFocusCapturer, focusTranscript, validateFocusResponse, validateTalkBackFocusCapture } from "../src/android/talkback-focus.mjs";
import { saveAccessibilityState, restoreAccessibilityState } from "../src/android/accessibility-state.mjs";
import { loadConfig } from "../src/config.mjs";

const target = "org.irs_public.aloud.fixture";
const node = (id) => ({ id, windowId: 3, packageName: target, text: "Same label", enabled: true });
function response(sequence, action, status, before, after = before) {
  return { schemaVersion: 1, source: "talkback-focus", talkbackCommit: "229212fdf5842191d0a93fc95d9ca1423b346866",
    requestId: "test-request", screen: "fixture", target, sequence, action, status, session: "service-session",
    pid: 45, windowId: 3, runtime: "14", elapsedMs: 800, before: node(before), after: node(after),
    signals: status === "edge" ? ["edge"] : [], focusEvents: status === "focused" ? [node(after)] : [],
    speech: status === "focused" ? [{ utteranceId: `talkback_${sequence}`, text: "Same label, Button" }] : [] };
}
function capture() {
  return { schemaVersion: 1, source: "talkback-focus", speechSource: "talkback-tts-request-listener",
    requestId: "test-request", screen: "fixture", target, targetPid: "20", coverage: {
      complete: true, start: "backward-edge", reason: "forward-edge", maxSteps: 3 }, commands: [
      response(0, "hello", "ready", "a"), response(1, "reset", "focused", "a"),
      response(2, "previous", "edge", "a"), response(3, "first", "focused", "a"),
      response(4, "next", "focused", "a", "b"), response(5, "next", "edge", "b"),
    ] };
}

test("preserves distinct focuses with duplicate speech and verifies native boundaries", () => {
  const c = capture();
  validateTalkBackFocusCapture(c);
  assert.deepEqual(focusTranscript(c), ["Same label, Button", "Same label, Button"]);
  assert.notEqual(c.commands[3].after.id, c.commands[4].after.id);
});

for (const [name, mutate] of Object.entries({
  "unobserved focus change": (c) => { c.commands[4].before.id = "unrecorded"; },
  "sequence gap": (c) => { c.commands[3].sequence++; },
  "different request": (c) => { c.commands[2].requestId = "another"; },
  "service restart": (c) => { c.commands[3].pid++; },
  "window change": (c) => { c.commands[3].windowId++; },
  "missing focus event": (c) => { c.commands[3].focusEvents = []; },
  "missing speech request": (c) => { c.commands[3].speech = []; },
  "scroll failure disguised as complete": (c) => { c.commands[3].signals.push("scroll-failed"); },
  "wrap disguised as complete": (c) => { c.commands[3].signals.push("wrap"); },
  "edge guessed from repeated focus": (c) => { c.commands.at(-1).signals = []; },
  "truncated forward pass": (c) => { c.commands.pop(); },
  "missing rewind": (c) => { c.commands[2].status = "step-timeout"; },
  "different speech source": (c) => { c.speechSource = "computed"; },
  "wrong pin": (c) => { c.commands[0].talkbackCommit = "new-build"; },
})) test(`rejects ${name}`, () => { const c = capture(); mutate(c); assert.throws(() => validateTalkBackFocusCapture(c)); });

test("does not accept a focused status with speech alone", () => {
  const r = response(1, "next", "focused", "a", "b"); r.focusEvents = [];
  assert.throws(() => validateFocusResponse(r, r), /focus and speech/);
});

for (const mode of ["complete", "limit", "restart", "exit", "unavailable", "missing-companion", "external-notification"]) {
  test(`controller ${mode} retains raw broadcasts and stops conservatively`, async (t) => {
    const out = mkdtempSync(join(tmpdir(), "aloud-focus-")); t.after(() => rmSync(out, { recursive: true, force: true }));
    let count = 0;
    const source = capture().commands;
    const capturer = createFocusCapturer({ out, target, maxSteps: 3, startupAttempts: 1,
      runShell: () => {
        if (mode === "unavailable" || (mode === "exit" && count > 2)) throw new Error("pidof found no process");
        return mode === "restart" && count > 2 ? "21" : "20";
      },
      runAdb: (args) => {
        if (args[0] === "logcat") return "raw diagnostics";
        const value = (name) => args[args.indexOf(name) + 1];
        const action = value("op"), sequence = Number(value("sequence"));
        count++;
        if (mode === "missing-companion") return "Broadcast completed: result=0";
        const r = mode === "limit" && sequence > 0 ? response(sequence, action, "focused", sequence === 1 ? "a" : `node-${sequence - 1}`, `node-${sequence}`) : structuredClone(source[sequence]);
        if (mode === "external-notification" && sequence === 4) r.status = "external-notification";
        r.requestId = value("requestId");
        return `Broadcast completed: result=200, data="${Buffer.from(JSON.stringify(r)).toString("base64")}"`;
      },
    });
    if (mode === "complete") assert.equal((await capturer("fixture")).coverage.complete, true);
    else await assert.rejects(capturer("fixture"), /incomplete TalkBack traversal/);
    const result = JSON.parse(readFileSync(join(out, "talkback-focus/fixture.json")));
    assert.equal(result.coverage.complete, mode === "complete");
    assert.match(readFileSync(join(out, "talkback-focus/fixture.logcat.txt"), "utf8"), /raw diagnostics/);
    if (["restart", "exit"].includes(mode)) assert.match(result.coverage.reason, /target-process-changed/);
    if (mode === "unavailable") assert.equal(result.coverage.reason, "target-not-running");
    if (mode === "limit") assert.equal(result.coverage.reason, "rewind-step-limit");
    if (mode === "external-notification") assert.equal(result.coverage.reason, "external-notification");
  });
}

test("restores absent and present secure settings and original TalkBack preferences", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aloud-settings-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json"), calls = [];
  const settings = { enabled_accessibility_services: "some.other/Service:com.android.talkback/Service", accessibility_enabled: "null" };
  const original = { ...settings };
  const runShell = (...args) => {
    calls.push(args);
    if (args[0] === "settings") {
      if (args[1] === "get") return settings[args[3]];
      if (args[1] === "delete") settings[args[3]] = "null";
      if (args[1] === "put") settings[args[3]] = args[4].slice(1, -1);
    }
    if (args[0] === "stat") return "12345";
    // A delayed PackageMonitor callback clears services after force-stop.
    if (args.includes("wait-for-broadcast-barrier")) settings.enabled_accessibility_services = "null";
    if (args[0] === "sh") return args.at(-1).includes(".xml.bak") ? "no" : "yes";
    return "";
  };
  saveAccessibilityState(file, "com.android.talkback", { runShell, runAdb: () => "" });
  settings.enabled_accessibility_services = "changed"; settings.accessibility_enabled = "1";
  restoreAccessibilityState(file, { runShell });
  assert.deepEqual(settings, original);
  const stop = calls.findIndex((a) => a[0] === "am");
  const restore = calls.findIndex((a) => a[0] === "cp" && a[2].startsWith("/data/local/tmp"));
  assert.ok(stop >= 0 && restore > stop, "stop the running service before restoring cached preferences");
  const barrier = calls.findIndex((a) => a.includes("wait-for-broadcast-barrier"));
  assert.ok(barrier > stop && barrier < restore, "finish force-stop broadcasts before restoring state");
  assert.ok(calls.some((a) => a[0] === "rm" && a.at(-1).endsWith(".xml.bak")));
});

test("validates opt-in Android traversal configuration", () => {
  assert.equal(loadConfig(null).android.talkBack, "startup");
  assert.equal(loadConfig(null, { android: { talkBack: "focus", talkBackMaxSteps: 200 } }).android.talkBack, "focus");
  for (const android of [{ talkBack: "computed" }, { talkBackMaxSteps: 0 }, { talkBackMaxSteps: 201 }, { talkBackMaxSteps: 2.5 }]) {
    assert.throws(() => loadConfig(null, { android }), /android.talkBack/);
  }
});

for (const mutation of ["none", "incomplete", "missing-step", "different-transcript", "different-screen"]) {
  test(`report verifies persisted TalkBack evidence: ${mutation}`, (t) => {
    const out = mkdtempSync(join(tmpdir(), "aloud-focus-report-")); t.after(() => rmSync(out, { recursive: true, force: true }));
    const c = capture(), transcript = focusTranscript(c);
    if (mutation === "incomplete") { c.coverage.complete = false; c.coverage.reason = "step-limit"; }
    if (mutation === "missing-step") c.commands.pop();
    if (mutation === "different-transcript") transcript.pop();
    if (mutation === "different-screen") c.screen = "another";
    writeFileSync(join(out, "fixture.transcript.json"), JSON.stringify({ screen: "fixture", source: "talkback-focus", transcript, talkBackFocus: c }));
    const result = spawnSync(process.execPath, ["src/report/report.mjs", "--dir", out], {
      env: { ...process.env, ALOUD_CONFIG: "" }, encoding: "utf8",
    });
    assert.equal(result.status === 0, mutation === "none", result.stderr);
    if (mutation === "none") {
      const summary = JSON.parse(readFileSync(join(out, "summary.json")));
      assert.equal(summary.screens.fixture.transcriptSource, "talkback-focus");
      assert.equal(summary.screens.fixture.talkBackFocus.coverage.complete, true);
      const html = readFileSync(join(out, "index.html"), "utf8");
      assert.match(html, /TalkBack speech requests/);
      assert.match(html, /do not prove audible delivery or correct focus order/);
      assert.match(html, /talkback-focus\/fixture.json/);
    }
  });
}

test("validates recorded native Android 14 captures without deduplicating speech", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/talkback-focus-android14.json", import.meta.url)));
  for (const capture of Object.values(fixture.captures)) validateTalkBackFocusCapture(capture);
  const nested = focusTranscript(fixture.captures.nested);
  assert.equal(nested.filter((text) => text === "SAME LABEL, Button").length, 2);
  assert.ok(nested.some((text) => /disabled/.test(text)));
  assert.ok(fixture.captures.scroll.commands.some((c) => c.signals.includes("scroll-complete")));
  assert.ok(focusTranscript(fixture.captures.scroll).some((s) => /ROW 30/.test(s)));
  assert.ok(focusTranscript(fixture.captures.dialog).some((s) => /Dialog value 12.50/.test(s)));
});

test("re-aggregation rejects trees left by an interrupted requested traversal", (t) => {
  const out = mkdtempSync(join(tmpdir(), "aloud-focus-interrupted-")); t.after(() => rmSync(out, { recursive: true, force: true }));
  writeFileSync(join(out, "capture-requirements.json"), JSON.stringify({ schemaVersion: 1, talkBackFocus: true }));
  writeFileSync(join(out, "fixture.tree.json"), JSON.stringify({ screen: "fixture", violations: [], gate: { errors: 0, ruleIds: [] } }));
  const result = spawnSync(process.execPath, ["src/report/report.mjs", "--dir", out], {
    env: { ...process.env, ALOUD_CONFIG: "" }, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requested TalkBack traversal did not complete/);
});

test("waits for cold service readiness without retrying a focus move", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "aloud-focus-startup-")); t.after(() => rmSync(out, { recursive: true, force: true }));
  const sent = []; let hellos = 0;
  const capturer = createFocusCapturer({ out, target, sleep: async () => {}, runShell: () => "20",
    runAdb: (args) => {
      if (args[0] === "logcat") return "startup diagnostics";
      const value = (name) => args[args.indexOf(name) + 1];
      const action = value("op"), sequence = Number(value("sequence")); sent.push(action);
      if (action === "hello" && ++hellos === 1) return "Broadcast completed: result=0";
      const r = structuredClone(capture().commands[sequence]); r.requestId = value("requestId");
      if (action === "hello" && hellos === 2) { r.status = "not-ready"; r.after = {}; }
      return `Broadcast completed: result=200, data="${Buffer.from(JSON.stringify(r)).toString("base64")}"`;
    },
  });
  const result = await capturer("fixture");
  assert.equal(result.coverage.complete, true);
  assert.equal(result.startupAttempts.length, 2);
  assert.deepEqual(sent, ["hello", "hello", "hello", "reset", "previous", "first", "next", "next"]);
});
