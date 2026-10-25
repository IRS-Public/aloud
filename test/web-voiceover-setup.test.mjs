// Device-free tests for the experimental VoiceOver runner setup. Every
// operating-system call is a fake: nothing here runs Guidepup, lists or
// stops processes, or changes a preference.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SETUP_UNAVAILABLE, appleEventDecisions, appleEventLines, permissionDiagnostics, setupRefusal, setupVoiceOver,
} from "../src/web/voiceover-setup.mjs";

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
    // Diagnostic commands answer from `answers`, keyed by the command name.
    answers: {},
    read: (file, args) => (io.answers[file] ?? (() => `unavailable: no ${file}`))(args),
    pid: 900,
    home: "/runner-home",
  };
  return io;
}
const printedAs = (io, label) => io.printed.filter(([, text]) => text.startsWith(label)).map(([, text]) => JSON.parse(text.slice(label.length + 1)));
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

test("tccd's log is cut to the lines of each Apple event request for System Events", () => {
  const lines = [
    "10:00:01 tccd AUTHREQ_CTX: msgID=401.1, function=TCCAccessRequest, service=kTCCServiceAppleEvents, target=com.apple.systemevents",
    "10:00:01 tccd AUTHREQ_ATTRIBUTION: msgID=401.1, attribution={responsible={TCCDProcess: identifier=node}}",
    "10:00:01 tccd AUTHREQ_RESULT: msgID=401.1, authValue=0, authReason=5",
    "10:00:02 tccd AUTHREQ_CTX: msgID=402.7, function=TCCAccessRequest, service=kTCCServiceAccessibility",
    "10:00:02 tccd AUTHREQ_RESULT: msgID=402.7, authValue=2",
  ];
  assert.deepEqual(appleEventLines(lines), lines.slice(0, 3));
  // An unexpected format keeps the raw tail instead.
  const other = Array.from({ length: 50 }, (_, n) => `line ${n}`);
  assert.deepEqual(appleEventLines(other), other.slice(-40));
});

test("permission diagnostics log the process ancestry, the System Events grants and tccd's decisions", () => {
  const io = fakeRunner([]);
  const parents = { 900: "800 node setup.mjs", 800: "700 bash -e step.sh", 700: "1 Runner.Worker" };
  io.answers.ps = (args) => parents[args.at(-1)] ?? "";
  io.answers.sudo = (args) => (args[1] === "sqlite3" ? `com.github.runner|0|2|4|1|1\n` : "msgID=1.1 kTCCServiceAppleEvents\nmsgID=1.1 AUTHREQ_RESULT authValue=0");
  io.answers.pgrep = () => "120 tccd\n";
  io.answers.stat = () => "runner\n";
  permissionDiagnostics(io);
  const [{ ancestry, grants }] = printedAs(io, "VoiceOver setup permissions");
  assert.deepEqual(ancestry, [
    { pid: 900, command: "node setup.mjs" }, { pid: 800, command: "bash -e step.sh" }, { pid: 700, command: "Runner.Worker" },
  ]);
  assert.deepEqual(grants, { system: ["com.github.runner|0|2|4|1|1"], user: ["com.github.runner|0|2|4|1|1"] });
  const [decisions] = printedAs(io, "VoiceOver Apple event decisions");
  assert.deepEqual(decisions, {
    phase: "setup failed", tccd: ["120 tccd"], consoleUser: "runner",
    decisions: ["msgID=1.1 kTCCServiceAppleEvents", "msgID=1.1 AUTHREQ_RESULT authValue=0"],
  });
  // A command that cannot run is named in place of its output.
  const bare = fakeRunner([]);
  appleEventDecisions(bare, "setup passed");
  assert.deepEqual(printedAs(bare, "VoiceOver Apple event decisions")[0].tccd, ["unavailable: no pgrep"]);
});

test("setup logs Apple event decisions after it passes, and permissions after it fails, without changing the outcome", async () => {
  const passing = fakeRunner([passes("setup done\n"), passes("installed\n")]);
  await setup(passing);
  assert.deepEqual(printedAs(passing, "VoiceOver Apple event decisions").map(({ phase }) => phase), ["setup passed"]);
  assert.deepEqual(printedAs(passing, "VoiceOver setup permissions"), []);
  const failing = fakeRunner([fails("", "Not authorized to send Apple events to System Events. (-1743)")]);
  await assert.rejects(setup(failing), /refuses Apple events/);
  assert.deepEqual(printedAs(failing, "VoiceOver Apple event decisions").map(({ phase }) => phase), ["setup failed"]);
  assert.equal(printedAs(failing, "VoiceOver setup permissions").length, 1);
  // Diagnostics that throw are logged and never fail a passing setup.
  const broken = fakeRunner([passes("setup done\n"), passes("installed\n")]);
  broken.read = () => { throw new Error("no shell"); };
  await setup(broken);
  assert.ok(broken.printed.some(([, text]) => text === "VoiceOver Apple event decisions unavailable no shell"));
});
