// Config loading for aloud. One file (aloud.config.json), all keys optional
// unless a leg needs them. CLI flags override the file. bin/aloud.mjs writes
// the merged result to <out>/config.resolved.json and the legs read only
// that file (env ALOUD_CONFIG). Validation is plain checks, no schema dep.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { validateScreenId } from "./screen-id.mjs";

export const NAV_MODES = ["current-screen", "deeplinks", "bridge"];

const DEFAULTS = {
  app: {
    android: { activity: ".MainActivity" },
    ios: {},
  },
  android: { talkBack: "startup", talkBackMaxSteps: 100, tts: "system" },
  ios: { appleAudit: false, voiceOver: "computed", voiceOverMaxSteps: 20 },
  nav: {
    mode: "current-screen",
    bridge: {
      port: 8081,
      globals: { nav: "__devNav", signIn: "__devSignInAs", signOut: "__devSignOut" },
    },
  },
  out: "aloud-report",
  baseline: {
    android: "aloud-baseline-android.json",
    ios: "aloud-baseline-ios.json",
  },
  openacr: {
    out: "acr-draft.yaml",
    author: { email: "todo@example.com" },
  },
};

// Keys that hold filesystem paths. Relative values from the config file
// resolve against the config file's directory; relative values from CLI
// flags (and the defaults) resolve against the current directory.
const PATH_KEYS = [
  ["out"],
  ["nav", "screens"],
  ["baseline", "android"],
  ["baseline", "ios"],
  ["app", "android", "apk"],
  ["app", "ios", "app"],
  ["openacr", "out"],
];

function resolvePathsInPlace(obj, baseDir) {
  for (const keyPath of PATH_KEYS) {
    let parent = obj;
    for (const key of keyPath.slice(0, -1)) {
      parent = parent?.[key];
      if (!parent || typeof parent !== "object") break;
    }
    if (!parent || typeof parent !== "object") continue;
    const last = keyPath[keyPath.length - 1];
    if (typeof parent[last] === "string" && parent[last] && !isAbsolute(parent[last])) {
      parent[last] = resolve(baseDir, parent[last]);
    }
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Recursive merge: objects merge, arrays and scalars replace.
function deepMerge(base, extra) {
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) {
      deepMerge(base[key], value);
    } else {
      base[key] = isPlainObject(value) ? deepMerge({}, value) : value;
    }
  }
  return base;
}

export function validateConfig(cfg) {
  if (cfg.android !== undefined && (!isPlainObject(cfg.android) ||
      (cfg.android.talkBack !== undefined && !["startup", "focus"].includes(cfg.android.talkBack)))) {
    throw new Error("android.talkBack must be startup or focus");
  }
  if (cfg.android?.talkBackMaxSteps !== undefined && (!Number.isInteger(cfg.android.talkBackMaxSteps) ||
      cfg.android.talkBackMaxSteps < 1 || cfg.android.talkBackMaxSteps > 200)) {
    throw new Error("android.talkBackMaxSteps must be an integer from 1 to 200");
  }
  if (cfg.android?.tts !== undefined && !["system", "logging"].includes(cfg.android.tts)) throw new Error("android.tts must be system or logging");
  if (cfg.android?.tts === "logging" && cfg.android.talkBack !== "focus") throw new Error("android.tts logging requires android.talkBack focus");
  if (cfg.ios !== undefined && (!isPlainObject(cfg.ios) ||
      (cfg.ios.appleAudit !== undefined && typeof cfg.ios.appleAudit !== "boolean"))) {
    throw new Error("ios.appleAudit must be a boolean");
  }
  if (cfg.ios?.voiceOver !== undefined && !["computed", "real"].includes(cfg.ios.voiceOver)) {
    throw new Error("ios.voiceOver must be computed or real");
  }
  if (cfg.ios?.voiceOverMaxSteps !== undefined && (!Number.isInteger(cfg.ios.voiceOverMaxSteps) ||
      cfg.ios.voiceOverMaxSteps < 1 || cfg.ios.voiceOverMaxSteps > 100)) {
    throw new Error("ios.voiceOverMaxSteps must be an integer from 1 to 100");
  }
  if (!NAV_MODES.includes(cfg.nav.mode)) {
    throw new Error(`unknown nav.mode "${cfg.nav.mode}" (use ${NAV_MODES.join(" | ")})`);
  }
  if (cfg.nav.screenId !== undefined) {
    validateScreenId(cfg.nav.screenId, "nav.screenId");
  }
  if ((cfg.nav.mode === "deeplinks" || cfg.nav.mode === "bridge") && !cfg.nav.screens) {
    throw new Error(`nav.mode "${cfg.nav.mode}" needs nav.screens (path to the screens manifest)`);
  }
  if (cfg.nav.mode === "bridge") {
    const hop = cfg.nav.bridge?.hopRoutes;
    if (hop !== undefined && (!Array.isArray(hop) || hop.length !== 2)) {
      throw new Error("nav.bridge.hopRoutes must be a two-route array: [routeA, routeB]");
    }
  }
  for (const key of ["name", "version"]) {
    if (cfg.app?.[key] !== undefined && typeof cfg.app[key] !== "string") {
      throw new Error(`app.${key} must be a string`);
    }
  }
  if (typeof cfg.out !== "string" || !cfg.out) {
    throw new Error("out must be a non-empty path string");
  }
}

// Leg-specific requirements, checked by bin/aloud.mjs before a leg spawns.
export function validateForLeg(cfg, leg, { requireVersion = true } = {}) {
  if (leg === "android" && !cfg.app?.android?.package) {
    throw new Error(
      "the android leg needs app.android.package (e.g. com.example.app) — set it in aloud.config.json",
    );
  }
  if (leg === "ios" && !cfg.app?.ios?.bundleId) {
    throw new Error(
      "the ios leg needs app.ios.bundleId (e.g. com.example.app) — set it in aloud.config.json",
    );
  }
  if (leg === "openacr") {
    if (!cfg.app?.name) {
      throw new Error("openacr needs app.name — set it in aloud.config.json");
    }
    if (requireVersion && !cfg.app?.version) {
      throw new Error("openacr needs app.version (or pass --version) — set it in aloud.config.json");
    }
  }
}

// Load aloud.config.json (explicit path, or ./aloud.config.json if present),
// apply defaults, merge CLI overrides on top, resolve paths, validate.
export function loadConfig(configPath, overrides = {}) {
  let fileCfg = {};
  let path = configPath;
  if (!path) {
    const candidate = resolve("aloud.config.json");
    if (existsSync(candidate)) path = candidate;
  } else {
    path = resolve(path);
    if (!existsSync(path)) throw new Error(`config file not found: ${path}`);
  }
  if (path) {
    let raw;
    try {
      raw = readFileSync(path, "utf8");
      fileCfg = JSON.parse(raw);
    } catch (err) {
      throw new Error(`could not read ${path}: ${err.message}`);
    }
    if (!isPlainObject(fileCfg)) throw new Error(`${path} must contain a JSON object`);
    resolvePathsInPlace(fileCfg, dirname(path));
  }

  const cfg = deepMerge(deepMerge(structuredClone(DEFAULTS), fileCfg), overrides);
  resolvePathsInPlace(cfg, process.cwd());

  if (!cfg.nav.bridge.readyExpr) {
    cfg.nav.bridge.readyExpr = `typeof globalThis.${cfg.nav.bridge.globals.nav} === 'function'`;
  }
  if (!cfg.openacr.description && cfg.app?.name) {
    cfg.openacr.description = `${cfg.app.name} mobile app for iOS and Android.`;
  }

  validateConfig(cfg);
  return cfg;
}
