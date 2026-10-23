import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
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
    // Diagnostics only: a command's output, or why it was unavailable.
    read: (file, args, timeout = 10000) => {
      try {
        return execFileSync(file, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        return `unavailable: ${error.message.split("\n")[0]}`;
      }
    },
    pid: process.pid,
    home: homedir(),
  };
}

// The lines of tccd's log that belong to Apple event requests for System
// Events. A decision's lines share a msgID, and only its request line names
// the service, so every line of each such request is kept. Without a match
// the raw tail is kept, so an unexpected format still shows.
export function appleEventLines(lines) {
  const messageId = (line) => line.match(/msgID=([\w.:-]+)/)?.[1];
  const requests = new Set(lines.filter((line) => /kTCCServiceAppleEvents|systemevents/.test(line)).map(messageId).filter(Boolean));
  return requests.size ? lines.filter((line) => requests.has(messageId(line))) : lines.slice(-40);
}

// tccd logs, for each Apple event it decides, the process it held
// responsible (AUTHREQ_ATTRIBUTION) and its answer (AUTHREQ_RESULT). Hosted
// machines on the same image sometimes refuse System Events even though
// every client in the process chain has a grant, so these decisions are
// logged after a passing setup as well as a failing one; comparing the two
// names what differs.
export function appleEventDecisions(io, phase) {
  const log = io.read("sudo", ["-n", "log", "show", "--last", "15m", "--info", "--style", "compact",
    "--predicate", 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS "AUTHREQ"'], 60000).split("\n");
  io.error("VoiceOver Apple event decisions", JSON.stringify({
    phase,
    tccd: io.read("pgrep", ["-lx", "tccd"]).trim().split("\n"),
    consoleUser: io.read("stat", ["-f", "%Su", "/dev/console"]).trim(),
    decisions: appleEventLines(log).slice(-60),
  }));
}

// macOS attributes an Apple event to the process it holds responsible, and
// Guidepup grants System Events control only to a fixed list of runner
// processes. When setup is refused on one hosted machine and not another,
// this logs the setup process's ancestry and the grants actually written,
// so the log names the client that is missing, then tccd's decisions.
export function permissionDiagnostics(io) {
  const ancestry = [];
  for (let pid = io.pid; pid > 1 && ancestry.length < 15;) {
    const [parent, ...command] = io.read("ps", ["-o", "ppid=,args=", "-p", `${pid}`]).trim().split(/\s+/);
    if (!/^\d+$/.test(parent)) break;
    ancestry.push({ pid, command: command.join(" ").slice(0, 200) });
    pid = Number(parent);
  }
  const grants = Object.fromEntries([
    ["system", "/Library/Application Support/com.apple.TCC/TCC.db"],
    ["user", `${io.home}/Library/Application Support/com.apple.TCC/TCC.db`],
  ].map(([name, database]) => [name, io.read("sudo", ["-n", "sqlite3", database,
    "SELECT client, client_type, auth_value, auth_reason, csreq IS NULL, indirect_object_code_identity IS NULL FROM access " +
    "WHERE service = 'kTCCServiceAppleEvents' AND indirect_object_identifier = 'com.apple.systemevents'"]).trim().split("\n")]));
  io.error("VoiceOver setup permissions", JSON.stringify({ ancestry, grants }));
  appleEventDecisions(io, "setup failed");
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
    // Diagnostics never fail a setup that passed.
    try {
      appleEventDecisions(io, "setup passed");
    } catch (error) {
      io.error("VoiceOver Apple event decisions unavailable", error.message);
    }
    try {
      await guidepupStep(["install"], timeouts.installMs);
    } catch (error) {
      error.unavailable = setupRefusal(error.output);
      throw error;
    }
  } catch (error) {
    errors.push(error);
    if (error.unavailable) marker(error.unavailable);
    // Diagnostics never replace the setup error or skip the cleanup.
    try {
      permissionDiagnostics(io);
    } catch (diagnosticError) {
      io.error("VoiceOver setup permissions unavailable", diagnosticError.message);
    }
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
