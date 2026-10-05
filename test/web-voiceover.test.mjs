// Device-free tests for the experimental Safari + VoiceOver web driver and
// its wiring into aloud web.
// Every operating-system call is a fake: nothing here starts VoiceOver,
// opens Safari, or runs osascript.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SETTLE, assertNativeDesktop, awaitQuiet, captureContext, hostRefusal, isTypedCharacter, matchingOwnedProcesses,
  parseVoiceOverProcesses, resetVoiceOverTimeoutForTests, VOICEOVER_COMMANDS, macosKeyScript, safariKey, settleVoiceOver,
  speechLog, startVoiceOver, stopOwnedVoiceOver, stopVoiceOver, voiceOverCommand, voiceOverListen, voiceOverPassNextKey,
  withAttempts,
} from "../src/web/voiceover.mjs";
import {
  createSafari, domOutline, javascriptScript, pageResult, pageScript, preflightRequest, sameDocumentUrl,
} from "../src/web/safari.mjs";
import { loadConfig } from "../src/config.mjs";
import { READER_STEP_COMMANDS, WEB_DEFAULTS, validateWebConfig, webScreens } from "../src/web/config.mjs";
import { hash, readWebReport, validateWebCapture, webSummary } from "../src/web/evidence.mjs";
import { renderWebReport } from "../src/web/report.mjs";
import { captureWeb } from "../src/web/run.mjs";
import { buildAcr } from "../src/report/openacr.mjs";

const HOSTED = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", ALOUD_ALLOW_NATIVE_DESKTOP: "1" };
const VO = "/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOver";

// A clock that only moves when the code under test sleeps.
function fakeClock() {
  const clock = { time: 0, slept: [] };
  clock.now = () => clock.time;
  clock.sleep = async (ms) => { clock.slept.push(ms); clock.time += ms; };
  return clock;
}

// Operating-system fakes: a process table the test controls, kills that
// remove matching entries, and VoiceOver's last phrase.
function fakeIo({ processes = new Map(), phrases = ["Ready"] } = {}) {
  const clock = fakeClock();
  const io = {
    ...clock,
    table: processes,
    killed: [],
    sent: [],
    sendKey: async (key) => { io.sent.push([key, io.time]); },
    voiceOverProcesses: async () => new Map(io.table),
    kill: (pid, signal) => { io.killed.push([pid, signal]); io.table.delete(pid); },
    lastPhrase: async () => phrases[0],
  };
  return io;
}

// A Guidepup-shaped VoiceOver that records every call, in order.
function fakeVoiceOver({ io, startFailures = 0, log = ["Button, Save"], item = "Save email, button" } = {}) {
  const calls = [];
  let failures = startFailures;
  const reader = {
    calls,
    log,
    item,
    get version() { return "fixture-voiceover"; },
    start: async (options) => {
      calls.push(["start", options]);
      if (failures-- > 0) throw new Error("VoiceOver not ready (-600)");
      io.table.set(501, `Tue Sep 29 10:00:00 2026 ${VO}`);
    },
    stop: async () => { calls.push(["stop"]); io.table.delete(501); },
    clearSpokenPhraseLog: async () => { calls.push(["clear"]); },
    capture: async (action, options) => { calls.push(["capture", options]); await action(); },
    spokenPhraseLog: async () => reader.log,
    press: async (key, options) => { calls.push(["press", key, options]); },
    type: async (characters, options) => { calls.push(["type", characters, options]); },
    perform: async (command, options) => { calls.push(["perform", command, options]); },
    keyboardCommands: { ignoreNextKeyCombination: "ignore-next-key" },
    next: async (options) => { calls.push(["next", options]); },
    interact: async (options) => { calls.push(["interact", options]); },
    // The item under the VoiceOver cursor; not a recorded call, so the
    // command sequences above stay as they are.
    itemText: async () => reader.item,
  };
  return reader;
}

const guidepup = (voiceOver) => ({ voiceOver, MacOSApplications: { Safari: "Safari" } });
const start = (io, voiceOver) => startVoiceOver({ env: HOSTED, platform: "darwin", io, guidepup: guidepup(voiceOver) });

test("VoiceOver refuses anything but an opted-in, GitHub-hosted macOS runner", () => {
  assert.throws(() => assertNativeDesktop({ env: HOSTED, platform: "linux" }), /requires macOS/);
  assert.throws(() => assertNativeDesktop({ env: {}, platform: "darwin" }), /disposable GitHub-hosted/);
  for (const key of Object.keys(HOSTED)) {
    assert.throws(() => assertNativeDesktop({ env: { ...HOSTED, [key]: "0" }, platform: "darwin" }), /ALOUD_ALLOW_NATIVE_DESKTOP=1/);
  }
  assert.throws(() => assertNativeDesktop({ env: { ...HOSTED, RUNNER_ENVIRONMENT: "self-hosted" }, platform: "darwin" }));
  assert.doesNotThrow(() => assertNativeDesktop({ env: HOSTED, platform: "darwin" }));
});

test("Safari keys: Tab and Shift+Tab become Option+Tab; other keys pass through", () => {
  assert.equal(safariKey("Tab"), "Option+Tab");
  assert.equal(safariKey("Shift+Tab"), "Option+Shift+Tab");
  for (const key of ["Enter", "Escape", "Control+Tab", "Tabulate", "ArrowDown"]) assert.equal(safariKey(key), key);
});

test("speech logs must be arrays of strings and come back as copies", () => {
  const log = ["Same", "Same", ""];
  const copy = speechLog(log);
  assert.deepEqual(copy, log);
  assert.notEqual(copy, log);
  for (const bad of [undefined, null, "Saved", [1], ["ok", null]]) assert.throws(() => speechLog(bad), /invalid Guidepup speech log/);
});

test("VoiceOver processes are identified by pid and start time", () => {
  const ps = [
    `  501 Tue Sep 29 10:00:00 2026     ${VO}`,
    "  502 Tue Sep 29 10:00:01 2026     /Applications/Safari.app/Contents/MacOS/Safari",
    "  503 Tue Sep 29 10:00:02 2026     /usr/bin/VoiceOverHelper",
    "not a process line",
  ].join("\n");
  const found = parseVoiceOverProcesses(ps);
  assert.deepEqual([...found.keys()], [501]);
  assert.equal(found.get(501), `Tue Sep 29 10:00:00 2026     ${VO}`);
  // A pid reused by a later process is not the owned one.
  const owned = new Map([[501, "old start"], [600, "same"]]);
  assert.deepEqual(matchingOwnedProcesses(new Map([[501, "new start"], [600, "same"]]), owned), [[600, "same"]]);
});

test("the quiet settle waits for one quiet second, caps continuous speech, and falls back to a fixed wait", async () => {
  // Stable speech: done after the quiet window.
  let clock = fakeClock();
  await awaitQuiet(async () => "Ready", clock);
  assert.equal(clock.time, SETTLE.quietMs);
  // Speech that changes once restarts the quiet window.
  clock = fakeClock();
  let reads = 0;
  await awaitQuiet(async () => (++reads < 4 ? "Loading" : "Loaded"), clock);
  assert.equal(clock.time, 3 * SETTLE.pollMs + SETTLE.quietMs);
  // Continuous speech stops at the cap.
  clock = fakeClock();
  await awaitQuiet(async () => `phrase ${clock.time}`, clock);
  assert.equal(clock.time, SETTLE.maxMs);
  // No live phrase, or a failing read, waits the fixed time.
  clock = fakeClock();
  await awaitQuiet(undefined, clock);
  assert.equal(clock.time, SETTLE.fixedMs);
  clock = fakeClock();
  reads = 0;
  await awaitQuiet(async () => { if (++reads > 3) throw new Error("osascript failed"); return "Ready"; }, clock);
  assert.equal(clock.time, SETTLE.fixedMs);
});

test("stopping owned VoiceOver never signals another session and reports a survivor", async () => {
  const io = fakeIo({ processes: new Map([[501, "mine"], [777, "someone else's"]]) });
  await stopOwnedVoiceOver(new Map([[501, "mine"]]), io);
  assert.deepEqual(io.killed, [[501, "SIGTERM"]]);
  assert.ok(io.table.has(777));
  // A process that ignores both signals is a failed cleanup.
  const stubborn = fakeIo({ processes: new Map([[501, "mine"]]) });
  stubborn.kill = (pid, signal) => { stubborn.killed.push([pid, signal]); };
  await assert.rejects(stopOwnedVoiceOver(new Map([[501, "mine"]]), stubborn), /did not stop/);
  assert.deepEqual(stubborn.killed, [[501, "SIGTERM"], [501, "SIGKILL"]]);
  // A process that exited between listing and signalling is fine.
  const gone = fakeIo({ processes: new Map([[501, "mine"]]) });
  gone.kill = (pid) => { gone.table.delete(pid); throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };
  await stopOwnedVoiceOver(new Map([[501, "mine"]]), gone);
});

test("setup attempts recover between failures and keep every error", async () => {
  let calls = 0, recoveries = 0;
  assert.equal(await withAttempts(async () => { if (++calls < 2) throw new Error("first"); return "ok"; },
    { attempts: 2, between: async () => { recoveries++; } }), "ok");
  assert.equal(recoveries, 1);
  const failed = await withAttempts(async (n) => { throw new Error(`attempt ${n}`); }, { attempts: 2, between: async () => {} }).catch((e) => e);
  assert.deepEqual(failed.errors.map((e) => e.message), ["attempt 1", "attempt 2"]);
  const stopped = await withAttempts(async () => { throw new Error("start"); },
    { attempts: 3, between: async () => { throw new Error("recovery"); } }).catch((e) => e);
  assert.deepEqual(stopped.errors.map((e) => e.message), ["start", "recovery"]);
});

test("VoiceOver refuses to replace an existing session and never starts Guidepup", async () => {
  const io = fakeIo({ processes: new Map([[42, `Mon Sep 28 09:00:00 2026 ${VO}`]]) });
  const voiceOver = fakeVoiceOver({ io });
  await assert.rejects(start(io, voiceOver), /already running/);
  assert.deepEqual(voiceOver.calls, []);
  assert.deepEqual(io.killed, []);
  await assert.rejects(startVoiceOver({ env: {}, platform: "darwin", io, guidepup: guidepup(voiceOver) }), /GitHub-hosted/);
});

test("VoiceOver startup retries once, and a failed startup stops only what it started", async () => {
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io, startFailures: 1 });
  const reader = await start(io, voiceOver);
  assert.equal(reader, voiceOver);
  assert.equal(voiceOver.calls.filter(([name]) => name === "start").length, 2);
  assert.deepEqual(voiceOver.calls[0][1], { capture: true, timeout: 10000, retries: 1, settings: { SCRShouldOutputVOInstructions: false } });
  assert.ok(io.slept.includes(5000));
  await stopVoiceOver(reader);

  const failing = fakeIo();
  const broken = fakeVoiceOver({ io: failing, startFailures: 5 });
  // A partial start leaves a process behind; cleanup stops it.
  broken.start = async () => { failing.table.set(900, `now ${VO}`); throw new Error("VoiceOver not ready (-600)"); };
  await assert.rejects(start(failing, broken), /did not start/);
  assert.equal(failing.table.size, 0);
  assert.ok(failing.killed.some(([pid]) => pid === 900));
  await assert.rejects(voiceOverCommand(broken, "next", undefined, 1000), /not started by startVoiceOver/);
});

test("VoiceOver commands settle first, send Safari keys, and validate their input", async () => {
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io, log: ["Save email, button", "Save email, button"] });
  const reader = await start(io, voiceOver);
  voiceOver.calls.length = 0;
  assert.deepEqual(await voiceOverCommand(reader, "press", "Tab", 1000), ["Save email, button", "Save email, button"]);
  assert.deepEqual(voiceOver.calls.map(([name]) => name), ["clear", "capture", "clear", "press"]);
  assert.deepEqual(voiceOver.calls[1][1], { capture: true });
  assert.deepEqual(voiceOver.calls[3], ["press", "Option+Tab", { capture: true, application: "Safari" }]);
  voiceOver.calls.length = 0;
  await voiceOverCommand(reader, "interact", undefined, 1000);
  assert.deepEqual(voiceOver.calls.at(-1), ["interact", { capture: true }]);
  // The settle returns what it discarded, for navigation speech.
  voiceOver.log = ["Fixture page, web content"];
  assert.deepEqual(await settleVoiceOver(reader, 1000), ["Fixture page, web content"]);
  await assert.rejects(voiceOverCommand(reader, "press", "", 1000), /requires a key/);
  await assert.rejects(voiceOverCommand(reader, "eval", undefined, 1000), /unsupported VoiceOver command/);
  await assert.rejects(voiceOverCommand(reader, "next", "Tab", 1000), /takes no argument/);
  voiceOver.log = "not a log";
  await assert.rejects(voiceOverCommand(reader, "next", undefined, 1000), /invalid Guidepup speech log/);
  await stopVoiceOver(reader);
  await assert.rejects(voiceOverCommand(reader, "next", undefined, 1000), /not started/);
});

test("a settle can run an action inside its capture, before the quiet wait", async () => {
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io, log: ["Fixture page, web content"] });
  const reader = await start(io, voiceOver);
  voiceOver.calls.length = 0;
  const order = [];
  const sleep = io.sleep;
  io.sleep = async (ms) => { order.push(`sleep ${ms}`); await sleep(ms); };
  const settled = await settleVoiceOver(reader, 1000, { action: async () => { order.push("action"); } });
  assert.deepEqual(settled, ["Fixture page, web content"]);
  assert.deepEqual(voiceOver.calls.map(([name]) => name), ["clear", "capture"]);
  assert.equal(order[0], "action");
  assert.ok(order.length > 1 && order.slice(1).every((step) => step.startsWith("sleep")));
  await stopVoiceOver(reader);
});

test("each capture remembers its command, the speech its settle discarded and the cursor item", async () => {
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io, log: ["Save email, button"], item: "Save email, button" });
  const reader = await start(io, voiceOver);
  const pressed = await voiceOverCommand(reader, "press", "Tab", 1000);
  assert.deepEqual(captureContext(pressed), {
    command: "press Option+Tab", settled: ["Save email, button"], cursor: "Save email, button",
  });
  const moved = await voiceOverCommand(reader, "next", undefined, 1000);
  assert.equal(captureContext(moved).command, "next");
  const listened = await voiceOverListen(reader, "x", 1500, 1000);
  assert.equal(captureContext(listened).command, "press x for 1500 ms");
  // A cursor read that fails is context, never a failed command.
  voiceOver.itemText = async () => { throw new Error("AppleScript timed out"); };
  const later = await voiceOverCommand(reader, "next", undefined, 1000);
  assert.deepEqual(later, ["Save email, button"]);
  assert.equal(captureContext(later).cursor, "unavailable (AppleScript timed out)");
  assert.equal(captureContext(["not a capture"]), undefined);
  await stopVoiceOver(reader);
});

test("a lone punctuation character is typed, and type sends text", async () => {
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io });
  const reader = await start(io, voiceOver);
  const colon = await voiceOverCommand(reader, "press", ":", 1000);
  assert.deepEqual(voiceOver.calls.at(-1), ["type", ":", { capture: true, application: "Safari" }]);
  assert.equal(captureContext(colon).command, 'type ":"');
  await voiceOverCommand(reader, "press", "a", 1000);
  assert.deepEqual(voiceOver.calls.at(-1), ["press", "a", { capture: true, application: "Safari" }]);
  await voiceOverCommand(reader, "type", "Ada", 1000);
  assert.deepEqual(voiceOver.calls.at(-1), ["type", "Ada", { capture: true, application: "Safari" }]);
  await assert.rejects(voiceOverCommand(reader, "type", "", 1000), /VoiceOver type requires text/);
  for (const key of [":", "/", ";"]) assert.equal(isTypedCharacter(key), true, key);
  for (const key of ["a", "7", "Tab", "Shift+Tab", "", undefined]) assert.equal(isTypedCharacter(key), false, String(key));
  await stopVoiceOver(reader);
});

test("pass next key performs VoiceOver's ignore-next-key command inside a capture", async () => {
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io });
  const reader = await start(io, voiceOver);
  voiceOver.calls.length = 0;
  await voiceOverPassNextKey(reader, 1000);
  assert.deepEqual(voiceOver.calls, [["perform", "ignore-next-key", { capture: true, application: "Safari" }]]);
  await stopVoiceOver(reader);
  await assert.rejects(voiceOverPassNextKey(reader, 1000), /not started by startVoiceOver/);
});

test("a machine that refuses Apple events stops startup after one attempt", async () => {
  assert.equal(hostRefusal("execution error: Not authorized to send Apple events to System Events. (-1743)"),
    "this machine refuses Apple events to System Events");
  assert.equal(hostRefusal("VoiceOver not ready (-600)"), undefined);
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io });
  voiceOver.start = async (options) => {
    voiceOver.calls.push(["start", options]);
    throw new Error("osascript: Not authorized to send Apple events to System Events. (-1743)");
  };
  const error = await start(io, voiceOver).catch((e) => e);
  assert.match(error.message, /cannot start here, this machine refuses Apple events to System Events/);
  assert.equal(error.unavailable, "this machine refuses Apple events to System Events");
  assert.equal(voiceOver.calls.filter(([name]) => name === "start").length, 1);
  assert.deepEqual(io.slept, []);
});

test("a timed-out VoiceOver command is never retried and blocks further readers", async () => {
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io });
  const reader = await start(io, voiceOver);
  voiceOver.next = () => new Promise(() => {});
  await assert.rejects(voiceOverCommand(reader, "next", undefined, 20), /VoiceOver next timed out/);
  await assert.rejects(voiceOverCommand(reader, "press", "Enter", 20), /refusing further commands/);
  // Cleanup still runs after a timeout.
  await stopVoiceOver(reader);
  assert.equal(io.table.size, 0);
  await assert.rejects(start(fakeIo(), fakeVoiceOver({ io: fakeIo() })), /refusing to start another reader/);
  resetVoiceOverTimeoutForTests();
});

test("VoiceOver cleanup kills an owned survivor and reports a failed stop", async () => {
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io });
  const reader = await start(io, voiceOver);
  voiceOver.stop = async () => { throw new Error("AppleScript refused"); };
  await assert.rejects(stopVoiceOver(reader), /cleanup failed.*AppleScript refused/);
  assert.equal(io.table.size, 0);
  await assert.rejects(stopVoiceOver(reader), /not started by startVoiceOver/);
});

test("Safari page scripts report values and errors through a JSON envelope", () => {
  const evaluate = (fn, argument) => pageResult(new Function(`return ${pageScript(fn, argument)}`)());
  assert.equal(evaluate((n) => n + 1, 1), 2);
  assert.deepEqual(evaluate(([a, b]) => ({ a, b }), ["x", "y"]), { a: "x", b: "y" });
  assert.equal(evaluate(() => undefined), null);
  assert.equal(evaluate("(sel) => sel.length", "#email"), 6);
  assert.throws(() => evaluate(() => { throw new Error("boom"); }), /page script failed: boom/);
  for (const output of ["missing value", "", "[]", "{}"]) assert.throws(() => pageResult(output), /observation/);
});

// A fake page world for Safari's `do JavaScript`: page scripts run as real
// JavaScript against a small document the test controls.
// `body` is the page content that the DOM outline reads.
const AXE_RESULT = { testEngine: { name: "axe-core", version: "4.13.0" }, incomplete: [], passes: [], inapplicable: [],
  violations: [{ id: "button-name", tags: ["wcag412"], help: "Name buttons", description: "Buttons need names", nodes: [{ target: ["#unnamed"], html: "<button></button>" }] }] };
function fakeSafari({ language = "en-US", chrome = [0, 80], screen, status = 200, axeVersion = "4.13.0", body = element("BODY") } = {}) {
  const world = { windows: [], closed: [], activated: 0, bounds: [0, 0, 0, 0], scripts: 0 };
  const makeDocument = (url) => {
    const elements = { "#email": { tagName: "INPUT", value: "", focused: false, clicked: 0, visible: true, events: [] } };
    for (const el of Object.values(elements)) {
      Object.assign(el, {
        scrollIntoView() {}, focus() { el.focused = true; }, click() { el.clicked++; },
        getClientRects: () => (el.visible ? [{}] : []), dispatchEvent: (event) => el.events.push(event.type),
      });
    }
    return { URL: url, readyState: "complete", elements, body, activeElement: null, getElementById: () => null,
      querySelector: (sel) => (sel === "body" ? body : elements[sel] ?? null), hasFocus: () => true };
  };
  world.document = makeDocument("about:blank");
  world.window = {};
  const io = {
    ...fakeClock(),
    version: async () => "26.0",
    openWindow: async () => { world.windows.push("7"); return "7"; },
    closeWindow: async (id) => { world.closed.push(id); },
    // macOS keeps a window inside the screen's available area.
    setBounds: async (id, [left, top, right, bottom]) => {
      world.bounds = [left, top, right, screen ? Math.min(bottom, top + screen[1]) : bottom];
    },
    bounds: async () => world.bounds,
    activate: async () => { world.activated++; },
    setUrl: async (id, url) => { world.document = makeDocument(url); world.window = {}; },
    javascript: async (id, source) => {
      world.scripts++;
      const { document, window } = world;
      const navigator = { language };
      const performance = { getEntriesByType: () => [{ responseStatus: status }] };
      const getComputedStyle = () => ({ display: "block", visibility: "visible" });
      const innerWidth = world.bounds[2] - chrome[0], innerHeight = world.bounds[3] - chrome[1];
      Object.assign(window, { innerWidth, innerHeight },
        screen && { screen: { availWidth: screen[0], availHeight: screen[1] } });
      return String(new Function("document", "window", "navigator", "performance", "getComputedStyle", "Event",
        `return ${source}`)(document, window, navigator, performance, getComputedStyle, class { constructor(type) { this.type = type; } }));
    },
    screenshot: async (path, bounds) => { world.shot = { path, bounds }; writeFileSync(path, "fixture image"); },
    fetch: async (url) => ({ ok: !url.includes("missing"), status: url.includes("missing") ? 404 : 200 }),
    axeSource: () => ({
      version: "4.13.0",
      source: `window.axe = { version: "${axeVersion}", run: async () => ({ ...${JSON.stringify(AXE_RESULT)}, url: document.URL }) }`,
    }),
  };
  return { io, world };
}

test("the Safari driver opens its own sized window, checks the language, and closes it", async () => {
  const { io, world } = fakeSafari();
  const browser = await createSafari(io).launch();
  assert.equal(browser.version(), "26.0");
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 800 } });
  // The first size leaves room for the window's chrome; the second corrects it.
  assert.deepEqual(world.bounds, [0, 0, 1280, 880]);
  await assert.rejects(browser.newContext({ storageState: "auth.json" }), /storage state/);
  await context.close();
  await context.close();
  assert.deepEqual(world.closed, ["7"]);

  // A screen too short for the page fails with its size instead of
  // recording a viewport the page never had.
  const short = fakeSafari({ screen: [1280, 709] });
  await assert.rejects((await createSafari(short.io).launch()).newContext({ viewport: { width: 1280, height: 800 } }),
    /got 1280 × 629; screen available 1280 × 709\); choose a smaller web.viewport/);
  assert.deepEqual(short.world.closed, ["7"]);

  const german = fakeSafari({ language: "de-DE" });
  await assert.rejects((await createSafari(german.io).launch()).newContext({ locale: "en-US" }), /Safari's language is de-DE/);
  assert.deepEqual(german.world.closed, ["7"]);
});

test("the Safari page navigates, drives setup actions as page scripts, and scans with injected axe", async () => {
  const { io, world } = fakeSafari();
  const context = await (await createSafari(io).launch()).newContext({ locale: "en-US" });
  context.setDefaultTimeout(500);
  context.setDefaultNavigationTimeout(500);
  const page = await context.newPage();
  const response = await page.goto("http://127.0.0.1:3000/form");
  assert.equal(response.ok(), true);
  assert.equal(await page.url(), "http://127.0.0.1:3000/form");
  assert.equal((await page.goto("http://127.0.0.1:3000/missing")).ok(), false);
  await page.locator("#email").click();
  await page.locator("#email").fill("a@example.test");
  const email = world.document.elements["#email"];
  assert.deepEqual([email.focused, email.clicked, email.value, email.events], [true, 1, "a@example.test", ["input", "change"]]);
  assert.equal(await page.locator("#email").evaluate((el) => el.value), "a@example.test");
  await assert.rejects(page.locator("#missing").waitFor({ state: "visible" }), /#missing was not visible within 500ms/);
  await page.bringToFront();
  assert.equal(world.activated, 1);
  const result = await page.axe();
  assert.equal(result.testEngine.name, "axe-core");
  assert.equal(result.url, "http://127.0.0.1:3000/form");
  const shot = join(mkdtempSync(join(tmpdir(), "aloud-safari-shot-")), "shot.png");
  await page.screenshot({ path: shot });
  assert.deepEqual(world.shot, { path: shot, bounds: world.bounds });

  // A page that never loads times out instead of reading the old document.
  io.setUrl = async () => {};
  await assert.rejects(page.goto("http://127.0.0.1:3000/slow"), /did not load/);
  // Safari's own status, when it reports one, must be a success too.
  const failing = fakeSafari({ status: 500 });
  const failingPage = await (await (await createSafari(failing.io).launch()).newContext({})).newPage();
  assert.equal((await failingPage.goto("http://127.0.0.1:3000/")).ok(), false);
  // A different axe build in the page is refused.
  const drift = fakeSafari({ axeVersion: "4.9.0" });
  const driftPage = await (await (await createSafari(drift.io).launch()).newContext({})).newPage();
  await driftPage.goto("http://127.0.0.1:3000/");
  await assert.rejects(driftPage.axe(), /expected 4\.13\.0/);
});

// A tiny DOM for the outline, which normally runs inside Safari.
function text(value) { return { nodeType: 3, textContent: value }; }
function element(tagName, attributes = {}, children = [], extra = {}) {
  return {
    nodeType: 1, tagName, childNodes: children, ...extra,
    getAttribute: (key) => attributes[key] ?? null,
    hasAttribute: (key) => Object.hasOwn(attributes, key),
    get textContent() { return children.map((child) => child.textContent).join(""); },
  };
}

test("the Safari DOM outline lists roles, names, and states and skips hidden content", () => {
  const label = element("LABEL", { for: "email" }, [text("Email address")]);
  const body = element("BODY", {}, [
    element("MAIN", {}, [
      element("H1", {}, [text("Account")]),
      element("DIV", {}, [text("  Plain   words ")]),
      label,
      element("INPUT", { id: "email", type: "email" }, [], { labels: [label] }),
      element("INPUT", { type: "checkbox", "aria-label": "Remember me" }, [], { checked: true }),
      element("BUTTON", { "aria-expanded": "false" }, [text("Save email")], { disabled: true }),
      element("A", { href: "/help" }, [text("Help")]),
      element("A", {}, [text("Not a link")]),
      element("IMG", { alt: "" }),
      element("SECTION", {}, [text("Unnamed section")]),
      element("DIV", { role: "presentation" }, [element("SPAN", { role: "status" }, [text("Saved")])]),
      element("P", { "aria-hidden": "true" }, [text("Hidden")]),
      element("P", {}, [text("Styled away")], { style: { display: "none" } }),
      element("SCRIPT", {}, [text("ignored()")]),
    ]),
  ]);
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = { body, getElementById: () => null };
  globalThis.getComputedStyle = (el) => el.style ?? { display: "block", visibility: "visible" };
  try {
    assert.equal(domOutline(), [
      "- main",
      '  - heading "Account" [level=1]',
      '  - text: "Plain words"',
      '  - text: "Email address"',
      '  - textbox "Email address"',
      '  - checkbox "Remember me" [checked=true]',
      '  - button "Save email" [disabled, expanded=false]',
      '  - link "Help"',
      '  - text: "Not a link"',
      '  - text: "Unnamed section"',
      "  - status",
      '    - text: "Saved"',
    ].join("\n"));
  } finally {
    Object.assign(globalThis, saved);
    if (saved.document === undefined) delete globalThis.document;
    if (saved.getComputedStyle === undefined) delete globalThis.getComputedStyle;
  }
});

// ── wiring: config, evidence, report, capture ──

test("web config accepts voiceover, its cursor steps, and speech assertions on captured steps only", () => {
  const web = { ...structuredClone(WEB_DEFAULTS), url: "https://example.test/", screenReader: "voiceover" };
  assert.doesNotThrow(() => validateWebConfig(web));
  assert.throws(() => validateWebConfig({ ...web, screenReader: "jaws" }), /none, nvda, or voiceover/);
  assert.throws(() => validateWebConfig({ ...web, storageState: "auth.json" }), /storageState is not supported with voiceover/);
  const manifest = (steps) => [{ id: "flow", screens: [{ id: "form", url: "/form", steps }] }];
  assert.doesNotThrow(() => webScreens(web, manifest([
    { action: "press", key: "Tab", expect: { speechIncludes: "Save" } },
    { action: "voiceover", command: "interact", expect: { speechIncludes: "group" } },
    { action: "voiceover", command: "stopInteracting" },
  ])));
  for (const steps of [
    [{ action: "voiceover", command: "eval" }],
    [{ action: "nvda", command: "next" }],
    [{ action: "voiceover" }],
    [{ action: "click", selector: "#save", expect: { speechIncludes: "Saved" } }],
  ]) assert.throws(() => webScreens(web, manifest(steps)));
  // NVDA runs keep their own command list; VoiceOver steps are refused there.
  assert.throws(() => webScreens({ ...web, screenReader: "nvda" }, manifest([{ action: "voiceover", command: "next" }])), /requires VoiceOver/);
  assert.throws(() => webScreens({ ...web, screenReader: "nvda" }, manifest([{ action: "nvda", command: "interact" }])), /requires NVDA/);
  assert.throws(() => webScreens({ ...web, screenReader: "none" }, manifest([{ action: "voiceover", command: "next" }])), /requires VoiceOver/);
});

function voiceOverFixture() {
  const screen = { id: "home", url: "https://example.test/", expectedUrl: "https://example.test/", steps: [
    { action: "press", key: "Tab", expect: { speechIncludes: "Save" } },
    { action: "voiceover", command: "next" },
    { action: "click", selector: "#email" },
  ] };
  const run = { schemaVersion: 1, platform: "web", runId: "fixture", status: "completed", cleanupComplete: true,
    generated: "2026-09-30T00:00:00Z", receipts: {}, screens: [screen],
    environment: { os: "darwin", osVersion: "25.0.0", browser: "safari", browserVersion: "26.0", axeInjection: "apple-events",
      axe: "4.13.0", screenReader: "voiceover", screenReaderVersion: "fixture-voiceover", guidepup: "0.34.0",
      locale: "en-US", viewport: { width: 1280, height: 800 }, headless: false } };
  const capture = { schemaVersion: 1, platform: "web", runId: "fixture", screen: "home", title: "Home", status: "completed",
    requestedUrl: screen.url, url: screen.url, speechSource: "voiceover-guidepup", navigationSpeech: ["Home, web content"],
    steps: [
      { sequence: 0, action: screen.steps[0], completed: true, speech: ["Save, button"], focused: null, assertionsPassed: true, sentKey: "Option+Tab" },
      { sequence: 1, action: screen.steps[1], completed: true, speech: ["Help, link"], focused: null, assertionsPassed: true },
      { sequence: 2, action: screen.steps[2], completed: true, speech: [], focused: null, assertionsPassed: true },
    ],
    ariaSnapshot: '- heading "Home" [level=1]', snapshotSource: "safari-dom-outline",
    coverage: { scope: "scripted-scenario", scenarioComplete: true, fullTraversal: false },
    axe: { ...structuredClone(AXE_RESULT), url: screen.url } };
  return { run, screen, capture };
}

test("VoiceOver evidence carries its speech source, sent keys, and Safari outline, and cannot borrow another reader's", () => {
  const { run, screen, capture } = voiceOverFixture();
  assert.doesNotThrow(() => validateWebCapture(capture, run, screen));
  for (const mutate of [
    (c) => { c.speechSource = "nvda-guidepup"; },
    (c) => { c.snapshotSource = "playwright-aria-snapshot"; },
    (c) => { delete c.steps[0].sentKey; },
    (c) => { c.steps[0].sentKey = "Tab"; },
    (c) => { c.steps[1].sentKey = "Option+Tab"; },
    (c) => { c.steps[2].speech = ["invented"]; },
    (c) => { c.steps[0].speech = ["Cancel, button"]; },
  ]) {
    const changed = structuredClone(capture);
    mutate(changed);
    assert.throws(() => validateWebCapture(changed, run, screen));
  }
  // A Chromium run cannot claim a Safari outline, and NVDA cannot claim VoiceOver speech.
  assert.throws(() => validateWebCapture(capture, { ...run, environment: { ...run.environment, screenReader: "nvda" } }, screen));
});

test("persisted VoiceOver runs require Safari provenance and render their own speech note", () => {
  const { run, capture } = voiceOverFixture();
  const dir = mkdtempSync(join(tmpdir(), "aloud-web-voiceover-"));
  const write = (value) => writeFileSync(join(dir, "web-run.json"), JSON.stringify(value));
  try {
    mkdirSync(join(dir, "shots"));
    writeFileSync(join(dir, "home.web.json"), JSON.stringify(capture));
    writeFileSync(join(dir, "shots", "home.png"), "fixture image");
    run.receipts.home = { capture: hash(readFileSync(join(dir, "home.web.json"))), screenshot: hash("fixture image") };
    write(run);
    const evidence = readWebReport(dir);
    assert.equal(webSummary(evidence).screens.home.utterances, 3);
    const html = renderWebReport(evidence);
    assert.match(html, /VoiceOver fixture-voiceover · Guidepup 0\.34\.0/);
    assert.match(html, /sent as Option\+Tab/);
    assert.match(html, /Speech after the page loaded \(no command sent\)/);
    assert.match(html, /Structural DOM outline/);
    assert.match(html, /injected through Apple Events/);
    assert.doesNotMatch(html, /Initial NVDA command/);
    for (const env of [
      { ...run.environment, browser: "chromium" },
      { ...run.environment, os: "linux" },
      { ...run.environment, screenReaderVersion: "" },
      { ...run.environment, playwright: "1.63.0" },
      { ...run.environment, axeInjection: undefined },
    ]) {
      write({ ...run, environment: env });
      assert.throws(() => readWebReport(dir), /invalid web evidence/);
    }
    write(run);
    const acr = buildAcr({ appName: "Fixture", productVersion: "1", date: "2026-09-30", web: webSummary(readWebReport(dir)) });
    assert.match(acr.notes, /VoiceOver command output formatted by Guidepup/);
    // The ACR carries the same Safari limits as the HTML report.
    assert.match(acr.notes, /untrusted page scripts/);
    assert.match(acr.notes, /Option\+Tab/);
    assert.match(acr.notes, /DOM outline, not Safari's accessibility tree/);
    assert.throws(() => buildAcr({ appName: "Fixture", productVersion: "1", date: "2026-09-30",
      web: { ...webSummary(evidence), environment: { ...run.environment, screenReader: "jaws" } } }), /unknown screen reader/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("aloud web refuses VoiceOver on a developer desktop before touching output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aloud-web-voiceover-guard-"));
  const saved = process.env.ALOUD_ALLOW_NATIVE_DESKTOP;
  delete process.env.ALOUD_ALLOW_NATIVE_DESKTOP;
  try {
    const cfg = loadConfig(undefined, { out: dir, web: { url: "http://127.0.0.1:3000/", screenReader: "voiceover" } });
    await assert.rejects(captureWeb(cfg), /Experimental VoiceOver capture/);
    assert.equal(existsSync(join(dir, "web")), false);
  } finally {
    if (saved !== undefined) process.env.ALOUD_ALLOW_NATIVE_DESKTOP = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a VoiceOver capture drives Safari and VoiceOver end to end with fakes and produces verified evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aloud-web-voiceover-run-"));
  const body = element("BODY", {}, [element("MAIN", {}, [element("H1", {}, [text("Account settings")])])]);
  const { io: safariIo, world } = fakeSafari({ body });
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io, log: ["Save email, button"] });
  const url = "http://127.0.0.1:3000/";
  const screens = join(dir, "screens.json");
  writeFileSync(screens, JSON.stringify([{ id: "voiceover", screens: [{ id: "form", url, steps: [
    { action: "click", selector: "#email" },
    { action: "press", key: "Shift+Tab", expect: { speechIncludes: "Save email" } },
    { action: "voiceover", command: "next" },
    { action: "press", key: "Enter", listenMs: 1500, expect: { speechIncludes: "Save email" } },
  ] }] }]));
  try {
    const cfg = loadConfig(undefined, { out: dir, web: { screens, screenReader: "voiceover", timeoutMs: 1000 } });
    const out = await captureWeb(cfg, { flow: ["voiceover"], dependencies: {
      platform: "darwin",
      safari: createSafari(safariIo),
      startReader: () => startVoiceOver({ env: HOSTED, platform: "darwin", io, guidepup: guidepup(voiceOver) }),
    } });
    const { run, screens: captured } = readWebReport(out);
    assert.equal(run.environment.browser, "safari");
    assert.equal(run.environment.browserVersion, "26.0");
    assert.equal(run.environment.screenReaderVersion, "fixture-voiceover");
    assert.equal(run.environment.playwright, undefined);
    assert.equal(run.provenance.tools.safari, "26.0");
    assert.equal(run.provenance.tools.voiceover, "fixture-voiceover");
    assert.equal(run.provenance.tools.playwright, undefined);
    const form = captured.form;
    assert.equal(form.speechSource, "voiceover-guidepup");
    assert.equal(form.snapshotSource, "safari-dom-outline");
    assert.equal(form.ariaSnapshot, '- main\n  - heading "Account settings" [level=1]');
    assert.deepEqual(form.steps.map((step) => [step.sentKey, step.speech]), [
      [undefined, []], ["Option+Shift+Tab", ["Save email, button"]], [undefined, ["Save email, button"]],
      ["Enter", ["Save email, button"]],
    ]);
    // The listen step typed its key through the operating system.
    assert.deepEqual(io.sent.map(([key]) => key), ["Enter"]);
    assert.ok(io.slept.includes(1500));
    assert.ok(voiceOver.calls.some((call) => call[0] === "press" && call[1] === "Option+Shift+Tab"));
    assert.equal(world.document.elements["#email"].clicked, 1);
    // Cleanup stopped the reader and closed the owned window.
    assert.ok(voiceOver.calls.some(([name]) => name === "stop"));
    assert.deepEqual(world.closed, ["7"]);
    assert.ok(existsSync(join(out, "index.html")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── review fixes ──

test("the page JavaScript AppleScript never names a variable after Safari's source property", () => {
  // Inside `tell application "Safari"`, `source` is the page's HTML, not a
  // local variable, so `do JavaScript source` would not run the file.
  assert.doesNotMatch(javascriptScript, /\bsource\b/);
  assert.match(javascriptScript, /set aloudScript to read \(POSIX file \(item 2 of argv\)\) as «class utf8»/);
  assert.match(javascriptScript, /do JavaScript aloudScript in current tab of w/);
});

test("the Safari status preflight is bounded, cancels its body, and explains a failure", async () => {
  let cancelled = 0, seen;
  const answering = { fetch: async (url, options) => {
    seen = options;
    return { ok: true, status: 200, body: { cancel: async () => { cancelled++; } } };
  } };
  assert.deepEqual(await preflightRequest(answering, "http://127.0.0.1:3000/", 1000), { ok: true, status: 200 });
  assert.ok(seen.signal instanceof AbortSignal);
  assert.equal(cancelled, 1);
  // A server that accepts the connection and never answers.
  const stalled = { fetch: (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  }) };
  await assert.rejects(preflightRequest(stalled, "http://127.0.0.1:3000/", 30), /no response within 30ms/);
  const untrusted = { fetch: async () => { throw new TypeError("fetch failed: self-signed certificate"); } };
  await assert.rejects(preflightRequest(untrusted, "https://localhost/", 1000), /could not request https:\/\/localhost\/ from Node.*self-signed/);
});

test("a Safari goto that changes only the fragment waits for the URL, not a new document", async () => {
  assert.equal(sameDocumentUrl("https://a.test/app/", "https://a.test/app/#/completed"), true);
  assert.equal(sameDocumentUrl("https://a.test/app/#/active", "https://a.test/app/#/completed"), true);
  assert.equal(sameDocumentUrl("https://a.test/app/#/completed", "https://a.test/app/#/completed"), true);
  // Leaving the fragment off, or changing the path or query, loads a document.
  assert.equal(sameDocumentUrl("https://a.test/app/#/completed", "https://a.test/app/"), false);
  assert.equal(sameDocumentUrl("https://a.test/app/", "https://a.test/other/#x"), false);
  assert.equal(sameDocumentUrl("https://a.test/app/?a=1", "https://a.test/app/?a=2#x"), false);
  assert.equal(sameDocumentUrl("about:blank", "https://a.test/#x"), false);

  const { io, world } = fakeSafari();
  // Safari keeps the document for a fragment change, as a browser does.
  const load = io.setUrl;
  io.setUrl = async (id, url) => {
    if (sameDocumentUrl(world.document.URL, url)) world.document.URL = url;
    else await load(id, url);
  };
  const context = await (await createSafari(io).launch()).newContext({});
  context.setDefaultNavigationTimeout(500);
  const page = await context.newPage();
  const app = "http://127.0.0.1:3000/app/";
  assert.equal((await page.goto(app)).ok(), true);
  const before = world.document;
  assert.equal((await page.goto(`${app}#/completed`)).ok(), true);
  assert.equal(world.document, before);
  assert.equal(await page.url(), `${app}#/completed`);
  assert.equal(world.document.aloudPrevious, undefined);
  // A later full navigation still waits for the new document.
  assert.equal((await page.goto(app)).ok(), true);
  assert.notEqual(world.document, before);
});

test("a failed VoiceOver start does not report Guidepup's not-running stop as a cleanup failure", async () => {
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io, startFailures: 5 });
  // Guidepup 0.34.0 throws from stop() whenever no start() resolved.
  voiceOver.stop = async () => { voiceOver.calls.push(["stop"]); throw new Error("VoiceOver not running"); };
  const error = await start(io, voiceOver).catch((failure) => failure);
  assert.match(error.message, /VoiceOver did not start/);
  assert.doesNotMatch(error.message, /cleanup after failed startup also failed/);
  assert.equal(voiceOver.calls.some(([name]) => name === "stop"), false);

  // A process that survives cleanup is still reported.
  const stuck = fakeIo();
  stuck.kill = () => {};
  const leaky = fakeVoiceOver({ io: stuck });
  leaky.start = async () => { stuck.table.set(900, `now ${VO}`); throw new Error("VoiceOver not ready (-600)"); };
  await assert.rejects(start(stuck, leaky), /cleanup after failed startup also failed/);
});

test("the DOM outline uses ARIA's default heading level, scopes headers, and keeps visible children of hidden parents", () => {
  const body = element("BODY", {}, [
    element("HEADER", {}, [text("Site")]),
    element("DIV", { role: "heading" }, [text("Step 2")]),
    element("SPAN", { role: "heading", "aria-level": "3" }, [text("Details")]),
    element("ARTICLE", {}, [element("HEADER", {}, [text("Post header")]), element("FOOTER", {}, [text("Post footer")])]),
    element("DIV", { role: "region", "aria-label": "News" }, [element("FOOTER", {}, [text("Region footer")])]),
    element("FOOTER", {}, [text("Legal")]),
    element("DIV", {}, [text("Invisible words"), element("BUTTON", {}, [text("Shown again")], { style: { display: "block", visibility: "visible" } })],
      { style: { display: "block", visibility: "hidden" } }),
  ]);
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = { body, getElementById: () => null };
  globalThis.getComputedStyle = (el) => el.style ?? { display: "block", visibility: "visible" };
  try {
    assert.equal(domOutline(), [
      "- banner",
      '  - text: "Site"',
      '- heading "Step 2" [level=2]',
      '- heading "Details" [level=3]',
      "- article",
      '  - text: "Post header"',
      '  - text: "Post footer"',
      '- region "News"',
      '  - text: "Region footer"',
      "- contentinfo",
      '  - text: "Legal"',
      '- button "Shown again"',
    ].join("\n"));
  } finally {
    Object.assign(globalThis, saved);
    if (saved.document === undefined) delete globalThis.document;
    if (saved.getComputedStyle === undefined) delete globalThis.getComputedStyle;
  }
});

test("VoiceOver press steps can hold a capture open with listenMs, through an allowed operating-system key", async () => {
  // Config: only VoiceOver press steps, bounded windows, and simple keys.
  const web = { ...structuredClone(WEB_DEFAULTS), url: "https://example.test/", screenReader: "voiceover" };
  const manifest = (steps) => [{ id: "flow", screens: [{ id: "form", url: "/form", steps }] }];
  assert.doesNotThrow(() => webScreens(web, manifest([{ action: "press", key: "x", listenMs: 2500, expect: { speechIncludes: "over" } }])));
  for (const [step, pattern] of [
    [{ action: "press", key: "Tab", listenMs: 2000 }, /accepts only a letter/],
    [{ action: "press", key: "Enter", listenMs: 500 }, /from 1000 to 30000/],
    [{ action: "press", key: "Enter", listenMs: 1500.5 }, /from 1000 to 30000/],
    [{ action: "voiceover", command: "next", listenMs: 2000 }, /valid only for press/],
  ]) assert.throws(() => webScreens(web, manifest([step])), pattern);
  assert.throws(() => webScreens({ ...web, screenReader: "nvda" }, manifest([{ action: "press", key: "Enter", listenMs: 2000 }])), /requires web.screenReader voiceover/);

  // The key script: letters, digits and named keys only.
  assert.equal(macosKeyScript("x"), 'tell application "Safari" to activate\ntell application "System Events" to keystroke "x"');
  assert.match(macosKeyScript("Enter"), /key code 36$/);
  assert.match(macosKeyScript("Space"), /key code 49$/);
  for (const key of ['"', "Tab", "xy", "", undefined]) assert.throws(() => macosKeyScript(key), /unsupported operating system key/);

  // The listen window: settle, clear once, then one capture around the key and the wait.
  const io = fakeIo();
  const voiceOver = fakeVoiceOver({ io, log: ["1 character over"] });
  const reader = await start(io, voiceOver);
  voiceOver.calls.length = 0;
  assert.deepEqual(await voiceOverListen(reader, "x", 2500, 1000), ["1 character over"]);
  assert.deepEqual(voiceOver.calls.map(([name]) => name), ["clear", "capture", "clear", "capture"]);
  assert.deepEqual(io.sent.map(([key]) => key), ["x"]);
  assert.equal(io.slept.at(-1), 2500);
  await assert.rejects(voiceOverListen(reader, "Tab", 2500, 1000), /unsupported operating system key/);
  await assert.rejects(voiceOverListen(reader, "x", 10, 1000), /listen window/);
  await stopVoiceOver(reader);
  await assert.rejects(voiceOverListen(reader, "x", 2500, 1000), /not started by startVoiceOver/);
});

test("the VoiceOver driver and the config share one cursor command list", () => {
  assert.equal(VOICEOVER_COMMANDS, READER_STEP_COMMANDS.voiceover);
});
