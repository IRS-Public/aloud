#!/usr/bin/env node
// iOS half of the aloud 508 audit: walk the screens manifest on a booted
// iOS simulator, and per screen dump the accessibility tree (idb), compute
// the VoiceOver transcript, and run the iOS rules.
//
//   ALOUD_CONFIG=/path/to/config.resolved.json node src/ios/walk.mjs \
//     [--flow ids] [--port 8081] [--out dir] [--screen-id id]
//
// One pass (unlike Android's two): the transcript here is COMPUTED from the
// tree — VoiceOver itself cannot run in the Simulator until the Xcode 27
// API ships. The Xcode 27 spike showed real speech differs slightly from
// the computed format ("Order status Heading" vs "Order status, heading"),
// so the swap must normalize before baselines carry over (see
// docs/ios.md). Navigation comes from the platform-blind nav
// adapter (src/nav/), same as the Android walker.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNavigator } from "../nav/index.mjs";
import { computeTranscript, normalizeElements, runIosChecks } from "./tree.mjs";

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

async function walk() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const udid = bootedUdid();
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

  for (const screen of nav.screens) {
    if (NAV_MODE !== "current-screen") setAppearance(!!screen.dark);
    // Bridge mode sleeps internally (persona/hop/eval timing is proven and
    // owned by the adapter); other modes settle here.
    await nav.goto(screen);
    if (NAV_MODE !== "bridge") await sleep(screen.settleMs ?? 2500);

    const elements = normalizeElements(parseIdbOutput(await settledDump(udid)));
    const transcript = computeTranscript(elements);
    const violations = runIosChecks(elements);
    const errors = violations.filter((v) => v.severity === "error");
    writeFileSync(
      join(OUT, `${screen.id}.tree.json`),
      JSON.stringify(
        {
          screen: screen.id,
          title: screen.title,
          violations,
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
      JSON.stringify({ screen: screen.id, source: "computed-voiceover", transcript }, null, 2),
    );
    simctl("io", udid, "screenshot", join(SHOTS_DIR, `${screen.id}.png`));
    console.log(
      `  ✓ ${screen.id} — ${transcript.length} utterances, ${errors.length} error(s), ${violations.length - errors.length} warn(s)`,
    );
  }
  await nav.stop();
  setAppearance(initialAppearance === "dark");
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
async function settledDump(udid) {
  let prev = describeAll(udid);
  for (let i = 1; i < SETTLE_TRIES; i++) {
    await sleep(SETTLE_INTERVAL_MS);
    const next = describeAll(udid);
    if (next === prev) return next;
    prev = next;
  }
  console.log(`    (tree did not settle after ${SETTLE_TRIES} dumps — using the last one)`);
  return prev;
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
