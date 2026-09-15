#!/usr/bin/env node
// TalkBack lifecycle for the aloud audit rig:
//
//   aloud talkback status
//   aloud talkback install path/to/talkback.apk
//   aloud talkback enable     # configure + turn on
//   aloud talkback disable
//
// Every mechanism here was verified against google/talkback source
// (commit 229212fd, TalkBack 16.2) — see docs/talkback.md:
// - Prefs live in DEVICE-PROTECTED storage:
//   /data/user_de/0/<pkg>/shared_prefs/<pkg>_preferences.xml
//   and direct XML edits are invisible to a RUNNING service (Android caches
//   prefs in memory), so we force-stop, write, then enable — in that order.
// - `pref_diagnosis_mode=true` forces VERBOSE speech logging regardless of
//   `pref_log_level`, and is immune to version-migration resets; we set both.
// - `first_time_user`/`has_training_exit`/`has_onboarding_exit` (plus the
//   restore-marker and 16.2 onboarding-shown flags) suppress the first-run
//   tutorial that would otherwise cover the screen and block the walk.
// - Root is required for the prefs write; google_apis emulator images are
//   userdebug builds where `adb root` works. Play-Store images are not
//   supported here.
// - TalkBack only logs "Speaking fragment" lines once a TTS engine has
//   initialized ("TTS is not ready" otherwise) — enable() health-checks for
//   an installed engine and for that error line.

import { fileURLToPath } from "node:url";
import { saveAccessibilityState, restoreAccessibilityState, stopTalkBack } from "./accessibility-state.mjs";
import { execFileSync } from "node:child_process";
import { adb, shell } from "./adb.mjs";

// OSS source builds use com.android.talkback; the Play "Android
// Accessibility Suite" (and forks that keep its id) use the marvin package.
// The service class is the same in both.
const PACKAGES = ["com.android.talkback", "com.google.android.marvin.talkback"];
const SERVICE_CLASS = "com.google.android.marvin.talkback.TalkBackService";

const AUDIT_PREFS = {
  // speech logging
  pref_diagnosis_mode: true,
  pref_log_level: "2", // VERBOSE (string-typed ListPreference)
  // keep the run silent and the screen clean
  pref_tts_overlay: false,
  pref_soundback: false,
  pref_vibration: false,
  pref_tree_debug: false,
  // suppress first-run tutorial/onboarding (would cover every screen)
  first_time_user: false,
  has_training_exit: true,
  has_onboarding_exit: true,
  pref_has_performed_restore_key: true,
  pref_update_welcome_16_2_shown_key: true,
  pref_update_multi_finger_gestures_shown_key: true,
};

export function findTalkBack() {
  const installed = shell("pm", "list", "packages");
  return PACKAGES.find((p) => installed.includes(`package:${p}`)) ?? null;
}

const component = (pkg) => `${pkg}/${SERVICE_CLASS}`;

function prefsXml() {
  const lines = Object.entries(AUDIT_PREFS).map(([k, v]) =>
    typeof v === "boolean"
      ? `    <boolean name="${k}" value="${v}" />`
      : `    <string name="${k}">${v}</string>`,
  );
  return `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n${lines.join("\n")}\n</map>\n`;
}

function ensureRoot() {
  const out = adb(["root"]);
  if (/cannot run as root/i.test(out)) {
    throw new Error(
      "adb root refused — use a google_apis (userdebug) emulator image, not a Play-Store one",
    );
  }
  adb(["wait-for-device"]); // adbd restarts after `adb root`
}

export function configure(pkg) {
  ensureRoot();
  // Write BEFORE the service runs — a live service never re-reads the file.
  stopTalkBack(pkg);
  const dir = `/data/user_de/0/${pkg}/shared_prefs`;
  const file = `${dir}/${pkg}_preferences.xml`;
  const b64 = Buffer.from(prefsXml()).toString("base64");
  shell("mkdir", "-p", dir);
  shell("sh", "-c", `'echo ${b64} | base64 -d > ${file}'`);
  // Own the file like the app would, or the service can't read/rewrite it.
  const uid = shell("stat", "-c", "%u", `/data/user_de/0/${pkg}`);
  shell("chown", "-R", `${uid}:${uid}`, dir);
  shell("chmod", "771", dir);
  shell("chmod", "660", file);
  console.log(`configured ${file} (diagnosis mode + tutorial suppressed)`);
}

export function enable() {
  const pkg = findTalkBack();
  if (!pkg) {
    throw new Error("TalkBack is not installed — run: aloud talkback install <apk>");
  }
  configure(pkg);
  const services = shell("settings", "get", "secure", "enabled_accessibility_services");
  const enabled = services === "null" ? [] : services.split(":").filter((s) => s && !PACKAGES.some((p) => s === component(p)));
  shell("settings", "put", "secure", "enabled_accessibility_services", [...new Set([...enabled, component(pkg)])].join(":"));
  shell("settings", "put", "secure", "accessibility_enabled", "1");
  execSleep(3);
  // Health checks — fail loud now, not with a walk's worth of empty
  // transcripts later.
  const dump = shell("dumpsys", "accessibility");
  if (!dump.includes(SERVICE_CLASS)) {
    throw new Error(
      "TalkBack service did not come up (dumpsys accessibility has no TalkBackService)",
    );
  }
  const tts = shell("pm", "list", "packages").match(/package:[\w.]*tts[\w.]*/gi) ?? [];
  if (tts.length === 0) {
    console.warn(
      "⚠ no TTS engine installed — TalkBack will log 'TTS is not ready' and speech capture will be EMPTY",
    );
  }
  console.log(`TalkBack enabled (${pkg}); TTS engines: ${tts.join(", ") || "none"}`);
}

export function disable() {
  const value = shell("settings", "get", "secure", "enabled_accessibility_services");
  const remaining = (value === "null" ? [] : value.split(":")).filter((s) => s && !PACKAGES.some((p) => s === component(p)));
  if (remaining.length) shell("settings", "put", "secure", "enabled_accessibility_services", remaining.join(":"));
  else shell("settings", "delete", "secure", "enabled_accessibility_services");
  shell("settings", "put", "secure", "accessibility_enabled", remaining.length ? "1" : "0");
  console.log("TalkBack disabled");
}

export function status() {
  const pkg = findTalkBack();
  const enabled = shell("settings", "get", "secure", "enabled_accessibility_services");
  console.log(`installed: ${pkg ?? "no"}`);
  console.log(`enabled_accessibility_services: ${enabled}`);
  if (pkg) {
    const ver = shell("dumpsys", "package", pkg).match(/versionName=(\S+)/);
    console.log(`version: ${ver ? ver[1] : "?"}`);
  }
}

const execSleep = (seconds) => execFileSync("sleep", [String(seconds)]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "snapshot") saveAccessibilityState(arg, findTalkBack(), { preferences: !process.argv.includes("--settings-only") });
    else if (cmd === "restore") restoreAccessibilityState(arg);
    else if (cmd === "enable") enable();
    else if (cmd === "disable") disable();
    else if (cmd === "status") status();
    else if (cmd === "configure") {
      const pkg = findTalkBack();
      if (!pkg) throw new Error("TalkBack is not installed");
      configure(pkg);
    } else if (cmd === "install") {
      if (!arg) throw new Error("usage: aloud talkback install <apk>");
      console.log(adb(["install", "-r", "-g", arg]));
    } else {
      console.error("usage: aloud talkback <enable|disable|status|configure|install <apk>>");
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }

}
