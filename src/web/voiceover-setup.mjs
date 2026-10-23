import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertNativeDesktop, hostRefusal, stopOwnedVoiceOver, systemIo, withAttempts } from "./voiceover.mjs";

// Experimental setup of a disposable GitHub-hosted macOS runner for
// VoiceOver capture: Guidepup's setup and install, with recovery between
// attempts and a name for a machine on which no attempt can pass. Ported
// from the USWDS accessibility harness's native setup.

// Printed, with a reason, when this hosted machine cannot run VoiceOver at
// all. A workflow can match it to rerun the job on a fresh machine.
export const SETUP_UNAVAILABLE = "VOICEOVER_SETUP_UNAVAILABLE";

// Why another setup attempt on this machine cannot pass, from a failure's
// output, or undefined. Some hosted machines refuse every Apple event to
// System Events for the whole job (see hostRefusal); Guidepup's Do Not
// Disturb step then fails after minutes of its own retries. Others cannot
// stop the VoiceOver that setup started: Guidepup reports "Unable to stop
// VoiceOver", the cleanup's signals leave it running, or another reader is
// running after the cleanup, and the next attempt refuses to start beside
// it. And Guidepup's
// install downloads its reader assets from GitHub's release host, which
// answers 429 when a runner's address has asked too often; another machine
// downloads from another address.
export function setupRefusal(output) {
  const text = String(output ?? "");
  const refused = hostRefusal(text);
  if (refused) return refused;
  if (/Unable to stop VoiceOver|VoiceOver remained active after disposable setup|VoiceOver started by this run did not stop/.test(text)) {
    return "VoiceOver on this machine cannot be stopped";
  }
  if (/Failed to download Guidepup cache asset[^\n]*\(429 ?\)/.test(text)) {
    return "the release host rate-limited this machine's Guidepup download (HTTP 429)";
  }
  return undefined;
}

// Guidepup's setup utility at the version aloud's workflows have validated,
// run through npx. A caller with its own pinned install passes its command.
export const GUIDEPUP_SETUP = ["npx", "--yes", "@guidepup/setup@0.25.3"];
export const SETUP_TIMEOUTS = { setupMs: 300000, installMs: 180000 };

const run = promisify(execFile);

// The real operating system: VoiceOver's processes and signals from
// voiceover.mjs, a command runner, and the job log. Tests pass their own.
export function setupIo() {
  return {
    ...systemIo(),
    exec: (file, args, timeout) => run(file, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 }),
    info: (...parts) => console.info(...parts),
    error: (...parts) => console.error(...parts),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

// Prepares this disposable macOS runner for VoiceOver capture: Guidepup's
// `setup --ci` (preferences, permissions, Do Not Disturb) up to `attempts`
// times, then `install`. Guidepup's output is printed when each step ends
// and kept on a failure, so the failure can be classified. Pinned
// @guidepup/setup starts VoiceOver to create its preferences and its stop
// check matches a narrower process command than aloud's, so every VoiceOver
// that appears during setup is treated as setup's own and stopped, by pid
// and start time, between attempts and at the end; setup refuses to run
// beside an existing session. A machine on which no attempt can pass (see
// setupRefusal) stops further attempts, and its reason is printed after
// SETUP_UNAVAILABLE. The final cleanup runs even when setup failed, and its
// errors never hide setup's.
export async function setupVoiceOver({
  env = process.env, platform = process.platform, io = setupIo(), guidepup = GUIDEPUP_SETUP,
  attempts = 2, timeouts = SETUP_TIMEOUTS,
} = {}) {
  assertNativeDesktop({ env, platform });
  const snapshot = async (phase) => {
    const processes = await io.voiceOverProcesses();
    io.info("VoiceOver setup processes", JSON.stringify({
      phase, processes: [...processes].map(([pid, identity]) => ({ pid, identity })),
    }));
    return processes;
  };
  if ((await snapshot("before setup")).size) throw new Error("Refusing VoiceOver setup beside an existing VoiceOver session");
  const stopSetupReaders = async (phase) => {
    await stopOwnedVoiceOver(await snapshot(`${phase}, before cleanup`), io);
    if ((await snapshot(`${phase}, after cleanup`)).size) throw new Error("VoiceOver remained active after disposable setup");
  };
  const guidepupStep = async (step, timeout) => {
    const [file, ...args] = guidepup;
    try {
      const { stdout = "", stderr = "" } = await io.exec(file, [...args, ...step], timeout);
      io.stdout(stdout);
      io.stderr(stderr);
    } catch (error) {
      io.stdout(error.stdout ?? "");
      io.stderr(error.stderr ?? "");
      error.output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
      throw error;
    }
  };
  const marker = (reason) => io.error(`${SETUP_UNAVAILABLE}: ${reason}`);
  const errors = [];
  try {
    // Guidepup retries Do Not Disturb and permission writes itself, which
    // can outrun one cap on a slow machine, so a second attempt follows a
    // cleanup, except on a machine setupRefusal names. The cleanup's own
    // failure is read too, since it is what reports a reader still running.
    await withAttempts(() => guidepupStep(["setup", "--ci"], timeouts.setupMs), {
      attempts,
      between: (attempt) => stopSetupReaders(`after setup attempt ${attempt}`),
      unrecoverable: (error) => setupRefusal(`${error.output ?? ""}\n${error.message ?? ""}`),
      log: (entry) => io.error("VoiceOver setup attempt failed", JSON.stringify(entry)),
      messages: { failed: "VoiceOver setup did not succeed", unavailable: "VoiceOver setup cannot pass on this machine" },
    });
    await snapshot("after setup");
    try {
      await guidepupStep(["install"], timeouts.installMs);
    } catch (error) {
      error.unavailable = setupRefusal(error.output);
      throw error;
    }
  } catch (error) {
    errors.push(error);
    if (error.unavailable) marker(error.unavailable);
  }
  // A reader still running after the final cleanup, such as one macOS
  // started again as soon as the cleanup stopped it, names the machine too.
  try {
    await stopSetupReaders("after tooling");
  } catch (error) {
    errors.push(error);
    const unavailable = setupRefusal(error.message);
    if (unavailable) marker(unavailable);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "VoiceOver setup and cleanup failed");
}
