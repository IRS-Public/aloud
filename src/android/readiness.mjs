// Host-side environment evidence only. This does not certify accessibility, speech,
// app responsiveness or the absence of every possible Android overlay.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ADB } from "./adb.mjs";
import { parseCliArgs } from "../cli-args.mjs";

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
function boundedAdb(args, options) {
  return new Promise((resolveOutput, reject) => execFile(ADB, args,
    { ...options, encoding: "buffer", killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolveOutput(stdout)));
}

// Android 14 WindowState.dump prints package/owner on the focused window's block.
// Do not infer ownership from the title: app dialogs may have arbitrary titles.
export function parseFocusedWindow(raw) {
  raw = raw.replace(/\r\n/g, "\n");
  // AOSP's default dump begins with a saved ANR snapshot, including old window
  // blocks AND old display focus. Only POLICY marks the return to current state.
  const history = [...raw.matchAll(/^WINDOW MANAGER LAST ANR \(dumpsys window lastanr\)$/gm)];
  if (history.length > 1) return null;
  if (history.length) {
    const current = [...raw.matchAll(/^WINDOW MANAGER POLICY STATE \(dumpsys window policy\)$/gm)];
    if (current.length !== 1 || current[0].index <= history[0].index) return null;
    raw = raw.slice(current[0].index);
  }
  const focuses = [...raw.matchAll(/^\s*mCurrentFocus=(.+)$/gm)].map((m) => m[1].trim());
  if (focuses.length !== 1 || focuses[0] === "null") return null;
  const match = /^Window\{([a-fA-F0-9]+) u(\d+) (.+)\}$/.exec(focuses[0]);
  if (!match) return null;
  const [, id, user, title] = match;
  const blocks = [...raw.matchAll(/^\s*Window #\d+ Window\{([^}]+)\}:[\s\S]*?(?=^\s*Window #\d+ Window\{|^\s*mCurrentFocus=|$(?![\s\S]))/gm)];
  const matches = blocks.filter((b) => b[1] === `${id} u${user} ${title}`);
  if (matches.length !== 1) return null;
  const owners = [...matches[0][0].matchAll(/\bmOwnerUid=(\d+)[^\n]*\bpackage=([A-Za-z0-9_.]+)/g)];
  if (owners.length !== 1 || !PACKAGE.test(owners[0][2])) return null;
  return { id, user: Number(user), title, packageName: owners[0][2], uid: Number(owners[0][1]),
    systemError: /^(?:Application Not Responding|Application Error): /.test(title) ||
      /\b(?:ty=SYSTEM_ERROR|ty=2010|SYSTEM_ERROR)\b/.test(matches[0][0].split("Requested w=")[0]) };
}

export function parseResumedActivity(raw) {
  const matches = [...raw.matchAll(/\b(?:mResumedActivity:|topResumedActivity=)\s*ActivityRecord\{([a-fA-F0-9]+) [^\n}]*?\bu(\d+) ([A-Za-z0-9_.]+)\/([^\s}]+) t(\d+)\b/g)];
  const unique = [...new Set(matches.map((m) => JSON.stringify({ id: m[1], user: Number(m[2]),
    packageName: m[3], component: `${m[3]}/${m[4]}`, taskId: Number(m[5]) })))];
  return unique.length === 1 ? JSON.parse(unique[0]) : null;
}

export function assessReadiness({ boot, packages, windows, activities, pid }, target) {
  if (boot !== "1") return { status: boot === "0" || boot === "" ? "not-ready" : "unknown", reason: "boot-incomplete-or-unreadable" };
  if (!/^package:\S+\.apk$/m.test(packages ?? "")) return { status: "unknown", reason: "package-manager-unavailable" };
  const window = parseFocusedWindow(windows ?? "");
  if (!window) return { status: "unknown", reason: "focused-window-unavailable" };
  if (window.systemError) return { status: "not-ready", reason: "current-system-error-dialog", window };
  const activity = parseResumedActivity(activities ?? "");
  if (!activity) return { status: "unknown", reason: "resumed-activity-unavailable", window };
  if (window.user !== activity.user || window.packageName !== activity.packageName)
    return { status: "not-ready", reason: "foreign-focused-window", window, activity };
  if (target && (window.packageName !== target || activity.packageName !== target))
    return { status: "not-ready", reason: "target-not-foreground", window, activity };
  if (target && !/^[1-9]\d*$/.test(pid ?? ""))
    return { status: pid === "" ? "not-ready" : "unknown", reason: "target-process-unavailable", window, activity };
  return { status: "ready", reason: "foreground-observed", window, activity, ...(target ? { targetPid: pid } : {}) };
}

export async function waitForAndroidReady({ out, target, timeoutMs = 60_000, commandTimeoutMs = Math.min(3000, timeoutMs),
  intervalMs = 1000, runAdb = boundedAdb, now = () => performance.now(), sleep = sleepDefault } = {}) {
  if (!out) throw new Error("Android readiness requires an output directory");
  if (target !== undefined && !PACKAGE.test(target)) throw new Error("invalid Android target package");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new Error("timeoutMs must be an integer from 1000 to 300000");
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > timeoutMs) throw new Error("invalid commandTimeoutMs");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > timeoutMs) throw new Error("invalid intervalMs");
  mkdirSync(out, { recursive: true });
  const started = now(), deadline = started + timeoutMs;
  // Reserve part of the SAME total budget for evidence when readiness fails.
  const probeDeadline = deadline - Math.min(10_000, Math.floor(timeoutMs / 4));
  const evidence = { schemaVersion: 1, source: "android-readiness", startedAt: new Date().toISOString(),
    target: target ?? null, timeoutMs, commandTimeoutMs, status: "unknown", reason: "not-probed",
    scope: "host environment and foreground observation; not accessibility or speech acceptance", observations: [], commands: [] };
  let index = 0;
  async function command(name, args, limit = deadline, binary = false) {
    const remaining = Math.floor(limit - now());
    if (remaining <= 0) return undefined;
    const record = { name, args, timeoutMs: Math.min(commandTimeoutMs, remaining) };
    const stem = `${String(++index).padStart(3, "0")}-${name}`;
    const start = now();
    try {
      const result = await runAdb(args, { timeout: record.timeoutMs });
      const bytes = Buffer.isBuffer(result) ? result : Buffer.from(result);
      if (binary && !bytes.subarray(0, PNG.length).equals(PNG)) throw new Error("screencap did not return a PNG");
      record.file = `${stem}.${binary ? "png" : "txt"}`;
      writeFileSync(join(out, record.file), bytes);
      record.ok = true;
      return binary ? record.file : bytes.toString("utf8").trim();
    } catch (error) {
      record.ok = false; record.error = error.message; record.code = error.code ?? null; record.signal = error.signal ?? null;
      record.file = `${stem}.error.txt`;
      writeFileSync(join(out, record.file), Buffer.concat([
        Buffer.from(error.stdout ?? ""), Buffer.from("\n"), Buffer.from(error.stderr ?? ""), Buffer.from(`\n${error.message}\n`)]));
      return undefined;
    } finally { record.elapsedMs = Math.round(now() - start); evidence.commands.push(record); }
  }
  let stableKey, previousAt;
  while (now() < probeDeadline) {
    const commandCount = evidence.commands.length;
    const values = {};
    for (const [name, args] of [
      ["boot", ["shell", "getprop", "sys.boot_completed"]],
      ["packages", ["shell", "pm", "path", "android"]],
      ["windows", ["shell", "dumpsys", "window"]],
      ["activities", ["shell", "dumpsys", "activity", "activities"]],
      ...(target ? [["pid", ["shell", "pidof", target]]] : []),
    ]) values[name] = await command(name, args, probeDeadline);
    // A sub-millisecond remainder can skip every command. It is not a new
    // observation and must not erase the last actual device result.
    if (evidence.commands.length === commandCount) break;
    const observation = { elapsedMs: Math.round(now() - started), ...assessReadiness(values, target) };
    evidence.observations.push(observation);
    evidence.status = observation.status; evidence.reason = observation.reason;
    if (observation.reason === "current-system-error-dialog") break;
    const key = observation.status === "ready" ? JSON.stringify([observation.window, observation.activity, observation.targetPid]) : null;
    if (key && key === stableKey && now() - previousAt >= intervalMs) {
      evidence.reason = "stable-foreground-observed";
      break;
    }
    stableKey = key; previousAt = now();
    // A single good snapshot is insufficient, including at the deadline.
    if (key) { evidence.status = "unknown"; evidence.reason = "foreground-not-yet-stable"; }
    const remaining = Math.floor(probeDeadline - now());
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  if (evidence.status !== "ready") {
    await command("failure-windows", ["shell", "dumpsys", "window"]);
    await command("failure-screen", ["exec-out", "screencap", "-p"], deadline, true);
    await command("failure-processes", ["shell", "dumpsys", "activity", "processes"]);
    await command("failure-logcat", ["logcat", "-d", "-v", "threadtime", "-t", "300"]);
  }
  await command("fingerprint", ["shell", "getprop", "ro.build.fingerprint"]);
  evidence.elapsedMs = Math.round(now() - started);
  writeFileSync(join(out, "readiness.json"), JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

export async function readinessCli(argv) {
  const args = parseCliArgs(argv, { out: { type: "string" }, target: { type: "string" },
    "timeout-ms": { type: "string" }, help: { type: "boolean" } });
  if (args.flag("help")) {
    console.log("Usage: aloud android-ready --out <dir> [--target <package>] [--timeout-ms 60000]\nRead-only bounded environment evidence; not an accessibility or speech pass.");
    return 0;
  }
  const out = args.opt("out");
  if (!out) throw new Error("--out <dir> is required");
  const evidence = await waitForAndroidReady({ out: resolve(out), target: args.opt("target"), timeoutMs: Number(args.opt("timeout-ms", "60000")) });
  console.log(`Android readiness: ${evidence.status} (${evidence.reason}); evidence: ${resolve(out, "readiness.json")}`);
  return evidence.status === "ready" ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await readinessCli(process.argv.slice(2)); }
  catch (error) { console.error(`android-ready: ${error.message}`); process.exitCode = 1; }
}
