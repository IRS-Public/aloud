import { flattenManifest } from "../nav/index.mjs";
import { validateScreenId } from "../screen-id.mjs";

export const WEB_VERSIONS = { playwright: "1.63.0", "@axe-core/playwright": "4.13.0", "@guidepup/guidepup": "0.34.0" };
export const WEB_DEFAULTS = {
  screenReader: "none", headed: false, timeoutMs: 10000,
  locale: "en-US", viewport: { width: 1280, height: 800 },
};
const text = (v) => typeof v === "string" && v.trim().length > 0;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (value, keys, label) => {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`invalid ${label}: unknown field or non-object`);
};

export function webUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw new Error(`invalid web URL: ${value}`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("web URLs must use HTTP(S) without embedded credentials");
  return url.href;
}

// Screen readers a web run can drive, and the browser each one uses. NVDA
// runs with Chromium on Windows; VoiceOver runs with Safari on macOS.
export const WEB_READERS = { none: "chromium", nvda: "chromium", voiceover: "safari" };

// Scenario step kinds that send a command through one reader's cursor.
export const READER_STEP_COMMANDS = {
  nvda: ["next", "previous", "nextHeading", "nextLandmark", "nextLink", "act"],
  voiceover: ["next", "previous", "nextHeading", "nextLandmark", "nextLink", "act", "interact", "stopInteracting"],
};

// What each screen reader's captured speech is labelled in evidence, and
// each browser's structural snapshot. run.mjs writes these; evidence.mjs
// checks them.
export const SPEECH_SOURCES = { none: "none", nvda: "nvda-guidepup", voiceover: "voiceover-guidepup" };
export const SNAPSHOT_SOURCES = { chromium: "playwright-aria-snapshot", safari: "safari-dom-outline" };

// A VoiceOver `press` step with `listenMs` sends its key through the
// operating system inside one capture held open that long, for products
// that announce after a longer pause than Guidepup's capture waits. Only
// these keys can be typed that way, so no manifest text reaches a script.
export const LISTEN_KEYS = ["Backspace", "Enter", "Space"];
export const LISTEN_MS = { min: 1000, max: 30000 };
export const listenKey = (key) => LISTEN_KEYS.includes(key) || /^[a-z0-9]$/i.test(key);

export function validateWebConfig(web) {
  only(web, [...Object.keys(WEB_DEFAULTS), "url", "screens", "storageState"], "web config");
  if (!Object.hasOwn(WEB_READERS, web.screenReader)) throw new Error("web.screenReader must be none, nvda, or voiceover");
  if (typeof web.headed !== "boolean") throw new Error("web.headed must be a boolean");
  for (const [key, min, max] of [["timeoutMs", 100, 60000]]) {
    if (!Number.isInteger(web[key]) || web[key] < min || web[key] > max) throw new Error(`web.${key} must be an integer from ${min} to ${max}`);
  }
  if (!text(web.locale)) throw new Error("web.locale is required");
  only(web.viewport, ["width", "height"], "web viewport");
  for (const key of ["width", "height"]) if (!Number.isInteger(web.viewport[key]) || web.viewport[key] < 320 || web.viewport[key] > 4096) throw new Error("web viewport dimensions must be integers from 320 to 4096");
  if (web.url !== undefined) webUrl(web.url);
  for (const key of ["screens", "storageState"]) if (web[key] !== undefined && !text(web[key])) throw new Error(`web.${key} must be a path`);
  // Playwright storage state loads into a Playwright browser context only.
  if (web.screenReader === "voiceover" && web.storageState !== undefined) {
    throw new Error("web.storageState is not supported with voiceover; Safari is not driven by Playwright");
  }
}

// One scenario step, checked against the run's screen reader. Speech can be
// asserted only on steps that the reader itself captured.
export function validateStep(step, reader) {
  only(step, ["action", "selector", "value", "key", "command", "listenMs", "expect"], "web step");
  const fields = { click: ["selector"], fill: ["selector", "value"], press: ["key"], wait: ["selector"], nvda: ["command"], voiceover: ["command"] };
  if (!fields[step.action]) throw new Error(`unknown web action: ${step.action}`);
  for (const key of fields[step.action]) {
    if (typeof step[key] !== "string" || (key !== "value" && !text(step[key]))) throw new Error(`${step.action} requires ${key}`);
  }
  for (const key of ["selector", "value", "key", "command"]) {
    if (step[key] !== undefined && !fields[step.action].includes(key)) throw new Error(`${key} is not valid for ${step.action}`);
  }
  if (step.action === "nvda" && (reader !== "nvda" || !READER_STEP_COMMANDS.nvda.includes(step.command))) {
    throw new Error("nvda action requires NVDA and a supported navigation command");
  }
  if (step.action === "voiceover" && (reader !== "voiceover" || !READER_STEP_COMMANDS.voiceover.includes(step.command))) {
    throw new Error("voiceover action requires VoiceOver and a supported cursor command");
  }
  if (step.listenMs !== undefined) {
    if (step.action !== "press") throw new Error("listenMs is valid only for press");
    if (reader !== "voiceover") throw new Error("listenMs requires web.screenReader voiceover");
    if (!Number.isInteger(step.listenMs) || step.listenMs < LISTEN_MS.min || step.listenMs > LISTEN_MS.max) {
      throw new Error(`listenMs must be an integer from ${LISTEN_MS.min} to ${LISTEN_MS.max}`);
    }
    if (!listenKey(step.key)) {
      throw new Error(`press with listenMs accepts only a letter, a digit, ${LISTEN_KEYS.join(", ")}; got ${step.key}`);
    }
  }
  if (step.expect !== undefined) {
    only(step.expect, ["focused", "speechIncludes"], "web expectation");
    if (!Object.keys(step.expect).length || Object.values(step.expect).some((v) => !text(v))) throw new Error("web expectations must contain non-empty strings");
    if (step.expect.speechIncludes && !Object.hasOwn(READER_STEP_COMMANDS, reader)) {
      throw new Error("speechIncludes requires web.screenReader nvda or voiceover; no speech is computed");
    }
    if (step.expect.speechIncludes && !capturesSpeech(step, reader)) {
      throw new Error("speechIncludes requires a captured press or screen-reader command; browser setup actions do not capture speech");
    }
  }
}

// True when a step's speech comes from the reader: keys pressed through it
// and its own cursor commands. Browser setup actions never capture speech.
export const capturesSpeech = (step, reader) =>
  reader !== "none" && (step.action === "press" || step.action === reader);

export function webScreens(web, manifest, flow = [], screenId = "current") {
  if (!manifest && flow.length) throw new Error("--flow requires a web screens manifest");
  const screens = manifest ? flattenManifest(manifest, flow) : [{ id: validateScreenId(screenId), url: web.url }];
  if (!screens.length) throw new Error("no web screens selected");
  return screens.map((screen) => {
    only(screen, ["id", "title", "url", "expectedUrl", "ready", "steps"], "web screen");
    if (!text(screen.url)) throw new Error(`web screen ${screen.id} needs a URL`);
    if (screen.title !== undefined && !text(screen.title)) throw new Error("web screen title must be a string");
    if (screen.ready !== undefined && !text(screen.ready)) throw new Error("web ready must be a selector");
    const steps = screen.steps ?? [];
    if (!Array.isArray(steps) || steps.length > 100) throw new Error("web screen steps must be an array of at most 100 actions");
    steps.forEach((step) => validateStep(step, web.screenReader));
    const url = webUrl(screen.url, web.url);
    return { ...screen, url, expectedUrl: screen.expectedUrl === undefined ? url : webUrl(screen.expectedUrl, web.url ?? url), steps };
  });
}
