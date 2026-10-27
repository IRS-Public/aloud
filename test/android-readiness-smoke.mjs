// Disposable emulator only. Public fixture data; no app server or private account.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { adb } from "../src/android/adb.mjs";
import { waitForAndroidReady } from "../src/android/readiness.mjs";

const out = resolve(process.env.ALOUD_READINESS_OUT ?? "aloud-report/readiness-smoke");
const target = "org.irs_public.aloud.fixture";
mkdirSync(out, { recursive: true });
const results = {};
const launch = (mode) => adb(["shell", "am", "start", "-S", "-n", `${target}/.MainActivity`, "--es", "mode", mode], { timeout: 10_000 });
try {
  for (const mode of ["nested", "dialog"]) {
    launch(mode);
    const e = await waitForAndroidReady({ out: join(out, mode), target });
    assert.equal(e.status, "ready", `${e.reason}; inspect ${join(out, mode)}`);
    assert.equal(e.observations.at(-1).window.packageName, target);
    results[mode] = e.status;
  }
  adb(["shell", "am", "start", "-a", "android.settings.SETTINGS"], { timeout: 10_000 });
  const foreign = await waitForAndroidReady({ out: join(out, "foreign-window"), target, timeoutMs: 8000 });
  assert.equal(foreign.status, "not-ready");
  assert.equal(foreign.reason, "target-not-foreground");
  assert.ok(foreign.commands.some((c) => c.name === "failure-screen" && c.ok));
  results.foreignWindow = "rejected with screenshot";
  console.log("Android readiness: fixture and dialog observed; foreign foreground rejected");
} finally {
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
  // Return to our public fixture; do not interact with or dismiss system dialogs.
  launch("nested");
}
