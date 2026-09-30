// Device-free tests for the experimental Safari + VoiceOver web driver.
// Every operating-system call is a fake: nothing here starts VoiceOver,
// opens Safari, or runs osascript.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SETTLE, assertNativeDesktop, awaitQuiet, matchingOwnedProcesses, parseVoiceOverProcesses, resetVoiceOverTimeoutForTests,
  safariKey, settleVoiceOver, speechLog, startVoiceOver, stopOwnedVoiceOver, stopVoiceOver, voiceOverCommand, withAttempts,
} from "../src/web/voiceover.mjs";
import { createSafari, domOutline, pageResult, pageScript } from "../src/web/safari.mjs";

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
    voiceOverProcesses: async () => new Map(io.table),
    kill: (pid, signal) => { io.killed.push([pid, signal]); io.table.delete(pid); },
    lastPhrase: async () => phrases[0],
  };
  return io;
}

// A Guidepup-shaped VoiceOver that records every call, in order.
function fakeVoiceOver({ io, startFailures = 0, log = ["Button, Save"] } = {}) {
  const calls = [];
  let failures = startFailures;
  const reader = {
    calls,
    log,
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
    next: async (options) => { calls.push(["next", options]); },
    interact: async (options) => { calls.push(["interact", options]); },
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
function fakeSafari({ language = "en-US", chrome = [0, 80], status = 200, axeVersion = "4.13.0" } = {}) {
  const world = { windows: [], closed: [], activated: 0, bounds: [0, 0, 0, 0], scripts: 0 };
  const makeDocument = (url) => {
    const elements = { "#email": { tagName: "INPUT", value: "", focused: false, clicked: 0, visible: true, events: [] } };
    for (const el of Object.values(elements)) {
      Object.assign(el, {
        scrollIntoView() {}, focus() { el.focused = true; }, click() { el.clicked++; },
        getClientRects: () => (el.visible ? [{}] : []), dispatchEvent: (event) => el.events.push(event.type),
      });
    }
    return { URL: url, readyState: "complete", elements, querySelector: (sel) => elements[sel] ?? null, hasFocus: () => true };
  };
  world.document = makeDocument("about:blank");
  world.window = {};
  const io = {
    ...fakeClock(),
    version: async () => "26.0",
    openWindow: async () => { world.windows.push("7"); return "7"; },
    closeWindow: async (id) => { world.closed.push(id); },
    setBounds: async (id, bounds) => { world.bounds = bounds; },
    bounds: async () => world.bounds,
    activate: async () => { world.activated++; },
    setUrl: async (id, url) => { world.document = makeDocument(url); world.window = {}; },
    javascript: async (id, source) => {
      world.scripts++;
      const { document, window } = world;
      const navigator = { language };
      const performance = { getEntriesByType: () => [{ responseStatus: status }] };
      const getComputedStyle = () => ({ visibility: "visible" });
      const innerWidth = world.bounds[2] - chrome[0], innerHeight = world.bounds[3] - chrome[1];
      Object.assign(window, { innerWidth, innerHeight });
      return String(new Function("document", "window", "navigator", "performance", "getComputedStyle", "Event",
        `return ${source}`)(document, window, navigator, performance, getComputedStyle, class { constructor(type) { this.type = type; } }));
    },
    screenshot: async (path, bounds) => { world.shot = { path, bounds }; },
    fetch: async (url) => ({ ok: !url.includes("missing"), status: url.includes("missing") ? 404 : 200 }),
    axeSource: () => ({
      version: "4.13.0",
      source: `window.axe = { version: "${axeVersion}", run: async () => ({ testEngine: { name: "axe-core", version: "4.13.0" }, url: document.URL, violations: [] }) }`,
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
  await page.screenshot({ path: "/tmp/shot.png" });
  assert.deepEqual(world.shot, { path: "/tmp/shot.png", bounds: world.bounds });

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
const text = (value) => ({ nodeType: 3, textContent: value });
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
