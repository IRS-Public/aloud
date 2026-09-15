import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adb, shell, screenshot } from "./adb.mjs";
import { validateScreenId } from "../screen-id.mjs";
import { validateAtfEvidence, validateAtfReceipt, validateAtfSnapshot } from "./atf-evidence.mjs";

export const ATF_ACTION = "org.irs_public.aloud.ATF_COMMAND";
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
    const pid = () => runShell("pidof", target).trim();
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
