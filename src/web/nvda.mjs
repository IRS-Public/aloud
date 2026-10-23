import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LISTEN_MS, listenKey } from "./config.mjs";
import { webDependency } from "./dependencies.mjs";

// Experimental Windows NVDA capture for Chromium, parallel to voiceover.mjs:
// startNvda, nvdaCommand, nvdaListen, nvdaPassNextKey and stopNvda.
// Guidepup captures text around its own commands. It normalizes whitespace
// and joins phrases upstream; these are command logs, never raw audio or an
// independent proof of complete speech delivery. Playwright setup actions
// are deliberately not presented as recorded screen-reader interactions.
//
// Every operating-system touch (tasklist, cscript, timers) goes through an
// injectable `io` so the logic below is unit-tested without NVDA. Ported
// from the USWDS accessibility harness's native driver.

const run = promisify(execFile);

// Guidepup's stop returns before nvda.exe has exited, and a start refuses to
// replace a running NVDA, so a stop waits for the process to be gone: 40
// polls of 250 ms, ten seconds.
export const NVDA_EXIT = { attempts: 40, pollMs: 250 };

// Guidepup's start has timed out on hosted Windows machines now and then,
// and a start after a stop has passed, so startup gets two attempts, each
// under its own deadline, with a stop and the exit wait after each failure.
// Guidepup's start waits up to 30 seconds for nvda.exe, twice, so the
// deadline of a minute lets it finish its own retry. A start that misses
// its deadline is still running inside Guidepup, which refuses another
// start (and a stop) until it settles, so it gets `settleMs` more first.
export const NVDA_START = { attempts: 2, timeoutMs: 60000, settleMs: 15000 };

const sessions = new WeakMap();

// A timed-out Guidepup action keeps running, and Guidepup's log reads and
// clears wait for every action, with no limit. A reader with a timed-out
// command therefore takes no more commands until it is started again.
const stuck = new WeakSet();

// The keys SendKeys may receive: letters, digits and these named keys, so
// no caller text reaches the script.
const NAMED_KEYS = { Backspace: "{BACKSPACE}", Enter: "{ENTER}", Space: " " };

function scriptKey(key) {
  if (Object.hasOwn(NAMED_KEYS, key)) return NAMED_KEYS[key];
  if (/^[a-z0-9]$/i.test(key)) return key;
  throw new Error(`unsupported operating system key: ${JSON.stringify(key)}`);
}

// VBScript for cscript.exe: SendKeys types into the foreground window, so the
// reader hears the key and the browser receives a trusted key event. The
// macOS counterpart is voiceover.mjs's macosKeyScript.
export function windowsKeyScript(key) {
  return `CreateObject("WScript.Shell").SendKeys "${scriptKey(key)}"`;
}

// Guidepup's press has key codes for letters, digits, named keys and a
// handful of punctuation (NVDA has none for "/" or ";"), and silently sends
// nothing for the rest, so a single character that is not a letter or a
// digit is typed instead.
export const isTypedCharacter = (key) => typeof key === "string" && key.length === 1 && !/^[A-Za-z0-9]$/.test(key);

export function systemIo() {
  return {
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    nvdaRunning: () =>
      /"nvda\.exe"/i.test(
        execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq nvda.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" }),
      ),
    // Asynchronous, so Guidepup keeps polling speech while cscript runs.
    sendKey: async (key) => {
      const dir = mkdtempSync(join(tmpdir(), "aloud-key-"));
      try {
        const script = join(dir, "key.vbs");
        writeFileSync(script, windowsKeyScript(key));
        await run("cscript.exe", ["//NoLogo", script], { timeout: 15000 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

const text = (value) => typeof value === "string" && value.trim().length > 0;

// Rejects after `ms`, calling `onTimeout` first. A timed-out Guidepup action
// is never retried or promoted to complete.
async function deadline(operation, ms, label, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => { onTimeout(); reject(new Error(`${label} timed out; capture is incomplete`)); }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function refuseStuck(reader) {
  if (stuck.has(reader)) throw new Error("an earlier NVDA command timed out and may still be running; stop and start NVDA before sending another");
}

// Failure context for each capture a command returned, keyed by the
// returned array: the command and, when it settled first, the speech that
// settle discarded. The same shape as voiceover.mjs's captureContext,
// without the cursor item NVDA does not report.
const contexts = new WeakMap();
export const captureContext = (phrases) => contexts.get(phrases);
function recordContext(phrases, command, settled) {
  contexts.set(phrases, { command, ...(settled && { settled }) });
  return phrases;
}

function speechLog(phrases) {
  if (!Array.isArray(phrases) || !phrases.every((s) => typeof s === "string")) throw new Error("invalid Guidepup speech log");
  return [...phrases];
}

// Starts NVDA through Guidepup on a dedicated Windows desktop. An NVDA that
// is already running is never replaced: capture would take over someone's
// session, and Guidepup's stop would end it. Every failed attempt, the last
// one included, is stopped and waited out, so a failed start does not leave
// nvda.exe running for the next one to refuse.
export async function startNvda({
  io = systemIo(), platform = process.platform, guidepup,
  attempts = NVDA_START.attempts, timeoutMs = NVDA_START.timeoutMs, settleMs = NVDA_START.settleMs,
} = {}) {
  if (platform !== "win32") throw new Error("Experimental NVDA capture requires a dedicated Windows desktop; use --screen-reader none for structural checks");
  if (io.nvdaRunning()) throw new Error("NVDA is already running; use a dedicated test desktop so capture does not replace an existing screen-reader session");
  const { nvda } = guidepup ?? (await webDependency("@guidepup/guidepup"));
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const start = nvda.start({ capture: true });
    try {
      await deadline(start, timeoutMs, "NVDA startup");
      sessions.set(nvda, { io });
      stuck.delete(nvda);
      return nvda;
    } catch (error) {
      errors.push(error);
    }
    // A start that is still pending can be neither stopped nor retried.
    if (!(await settles(start, settleMs))) {
      throw new AggregateError(errors, `NVDA startup was still pending ${settleMs} ms after its deadline; dedicated test desktop needs recovery`);
    }
    if (!(await stopAfterFailedStart(nvda, io)) && attempt === attempts) {
      throw new AggregateError(errors, `NVDA did not start in ${attempts} attempts, and nvda.exe did not exit; dedicated test desktop needs recovery`);
    }
  }
  throw new AggregateError(errors, `NVDA did not start in ${attempts} attempts`);
}

// Whether `operation` settles, either way, within `ms`.
async function settles(operation, ms) {
  try {
    await deadline(operation.then(() => {}, () => {}), ms, "NVDA startup settling");
    return true;
  } catch {
    return false;
  }
}

// A start that failed, or succeeded after its deadline, may have left
// nvda.exe running; stop it, ignoring a reader that refuses because it
// never started, and wait for it to exit. Returns whether it exited.
async function stopAfterFailedStart(nvda, io) {
  try {
    await deadline(nvda.stop(), 10000, "NVDA stop after a failed start");
  } catch {
    // Nothing to stop, or a stop that hung; the exit wait decides.
  }
  for (let attempt = 0; attempt < NVDA_EXIT.attempts; attempt++) {
    if (!io.nvdaRunning()) return true;
    await io.sleep(NVDA_EXIT.pollMs);
  }
  return !io.nvdaRunning();
}

// NVDA's capture restarts its own one-second wait on each phrase, so a
// settle that waits a fixed SETTLE_MS inside a capture lets pending speech
// finish there.
export const NVDA_SETTLE_MS = 1500;

// Let pending speech, such as a page load's, finish inside its own capture,
// and return it, so it never lands in the next command's log. An `action`,
// such as a navigation, runs inside the capture before the wait, so what it
// makes NVDA say is discarded with the rest. Ported from the harness's
// settle. Never retried.
export async function settleNvda(reader, timeoutMs, { action = async () => {} } = {}) {
  const io = sessions.get(reader)?.io ?? systemIo();
  refuseStuck(reader);
  return deadline((async () => {
    await reader.clearSpokenPhraseLog();
    await reader.capture(async () => {
      await action();
      await io.sleep(NVDA_SETTLE_MS);
    }, { capture: true });
    return speechLog(await reader.spokenPhraseLog());
  })(), timeoutMs + NVDA_SETTLE_MS, "NVDA settle", () => stuck.add(reader));
}

// Send one command and return its captured speech. `press` sends a key,
// except a single character that is not a letter or a digit, which is typed
// (see isTypedCharacter); `type` types text; any other command is one of
// Guidepup's cursor commands. The returned capture's context is in
// captureContext. With `{ settle: true }` it settles first (see settleNvda),
// and the context keeps what that settle discarded. Never retried.
export async function nvdaCommand(reader, command, argument, timeoutMs, { settle = false } = {}) {
  if ((command === "press" || command === "type") && !text(argument)) {
    throw new Error(`NVDA ${command} requires ${command === "press" ? "a key" : "text"}`);
  }
  refuseStuck(reader);
  const settled = settle ? await settleNvda(reader, timeoutMs) : undefined;
  await reader.clearSpokenPhraseLog();
  const typed = command === "type" || (command === "press" && isTypedCharacter(argument));
  const action = typed
    ? reader.type(argument, { capture: true })
    : command === "press"
      ? reader.press(argument, { capture: true })
      : reader[command]({ capture: true });
  await deadline(action, timeoutMs, `NVDA ${command}`, () => stuck.add(reader));
  const label = typed ? `type ${JSON.stringify(argument)}` : command === "press" ? `press ${argument}` : command;
  return recordContext(speechLog(await reader.spokenPhraseLog()), label, settled);
}

// Press `key` through Windows inside one capture that stays open
// `milliseconds` after it, and return that capture's speech. Guidepup ends
// its own captures after about a second of quiet, so an announcement a
// product delays longer (a debounced live region) needs this window. The
// key goes around Guidepup because a key sent through the reader waits
// behind the open capture. `settle` works as in nvdaCommand. Never retried.
export async function nvdaListen(reader, key, milliseconds, timeoutMs, { settle = false } = {}) {
  const io = sessions.get(reader)?.io ?? systemIo();
  if (!listenKey(key)) throw new Error(`NVDA listen key must be a letter, a digit or one of the named keys, not ${JSON.stringify(key)}`);
  if (!Number.isInteger(milliseconds) || milliseconds < LISTEN_MS.min || milliseconds > LISTEN_MS.max) {
    throw new Error(`NVDA listen window must be an integer from ${LISTEN_MS.min} to ${LISTEN_MS.max} ms`);
  }
  refuseStuck(reader);
  const settled = settle ? await settleNvda(reader, timeoutMs) : undefined;
  await reader.clearSpokenPhraseLog();
  await deadline(
    reader.capture(async () => {
      await io.sendKey(key);
      await io.sleep(milliseconds);
    }, { capture: true }),
    milliseconds + timeoutMs,
    `NVDA press ${key} with listen window`,
    () => stuck.add(reader),
  );
  return recordContext(speechLog(await reader.spokenPhraseLog()), `press ${key} for ${milliseconds} ms`, settled);
}

// Tell NVDA to pass the next key to the browser untouched, for a key NVDA
// would otherwise take in browse mode; the key itself follows as a `press`.
// Returns the capture around the command. `settle` works as in nvdaCommand.
// Never retried.
export async function nvdaPassNextKey(reader, timeoutMs, { settle = false } = {}) {
  refuseStuck(reader);
  const settled = settle ? await settleNvda(reader, timeoutMs) : undefined;
  await reader.clearSpokenPhraseLog();
  await deadline(
    reader.perform(reader.keyboardCommands.ignoreNextKeyCombination, { capture: true }),
    timeoutMs,
    "NVDA pass next key",
    () => stuck.add(reader),
  );
  return recordContext(speechLog(await reader.spokenPhraseLog()), "pass next key", settled);
}

// Stops Guidepup's reader, then waits for nvda.exe to exit, because the next
// start refuses to replace a running NVDA. A reader this module did not
// start is stopped without the wait.
export async function stopNvda(reader, timeoutMs = 10000) {
  let timer;
  try {
    await Promise.race([reader.stop(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("NVDA cleanup timed out; dedicated test desktop needs recovery")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
  const io = sessions.get(reader)?.io;
  if (!io) return;
  for (let attempt = 0; attempt < NVDA_EXIT.attempts; attempt++) {
    if (!io.nvdaRunning()) return;
    await io.sleep(NVDA_EXIT.pollMs);
  }
  throw new Error("NVDA started by this run did not stop; dedicated test desktop needs recovery");
}
