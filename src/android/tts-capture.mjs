import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { adb } from "./adb.mjs";
import { UUID, TTS_ENGINE } from "./tts-evidence.mjs";

export function collectTtsEvidence(capture, out, runAdb = adb) {
  const session = capture.commands.find((c) => UUID.test(c.tts?.clientSession))?.tts.clientSession;
  if (!session) throw new Error("logging TTS requires a rebuilt companion and the recording engine");
  return collectClientTtsEvidence(session, "com.android.talkback", out, runAdb);
}

export function collectClientTtsEvidence(session, clientPackage, out, runAdb = adb) {
  if (!UUID.test(session) || !/^[A-Za-z0-9_.]+$/.test(clientPackage)) throw new Error("invalid TTS producer identity");
  const dir = join(out, "tts-logging", session);
  mkdirSync(dir, { recursive: true });
  const client = runAdb(["exec-out", "cat", `/data/user_de/0/${clientPackage}/files/aloud-tts/${session}.jsonl`], { trim: false, timeout: 15000 });
  writeFileSync(join(dir, "client.jsonl"), client);
  const root = `/data/user_de/0/${TTS_ENGINE}/files/aloud-tts/${session}`;
  let names;
  try { names = runAdb(["shell", "ls", root], { timeout: 15000 }).split(/\r?\n/).filter(Boolean); }
  catch (error) { return { schemaVersion: 1, client, engines: [], readError: String(error.message) }; }
  if (names.length > 20 || names.some((n) => !n.endsWith(".jsonl") || !UUID.test(n.slice(0, -6)))) throw new Error("invalid engine journal filenames");
  const engines = names.sort().map((name) => {
    const raw = runAdb(["exec-out", "cat", `${root}/${name}`], { trim: false, timeout: 15000 });
    writeFileSync(join(dir, `engine-${name}`), raw);
    return raw;
  });
  return { schemaVersion: 1, client, engines };
}

// The shell runner can still export fsynced journals after its capture child was interrupted.
export function recoverTtsJournals(out, runAdb = adb) {
  const dir = join(out, "talkback-focus"), sessions = new Set();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".commands.jsonl"))) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      try {
        const row = JSON.parse(line);
        if (UUID.test(row.tts?.clientSession)) sessions.add(row.tts.clientSession);
      } catch { /* Retain a partially written command as raw data; never call it complete. */ }
    }
  }
  for (const session of sessions) collectClientTtsEvidence(session, "com.android.talkback", out, runAdb);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) recoverTtsJournals(process.argv[2]);
