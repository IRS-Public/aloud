// Thin adb layer for the aloud Android leg. Resolves the SDK instead of
// hard-coding one path, so the same code runs on a dev Mac and on a CI
// ubuntu runner (where adb is on PATH via ANDROID_HOME).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function resolveAdb() {
  const candidates = [
    process.env.ADB_PATH,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, "platform-tools", "adb"),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb"),
    join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return "adb"; // PATH fallback (CI)
}

export const ADB = resolveAdb();

export function adb(args, { trim = true, ...opts } = {}) {
  const output = execFileSync(ADB, args, { stdio: "pipe", maxBuffer: 64 * 1024 * 1024, ...opts }).toString();
  return trim ? output.trim() : output;
}

export const shell = (...cmd) => adb(["shell", ...cmd]);

export function waitForDevice(timeoutMs = 120_000) {
  adb(["wait-for-device"], { timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shell("getprop", "sys.boot_completed") === "1") return;
    execFileSync("sleep", ["2"]);
  }
  throw new Error("device never finished booting");
}

export const setNight = (wantDark) => shell("cmd", "uimode", "night", wantDark ? "yes" : "no");
export const getNight = () => /yes/i.test(shell("cmd", "uimode", "night"));

// Physical density in dpi — needed to convert uiautomator px bounds to dp
// for the 48dp touch-target rule. "Physical density: 420" (or "Override…").
export function getDensityDpi() {
  const out = shell("wm", "density");
  const m = out.match(/density:\s*(\d+)/i);
  if (!m) throw new Error(`cannot read density from: ${out}`);
  return Number(m[1]);
}

export function screenshot(destPath) {
  shell("screencap", "-p", "/sdcard/a11y-shot.png");
  adb(["pull", "/sdcard/a11y-shot.png", destPath]);
  shell("rm", "-f", "/sdcard/a11y-shot.png");
}

// Dump the current window's accessibility-derived view tree as XML.
// NOTE: uiautomator uses UiAutomation, which can evict a running
// AccessibilityService (TalkBack) — the walk runs it only in the tree pass,
// with TalkBack off. See src/android/walk.mjs.
export function uiDump() {
  shell("uiautomator", "dump", "/sdcard/a11y-dump.xml");
  const xml = shell("cat", "/sdcard/a11y-dump.xml");
  shell("rm", "-f", "/sdcard/a11y-dump.xml");
  return xml;
}

// Logcat markers segment the TalkBack transcript per screen: the walker logs
// one before and after each screen, then transcript.mjs slices utterances
// between them. `log` is a standard Android shell tool; the tag is ours.
export const MARKER_TAG = "A11Y_AUDIT";
export const logMarker = (text) => shell("log", "-p", "i", "-t", MARKER_TAG, text);
// The transcript pass reads the whole walk's log in one dump at the end —
// the default ring buffer (≤1MB) would evict the early screens' utterances
// under verbose TalkBack + system chatter, so grow it before capturing.
export const logcatClear = () => {
  adb(["logcat", "-G", "16M"]);
  adb(["logcat", "-c"]);
};
export const logcatDump = () => adb(["logcat", "-d", "-v", "time"]);

// Cold start every walk: `am start` over a live process resumes whatever
// screen (sheets, overlays, sessions) the previous run stranded, and the
// tree pass faithfully audits that leftover state — force-stop first makes
// runs deterministic.
export const launchApp = (appPackage, activity = ".MainActivity") => {
  if (!appPackage) throw new Error("launchApp: appPackage is required (config app.android.package)");
  shell("am", "force-stop", appPackage);
  shell("am", "start", "-n", `${appPackage}/${activity}`);
};
export const reverseMetro = (port = "8081") => adb(["reverse", `tcp:${port}`, `tcp:${port}`]);
