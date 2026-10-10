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
// under its own deadline, with a stop and the exit wait between them.
export const NVDA_START = { attempts: 2, timeoutMs: 30000 };

const sessions = new WeakMap();

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

// Rejects after `ms`. A timed-out Guidepup action is never retried or
// promoted to complete.
async function deadline(operation, ms, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out; capture is incomplete`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function speechLog(phrases) {
  if (!Array.isArray(phrases) || !phrases.every((s) => typeof s === "string")) throw new Error("invalid Guidepup speech log");
  return [...phrases];
}

// Starts NVDA through Guidepup on a dedicated Windows desktop. An NVDA that
// is already running is never replaced: capture would take over someone's
// session, and Guidepup's stop would end it.
export async function startNvda({
  io = systemIo(), platform = process.platform, guidepup, attempts = NVDA_START.attempts, timeoutMs = NVDA_START.timeoutMs,
} = {}) {
  if (platform !== "win32") throw new Error("Experimental NVDA capture requires a dedicated Windows desktop; use --screen-reader none for structural checks");
  if (io.nvdaRunning()) throw new Error("NVDA is already running; use a dedicated test desktop so capture does not replace an existing screen-reader session");
  const { nvda } = guidepup ?? (await webDependency("@guidepup/guidepup"));
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await deadline(nvda.start({ capture: true }), timeoutMs, "NVDA startup");
      sessions.set(nvda, { io });
      return nvda;
    } catch (error) {
      errors.push(error);
      if (attempt < attempts) await stopAfterFailedStart(nvda, io);
    }
  }
  throw new AggregateError(errors, `NVDA did not start in ${attempts} attempts`);
}

// A start that failed may have left nvda.exe running; stop it, ignoring a
// reader that refuses because it never started, and wait for it to exit.
async function stopAfterFailedStart(nvda, io) {
  try {
    await deadline(nvda.stop(), 10000, "NVDA stop after a failed start");
  } catch {
    // Nothing to stop, or a stop that hung; the exit wait decides.
  }
  for (let attempt = 0; attempt < NVDA_EXIT.attempts && io.nvdaRunning(); attempt++) await io.sleep(NVDA_EXIT.pollMs);
}

// Send one command and return its captured speech. `press` sends a key,
// except a single character that is not a letter or a digit, which is typed
// (see isTypedCharacter); `type` types text; any other command is one of
// Guidepup's cursor commands. Never retried.
export async function nvdaCommand(reader, command, argument, timeoutMs) {
  if ((command === "press" || command === "type") && !text(argument)) {
    throw new Error(`NVDA ${command} requires ${command === "press" ? "a key" : "text"}`);
  }
  await reader.clearSpokenPhraseLog();
  const typed = command === "type" || (command === "press" && isTypedCharacter(argument));
  const action = typed
    ? reader.type(argument, { capture: true })
    : command === "press"
      ? reader.press(argument, { capture: true })
      : reader[command]({ capture: true });
  await deadline(action, timeoutMs, `NVDA ${command}`);
  return speechLog(await reader.spokenPhraseLog());
}

// Press `key` through Windows inside one capture that stays open
// `milliseconds` after it, and return that capture's speech. Guidepup ends
// its own captures after about a second of quiet, so an announcement a
// product delays longer (a debounced live region) needs this window. The
// key goes around Guidepup because a key sent through the reader waits
// behind the open capture. Never retried.
export async function nvdaListen(reader, key, milliseconds, timeoutMs) {
  const io = sessions.get(reader)?.io ?? systemIo();
  if (!listenKey(key)) throw new Error(`NVDA listen key must be a letter, a digit or one of the named keys, not ${JSON.stringify(key)}`);
  if (!Number.isInteger(milliseconds) || milliseconds < LISTEN_MS.min || milliseconds > LISTEN_MS.max) {
    throw new Error(`NVDA listen window must be an integer from ${LISTEN_MS.min} to ${LISTEN_MS.max} ms`);
  }
  await reader.clearSpokenPhraseLog();
  await deadline(
    reader.capture(async () => {
      await io.sendKey(key);
      await io.sleep(milliseconds);
    }, { capture: true }),
    milliseconds + timeoutMs,
    `NVDA press ${key} with listen window`,
  );
  return speechLog(await reader.spokenPhraseLog());
}

// Tell NVDA to pass the next key to the browser untouched, for a key NVDA
// would otherwise take in browse mode; the key itself follows as a `press`.
// Returns the capture around the command. Never retried.
export async function nvdaPassNextKey(reader, timeoutMs) {
  await reader.clearSpokenPhraseLog();
  await deadline(
    reader.perform(reader.keyboardCommands.ignoreNextKeyCombination, { capture: true }),
    timeoutMs,
    "NVDA pass next key",
  );
  return speechLog(await reader.spokenPhraseLog());
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
