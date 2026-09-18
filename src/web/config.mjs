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

export function validateWebConfig(web) {
  only(web, [...Object.keys(WEB_DEFAULTS), "url", "screens", "storageState"], "web config");
  if (!["none", "nvda"].includes(web.screenReader)) throw new Error("web.screenReader must be none or nvda");
  if (typeof web.headed !== "boolean") throw new Error("web.headed must be a boolean");
  for (const [key, min, max] of [["timeoutMs", 100, 60000]]) {
    if (!Number.isInteger(web[key]) || web[key] < min || web[key] > max) throw new Error(`web.${key} must be an integer from ${min} to ${max}`);
  }
  if (!text(web.locale)) throw new Error("web.locale is required");
  only(web.viewport, ["width", "height"], "web viewport");
  for (const key of ["width", "height"]) if (!Number.isInteger(web.viewport[key]) || web.viewport[key] < 320 || web.viewport[key] > 4096) throw new Error("web viewport dimensions must be integers from 320 to 4096");
  if (web.url !== undefined) webUrl(web.url);
  for (const key of ["screens", "storageState"]) if (web[key] !== undefined && !text(web[key])) throw new Error(`web.${key} must be a path`);
}

export function validateStep(step, reader) {
  only(step, ["action", "selector", "value", "key", "command", "expect"], "web step");
  const fields = { click: ["selector"], fill: ["selector", "value"], press: ["key"], wait: ["selector"], nvda: ["command"] };
  if (!fields[step.action]) throw new Error(`unknown web action: ${step.action}`);
  for (const key of fields[step.action]) if (typeof step[key] !== "string" || (key !== "value" && !text(step[key]))) throw new Error(`${step.action} requires ${key}`);
  for (const key of ["selector", "value", "key", "command"]) if (step[key] !== undefined && !fields[step.action].includes(key)) throw new Error(`${key} is not valid for ${step.action}`);
  if (step.action === "nvda" && (reader !== "nvda" || !["next", "previous", "nextHeading", "nextLandmark", "nextLink", "act"].includes(step.command))) throw new Error("nvda action requires NVDA and a supported navigation command");
  if (step.expect !== undefined) {
    only(step.expect, ["focused", "speechIncludes"], "web expectation");
    if (!Object.keys(step.expect).length || Object.values(step.expect).some((v) => !text(v))) throw new Error("web expectations must contain non-empty strings");
    if (step.expect.speechIncludes && reader !== "nvda") throw new Error("speechIncludes requires web.screenReader nvda; no speech is computed");
    if (step.expect.speechIncludes && !["press", "nvda"].includes(step.action)) throw new Error("speechIncludes requires a captured press or nvda command; browser setup actions do not capture speech");
  }
}

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
