#!/usr/bin/env node
// iOS half of the aloud 508 audit: walk the screens manifest on a booted
// iOS simulator, and per screen dump the accessibility tree (idb), compute
// the VoiceOver transcript, and run the iOS rules.
//
//   ALOUD_CONFIG=/path/to/config.resolved.json node src/ios/walk.mjs \
//     [--flow ids] [--port 8081] [--out dir] [--screen-id id]
//
// Computed speech is the default; optional real VoiceOver uses Xcode 27
// and records partial traversal coverage. Tree baselines do not compare
// speech. Navigation comes from the shared platform-blind adapter.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNavigator } from "../nav/index.mjs";
import { computeTranscript, normalizeElements, runIosChecks, validateIosCapture } from "./tree.mjs";
import { createAppleAuditor } from "./apple-audit.mjs";
import { createVoiceOverCapturer } from "./voiceover-capture.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

// Legs read the merged config bin/aloud.mjs wrote; flags override it.
const cfgPath = process.env.ALOUD_CONFIG;
if (!cfgPath) {
  console.error("ALOUD_CONFIG not set — run this through `aloud ios` (or src/ios/run.sh)");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

cfg.nav = cfg.nav ?? {};
const NAV_MODE = opt("nav", cfg.nav.mode ?? "current-screen");
cfg.nav.mode = NAV_MODE;
const PORT = String(opt("port", cfg.nav.bridge?.port ?? "8081"));
cfg.nav.bridge = { ...(cfg.nav.bridge ?? {}), port: PORT };
const SCREEN_ID = opt("screen-id", "");
if (SCREEN_ID) cfg.nav.screenId = SCREEN_ID; // current-screen mode report key

const OUT = opt("out", join(cfg.out ?? "aloud-report", "ios"));
const ONLY_FLOWS = opt("flow", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const BUNDLE_ID = cfg.app?.ios?.bundleId;
if (!BUNDLE_ID) {
  console.error("app.ios.bundleId is required for the iOS leg — set it in aloud.config.json");
  process.exit(1);
}

const sh = (cmd, cmdArgs) =>
  execFileSync(cmd, cmdArgs, { stdio: "pipe", maxBuffer: 256 * 1024 * 1024 })
    .toString()
    .trim();
const simctl = (...a) => sh("xcrun", ["simctl", ...a]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bootedUdid() {
  const list = JSON.parse(simctl("list", "devices", "booted", "-j"));
  const dev = Object.values(list.devices)
    .flat()
    .find((d) => d.state === "Booted");
  if (!dev) throw new Error("no booted simulator — boot one first (src/ios/run.sh does this)");
  return dev.udid;
}

const SHOTS_DIR = join(OUT, "shots");
const TREES_DIR = join(OUT, "capture-trees");

async function walk() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  mkdirSync(TREES_DIR, { recursive: true });
  const udid = bootedUdid();
  const appleAuditor = cfg.ios?.appleAudit
    ? createAppleAuditor({ out: OUT, udid, bundleId: BUNDLE_ID }) : null;
  const voiceOverCapturer = cfg.ios?.voiceOver === "real"
    ? createVoiceOverCapturer({ out: OUT, udid, bundleId: BUNDLE_ID, maxSteps: cfg.ios.voiceOverMaxSteps }) : null;
  // Navigators that can reconstruct a screen start clean. current-screen
  // must preserve the app state the user selected before running the audit.
  if (NAV_MODE !== "current-screen") {
    try {
      simctl("terminate", udid, BUNDLE_ID);
    } catch {
      // not running — fine
    }
    simctl("launch", udid, BUNDLE_ID);
  }

  // The screens manifest (screens.json). current-screen mode has none.
  const manifest =
    NAV_MODE !== "current-screen" && cfg.nav.screens
      ? JSON.parse(readFileSync(cfg.nav.screens, "utf8"))
      : null;

  const ctx = {
    platform: "ios",
    config: cfg,
    manifest,
    flowFilter: ONLY_FLOWS,
    device: {
      openUrl: (url) => simctl("openurl", udid, url),
      log: (msg) => console.log(msg),
    },
  };
  const loaded = await loadNavigator(NAV_MODE);
  const createNavigator = typeof loaded === "function" ? loaded : loaded.createNavigator;
  const nav = await createNavigator(ctx);
  // bridge: polls the dev bridge until the app is drivable, then settles.
  await nav.start();

  const initialAppearance = simctl("ui", udid, "appearance");
  let dark = initialAppearance === "dark";
  const setAppearance = (wantDark) => {
    if (dark === wantDark) return;
    simctl("ui", udid, "appearance", wantDark ? "dark" : "light");
    dark = wantDark;
  };

  try {
    for (const screen of nav.screens) {
      if (NAV_MODE !== "current-screen") setAppearance(!!screen.dark);
      // Bridge mode sleeps internally (persona/hop/eval timing is proven and
      // owned by the adapter); other modes settle here.
      await nav.goto(screen);
      if (NAV_MODE !== "bridge") await sleep(screen.settleMs ?? 2500);

      const elements = await settledElements(udid, screen.id);
      const violations = runIosChecks(elements);
      const errors = violations.filter((v) => v.severity === "error");
      // Apple's audits can temporarily change settings such as Dynamic Type.
      // Keep the tree screenshot paired with the dump captured above.
      simctl("io", udid, "screenshot", join(SHOTS_DIR, `${screen.id}.png`));
      const appleAudit = appleAuditor?.capture(screen.id);
      if (appleAudit) {
        const afterAudit = await settledElements(udid, screen.id, "after-apple-audit");
        // XCTest briefly backgrounds the app. Reject apps that reset their
        // screen on activation, or audits that leave changed content behind.
        // Raw idb metadata can vary; compare normalized content and geometry.
        const fingerprint = (els) => JSON.stringify(els.map(({ raw, ...el }) => el));
        if (fingerprint(elements) !== fingerprint(afterAudit)) {
          throw new Error(`screen "${screen.id}": accessibility content changed during the Apple audit; refusing to pair findings with a different screen`);
        }
      }
      const voiceOver = voiceOverCapturer?.capture(screen.id);
      if (voiceOver) {
        const afterSpeech = await settledElements(udid, screen.id, "after-voiceover");
        const fingerprint = (els) => JSON.stringify(els.map(({ raw, ...el }) => el));
        if (fingerprint(elements) !== fingerprint(afterSpeech)) {
          throw new Error(`screen "${screen.id}": accessibility content changed during VoiceOver capture; raw speech is retained but cannot be paired with this tree or screenshot`);
        }
      }
      const transcript = voiceOver
        ? voiceOver.steps.flatMap((step) => step.utterance === null ? [] : [step.utterance])
        : computeTranscript(elements);
      writeFileSync(
        join(OUT, `${screen.id}.tree.json`),
        JSON.stringify(
          {
            screen: screen.id,
            title: screen.title,
            violations,
            ...(appleAudit ? { appleAudit } : {}),
            gate: {
              errors: errors.length,
              ruleIds: [...new Set(errors.map((v) => v.ruleId))].sort(),
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(OUT, `${screen.id}.transcript.json`),
        JSON.stringify({ screen: screen.id, source: voiceOver ? "voiceover" : "computed-voiceover", transcript,
          ...(voiceOver ? { voiceOver } : {}),
        }, null, 2),
      );
      console.log(
        `  ${voiceOver ? "△" : "✓"} ${screen.id} — ${transcript.length} utterances, ${errors.length} error(s), ${violations.length - errors.length} warn(s)` +
          (voiceOver ? `; VoiceOver traversal partial (${voiceOver.coverage.reason})` : ""),
      );
    }
  } finally {
    try { await nav.stop(); }
    finally { setAppearance(initialAppearance === "dark"); }
  }
}

// describe-all output is always JSON (one flat array); the --json flag is a
// root-parser logging flag and mispositions after the verb.
const describeAll = (udid) => sh("idb", ["ui", "describe-all", "--udid", udid]);

// A dump can race the accessibility tree's realization: on the IRS app,
// walk-time dumps showed two of six list rows without their button trait
// while a later dump showed all six with it. That is a measurement
// artifact, not an app finding, so keep dumping until two consecutive
// dumps agree (or the budget runs out — a screen with a live spinner never
// settles, and the last dump is still the best evidence we have).
const SETTLE_TRIES = 6;
const SETTLE_INTERVAL_MS = 500;
async function settledElements(udid, screenId, phase = "before") {
  let prev;
  let elements;
  let lastError;
  for (let i = 0; i < SETTLE_TRIES; i++) {
    if (i) await sleep(SETTLE_INTERVAL_MS);
    try {
      const next = describeAll(udid);
      // Keep both sides of a rejected pairing available for diagnosis. Never
      // reconstruct or silently substitute a tree after native capture.
      writeFileSync(join(TREES_DIR, `${screenId}.${phase}.${i + 1}.json`), next);
      elements = normalizeElements(parseIdbOutput(next));
      validateIosCapture(elements);
      if (next === prev) return elements;
      prev = next;
      lastError = undefined;
    } catch (err) {
      // Repeated empty/invalid dumps are not a settled screen. Allow the
      // existing realization budget to recover, then fail without artifacts.
      prev = undefined;
      elements = undefined;
      lastError = err;
    }
  }
  if (lastError) {
    throw new Error(`screen "${screenId}": iOS accessibility capture failed after ${SETTLE_TRIES} attempts: ${lastError.message}`);
  }
  console.log(`    (tree did not settle after ${SETTLE_TRIES} dumps — using the last one)`);
  return elements;
}

// idb --json historically emits either one JSON array or newline-delimited
// objects depending on version — accept both.
function parseIdbOutput(out) {
  const text = out.trim();
  if (text.startsWith("[")) return JSON.parse(text);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

walk().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
