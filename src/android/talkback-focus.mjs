// Controller for the test-only bridge in the pinned TalkBack build.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { adb, shell } from "./adb.mjs";
import { validateScreenId } from "../screen-id.mjs";
import { TALKBACK_COMMIT } from "./talkback-companion/patch.mjs";

export const FOCUS_ACTION = "org.irs_public.aloud.TALKBACK_COMMAND";
const statuses = ["not-ready", "ready", "focused", "edge", "wrap", "scroll-failed", "target-changed", "window-changed",
  "service-stopped", "step-timeout", "speech-limit"];
const isText = (x) => typeof x === "string" && x.length > 0;
const nodeMatches = (node, target, windowId) => node && isText(node.id) &&
  node.packageName === target && node.windowId === windowId;

export function parseFocusResponse(output, expected) {
  const match = output.match(/Broadcast completed: result=200, data="([A-Za-z0-9+/=]+)"/);
  if (!match) throw new Error("TalkBack companion did not return a response (install a --companion build)");
  const value = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  validateFocusResponse(value, expected);
  return value;
}

export function validateFocusResponse(value, expected) {
  for (const key of ["requestId", "screen", "target", "sequence", "action"]) {
    if (value?.[key] !== expected[key]) throw new Error(`TalkBack companion ${key} mismatch`);
  }
  if (value.schemaVersion !== 1 || value.source !== "talkback-focus" || value.talkbackCommit !== TALKBACK_COMMIT ||
      !isText(value.session) || !isText(value.runtime) || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !Number.isInteger(value.windowId) || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 ||
      !statuses.includes(value.status) || !Array.isArray(value.signals) ||
      !value.signals.every((s) => ["edge", "wrap", "scroll-failed", "scroll-complete"].includes(s)) ||
      !Array.isArray(value.speech) || value.speech.length > 101 ||
      !value.speech.every((s) => isText(s.utteranceId) && typeof s.text === "string") ||
      !Array.isArray(value.focusEvents) || !value.before || !value.after) {
    throw new Error("invalid TalkBack companion response");
  }
  if (value.status === "not-ready" && value.action !== "hello") throw new Error("readiness is only valid for hello");
  if (expected.session && (value.session !== expected.session || value.pid !== expected.pid ||
      value.windowId !== expected.windowId)) throw new Error("TalkBack companion session or window changed");
  if (["ready", "focused", "edge"].includes(value.status) &&
      (!nodeMatches(value.after, value.target, value.windowId) ||
       value.focusEvents.some((node) => !nodeMatches(node, value.target, value.windowId)) ||
       value.signals.some((s) => ["wrap", "scroll-failed"].includes(s)))) {
    throw new Error("TalkBack companion success has invalid focus evidence");
  }
  if (value.status === "focused" && (!value.focusEvents.length || !value.speech.some((s) => s.text.length > 0) ||
      value.signals.includes("edge") || value.focusEvents.at(-1).id !== value.after.id)) {
    throw new Error("TalkBack focus move has no matching focus and speech evidence");
  }
  if (value.status === "edge" && (!value.signals.includes("edge") || value.focusEvents.length ||
      value.before.id !== value.after.id)) throw new Error("TalkBack edge has no stable native boundary evidence");
  return value;
}

export function validateTalkBackFocusCapture(capture) {
  if (capture?.schemaVersion !== 1 || capture.source !== "talkback-focus" ||
      !isText(capture.requestId) || !isText(capture.screen) || !isText(capture.target) ||
      !isText(capture.targetPid) || !Array.isArray(capture.commands) || !capture.commands.length ||
      !Number.isInteger(capture.coverage?.maxSteps) || capture.coverage.maxSteps < 1 || capture.coverage.maxSteps > 200 ||
      capture.speechSource !== "talkback-tts-request-listener" ||
      capture.coverage.start !== "backward-edge" || typeof capture.coverage.complete !== "boolean") {
    throw new Error("invalid TalkBack focus capture");
  }
  const hello = capture.commands[0];
  for (const [sequence, command] of capture.commands.entries()) {
    validateFocusResponse(command, { requestId: capture.requestId, screen: capture.screen, target: capture.target,
      sequence, action: command.action,
      ...(sequence ? { session: hello.session, pid: hello.pid, windowId: hello.windowId } : {}) });
  }
  for (let i = 1; i < capture.commands.length; i++) {
    if (capture.commands[i].before.id !== capture.commands[i - 1].after.id) {
      throw new Error("TalkBack focus changed between commands");
    }
  }
  if (hello.action !== "hello" || hello.status !== "ready") throw new Error("TalkBack capture lacks a ready session");
  if (capture.coverage.complete) {
    const first = capture.commands.findIndex((c) => c.action === "first");
    const rewind = capture.commands.slice(2, first);
    const forward = capture.commands.slice(first + 1);
    if (capture.coverage.reason !== "forward-edge" || first < 3 || capture.commands[1].action !== "reset" || capture.commands[1].status !== "focused" ||
        rewind.length > capture.coverage.maxSteps || forward.length > capture.coverage.maxSteps ||
        rewind.some((c, i) => c.action !== "previous" || c.status !== (i === rewind.length - 1 ? "edge" : "focused")) ||
        capture.commands[first].status !== "focused" || !forward.length ||
        forward.some((c, i) => c.action !== "next" || c.status !== (i === forward.length - 1 ? "edge" : "focused"))) {
      throw new Error("TalkBack completion requires verified backward and forward boundaries");
    }
  } else if (!isText(capture.coverage.reason) || capture.coverage.reason === "forward-edge") {
    throw new Error("invalid incomplete TalkBack stopping reason");
  }
  return capture;
}

export const focusTranscript = (capture) => {
  const first = capture.commands.findIndex((c) => c.action === "first");
  return first < 0 ? [] : capture.commands.slice(first).flatMap((c) => c.speech.map((s) => s.text));
};

export function createFocusCapturer({ out, target, maxSteps = 100, runShell = shell, runAdb = adb,
  startupAttempts = 30, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!/^[A-Za-z0-9_.]+$/.test(target)) throw new Error("invalid Android target package");
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) throw new Error("TalkBack maxSteps must be 1–200");
  const dir = join(out, "talkback-focus");
  mkdirSync(dir, { recursive: true });
  const currentPid = () => {
    try { return runShell("pidof", target).trim(); } catch { return ""; }
  };
  return async function capture(screen) {
    validateScreenId(screen);
    const requestId = randomUUID();
    const log = join(dir, `${screen}.commands.jsonl`);
    const raw = join(dir, `${screen}.broadcasts.txt`);
    const result = { schemaVersion: 1, source: "talkback-focus", speechSource: "talkback-tts-request-listener",
      requestId, screen, target, targetPid: "", commands: [], startupAttempts: [],
      coverage: { complete: false, start: "backward-edge", reason: "controller-failed", maxSteps } };
    writeFileSync(log, ""); writeFileSync(raw, "");
    let hello;
    async function command(action) {
      if (currentPid() !== result.targetPid) throw new Error("target-process-changed");
      const sequence = result.commands.length;
      const args = ["shell", "am", "broadcast", "-a", FOCUS_ACTION, "-p", "com.android.talkback",
        "--es", "op", action, "--es", "requestId", requestId, "--es", "screen", screen,
        "--es", "target", target, "--ei", "sequence", String(sequence)];
      if (hello) args.push("--es", "session", hello.session);
      let response;
      for (let attempt = 0; attempt < (action === "hello" ? startupAttempts : 1); attempt++) {
        if (currentPid() !== result.targetPid) throw new Error("target-process-changed");
        const output = runAdb(args, { timeout: 15_000 });
        appendFileSync(raw, `# ${action} attempt ${attempt + 1}\n${output}\n`);
        const absent = /Broadcast completed: result=0\s*$/.test(output);
        if (!absent || action !== "hello") {
          response = parseFocusResponse(output, { requestId, screen, target, sequence, action,
            ...(hello ? { session: hello.session, pid: hello.pid, windowId: hello.windowId } : {}) });
        }
        if (action !== "hello" || (response && response.status !== "not-ready")) break;
        result.startupAttempts.push({ attempt: attempt + 1, status: absent ? "receiver-unavailable" : "not-ready",
          ...(response ? { response } : {}) });
        response = undefined;
        if (attempt < startupAttempts - 1) await sleep(1000);
      }
      if (!response) throw new Error("companion-startup-timeout (install a --companion build and check TalkBack/TTS startup)");
      const previous = result.commands.at(-1);
      result.commands.push(response);
      appendFileSync(log, JSON.stringify(response) + "\n");
      if (previous && ["focused", "edge"].includes(response.status) && response.before.id !== previous.after.id) {
        throw new Error("focus-changed-between-commands");
      }
      if (currentPid() !== result.targetPid) throw new Error("target-process-changed");
      return response;
    }
    try {
      result.targetPid = currentPid();
      if (!result.targetPid) throw new Error("target-not-running");
      hello = await command("hello");
      if (hello.status !== "ready") throw new Error(hello.status);
      // A previous screen can leave TalkBack's reachEdge flag set. Its First item action
      // establishes a fresh pivot and clears that flag before the backward sweep.
      const reset = await command("reset");
      if (reset.status !== "focused") throw new Error(reset.status);
      let rewindEdge = false;
      for (let i = 0; i < maxSteps; i++) {
        const step = await command("previous");
        if (step.status === "edge") { rewindEdge = true; break; }
        if (step.status !== "focused") throw new Error(step.status);
      }
      if (!rewindEdge) throw new Error("rewind-step-limit");
      const first = await command("first");
      if (first.status !== "focused") throw new Error(first.status);
      for (let i = 0; i < maxSteps; i++) {
        const step = await command("next");
        if (step.status === "edge") {
          result.coverage = { ...result.coverage, complete: true, reason: "forward-edge" };
          break;
        }
        if (step.status !== "focused") throw new Error(step.status);
      }
      if (!result.coverage.complete) throw new Error("forward-step-limit");
      validateTalkBackFocusCapture(result);
    } catch (error) {
      result.coverage = { ...result.coverage, complete: false, reason: error.message };
    } finally {
      writeFileSync(join(dir, `${screen}.json`), JSON.stringify(result, null, 2));
      // Also retain unstructured diagnostics for startup, events outside commands, and crashes.
      try { writeFileSync(join(dir, `${screen}.logcat.txt`), runAdb(["logcat", "-d", "-v", "threadtime"])); }
      catch { /* structured evidence and the controller failure remain available */ }
    }
    if (!result.coverage.complete) throw new Error(`screen "${screen}": incomplete TalkBack traversal (${result.coverage.reason}); raw evidence: ${dir}`);
    return result;
  };
}
