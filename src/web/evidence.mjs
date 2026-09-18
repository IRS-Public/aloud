import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateScreenId } from "../screen-id.mjs";
import { validateStep, webUrl } from "./config.mjs";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.trim().length > 0;
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
const require = (ok, message) => { if (!ok) throw new Error(`invalid web evidence: ${message}`); };

export function isWebReport(dir) {
  return existsSync(join(dir, "web-run.json")) || (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".web.json")));
}

export function validateAxe(axe, url, version) {
  require(object(axe) && axe.testEngine?.name === "axe-core" && text(axe.testEngine.version) && axe.url === url, "axe identity or URL");
  if (version) require(axe.testEngine.version === version, "axe version changed");
  for (const kind of ["violations", "incomplete", "passes", "inapplicable"]) {
    require(Array.isArray(axe[kind]), `missing axe ${kind}`);
    const ids = new Set();
    for (const rule of axe[kind]) {
      require(object(rule) && text(rule.id) && !ids.has(rule.id) && strings(rule.tags) && text(rule.help) && Array.isArray(rule.nodes), `malformed axe ${kind} rule`);
      ids.add(rule.id);
      for (const node of rule.nodes) require(object(node) && Array.isArray(node.target) && typeof node.html === "string", "malformed axe node");
    }
  }
  require(["violations", "incomplete", "passes", "inapplicable"].some((kind) => axe[kind].length > 0), "no axe rule results");
}

export function validateWebCapture(capture, run, screen) {
  require(capture.schemaVersion === 1 && capture.platform === "web" && capture.runId === run.runId && capture.screen === screen.id, "capture identity");
  require(capture.status === "completed" && capture.requestedUrl === screen.url, "incomplete capture or changed request");
  webUrl(capture.url);
  require(capture.url === screen.expectedUrl, "captured URL differs from the requested final state");
  require(capture.coverage?.scope === "scripted-scenario" && capture.coverage.scenarioComplete === true && capture.coverage.fullTraversal === false, "coverage");
  require(typeof capture.ariaSnapshot === "string" && capture.ariaSnapshot.trim() && capture.snapshotSource === "playwright-aria-snapshot", "structural snapshot");
  require(capture.speechSource === (run.environment.screenReader === "nvda" ? "nvda-guidepup" : "none"), "speech source");
  require(Array.isArray(capture.steps) && capture.steps.length === screen.steps.length, "missing steps");
  require(strings(capture.navigationSpeech), "navigation speech");
  for (const [i, step] of capture.steps.entries()) {
    const expected = screen.steps[i];
    validateStep(expected, run.environment.screenReader);
    require(step.sequence === i && JSON.stringify(step.action) === JSON.stringify(expected) && step.completed === true && strings(step.speech), "step identity or incomplete action");
    require(typeof step.focused === "boolean" || step.focused === null, "focus observation");
    require(step.assertionsPassed === ((!expected.expect?.focused || step.focused === true) &&
      (!expected.expect?.speechIncludes || step.speech.some((phrase) => phrase.includes(expected.expect.speechIncludes)))), "contradictory assertion result");
    require(step.assertionsPassed, "failed scenario assertion");
    if (capture.speechSource === "none") require(step.speech.length === 0, "invented speech");
  }
  if (capture.speechSource === "none") require(capture.navigationSpeech.length === 0, "invented navigation speech");
  validateAxe(capture.axe, capture.url, run.environment.axe);
  return capture;
}

export function readWebReport(dir) {
  const run = JSON.parse(readFileSync(join(dir, "web-run.json"), "utf8"));
  require(run.schemaVersion === 1 && run.platform === "web" && text(run.runId) && run.status === "completed" && run.cleanupComplete === true, "run did not complete, including cleanup; inspect web-run.json and raw captures");
  const env = run.environment;
  require(object(env) && env.browser === "chromium" && ["none", "nvda"].includes(env.screenReader) &&
    [env.os, env.osVersion, env.browserVersion, env.playwright, env.axe, env.locale].every(text) &&
    Number.isInteger(env.viewport?.width) && Number.isInteger(env.viewport?.height), "environment");
  if (env.screenReader === "nvda") require(env.os === "win32" && text(env.screenReaderVersion) && text(env.guidepup), "NVDA provenance");
  require(Array.isArray(run.screens) && run.screens.length > 0 && object(run.receipts), "expected screen inventory");
  const ids = run.screens.map((s) => validateScreenId(s.id));
  require(new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "duplicate screen inventory");
  const files = readdirSync(dir).filter((f) => f.endsWith(".web.json")).sort();
  require(JSON.stringify(files) === JSON.stringify(ids.map((id) => `${id}.web.json`).sort()), "missing or unexpected captures");
  const screens = {};
  for (const screen of run.screens) {
    const raw = readFileSync(join(dir, `${screen.id}.web.json`));
    require(hash(raw) === run.receipts[screen.id]?.capture, "capture receipt mismatch");
    const capture = validateWebCapture(JSON.parse(raw), run, screen);
    require(hash(readFileSync(join(dir, "shots", `${screen.id}.png`))) === run.receipts[screen.id]?.screenshot, "screenshot receipt mismatch");
    screens[screen.id] = capture;
  }
  return { run, screens };
}

export function webSummary({ run, screens }) {
  return { schemaVersion: 1, platform: "web", generated: run.generated, environment: run.environment, reportOnly: true,
    screens: Object.fromEntries(Object.entries(screens).map(([id, screen]) => [id, {
      errors: null, ruleIds: [], utterances: screen.speechSource === "none" ? null : screen.navigationSpeech.length + screen.steps.reduce((n, s) => n + s.speech.length, 0),
      web: { reportOnly: true, coverage: screen.coverage, speechSource: screen.speechSource,
        violations: screen.axe.violations.reduce((n, r) => n + r.nodes.length, 0),
        incomplete: screen.axe.incomplete.reduce((n, r) => n + r.nodes.length, 0), steps: screen.steps.length },
    }])) };
}
