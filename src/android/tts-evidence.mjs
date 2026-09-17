// Pair durable API-boundary requests with independent engine receipts and Android callbacks.
import { isDeepStrictEqual } from "node:util";
export const TTS_ENGINE = "org.irs_public.aloud.tts";
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.length > 0;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const check = (yes, reason) => { if (!yes) throw new Error(`invalid TTS evidence: ${reason}`); };
const equal = (a, b) => isDeepStrictEqual(a, b);

export function parseTtsJournal(raw, producer) {
  check(typeof raw === "string" && raw.length > 0 && Buffer.byteLength(raw) <= 32 * 1024 * 1024 && raw.endsWith("\n"), "missing, oversized, or truncated journal");
  const rows = raw.slice(0, -1).split("\n").map((line) => JSON.parse(line));
  const header = rows[0];
  check(header?.kind === "header" && header.data?.producer === producer && UUID.test(header.session), "journal header");
  check(integer(header.data.pid) && header.data.pid > 0 && integer(header.data.uid) && text(header.data.packageName) &&
    header.data.output === "synthetic-silence", "producer identity");
  const kinds = producer === "client" ? ["header", "command-begin", "command-end", "request", "return", "start", "done", "stop", "error", "test-plan", "test-ready", "test-finished"]
    : ["header", "received", "synthesis-start", "synthesis-complete", "synthesis-stopped", "synthesis-error", "stop-request"];
  for (const [i, row] of rows.entries()) {
    check(row.schemaVersion === 1 && row.session === header.session && row.event === i + 1 && object(row.data) &&
      integer(row.uptimeMs) && (i === 0 || row.uptimeMs >= rows[i - 1].uptimeMs) && kinds.includes(row.kind) &&
      (i === 0 || row.kind !== "header"), "journal sequence or event");
  }
  return rows;
}

export function accountTts(evidence, { requestId, screen, requireDone = false } = {}) {
  check(evidence?.schemaVersion === 1 && typeof evidence.client === "string" && Array.isArray(evidence.engines), "capture envelope");
  check(evidence.readError === undefined, "engine journal could not be read");
  const client = parseTtsJournal(evidence.client, "client");
  const header = client[0], session = header.session;
  const engines = evidence.engines.map((raw) => parseTtsJournal(raw, "engine"));
  check(new Set(engines.map((rows) => rows[0].session)).size === engines.length, "duplicate engine journal");
  for (const rows of engines) check(rows[0].data.packageName === TTS_ENGINE, "wrong engine package");
  const requests = new Map(), returns = new Map(), callbacks = new Map(), engineEvents = new Map();
  for (const row of client.slice(1)) {
    const d = row.data;
    if (row.kind === "request") {
      check(d.dispatchId === `${session}:${requests.size + 1}` && !requests.has(d.dispatchId) &&
        ["speak", "stop"].includes(d.operation) && object(d.metadata) && d.metadata.clientSession === session &&
        d.metadata.dispatchId === d.dispatchId && (d.metadata.originalUtteranceId === null || text(d.metadata.originalUtteranceId)) &&
        d.wireId === (d.metadata.originalUtteranceId === null ? null : d.dispatchId), "dispatch identity");
      check(d.operation === "speak" ? typeof d.text === "string" && [0, 1, 2].includes(d.queueMode)
        : d.text === null && d.queueMode === null && d.wireId === null, "request or queue control");
      const s = d.metadata.scope;
      check(s === null || (object(s) && text(s.requestId) && text(s.screen) && integer(s.sequence) && text(s.serviceSession)), "capture scope");
      requests.set(d.dispatchId, d);
    } else if (row.kind === "return" || ["start", "done", "stop", "error"].includes(row.kind)) {
      check(requests.has(d.dispatchId), "callback/result without a request");
      if (row.kind === "return") {
        check(!returns.has(d.dispatchId) && Number.isSafeInteger(d.result) && d.result <= 0, "duplicate or invalid dispatch result");
        returns.set(d.dispatchId, d.result);
      } else {
        check(typeof d.interrupted === "boolean", "callback interruption flag");
        const list = callbacks.get(d.dispatchId) ?? [];
        list.push(row); callbacks.set(d.dispatchId, list);
      }
    } else if (["command-begin", "command-end"].includes(row.kind)) {
      check(object(d.scope) && text(d.scope.requestId) && text(d.scope.screen) && integer(d.scope.sequence) && text(d.scope.serviceSession), "command boundary");
    }
  }
  for (const rows of engines) for (const row of rows.slice(1)) {
    const d = row.data;
    check(text(d.dispatchId) && requests.has(d.dispatchId), "engine event without a client request");
    const req = requests.get(d.dispatchId);
    if (row.kind === "received") {
      check(equal(d.metadata, req.metadata) && d.text === req.text && d.callerUid === header.data.uid, "engine receipt identity, text, or caller UID");
    }
    const list = engineEvents.get(d.dispatchId) ?? [];
    list.push({ ...row, engineSession: rows[0].session }); engineEvents.set(d.dispatchId, list);
  }
  const selected = [...requests.values()].filter((r) => requestId === undefined ||
    (r.metadata.scope?.requestId === requestId && r.metadata.scope?.screen === screen));
  const problems = [], speech = [], controls = [];
  const engineSessions = new Set();
  for (const r of selected) {
    const id = r.dispatchId, result = returns.get(id), events = callbacks.get(id) ?? [], native = engineEvents.get(id) ?? [];
    const receipts = native.filter((e) => e.kind === "received");
    const terminals = events.filter((e) => ["done", "stop", "error"].includes(e.kind));
    const starts = events.filter((e) => e.kind === "start");
    const synthesis = native.filter((e) => ["synthesis-complete", "synthesis-stopped", "synthesis-error"].includes(e.kind));
    for (const e of native) engineSessions.add(e.engineSession);
    if (result === undefined) problems.push(`${id}: missing dispatch result`);
    if (result !== undefined && result < 0 && (receipts.length || terminals.length || starts.length)) problems.push(`${id}: rejected dispatch has downstream events`);
    if (receipts.length > 1 || synthesis.length > 1 || terminals.length > 1 || starts.length > 1) problems.push(`${id}: duplicate receipt or lifecycle event`);
    if (native.length && receipts.length !== 1) problems.push(`${id}: missing engine receipt`);
    if (r.operation === "stop" || r.queueMode !== 1) controls.push({ dispatchId: id, operation: r.operation, queueMode: r.queueMode, result });
    if (r.operation === "stop" || r.text === "") {
      if (result !== 0) problems.push(`${id}: queue control failed`);
      if (r.operation === "stop" && native.length) problems.push(`${id}: stop control has synthesis events`);
      if (r.wireId === null && events.length) problems.push(`${id}: callback for a control without a wire ID`);
      continue;
    }
    const terminal = terminals[0]?.kind ?? (result !== undefined && result < 0 ? "rejected" : "unresolved");
    if (result === 0 && terminals.length !== 1) problems.push(`${id}: missing terminal callback`);
    if (terminal === "done") {
      const complete = synthesis[0];
      const start = native.filter((e) => e.kind === "synthesis-start");
      if (receipts.length !== 1 || starts.length !== 1 || start.length !== 1 || start[0].data.result !== 0 ||
          complete?.kind !== "synthesis-complete" || complete.data.result !== 0 || !integer(complete.data.bytes) || complete.data.bytes <= 0 ||
          complete.data.output !== "synthetic-silence" || native.some((e) => e.kind === "stop-request")) {
        problems.push(`${id}: completion lacks successful synthesis and playback evidence`);
      }
    } else if (receipts.length && synthesis.length !== 1) problems.push(`${id}: synthesis has no terminal event`);
    if (requireDone && (result !== 0 || terminal !== "done")) problems.push(`${id}: focus speech did not complete`);
    speech.push({ dispatchId: id, ...r.metadata.scope, utteranceId: r.metadata.originalUtteranceId,
      text: r.text, queueMode: r.queueMode, result, terminal, engineReceived: receipts.length === 1,
      interrupted: terminal === "stop" ? terminals[0].data.interrupted : false,
      synthesis: synthesis[0]?.kind ?? null, bytes: synthesis[0]?.data.bytes ?? 0 });
  }
  if (engineSessions.size > 1) problems.push("engine process changed during capture");
  return { schemaVersion: 1, source: "logging-tts", output: "synthetic-silence", clientSession: session,
    engineSession: engineSessions.size === 1 ? [...engineSessions][0] : null,
    complete: problems.length === 0, problems, requests: speech, queueEvents: controls };
}

export function validateFocusTts(capture) {
  const evidence = capture.loggingTts;
  const accounting = accountTts(evidence, { requestId: capture.requestId, screen: capture.screen });
  check(accounting.complete && accounting.requests.length > 0, `incomplete accounting: ${accounting.problems.join("; ")}`);
  // TalkBack can flush its own WebView boundary announcement before the next
  // control's label. A fully accounted stop is a recorded request, not lost speech.
  check(accounting.requests.every((r) => r.result === 0 && ["done", "stop"].includes(r.terminal)), "focus speech dispatch or synthesis failed");
  const client = parseTtsJournal(evidence.client, "client");
  check(client[0].data.packageName === "com.android.talkback" && client[0].data.pid === capture.commands[0].pid,
    "focus journal belongs to another client process");
  check(accounting.requests.every((r) => integer(r.sequence) && r.sequence < capture.commands.length), "speech belongs to an unknown focus step");
  for (const command of capture.commands) {
    const t = command.tts, scope = { requestId: capture.requestId, screen: capture.screen,
      sequence: command.sequence, serviceSession: command.session };
    check(t?.schemaVersion === 1 && t.engine === TTS_ENGINE && t.clientSession === accounting.clientSession &&
      t.output === "synthetic-silence" && t.error === null && integer(t.firstEvent) && integer(t.lastEvent), "missing command TTS provenance");
    const first = client[t.firstEvent - 1], last = client[t.lastEvent - 1];
    check(first?.kind === "command-begin" && last?.kind === "command-end" && t.lastEvent > t.firstEvent &&
      equal(first.data.scope, scope) && equal(last.data.scope, scope), "command journal boundaries");
    const spoken = accounting.requests.filter((r) => r.sequence === command.sequence);
    const ids = new Set(spoken.map((r) => r.dispatchId));
    check(client.filter((row) => ids.has(row.data.dispatchId)).every((row) => row.event > t.firstEvent && row.event < t.lastEvent), "speech lifecycle extends outside its focus step");
    check(equal(spoken.map((r) => ({ utteranceId: r.utteranceId, text: r.text })), command.speech), "focus speech and engine receipts disagree");
  }
  return accounting;
}

export function focusTtsSummary(capture) {
  const a = validateFocusTts(capture);
  return { schemaVersion: 1, source: a.source, output: a.output, complete: a.complete,
    engine: TTS_ENGINE, clientSession: a.clientSession, engineSession: a.engineSession,
    requests: a.requests.length, queueEvents: a.queueEvents.length,
    completedRequests: a.requests.filter((r) => r.terminal === "done").length,
    stoppedRequests: a.requests.filter((r) => r.terminal === "stop").length };
}
