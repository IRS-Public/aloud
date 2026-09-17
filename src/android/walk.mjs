#!/usr/bin/env node
// Walk the screens manifest on the attached Android device — the Android
// half of the aloud audit (see docs/how-it-works.md).
//
//   node src/android/walk.mjs --pass transcript   # TalkBack ON
//   node src/android/walk.mjs --pass tree         # TalkBack OFF
//   … --flow guest,payments   # subset, same ids as the screens manifest
//   … --port 8082             # app server (bridge mode) on a non-default port
//
// Reads the resolved config from $ALOUD_CONFIG (written by bin/aloud.mjs);
// flags override config values.
//
// Two passes because they can't share a device session: the transcript pass
// needs TalkBack running and undisturbed, while the tree pass shells out to
// `uiautomator dump`, whose UiAutomation connection evicts accessibility
// services. src/android/run.sh sequences them.
//
// Navigation is delegated to a nav adapter (src/nav/) — current-screen,
// deeplinks, or the dev-bridge driver. The bridge talks to the app server on
// the host, so it is platform-blind; only the device shell-outs differ
// (adb here, simctl on iOS).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNavigator } from "../nav/index.mjs";
import {
  getDensityDpi,
  getNight,
  launchApp,
  logMarker,
  logcatClear,
  logcatDump,
  reverseMetro,
  screenshot,
  setNight,
  shell,
  uiDump,
  waitForDevice,
} from "./adb.mjs";
import { createFocusCapturer, focusTranscript } from "./talkback-focus.mjs";
import { createAtfCapturer } from "./atf-capture.mjs";
import { atfTreeNodes, validateAtfEvidence } from "./atf-evidence.mjs";
import { dedupeConsecutive, segmentTranscript } from "./transcript.mjs";
import { parseUiDump, runChecks, validateUiCapture } from "./ui-tree.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CONFIG_PATH = opt("config", process.env.ALOUD_CONFIG);
if (!CONFIG_PATH) {
  console.error("no config — set ALOUD_CONFIG or pass --config (run via: aloud android)");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

const PASS = opt("pass", "tree");
const PORT = String(opt("port", cfg.nav?.bridge?.port ?? "8081"));
const OUT = opt("out", join(cfg.out ?? "aloud-report", "android"));
const NAV_MODE = cfg.nav?.mode ?? "current-screen";
const ONLY_FLOWS = opt("flow", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// How long after settle to keep listening before moving on — TalkBack
// finishes announcing a screen well after the UI settles.
const TALKBACK_SETTLE_MS = Number(opt("talkback-settle", "3500"));

if (!["transcript", "tree"].includes(PASS)) {
  console.error(`unknown --pass ${PASS} (use transcript|tree)`);
  process.exit(1);
}

// The bridge adapter reads the port from config — fold a --port override in.
cfg.nav = { ...(cfg.nav ?? {}), bridge: { ...(cfg.nav?.bridge ?? {}), port: PORT } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS_DIR = join(OUT, "shots");

function loadManifest() {
  if (NAV_MODE === "current-screen") return null;
  const p = cfg.nav?.screens;
  if (!p) {
    throw new Error(`nav.mode "${NAV_MODE}" needs a screens manifest (config nav.screens)`);
  }
  return JSON.parse(readFileSync(isAbsolute(p) ? p : resolve(process.cwd(), p), "utf8"));
}

async function walk() {
  const appPackage = cfg.app?.android?.package;
  if (!appPackage) throw new Error("config app.android.package is required for the android leg");
  const activity = cfg.app?.android?.activity ?? ".MainActivity";

  mkdirSync(OUT, { recursive: true });
  if (PASS === "tree") mkdirSync(SHOTS_DIR, { recursive: true });
  waitForDevice();
  if (NAV_MODE === "bridge") reverseMetro(PORT);
  // Cold start every walk for deterministic runs — except current-screen
  // mode, whose whole point is to audit the screen the user already has up.
  if (NAV_MODE !== "current-screen") launchApp(appPackage, activity);

  const loaded = await loadNavigator(NAV_MODE);
  const createNavigator = typeof loaded === "function" ? loaded : loaded.createNavigator;
  const nav = await createNavigator({
    platform: "android",
    config: cfg,
    manifest: loadManifest(),
    flowFilter: ONLY_FLOWS,
    device: {
      openUrl: (url) =>
        shell("am", "start", "-a", "android.intent.action.VIEW", "-d", url, appPackage),
      log: (msg) => console.log(msg),
    },
  });
  await nav.start();

  const densityDpi = PASS === "tree" ? getDensityDpi() : null;
  if (PASS === "transcript") logcatClear();

  const initialNight = getNight();
  let dark = initialNight;
  const setAppearance = (wantDark) => {
    if (dark === wantDark) return;
    setNight(wantDark);
    dark = wantDark;
  };

  const captureFocus = PASS === "transcript" && cfg.android?.talkBack === "focus"
    ? createFocusCapturer({ out: OUT, target: appPackage, maxSteps: cfg.android.talkBackMaxSteps ?? 100,
      loggingTts: cfg.android.tts === "logging" }) : null;
  const captureAtf = PASS === "tree" && cfg.android?.atf ? createAtfCapturer({ out: OUT, target: appPackage }) : null;
  if (captureAtf) {
    const path = join(OUT, "capture-requirements.json");
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    writeFileSync(path, JSON.stringify({ ...previous, schemaVersion: 1, androidAtf: true, atfScreens: nav.screens.map((s) => s.id) }));
  }
  const walked = [];
  for (const screen of nav.screens) {
    if (NAV_MODE !== "current-screen") setAppearance(!!screen.dark);
    // The start marker must land between the adapter's tab hop and its final
    // navigation, so the hop's speech stays OUTSIDE the marker pair — the
    // adapter calls onBeforeFinalNav at exactly that point.
    const hooks =
      PASS === "transcript"
        ? { onBeforeFinalNav: () => logMarker(`screen-start:${screen.id}`) }
        : {};
    await nav.goto(screen, hooks);
    if (PASS === "transcript" && NAV_MODE === "current-screen") {
      // A settled screen has no navigation event to make TalkBack speak.
      // Enable it inside the marker pair so its initial focus announcement
      // is captured without restarting the app or changing the screen.
      execFileSync(process.execPath, [fileURLToPath(new URL("./talkback.mjs", import.meta.url)), "enable",
        ...(cfg.android?.tts === "logging" ? ["--logging-tts"] : [])], {
        stdio: "inherit",
      });
    }
    // The bridge adapter sleeps internally (settle + eval timing is part of
    // the proven loop); for the other modes the walker owns the settle.
    if (NAV_MODE !== "bridge") await sleep(screen.settleMs ?? 2500);

    if (PASS === "transcript") {
      if (captureFocus) {
        const talkBackFocus = await captureFocus(screen.id);
        writeFileSync(join(OUT, `${screen.id}.transcript.json`), JSON.stringify({
          screen: screen.id, source: "talkback-focus", transcript: focusTranscript(talkBackFocus), talkBackFocus,
        }, null, 2));
      } else await sleep(TALKBACK_SETTLE_MS);
      logMarker(`screen-end:${screen.id}`);
    } else {
      let nodes, androidAtf, nativeSnapshot;
      try {
        if (captureAtf) {
          androidAtf = await captureAtf(screen.id);
          nativeSnapshot = validateAtfEvidence(androidAtf);
          nodes = atfTreeNodes(nativeSnapshot);
        } else nodes = parseUiDump(uiDump());
        validateUiCapture(nodes, appPackage);
      } catch (err) {
        throw new Error(`screen "${screen.id}": Android accessibility capture failed: ${err.message}`);
      }
      const violations = runChecks(nodes, { densityDpi: nativeSnapshot?.densityDpi ?? densityDpi, appPackage });
      const errors = violations.filter((v) => v.severity === "error");
      // .gate is what the ratchet compares and what `aloud baseline` merges
      // into the baseline file — computed once, here, so gate and baseline
      // can't drift.
      writeFileSync(
        join(OUT, `${screen.id}.tree.json`),
        JSON.stringify(
          {
            screen: screen.id,
            title: screen.title,
            ...(androidAtf ? { treeSource: "accessibility-node-info", androidAtf } : {}),
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
      if (!captureAtf) screenshot(join(SHOTS_DIR, `${screen.id}.png`));
      console.log(
        `  ✓ ${screen.id} — ${errors.length} error(s), ${violations.length - errors.length} warn(s)`,
      );
    }
    walked.push(screen.id);
    if (PASS === "transcript") console.log(`  ✓ ${screen.id}`);
  }
  setAppearance(initialNight);
  await nav.stop();

  if (PASS === "transcript" && !captureFocus) {
    const screens = segmentTranscript(logcatDump());
    for (const id of walked) {
      const transcript = dedupeConsecutive(screens[id] ?? []);
      writeFileSync(
        join(OUT, `${id}.transcript.json`),
        JSON.stringify({ screen: id, source: "talkback", transcript }, null, 2),
      );
      if (transcript.length === 0) {
        console.warn(`  ⚠ ${id}: no utterances captured — is TalkBack on with verbose logging?`);
      }
    }
    // Speech that fell outside every marker pair (persona switches, tab
    // hops) — kept as a debug artifact, ignored by the report (.debug.json).
    writeFileSync(
      join(OUT, "_between.debug.json"),
      JSON.stringify({ betweenScreens: screens["_between"] ?? [] }, null, 2),
    );
    const spoke = walked.filter((id) => (screens[id] ?? []).length > 0).length;
    console.log(`\ntranscripts: ${spoke}/${walked.length} screens captured speech`);
  }
}

walk().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
