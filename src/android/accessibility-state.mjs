// Save before the runner changes services; restore on success, error, SIGINT, and SIGTERM.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { adb, shell } from "./adb.mjs";

const KEYS = ["enabled_accessibility_services", "accessibility_enabled"];
export const TTS_KEYS = ["tts_default_synth", "tts_default_rate", "tts_default_pitch", "tts_default_locale", "tts_enabled_plugins"];
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
export function stopTalkBack(pkg, runShell = shell) {
  runShell("am", "force-stop", pkg);
  // Android's PackageMonitor handles force-stop asynchronously and removes
  // TalkBack from enabled_accessibility_services. Drain that broadcast before
  // re-enabling/restoring it, or the delayed callback can undo our settings.
  runShell("timeout", "45", "am", "wait-for-broadcast-barrier", "--flush-broadcast-loopers");
}

export function saveAccessibilityState(file, pkg, { preferences = true, tts = false, runShell = shell, runAdb = adb } = {}) {
  const state = { schemaVersion: 1, settings: Object.fromEntries(KEYS.map((key) =>
    [key, runShell("settings", "get", "secure", key)])), pkg: preferences ? pkg : null };
  if (tts) state.ttsSettings = Object.fromEntries(TTS_KEYS.map((key) => [key, runShell("settings", "get", "secure", key)]));
  if (state.pkg) {
    if (!["com.android.talkback", "com.google.android.marvin.talkback"].includes(pkg)) throw new Error("invalid TalkBack package");
    if (/cannot run as root/i.test(runAdb(["root"]))) throw new Error("saving TalkBack preferences requires a userdebug emulator");
    runAdb(["wait-for-device"], { timeout: 30000 });
    state.backup = `/data/local/tmp/aloud-state-${randomUUID()}`;
    state.dir = `/data/user_de/0/${pkg}/shared_prefs`;
    state.uid = runShell("stat", "-c", "%u", `/data/user_de/0/${pkg}`);
    if (!/^\d+$/.test(state.uid)) throw new Error("cannot determine TalkBack UID");
    runShell("mkdir", "-m", "700", state.backup);
    state.files = {};
    for (const suffix of [".xml", ".xml.bak"]) {
      const name = `${pkg}_preferences${suffix}`;
      const exists = runShell("sh", "-c", quote(`if [ -f ${state.dir}/${name} ]; then echo yes; else echo no; fi`)) === "yes";
      state.files[name] = exists;
      if (exists) runShell("cp", "-p", `${state.dir}/${name}`, `${state.backup}/${name}`);
    }
  }
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  return state;
}

export function restoreAccessibilityState(file, { runShell = shell } = {}) {
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (state.schemaVersion !== 1 || !KEYS.every((key) => typeof state.settings?.[key] === "string")) throw new Error("invalid accessibility snapshot");
  if (state.ttsSettings && !TTS_KEYS.every((key) => typeof state.ttsSettings[key] === "string")) throw new Error("invalid TTS settings snapshot");
  if (state.pkg) {
    if (!["com.android.talkback", "com.google.android.marvin.talkback"].includes(state.pkg) ||
        !/^\/data\/local\/tmp\/aloud-state-[a-f0-9-]+$/.test(state.backup) ||
        state.dir !== `/data/user_de/0/${state.pkg}/shared_prefs` || !/^\d+$/.test(state.uid)) throw new Error("invalid preferences snapshot");
    stopTalkBack(state.pkg, runShell);
    runShell("mkdir", "-p", state.dir);
    for (const suffix of [".xml", ".xml.bak"]) {
      const name = `${state.pkg}_preferences${suffix}`;
      if (state.files[name]) {
        runShell("cp", "-p", `${state.backup}/${name}`, `${state.dir}/${name}`);
      } else runShell("rm", "-f", `${state.dir}/${name}`);
    }
    runShell("chown", `${state.uid}:${state.uid}`, state.dir);
    runShell("chmod", "771", state.dir);
  }
  if (state.ttsSettings) {
    stopTalkBack("org.irs_public.aloud.tts", runShell);
    for (const key of TTS_KEYS) {
      if (state.ttsSettings[key] === "null") runShell("settings", "delete", "secure", key);
      else runShell("settings", "put", "secure", key, quote(state.ttsSettings[key]));
      if (runShell("settings", "get", "secure", key) !== state.ttsSettings[key]) throw new Error(`failed to restore ${key}; snapshot retained at ${file}`);
    }
  }
  // Clear the temporary service list first so the framework reconnects an originally enabled service.
  runShell("settings", "delete", "secure", "enabled_accessibility_services");
  for (const key of KEYS) {
    if (state.settings[key] === "null") runShell("settings", "delete", "secure", key);
    else runShell("settings", "put", "secure", key, quote(state.settings[key]));
  }
  for (const key of KEYS) {
    if (runShell("settings", "get", "secure", key) !== state.settings[key]) throw new Error(`failed to restore ${key}; snapshot retained at ${file}`);
  }
  if (state.backup) runShell("rm", "-rf", state.backup);
}
