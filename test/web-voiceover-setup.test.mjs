// Device-free tests for the experimental VoiceOver runner setup. Every
// operating-system call is a fake: nothing here runs Guidepup, lists or
// stops processes, or changes a preference.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SETUP_UNAVAILABLE, setupRefusal, setupVoiceOver } from "../src/web/voiceover-setup.mjs";

test("a setup failure names a machine no further attempt can help", () => {
  assert.equal(SETUP_UNAVAILABLE, "VOICEOVER_SETUP_UNAVAILABLE");
  assert.equal(setupRefusal("execution error: Not authorized to send Apple events to System Events. (-1743)"),
    "this machine refuses Apple events to System Events");
  assert.equal(setupRefusal("Error: Unable to stop VoiceOver"), "VoiceOver on this machine cannot be stopped");
  assert.equal(setupRefusal("VoiceOver remained active after disposable setup"), "VoiceOver on this machine cannot be stopped");
  assert.equal(setupRefusal("VoiceOver started by this run did not stop; the disposable desktop needs recovery"),
    "VoiceOver on this machine cannot be stopped");
  assert.equal(setupRefusal("Failed to download Guidepup cache asset voiceover.zip (429 )"),
    "the release host rate-limited this machine's Guidepup download (HTTP 429)");
  assert.equal(setupRefusal("Failed to download Guidepup cache asset voiceover.zip (429)"),
    "the release host rate-limited this machine's Guidepup download (HTTP 429)");
  // Other failures may pass on another attempt.
  for (const output of ["Failed to enable Do Not Disturb", "Failed to download Guidepup cache asset (500)", "", undefined]) {
    assert.equal(setupRefusal(output), undefined);
  }
});

const HOSTED = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", ALOUD_ALLOW_NATIVE_DESKTOP: "1" };
const VO = "/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOver";

// A runner: a process table, kills that remove entries, and Guidepup steps
// answered in order by `steps`, each a function of the call that may start
// VoiceOver, throw, or both. Everything printed is kept in order.
function fakeRunner(steps) {
  const io = {
    table: new Map(), killed: [], calls: [], printed: [],
    now: () => 0,
    sleep: async () => {},
    voiceOverProcesses: async () => new Map(io.table),
    kill: (pid, signal) => { io.killed.push([pid, signal]); io.table.delete(pid); },
    exec: async (file, args, timeout) => {
      io.calls.push([file, args, timeout]);
      const step = steps.shift();
      if (!step) throw new Error(`unexpected command ${args.join(" ")}`);
      return step(io);
    },
    info: (...parts) => io.printed.push(["info", parts.join(" ")]),
    error: (...parts) => io.printed.push(["error", parts.join(" ")]),
    stdout: (text) => text && io.printed.push(["stdout", text]),
    stderr: (text) => text && io.printed.push(["stderr", text]),
  };
  return io;
}
const startsVoiceOver = (pid) => (io) => { io.table.set(pid, `Tue Oct 20 10:00:0${pid % 10} 2026 ${VO}`); };
const fails = (stdout, stderr = "") => () => { throw Object.assign(new Error("Command failed: guidepup"), { code: 1, stdout, stderr }); };
const passes = (stdout) => () => ({ stdout, stderr: "" });
const setup = (io, options = {}) => setupVoiceOver({ env: HOSTED, platform: "darwin", io, guidepup: ["guidepup"], ...options });
const markers = (io) => io.printed.filter(([, text]) => text.startsWith(SETUP_UNAVAILABLE)).map(([, text]) => text);

test("setup refuses a developer desktop and an existing VoiceOver session before running Guidepup", async () => {
  const io = fakeRunner([]);
  await assert.rejects(setupVoiceOver({ env: {}, platform: "darwin", io }), /ALOUD_ALLOW_NATIVE_DESKTOP=1/);
  await assert.rejects(setupVoiceOver({ env: HOSTED, platform: "linux", io }), /requires macOS/);
  io.table.set(400, `earlier ${VO}`);
  await assert.rejects(setup(io), /Refusing VoiceOver setup beside an existing VoiceOver session/);
  assert.deepEqual(io.calls, []);
  assert.deepEqual(io.killed, []);
});

test("setup runs Guidepup's setup and install, prints their output, and stops the VoiceOver setup started", async () => {
  const io = fakeRunner([(runner) => { startsVoiceOver(501)(runner); return passes("setup done\n")(); }, passes("installed\n")]);
  await setup(io);
  assert.deepEqual(io.calls, [["guidepup", ["setup", "--ci"], 300000], ["guidepup", ["install"], 180000]]);
  assert.deepEqual(io.printed.filter(([kind]) => kind === "stdout").map(([, text]) => text), ["setup done\n", "installed\n"]);
  assert.deepEqual(io.killed, [[501, "SIGTERM"]]);
  assert.equal(io.table.size, 0);
  assert.deepEqual(markers(io), []);
});

test("a failed setup attempt is logged and cleaned up before the second", async () => {
  const io = fakeRunner([
    (runner) => { startsVoiceOver(502)(runner); return fails("", "Failed to enable Do Not Disturb")(); },
    passes("setup done\n"),
    passes("installed\n"),
  ]);
  await setup(io);
  assert.equal(io.calls.length, 3);
  assert.deepEqual(io.killed, [[502, "SIGTERM"]]);
  const attempt = io.printed.find(([, text]) => text.startsWith("VoiceOver setup attempt failed"));
  assert.match(attempt[1], /"attempt":1,"attempts":2,"message":"Command failed: guidepup","code":1/);
  assert.ok(io.printed.some(([kind, text]) => kind === "stderr" && text === "Failed to enable Do Not Disturb"));
});

test("a machine that refuses Apple events gets one attempt and the unavailable marker", async () => {
  const io = fakeRunner([fails("", "Not authorized to send Apple events to System Events. (-1743)")]);
  const error = await setup(io).catch((e) => e);
  assert.equal(io.calls.length, 1);
  assert.equal(error.unavailable, "this machine refuses Apple events to System Events");
  assert.match(error.message, /^VoiceOver setup cannot pass on this machine, this machine refuses Apple events/);
  assert.deepEqual(markers(io), [`${SETUP_UNAVAILABLE}: this machine refuses Apple events to System Events`]);
});

test("a VoiceOver that survives the cleanup between attempts names the machine", async () => {
  const io = fakeRunner([(runner) => { startsVoiceOver(503)(runner); return fails("", "Failed to enable Do Not Disturb")(); }]);
  // Every signal is ignored: the reader keeps running.
  io.kill = (pid, signal) => { io.killed.push([pid, signal]); };
  const error = await setup(io).catch((e) => e);
  assert.ok(error instanceof AggregateError);
  assert.equal(io.calls.length, 1);
  assert.deepEqual(markers(io), [
    `${SETUP_UNAVAILABLE}: VoiceOver on this machine cannot be stopped`,
    `${SETUP_UNAVAILABLE}: VoiceOver on this machine cannot be stopped`,
  ]);
});

test("a rate-limited install names the machine, and the final cleanup still runs", async () => {
  const io = fakeRunner([
    (runner) => { startsVoiceOver(504)(runner); return passes("setup done\n")(); },
    fails("", "Failed to download Guidepup cache asset voiceover.zip (429 )"),
  ]);
  const error = await setup(io).catch((e) => e);
  assert.equal(error.unavailable, "the release host rate-limited this machine's Guidepup download (HTTP 429)");
  assert.deepEqual(markers(io), [`${SETUP_UNAVAILABLE}: the release host rate-limited this machine's Guidepup download (HTTP 429)`]);
  assert.deepEqual(io.killed, [[504, "SIGTERM"]]);
});

test("a VoiceOver macOS restarts after the final cleanup names the machine", async () => {
  // Setup and install pass, but a VoiceOver starts during install, and macOS
  // starts it again as soon as the cleanup stops it.
  const io = fakeRunner([passes("setup done\n"), (runner) => { startsVoiceOver(600)(runner); return passes("installed\n")(); }]);
  io.kill = (pid, signal) => { io.killed.push([pid, signal]); io.table.delete(pid); io.table.set(pid + 1, `restarted ${VO}`); };
  await assert.rejects(setup(io), /^Error: VoiceOver remained active after disposable setup$/);
  assert.deepEqual(markers(io), [`${SETUP_UNAVAILABLE}: VoiceOver on this machine cannot be stopped`]);
});
