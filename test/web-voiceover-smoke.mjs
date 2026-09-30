// Run only on a disposable GitHub-hosted macOS runner after Guidepup setup
// (.github/workflows/web-voiceover.yml). Actual command logs, including
// failed captures, remain available as CI artifacts. Not yet validated on a
// hosted runner: treat a first pass as evidence to review, not acceptance.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { captureWeb } from "../src/web/run.mjs";
import { readWebReport } from "../src/web/evidence.mjs";
import { assertNativeDesktop } from "../src/web/voiceover.mjs";

assertNativeDesktop();
const root = resolve("aloud-report", "web-voiceover-smoke");
mkdirSync(root, { recursive: true });
const html = readFileSync(new URL("./web-fixture/index.html", import.meta.url));
const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(html); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
// The NVDA fixture scenarios, with VoiceOver's cursor commands added. Safari
// receives Tab as Option+Tab; setup clicks are page scripts.
const screens = [
  { id: "form-error", url, steps: [
    { action: "click", selector: "#email" },
    { action: "press", key: "Tab", expect: { focused: "#submit", speechIncludes: "Save email" } },
    { action: "press", key: "Enter", expect: { focused: "#email", speechIncludes: "Enter an email address" } },
  ] },
  { id: "modal-return", url, steps: [
    { action: "click", selector: "#open", expect: { focused: "#close" } },
    { action: "press", key: "Escape", expect: { focused: "#open", speechIncludes: "Open preferences" } },
  ] },
  { id: "live-status", url, steps: [
    { action: "click", selector: "#update" },
    { action: "press", key: "Enter", expect: { speechIncludes: "Your account has no new changes" } },
  ] },
  { id: "repeated-long", url, steps: [
    { action: "click", selector: "#repeat-one" },
    { action: "press", key: "Tab", expect: { focused: "#repeat-two", speechIncludes: "Repeat" } },
    { action: "press", key: "Shift+Tab", expect: { focused: "#repeat-one", speechIncludes: "Repeat" } },
    { action: "press", key: "Tab", expect: { focused: "#repeat-two", speechIncludes: "Repeat" } },
    { action: "press", key: "Tab", expect: { focused: "#long", speechIncludes: "including this final verification phrase" } },
  ] },
  { id: "cursor", url, steps: [
    { action: "voiceover", command: "nextHeading", expect: { speechIncludes: "Account settings" } },
    { action: "voiceover", command: "next" },
  ] },
];
const path = join(root, "screens.json");
writeFileSync(path, JSON.stringify([{ id: "voiceover", screens }]));
try {
  const cfg = loadConfig(undefined, { out: root, web: { screenReader: "voiceover", screens: path, timeoutMs: 30000 } });
  const report = await captureWeb(cfg);
  const evidence = readWebReport(report);
  assert.equal(Object.keys(evidence.screens).length, screens.length);
  assert.ok(evidence.screens["repeated-long"].steps.at(-1).speech.join(" ").length > 64);
  const repeat = await captureWeb(cfg);
  assert.equal(Object.keys(readWebReport(repeat).screens).length, screens.length);
  console.log("VoiceOver fixtures completed twice; review retained command logs before promoting support.");
} finally { await new Promise((resolve) => server.close(resolve)); }
