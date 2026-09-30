import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { webDependency } from "./dependencies.mjs";

// Experimental macOS VoiceOver capture for Safari, parallel to nvda.mjs:
// startVoiceOver, voiceOverCommand, settleVoiceOver and stopVoiceOver.
// Ported from the USWDS accessibility harness's native driver. Guidepup
// captures text around its own commands; these are command logs labelled
// voiceover-guidepup, never raw audio or proof of complete speech delivery.
//
// Every operating-system touch (ps, kill, osascript, timers) goes through an
// injectable `io` so the logic below is unit-tested without VoiceOver.

const run = promisify(execFile);

// Cursor commands a scenario may send through VoiceOver. `press` sends a key
// to Safari; the rest move or act with the VoiceOver cursor.
export const VOICEOVER_COMMANDS = ["next", "previous", "nextHeading", "nextLandmark", "nextLink", "act", "interact", "stopInteracting"];

// Guidepup starts VoiceOver itself; two attempts, with recovery between them,
// cover a hosted runner where the first launch is not yet ready.
const START_ATTEMPTS = 2;
const START_RETRY_PAUSE_MS = 5000;

// VoiceOver defers its own delayed output (help tags, and hints when on) by
// one second after speech, so a settle waits for one second with no new
// phrase. Continuous speech stops the watch at SETTLE_MAX_MS. Without a live
// phrase, or when reading it fails, a fixed wait is used instead.
export const SETTLE = { quietMs: 1000, pollMs: 100, maxMs: 5000, fixedMs: 1500 };

// A timed-out Guidepup or AppleScript action cannot be cancelled. Once one
// times out, this process never starts another reader or sends it commands.
let timedOut = false;
const sessions = new WeakMap();

const text = (value) => typeof value === "string" && value.trim().length > 0;

// Never start a reader or change accessibility settings on a developer's
// Mac. Mirrors the harness: only a disposable GitHub-hosted runner that
// explicitly opts in. These variables prevent accidents; they are not a
// security boundary.
export function assertNativeDesktop({ env = process.env, platform = process.platform } = {}) {
  if (platform !== "darwin") {
    throw new Error("Experimental VoiceOver capture requires macOS; use --screen-reader none for structural checks");
  }
  const allowed =
    env.GITHUB_ACTIONS === "true" &&
    env.RUNNER_ENVIRONMENT === "github-hosted" &&
    env.ALOUD_ALLOW_NATIVE_DESKTOP === "1";
  if (!allowed) {
    throw new Error(
      "Experimental VoiceOver capture runs only on a disposable GitHub-hosted macOS runner: " +
      "it needs GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted and ALOUD_ALLOW_NATIVE_DESKTOP=1",
    );
  }
}

// Safari on the hosted runner ignores its tab-to-links preference, so plain
// Tab skips links. Option+Tab is Safari's own key for Tabbing to every item,
// links included, so Tab and Shift+Tab reach the same stops that Chromium
// reaches under NVDA. Every other key is sent unchanged.
export const safariKey = (key) => key.replace(/^(Shift\+)?Tab$/, "Option+$1Tab");

// Guidepup's log, checked and copied. Anything but an array of strings is a
// broken capture, never an empty one.
export function speechLog(phrases) {
  if (!Array.isArray(phrases) || !phrases.every((phrase) => typeof phrase === "string")) {
    throw new Error("invalid Guidepup speech log");
  }
  return [...phrases];
}

// `ps -axo pid=,lstart=,comm=` lines for VoiceOver, as pid -> "start command".
// The start time is part of the identity, so a later process that reuses a
// pid is never mistaken for this run's reader.
export function parseVoiceOverProcesses(output) {
  const processes = new Map();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+\s+\/\S*VoiceOver\.app\/\S*\/VoiceOver)\s*$/);
    if (match) processes.set(Number(match[1]), match[2].trim());
  }
  return processes;
}

// The processes in `current` that are still exactly the ones in `owned`.
export function matchingOwnedProcesses(current, owned) {
  return [...current].filter(([pid, identity]) => owned.get(pid) === identity);
}

// The real operating system. Tests pass their own.
export function systemIo() {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    kill: (pid, signal) => process.kill(pid, signal),
    voiceOverProcesses: async () => {
      const { stdout } = await run("/bin/ps", ["-axo", "pid=,lstart=,comm="], { encoding: "utf8", timeout: 2000 });
      return parseVoiceOverProcesses(stdout);
    },
    // Asynchronous, so Guidepup keeps polling speech while osascript runs.
    lastPhrase: async () => {
      const { stdout } = await run("/usr/bin/osascript", ["-e", 'tell application "VoiceOver" to return content of last phrase'],
        { encoding: "utf8", timeout: 5000 });
      return stdout.trim();
    },
  };
}

// Stop only processes this run started: pid and start time must both match.
// An existing session, or a later process reusing a pid, is never signalled.
export async function stopOwnedVoiceOver(owned, io) {
  const remaining = async () => matchingOwnedProcesses(await io.voiceOverProcesses(), owned);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const [pid] of await remaining()) {
      try {
        io.kill(pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await remaining()).length === 0) return;
      await io.sleep(100);
    }
  }
  throw new Error("VoiceOver started by this run did not stop; the disposable desktop needs recovery");
}

// Wait until VoiceOver's last phrase has not changed for SETTLE.quietMs,
// reading it every SETTLE.pollMs, for at most SETTLE.maxMs. The phrase
// changes when an utterance starts, not when it ends; Guidepup's own polling
// after the enclosing capture then waits out that utterance.
export async function awaitQuiet(lastPhrase, { now, sleep }) {
  const started = now();
  if (!lastPhrase) return sleep(SETTLE.fixedMs);
  try {
    let phrase = await lastPhrase();
    let changed = started;
    while (now() - changed < SETTLE.quietMs && now() - started < SETTLE.maxMs) {
      await sleep(SETTLE.pollMs);
      const next = await lastPhrase();
      if (next !== phrase) {
        phrase = next;
        changed = now();
      }
    }
  } catch {
    await sleep(Math.max(0, SETTLE.fixedMs - (now() - started)));
  }
}

function session(reader) {
  const state = sessions.get(reader);
  if (!state) throw new Error("VoiceOver reader was not started by startVoiceOver");
  if (state.timedOut) throw new Error("a VoiceOver command timed out; refusing further commands on this desktop");
  return state;
}

// Rejects after `ms`. A timeout marks the session and the process, so a
// reader whose action is still running is never driven again.
async function deadline(operation, ms, label, state) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          if (state) state.timedOut = true;
          reject(new Error(`${label} timed out; capture is incomplete`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Runs `operation` up to `attempts` times, recovering with `between` after
// each failure. A failed recovery stops further attempts. Every error is
// kept on the thrown AggregateError.
export async function withAttempts(operation, { attempts, between }) {
  const errors = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      errors.push(error);
    }
    if (attempt < attempts) {
      try {
        await between(attempt);
      } catch (error) {
        errors.push(error);
        break;
      }
    }
  }
  throw new AggregateError(errors, `VoiceOver did not start: ${errors.map((e) => e.message).join("; ")}`);
}

// Start VoiceOver with Guidepup. Refuses to replace an existing session:
// any VoiceOver process after startup is then this run's own, and only
// those are stopped at cleanup. Returns the Guidepup reader.
export async function startVoiceOver({ env = process.env, platform = process.platform, io = systemIo(), guidepup } = {}) {
  assertNativeDesktop({ env, platform });
  if (timedOut) throw new Error("a native operation timed out; refusing to start another reader in this process");
  const refuseExisting = async () => {
    if ((await io.voiceOverProcesses()).size) {
      throw new Error("VoiceOver is already running; use a disposable runner so capture does not replace an existing screen-reader session");
    }
  };
  await refuseExisting();
  const { voiceOver, MacOSApplications } = guidepup ?? await webDependency("@guidepup/guidepup");
  // Recheck immediately before Guidepup can start or stop any process.
  await refuseExisting();
  try {
    // Guidepup bounds its own AppleScript and readiness polling; its retries
    // option counts attempts. Hints ("To click this button, press
    // Control-Option-Space.") arrive a second after an item and spill into
    // the next capture, so they are turned off; descriptions stay on.
    await withAttempts(
      () => voiceOver.start({ capture: true, timeout: 10000, retries: 1, settings: { SCRShouldOutputVOInstructions: false } }),
      {
        attempts: START_ATTEMPTS,
        between: async () => {
          await stopOwnedVoiceOver(await io.voiceOverProcesses(), io);
          await io.sleep(START_RETRY_PAUSE_MS);
        },
      },
    );
  } catch (error) {
    // The caller never receives this reader, so stop what startup left.
    const errors = [error];
    try { await voiceOver.stop({ timeout: 3000, retries: 1 }); } catch (stopError) { errors.push(stopError); }
    try { await stopOwnedVoiceOver(await io.voiceOverProcesses(), io); } catch (stopError) { errors.push(stopError); }
    if (errors.length > 1) throw new AggregateError(errors, `${error.message}; cleanup after failed startup also failed`);
    throw error;
  }
  // No reader existed before, so every VoiceOver process now is this run's.
  const owned = await io.voiceOverProcesses();
  sessions.set(voiceOver, { io, owned, application: MacOSApplications.Safari, timedOut: false });
  return voiceOver;
}

// Let pending speech finish inside its own capture, and return it. Commands
// settle first so page loads and earlier announcements never land in the
// next command's log.
export async function settleVoiceOver(reader, timeoutMs) {
  const state = session(reader);
  return deadline((async () => {
    await reader.clearSpokenPhraseLog();
    await reader.capture(() => awaitQuiet(state.io.lastPhrase, state.io), { capture: true });
    return speechLog(await reader.spokenPhraseLog());
  })(), timeoutMs + SETTLE.maxMs, "VoiceOver settle", state);
}

// Send one command and return its captured speech. `press` keys go to
// Safari (Tab becomes Option+Tab, see safariKey); cursor commands act on
// VoiceOver's current item and take no application. Never retried.
export async function voiceOverCommand(reader, command, argument, timeoutMs) {
  const state = session(reader);
  if (command === "press") {
    if (!text(argument)) throw new Error("VoiceOver press requires a key");
  } else if (!VOICEOVER_COMMANDS.includes(command)) {
    throw new Error(`unsupported VoiceOver command: ${command}`);
  } else if (argument !== undefined) {
    throw new Error(`VoiceOver ${command} takes no argument`);
  }
  await settleVoiceOver(reader, timeoutMs);
  await reader.clearSpokenPhraseLog();
  const action = command === "press"
    ? reader.press(safariKey(argument), { capture: true, application: state.application })
    : reader[command]({ capture: true });
  await deadline(action, timeoutMs, `VoiceOver ${command}`, state);
  return speechLog(await reader.spokenPhraseLog());
}

// Stop Guidepup's reader, then any process this run started that is still
// running. Both run even when the first fails; any failure is reported.
export async function stopVoiceOver(reader, timeoutMs = 10000) {
  const state = sessions.get(reader);
  if (!state) throw new Error("VoiceOver reader was not started by startVoiceOver");
  sessions.delete(reader);
  const errors = [];
  try {
    await deadline(reader.stop({ timeout: 3000, retries: 1 }), timeoutMs, "VoiceOver cleanup");
  } catch (error) { errors.push(error); }
  try {
    await stopOwnedVoiceOver(state.owned, state.io);
  } catch (error) { errors.push(error); }
  if (errors.length) {
    throw new Error(`VoiceOver cleanup failed; disposable desktop needs recovery: ${errors.map((e) => e.message).join("; ")}`);
  }
}

// Only for tests: forget an earlier timeout in this process.
export function resetVoiceOverTimeoutForTests() {
  timedOut = false;
}
