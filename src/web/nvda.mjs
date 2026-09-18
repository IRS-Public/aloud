import { execFileSync } from "node:child_process";
import { webDependency } from "./dependencies.mjs";

// Guidepup captures text around its own commands. It normalizes whitespace
// and joins phrases upstream; these are command logs, never raw audio or an
// independent proof of complete speech delivery. Playwright setup actions
// are deliberately not presented as recorded screen-reader interactions.
export async function startNvda() {
  if (process.platform !== "win32") throw new Error("Experimental NVDA capture requires a dedicated Windows desktop; use --screen-reader none for structural checks");
  const running = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq nvda.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
  if (/"nvda\.exe"/i.test(running)) throw new Error("NVDA is already running; use a dedicated test desktop so capture does not replace an existing screen-reader session");
  const { nvda } = await webDependency("@guidepup/guidepup");
  await nvda.start({ capture: true });
  return nvda;
}

export async function nvdaCommand(reader, command, argument, timeoutMs) {
  await reader.clearSpokenPhraseLog();
  let timer;
  try {
    // A timed-out action is never retried or promoted to complete.
    await Promise.race([
      command === "press" ? reader.press(argument, { capture: true }) : reader[command]({ capture: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("NVDA command timed out; capture is incomplete")), timeoutMs); }),
    ]);
    const speech = await reader.spokenPhraseLog();
    if (!Array.isArray(speech) || !speech.every((s) => typeof s === "string")) throw new Error("invalid Guidepup speech log");
    return [...speech];
  } finally { clearTimeout(timer); }
}

export async function stopNvda(reader, timeoutMs = 10000) {
  let timer;
  try {
    await Promise.race([reader.stop(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("NVDA cleanup timed out; dedicated test desktop needs recovery")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
