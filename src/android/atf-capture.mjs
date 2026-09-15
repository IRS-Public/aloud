import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { adb, shell, screenshot } from "./adb.mjs";
import { validateScreenId } from "../screen-id.mjs";
import { validateAtfEvidence, validateAtfReceipt, validateAtfSnapshot } from "./atf-evidence.mjs";

export const ATF_ACTION = "org.irs_public.aloud.ATF_COMMAND";
export function recoverAtfArtifacts(out, runAdb = adb) {
  const dir = join(out, "atf"), recovered = [];
  if (!existsSync(dir)) return recovered;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    let e;
    try { e = JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { continue; }
    if (e.schemaVersion !== 1 || e.source !== "android-atf" || e.complete !== false || file !== `${e.screen}.json` ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(e.requestId)) continue;
    validateScreenId(e.screen);
    for (const phase of ["capture", "verify"]) {
      try {
        const raw = runAdb(["exec-out", "cat", `/data/user_de/0/com.android.talkback/files/aloud-atf/${e.requestId}.${phase}.json`], { trim: false, timeout: 5000 });
        if (Buffer.byteLength(raw) > 8 * 1024 * 1024) continue;
        const path = join(dir, `${e.screen}.recovered-${phase}.json`);
        writeFileSync(path, raw); recovered.push(path);
      } catch { /* Missing native output remains missing evidence; keep the incomplete envelope. */ }
    }
  }
  return recovered;
}
export function createAtfCapturer({ out, target, runAdb = adb, runShell = shell, takeScreenshot = screenshot,
  startupAttempts = 15, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!/^[A-Za-z0-9_.]+$/.test(target)) throw new Error("invalid Android ATF target package");
  const dir = join(out, "atf");
  mkdirSync(dir, { recursive: true }); mkdirSync(join(out, "shots"), { recursive: true });
  return async function capture(screen) {
    validateScreenId(screen);
    const requestId = randomUUID();
    const evidence = { schemaVersion: 1, source: "android-atf", requestId, screen, target, complete: false };
    const logs = [];
    const pid = () => { try { return runShell("pidof", target).trim(); } catch { return ""; } };
    async function command(phase, session) {
      if (pid() !== evidence.targetPidBefore) throw new Error("target process changed");
      const expected = { requestId, screen, target, phase, ...(session ? { session } : {}) };
      const args = ["shell", "am", "broadcast", "-a", ATF_ACTION, "-p", "com.android.talkback",
        "--es", "requestId", requestId, "--es", "screen", screen, "--es", "target", target, "--es", "phase", phase];
      if (session) args.push("--es", "session", session);
      let output;
      for (let i = 0; i < (phase === "capture" ? startupAttempts : 1); i++) {
        output = runAdb(args, { timeout: 15000 }); logs.push(output);
        if (!/Broadcast completed: result=0\s*$/.test(output)) break;
        await sleep(1000);
        if (pid() !== evidence.targetPidBefore) throw new Error("target process changed during startup");
      }
      const match = output?.match(/Broadcast completed: result=200, data="([A-Za-z0-9+/=]+)"/);
      if (!match) throw new Error("ATF companion unavailable or command failed; rebuild and install the --companion APK");
      const receipt = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
      validateAtfReceipt(receipt, expected);
      const record = { receipt };
      evidence[phase === "capture" ? "capture" : "verification"] = record;
      const raw = runAdb(["exec-out", "cat", `/data/user_de/0/com.android.talkback/files/aloud-atf/${receipt.file}`], { trim: false, timeout: 10000 });
      record.raw = raw;
      writeFileSync(join(dir, `${screen}.${phase}.json`), raw);
      const value = validateAtfSnapshot(raw, receipt, expected);
      if (pid() !== evidence.targetPidBefore) throw new Error("target process changed after native capture");
      return value;
    }
    try {
      evidence.targetPidBefore = pid();
      if (!evidence.targetPidBefore) throw new Error("target is not running");
      // A signal can terminate the host while the native command is running. Preserve its identity first.
      writeFileSync(join(dir, `${screen}.json`), JSON.stringify(evidence, null, 2));
      const first = await command("capture");
      takeScreenshot(join(out, "shots", `${screen}.png`));
      await command("verify", first.session);
      evidence.targetPidAfter = pid();
      evidence.complete = true;
      validateAtfEvidence(evidence);
    } catch (e) { evidence.complete = false; evidence.error = e.message; }
    finally {
      writeFileSync(join(dir, `${screen}.json`), JSON.stringify(evidence, null, 2));
      writeFileSync(join(dir, `${screen}.broadcasts.txt`), logs.join("\n"));
    }
    if (!evidence.complete) throw new Error(`screen "${screen}": Android ATF capture failed (${evidence.error}); raw evidence: ${dir}`);
    return evidence;
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: atf-capture.mjs <android-output-dir>");
  for (const file of recoverAtfArtifacts(process.argv[2])) console.log(`retained incomplete ATF artifact: ${file}`);
}
