// The NVDA driver's logic without NVDA: a Guidepup-shaped fake reader and an
// operating-system fake stand in. The hosted smoke (web-nvda-smoke.mjs) is
// the only place the real reader runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NVDA_EXIT, NVDA_SETTLE_MS, NVDA_START, isTypedCharacter, nvdaCommand, nvdaListen, nvdaPassNextKey, settleNvda, startNvda,
  stopNvda, windowsKeyScript,
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

const later = (ms, settle) => new Promise((resolve, reject) => setTimeout(() => settle(resolve, reject), ms));

// A Guidepup-shaped reader whose starts follow `starts` in turn, recording
// each start, each start settling, and each stop in one ordered list.
function startingReader(starts) {
  const reader = fakeReader();
  const events = [];
  let count = 0;
  reader.start = () => {
    const start = starts[count++]();
    events.push(`start ${count}`);
    const n = count;
    start.then(() => events.push(`start ${n} resolved`), () => events.push(`start ${n} rejected`));
    return start;
  };
  reader.stop = async () => { events.push("stop"); };
  return { reader, events };
}

test("NVDA startup gets a second attempt after a timeout, once the timed-out start settles and is stopped", async () => {
  assert.deepEqual(NVDA_START, { attempts: 2, timeoutMs: 60000, settleMs: 15000 });
  // The first start fails after its deadline; Guidepup would refuse a retry
  // before then, so the retry waits for it.
  const failsLate = startingReader([() => later(40, (_, reject) => reject(new Error("cannot be started"))), async () => {}]);
  const started = await startNvda({ io: fakeIo(), platform: "win32", guidepup: { nvda: failsLate.reader }, timeoutMs: 20, settleMs: 1000 });
  assert.equal(started, failsLate.reader);
  assert.deepEqual(failsLate.events, ["start 1", "start 1 rejected", "stop", "start 2", "start 2 resolved"]);
  // The first start succeeds after its deadline: it is stopped, not kept.
  const startsLate = startingReader([() => later(40, (resolve) => resolve()), async () => {}]);
  await startNvda({ io: fakeIo(), platform: "win32", guidepup: { nvda: startsLate.reader }, timeoutMs: 20, settleMs: 1000 });
  assert.deepEqual(startsLate.events, ["start 1", "start 1 resolved", "stop", "start 2", "start 2 resolved"]);
});

test("a start still pending after its settle window is neither retried nor stopped", async () => {
  const { reader, events } = startingReader([() => new Promise(() => {})]);
  const error = await startNvda({ io: fakeIo(), platform: "win32", guidepup: { nvda: reader }, timeoutMs: 20, settleMs: 20 }).catch((caught) => caught);
  assert.ok(error instanceof AggregateError);
  assert.match(error.message, /still pending 20 ms after its deadline; dedicated test desktop needs recovery/);
  assert.equal(error.errors.length, 1);
  assert.match(error.errors[0].message, /NVDA startup timed out/);
  assert.deepEqual(events, ["start 1"]);
});

test("the last failed start is stopped and waited out too, and every error is kept", async () => {
  const fail = async () => { throw new Error("cannot be started"); };
  const { reader, events } = startingReader([fail, fail]);
  const io = fakeIo();
  const error = await startNvda({ io, platform: "win32", guidepup: { nvda: reader }, timeoutMs: 20, settleMs: 20 }).catch((caught) => caught);
  assert.ok(error instanceof AggregateError);
  assert.match(error.message, /^NVDA did not start in 2 attempts$/);
  assert.deepEqual(error.errors.map((each) => each.message), ["cannot be started", "cannot be started"]);
  assert.deepEqual(events, ["start 1", "start 1 rejected", "stop", "start 2", "start 2 rejected", "stop"]);
  // A failed start that leaves nvda.exe running past the exit wait says so,
  // since the next start would refuse to replace it.
  const leaves = startingReader([0, 0].map(() => async () => { io.running = true; throw new Error("cannot be started"); }));
  io.running = false;
  io.slept.length = 0;
  const stuck = await startNvda({ io, platform: "win32", guidepup: { nvda: leaves.reader }, timeoutMs: 20, settleMs: 20 }).catch((caught) => caught);
  assert.match(stuck.message, /did not start in 2 attempts, and nvda.exe did not exit; dedicated test desktop needs recovery/);
  assert.equal(io.slept.length, 2 * NVDA_EXIT.attempts);
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

test("a settle waits a fixed time inside its own capture, after any action, and returns what it heard", async () => {
  const reader = fakeReader(["Fixture page, document"]);
  const io = fakeIo();
  const started = await startNvdaWith(reader, io);
  reader.calls.length = 0;
  const order = [];
  const sleep = io.sleep;
  io.sleep = async (ms) => { order.push(`sleep ${ms}`); await sleep(ms); };
  const settled = await settleNvda(started, 1000, { action: async () => { order.push("action"); } });
  assert.deepEqual(settled, ["Fixture page, document"]);
  assert.notEqual(settled, reader.log);
  assert.deepEqual(reader.calls, [["clear"], ["capture", { capture: true }]]);
  assert.deepEqual(order, ["action", `sleep ${NVDA_SETTLE_MS}`]);
  reader.log = "not a log";
  await assert.rejects(settleNvda(started, 1000), /invalid Guidepup speech log/);
  // A settle that times out marks the reader like a command does.
  reader.log = [];
  started.capture = () => new Promise(() => {});
  await assert.rejects(settleNvda(started, 10), /NVDA settle timed out/);
  await assert.rejects(nvdaCommand(started, "next", undefined, 10), /an earlier NVDA command timed out/);
});

test("pass next key performs NVDA's ignore-next-key command inside a capture", async () => {
  const reader = fakeReader(["Pass next key through"]);
  assert.deepEqual(await nvdaPassNextKey(reader, 1000), ["Pass next key through"]);
  assert.deepEqual(reader.calls, [["clear"], ["perform", "ignore-next-key", { capture: true }]]);
});

test("a timed-out NVDA command refuses later commands, which would wait behind it, until NVDA starts again", async () => {
  const reader = fakeReader();
  // Guidepup's log clear waits for every action, the timed-out one included.
  let pending;
  reader.next = () => (pending = new Promise(() => {}));
  reader.clearSpokenPhraseLog = async () => { await pending; };
  const started = await startNvdaWith(reader, fakeIo());
  await assert.rejects(nvdaCommand(started, "next", undefined, 20), /NVDA next timed out/);
  for (const later of [
    () => nvdaCommand(started, "press", "Tab", 20),
    () => nvdaListen(started, "x", 1000, 20),
    () => nvdaPassNextKey(started, 20),
  ]) await assert.rejects(later(), /an earlier NVDA command timed out/);
  // A command that fails on its own, without timing out, leaves the reader usable.
  const other = fakeReader();
  other.next = async () => { throw new Error("NVDA is not running"); };
  await assert.rejects(nvdaCommand(other, "next", undefined, 20), /not running/);
  assert.deepEqual(await nvdaCommand(other, "press", "Tab", 20), ["Save, button"]);
  // A new start makes the reader usable again.
  pending = undefined;
  await startNvda({ io: fakeIo(), platform: "win32", guidepup: { nvda: started } });
  assert.deepEqual(await nvdaCommand(started, "press", "Tab", 20), ["Save, button"]);
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
