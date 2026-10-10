// The NVDA driver's logic without NVDA: a Guidepup-shaped fake reader and an
// operating-system fake stand in. The hosted smoke (web-nvda-smoke.mjs) is
// the only place the real reader runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NVDA_EXIT, NVDA_START, isTypedCharacter, nvdaCommand, nvdaListen, nvdaPassNextKey, startNvda, stopNvda, windowsKeyScript,
} from "../src/web/nvda.mjs";

function fakeIo({ running = false } = {}) {
  const io = {
    time: 0,
    slept: [],
    sent: [],
    running,
    sleep: async (ms) => { io.slept.push(ms); io.time += ms; },
    nvdaRunning: () => io.running,
    sendKey: async (key) => { io.sent.push([key, io.time]); },
  };
  return io;
}

function fakeReader(log = ["Save, button"]) {
  const reader = {
    calls: [],
    log,
    clearSpokenPhraseLog: async () => { reader.calls.push(["clear"]); },
    spokenPhraseLog: async () => reader.log,
    capture: async (action, options) => { reader.calls.push(["capture", options]); await action(); },
    press: async (key, options) => { reader.calls.push(["press", key, options]); },
    type: async (characters, options) => { reader.calls.push(["type", characters, options]); },
    perform: async (command, options) => { reader.calls.push(["perform", command, options]); },
    keyboardCommands: { ignoreNextKeyCombination: "ignore-next-key" },
    next: async (options) => { reader.calls.push(["next", options]); },
    stop: async () => { reader.calls.push(["stop"]); },
  };
  return reader;
}

test("NVDA starts only on Windows and never replaces a running NVDA", async () => {
  await assert.rejects(startNvda({ io: fakeIo(), platform: "darwin" }), /requires a dedicated Windows desktop/);
  await assert.rejects(startNvda({ io: fakeIo({ running: true }), platform: "win32" }), /already running/);
});

test("NVDA startup gets a second attempt after a timeout, with a stop between, and keeps every error", async () => {
  assert.deepEqual(NVDA_START, { attempts: 2, timeoutMs: 30000 });
  const reader = fakeReader();
  const io = fakeIo();
  let starts = 0;
  const nvda = { ...reader, start: async () => { starts++; if (starts === 1) return new Promise(() => {}); } };
  const started = await startNvda({ io, platform: "win32", guidepup: { nvda }, timeoutMs: 20 });
  assert.equal(starts, 2);
  assert.deepEqual(reader.calls, [["stop"]]);
  assert.equal(started, nvda);
  // Both attempts failing: an AggregateError with both reasons.
  const never = { ...fakeReader(), start: async () => new Promise(() => {}) };
  const error = await startNvda({ io, platform: "win32", guidepup: { nvda: never }, timeoutMs: 20 }).catch((caught) => caught);
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors.length, 2);
  assert.match(error.message, /did not start in 2 attempts/);
  assert.match(error.errors[0].message, /NVDA startup timed out/);
});

test("the Windows key script accepts letters, digits and the named keys only", () => {
  assert.equal(windowsKeyScript("x"), 'CreateObject("WScript.Shell").SendKeys "x"');
  assert.equal(windowsKeyScript("Enter"), 'CreateObject("WScript.Shell").SendKeys "{ENTER}"');
  assert.equal(windowsKeyScript("Space"), 'CreateObject("WScript.Shell").SendKeys " "');
  for (const key of ["Tab", "{ENTER}", "ab", '"', ""]) assert.throws(() => windowsKeyScript(key), /unsupported operating system key/);
});

test("NVDA commands press keys, type text and lone punctuation, and validate their input", async () => {
  const reader = fakeReader();
  assert.deepEqual(await nvdaCommand(reader, "press", "Tab", 1000), ["Save, button"]);
  assert.deepEqual(reader.calls, [["clear"], ["press", "Tab", { capture: true }]]);
  reader.calls.length = 0;
  await nvdaCommand(reader, "press", ":", 1000);
  assert.deepEqual(reader.calls.at(-1), ["type", ":", { capture: true }]);
  await nvdaCommand(reader, "type", "hello", 1000);
  assert.deepEqual(reader.calls.at(-1), ["type", "hello", { capture: true }]);
  await nvdaCommand(reader, "next", undefined, 1000);
  assert.deepEqual(reader.calls.at(-1), ["next", { capture: true }]);
  await assert.rejects(nvdaCommand(reader, "press", "", 1000), /requires a key/);
  await assert.rejects(nvdaCommand(reader, "type", " ", 1000), /requires text/);
  reader.log = "not a log";
  await assert.rejects(nvdaCommand(reader, "next", undefined, 1000), /invalid Guidepup speech log/);
  assert.equal(isTypedCharacter("/"), true);
  assert.equal(isTypedCharacter("a"), false);
  assert.equal(isTypedCharacter("Enter"), false);
});

test("a listen sends the key through Windows inside one capture held open for the window", async () => {
  const reader = fakeReader(["3 characters over the limit"]);
  const io = fakeIo();
  // A reader started by this module keeps its io; stand in for startNvda.
  const started = await startNvdaWith(reader, io);
  assert.deepEqual(await nvdaListen(started, "x", 2500, 1000), ["3 characters over the limit"]);
  assert.deepEqual(io.sent, [["x", 0]]);
  assert.deepEqual(io.slept, [2500]);
  assert.deepEqual(reader.calls.map(([name]) => name), ["clear", "capture"]);
  await assert.rejects(nvdaListen(started, "Tab", 2500, 1000), /listen key/);
  await assert.rejects(nvdaListen(started, "x", 500, 1000), /listen window/);
});

test("pass next key performs NVDA's ignore-next-key command inside a capture", async () => {
  const reader = fakeReader(["Pass next key through"]);
  assert.deepEqual(await nvdaPassNextKey(reader, 1000), ["Pass next key through"]);
  assert.deepEqual(reader.calls, [["clear"], ["perform", "ignore-next-key", { capture: true }]]);
});

test("stopping waits for nvda.exe to exit and reports one that never does", async () => {
  const reader = fakeReader();
  const io = fakeIo({ running: true });
  const started = await startNvdaWith(reader, io);
  let polls = 0;
  io.nvdaRunning = () => ++polls < 3;
  await stopNvda(started, 1000);
  assert.deepEqual(reader.calls.at(-1), ["stop"]);
  assert.deepEqual(io.slept, [NVDA_EXIT.pollMs, NVDA_EXIT.pollMs]);
  io.slept.length = 0;
  io.nvdaRunning = () => true;
  await assert.rejects(stopNvda(started, 1000), /did not stop/);
  assert.equal(io.slept.length, NVDA_EXIT.attempts);
  // A reader this module did not start is stopped without the wait.
  const other = fakeReader();
  await stopNvda(other, 1000);
  assert.deepEqual(other.calls, [["stop"]]);
});

// startNvda loads Guidepup, so the tests register a fake reader the way it
// would: through the module's own start with a fake dependency. nvda.exe
// runs only once that start has run, and the module keeps the test's own io,
// so a test can change what it reports afterwards.
async function startNvdaWith(reader, io) {
  const running = io.running;
  io.running = false;
  const nvda = { ...reader, start: async () => { io.running = running; } };
  return startNvda({ io, platform: "win32", guidepup: { nvda } }).then(
    (started) => Object.assign(started, { calls: reader.calls }),
  );
}
