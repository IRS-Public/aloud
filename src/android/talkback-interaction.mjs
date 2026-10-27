// Explicit actions and observed native state/speech. Completion is not an accessibility verdict.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { adb } from "./adb.mjs";
import { FOCUS_ACTION, validateFocusResponse } from "./talkback-focus.mjs";
import { TALKBACK_COMMIT } from "./talkback-companion/patch.mjs";
import { collectTtsEvidence } from "./tts-capture.mjs";
import { accountTts, parseTtsJournal, TTS_ENGINE } from "./tts-evidence.mjs";
import { validateScreenId } from "../screen-id.mjs";
import { collectProvenance } from "../provenance.mjs";

const actions = ["first", "next", "previous", "activate"];
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.length > 0;
const check = (value, message) => { if (!value) throw new Error(message); };
const keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));

export function validateInteractionScenario(scenario) {
  check(object(scenario) && keys(scenario, ["id", "steps"]), "invalid interaction scenario");
  validateScreenId(scenario.id);
  check(Array.isArray(scenario.steps) && scenario.steps.length >= 1 && scenario.steps.length <= 100,
    "interaction scenario requires 1–100 explicit steps");
  for (const step of scenario.steps) {
    check(object(step) && keys(step, ["action", "expect"]) && actions.includes(step.action), "invalid interaction action");
    if (step.expect === undefined) continue;
    const e = step.expect;
    check(object(e) && keys(e, ["checked", "checkable", "stateDescription", "speechIncludes", "speechExcludes"]), "invalid interaction expectation");
    for (const key of ["checked", "checkable"]) check(e[key] === undefined || typeof e[key] === "boolean", `invalid ${key} expectation`);
    check(e.stateDescription === undefined || typeof e.stateDescription === "string", "invalid stateDescription expectation");
    for (const field of ["speechIncludes", "speechExcludes"])
      check(e[field] === undefined || (Array.isArray(e[field]) && e[field].length > 0 &&
        e[field].length <= 20 && e[field].every((s) => text(s) && s.trim() && s.length <= 1000)), `invalid ${field} expectation`);
  }
  return scenario;
}

function validateNode(node) {
  check(object(node) && text(node.id) && text(node.packageName) && Number.isInteger(node.windowId), "invalid interaction node identity");
  for (const field of ["enabled", "checkable", "checked", "selected", "clickable", "focusable", "accessibilityFocused", "stateDescriptionSupported"])
    check(typeof node[field] === "boolean", `missing native ${field}`);
  check(typeof node.className === "string" && typeof node.text === "string" && typeof node.description === "string" &&
    Number.isInteger(node.childCount) && node.childCount >= 0 &&
    (node.stateDescriptionSupported ? typeof node.stateDescription === "string" : node.stateDescription === null), "invalid native node properties");
}

export function validateInteractionResponse(value, expected) {
  validateFocusResponse(value, expected, { interaction: true });
  check(value.action === "hello" || actions.includes(value.action), "invalid interaction command action");
  check(value.interactionVersion === 1 && Array.isArray(value.stateEvents) && value.stateEvents.length <= 200,
    "companion lacks interaction-v1 evidence; rebuild the companion");
  for (const node of [value.before, value.after, ...value.focusEvents]) if (Object.keys(node).length) validateNode(node);
  for (const event of value.stateEvents) {
    check(object(event) && ["TYPE_VIEW_CLICKED", "TYPE_WINDOW_CONTENT_CHANGED", "TYPE_VIEW_SELECTED"].includes(event.type) &&
      Number.isSafeInteger(event.eventTime) && event.eventTime >= 0 && Number.isSafeInteger(event.observedAt) && event.observedAt >= event.eventTime &&
      Number.isInteger(event.windowId) && typeof event.packageName === "string" && Number.isInteger(event.contentChangeTypes) && event.contentChangeTypes >= 0,
    "invalid interaction state event");
    if (event.source !== null) validateNode(event.source);
  }
  if (value.status === "observed") {
    check(value.action === "activate" && value.actionDispatched === true && value.before.id === expected.expectedNodeId &&
      value.after.id === value.before.id && value.before.packageName === value.target && value.before.windowId === value.windowId &&
      value.before.accessibilityFocused && value.after.accessibilityFocused && value.before.enabled,
    "activation has no stable intended native focus");
  }
  if (value.action === "activate") check(value.status !== "focused" && value.status !== "edge", "activation cannot claim a navigation result");
  return value;
}

export function evaluateInteractionExpectations(command, expectation = {}) {
  const failures = [];
  for (const field of ["checked", "checkable", "stateDescription"]) {
    if (expectation[field] !== undefined && command.after[field] !== expectation[field])
      failures.push(`${field}: expected ${JSON.stringify(expectation[field])}, observed ${JSON.stringify(command.after[field])}`);
  }
  for (const expected of expectation.speechIncludes ?? []) {
    if (!command.speech.some((s) => s.text.toLowerCase().includes(expected.toLowerCase())))
      failures.push(`speechIncludes: missing ${JSON.stringify(expected)} in this command's speech requests`);
  }
  for (const excluded of expectation.speechExcludes ?? []) {
    if (command.speech.some((s) => s.text.toLowerCase().includes(excluded.toLowerCase())))
      failures.push(`speechExcludes: found ${JSON.stringify(excluded)} in this command's speech requests`);
  }
  return { passed: failures.length === 0, failures };
}

// Unlike traversal acceptance, a diagnostic can observe zero speech. Still validate every
// command boundary and every actual engine request, including interrupted/failed requests.
export function validateInteractionTts(capture) {
  const accounting = accountTts(capture.loggingTts, { requestId: capture.requestId, screen: capture.screen });
  check(accounting.complete, `incomplete TTS accounting: ${accounting.problems.join("; ")}`);
  check(accounting.requests.every((r) => r.result === 0 && ["done", "stop"].includes(r.terminal) && r.synthesis !== "synthesis-error"),
    "interaction speech dispatch or synthesis failed");
  const client = parseTtsJournal(capture.loggingTts.client, "client");
  check(client[0].data.packageName === "com.android.talkback" && client[0].data.pid === capture.commands[0].pid,
    "interaction TTS client process mismatch");
  check(accounting.requests.every((r) => Number.isSafeInteger(r.sequence) && r.sequence >= 0 && r.sequence < capture.commands.length),
    "speech belongs to an unknown interaction command");
  for (const command of capture.commands) {
    const t = command.tts;
    const scope = { requestId: capture.requestId, screen: capture.screen, sequence: command.sequence, serviceSession: command.session };
    check(t?.schemaVersion === 1 && t.engine === TTS_ENGINE && t.clientSession === accounting.clientSession &&
      t.output === "synthetic-silence" && t.error === null && Number.isSafeInteger(t.firstEvent) && Number.isSafeInteger(t.lastEvent),
    "missing interaction TTS provenance");
    const first = client[t.firstEvent - 1], last = client[t.lastEvent - 1];
    check(first?.kind === "command-begin" && last?.kind === "command-end" && t.lastEvent > t.firstEvent &&
      isDeepStrictEqual(first.data.scope, scope) && isDeepStrictEqual(last.data.scope, scope), "interaction TTS boundaries mismatch");
    const spoken = accounting.requests.filter((r) => r.sequence === command.sequence);
    const ids = new Set(spoken.map((r) => r.dispatchId));
    check(client.filter((r) => ids.has(r.data.dispatchId)).every((r) => r.event > t.firstEvent && r.event < t.lastEvent),
      "speech lifecycle extends outside its interaction command");
    check(isDeepStrictEqual(spoken.map((r) => ({ utteranceId: r.utteranceId, text: r.text })), command.speech),
      "interaction speech and engine receipts disagree");
  }
  return accounting;
}

export function createInteractionSession({ out, target, screen, loggingTts = false, runAdb = adb,
  runShell = (...args) => runAdb(["shell", ...args], { timeout: 5000 }), startupAttempts = 15,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), provenance } = {}) {
  check(typeof out === "string" && out.length > 0 && typeof target === "string" && /^[A-Za-z0-9_.]{1,200}$/.test(target), "invalid interaction output or target");
  validateScreenId(screen);
  check(Number.isInteger(startupAttempts) && startupAttempts >= 1 && startupAttempts <= 30, "invalid startupAttempts");
  const dir = join(out, "talkback-interaction"); mkdirSync(dir, { recursive: true });
  const prefix = join(dir, screen), requestId = randomUUID();
  const observedProvenance = provenance ?? collectProvenance({ tools: { talkback: TALKBACK_COMMIT } });
  // cwd is the controller checkout; it cannot identify the APK installed on the device.
  const result = { schemaVersion: 1, source: "talkback-interaction", requestId, screen, target, targetPid: "",
    provenance: { ...observedProvenance, commit: null, workingTreeDirty: null }, appIdentity: { packageName: target, sourceCommit: null, apkSha256: null },
    speechSource: loggingTts ? "logging-tts" : "talkback-tts-request-listener", audibleRecording: false,
    commands: [], startupAttempts: [], observationComplete: false, assertions: { passed: true, failures: [] }, complete: false };
  let hello, closed = false, failed = false;
  writeFileSync(`${prefix}.commands.jsonl`, ""); writeFileSync(`${prefix}.broadcasts.txt`, "");
  const persist = () => writeFileSync(`${prefix}.json`, JSON.stringify(result, null, 2));
  const pid = () => { try { return runShell("pidof", target).trim(); } catch { return ""; } };
  const sameProcess = () => check(pid() === result.targetPid && result.targetPid, "target-process-changed");
  async function dispatch(action) {
    check(!closed && !failed, "interaction session is closed or failed");
    check(result.commands.length <= 100, "interaction command limit");
    sameProcess();
    const sequence = result.commands.length;
    const previous = result.commands.at(-1);
    const expected = { requestId, screen, target, sequence, action,
      ...(hello ? { session: hello.session, pid: hello.pid, windowId: hello.windowId } : {}),
      ...(action === "activate" ? { expectedNodeId: previous?.after.id } : {}) };
    if (action === "activate") check(text(expected.expectedNodeId), "activate requires an observed focused node");
    const args = ["shell", "am", "broadcast", "-a", FOCUS_ACTION, "-p", "com.android.talkback",
      "--es", "op", action, "--es", "requestId", requestId, "--es", "screen", screen,
      "--es", "target", target, "--ei", "sequence", String(sequence)];
    if (hello) args.push("--es", "session", hello.session);
    if (action === "activate") args.push("--es", "expectedNodeId", expected.expectedNodeId);
    let response;
    for (let attempt = 0; attempt < (action === "hello" ? startupAttempts : 1); attempt++) {
      sameProcess();
      const output = runAdb(args, { timeout: 15000 });
      appendFileSync(`${prefix}.broadcasts.txt`, `# ${action} attempt ${attempt + 1}\n${output}\n`);
      const match = output.match(/Broadcast completed: result=200, data="([A-Za-z0-9+/=]+)"/);
      if (match) {
        response = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
        // Persist even invalid evidence before checking it.
        appendFileSync(`${prefix}.commands.jsonl`, JSON.stringify(response) + "\n");
        validateInteractionResponse(response, expected);
      } else check(action === "hello" && /Broadcast completed: result=0\s*$/.test(output), "interaction companion unavailable or command rejected");
      if (action !== "hello" || (response && response.status !== "not-ready")) break;
      result.startupAttempts.push({ attempt: attempt + 1, status: response?.status ?? "receiver-unavailable", response });
      response = undefined; persist();
      if (attempt + 1 < startupAttempts) await sleep(1000);
    }
    check(response, "companion-startup-timeout");
    result.commands.push(response); persist();
    sameProcess();
    if (previous) check(response.before.id === previous.after.id, "focus-changed-between-commands");
    const allowed = action === "hello" ? ["ready"] : action === "activate" ? ["observed"] : ["focused"];
    check(allowed.includes(response.status), `interaction ${action}: ${response.status}`);
    return response;
  }
  async function guarded(action) {
    try { return await dispatch(action); }
    catch (error) { failed = true; result.error = error.message; persist(); throw error; }
  }
  return {
    result,
    async start() {
      check(!hello && !result.commands.length, "interaction session already started");
      result.targetPid = pid(); persist();
      check(/^\d+$/.test(result.targetPid), "target is not running as exactly one process");
      hello = await guarded("hello"); return hello;
    },
    async command(action) { check(hello && actions.includes(action), "start session before an explicit interaction action"); return guarded(action); },
    async finish() {
      if (closed) return result;
      closed = true;
      try {
        if (loggingTts && result.commands.length) {
          result.loggingTts = collectTtsEvidence(result, out, runAdb);
          result.ttsAccounting = validateInteractionTts(result);
        }
        result.observationComplete = !failed && !!hello;
      } catch (error) { result.error = error.message; result.observationComplete = false; }
      result.complete = result.observationComplete && result.assertions.passed;
      try { writeFileSync(`${prefix}.logcat.txt`, runAdb(["logcat", "-d", "-v", "threadtime"], { timeout: 5000 })); }
      catch (error) { result.diagnosticError = error.message; }
      persist(); return result;
    },
  };
}

export function createInteractionCapturer(options) {
  return async function capture(scenario) {
    validateInteractionScenario(scenario);
    const session = createInteractionSession({ ...options, screen: scenario.id });
    session.result.scenario = structuredClone(scenario);
    let failure;
    try {
      await session.start();
      for (const [index, step] of scenario.steps.entries()) {
        const command = await session.command(step.action);
        const assertion = evaluateInteractionExpectations(command, step.expect);
        if (!assertion.passed) {
          session.result.assertions.passed = false;
          session.result.assertions.failures.push(...assertion.failures.map((message) => ({ step: index, action: step.action, message })));
          throw new Error(`interaction assertion failed at step ${index}: ${assertion.failures.join("; ")}`);
        }
      }
    } catch (error) { failure = error; session.result.error = error.message; }
    const result = await session.finish();
    result.observationComplete = result.observationComplete && result.commands.length === scenario.steps.length + 1;
    result.complete = result.observationComplete && result.assertions.passed;
    writeFileSync(join(options.out, "talkback-interaction", `${scenario.id}.json`), JSON.stringify(result, null, 2));
    if (!result.complete || failure) {
      const error = failure ?? new Error(result.error ?? "incomplete interaction capture"); error.result = result; throw error;
    }
    return result;
  };
}
