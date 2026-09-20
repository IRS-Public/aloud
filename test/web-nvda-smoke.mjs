// Run only on a dedicated Windows desktop after Guidepup setup. Actual
// command logs, including failed captures, remain available as CI artifacts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { captureWeb } from "../src/web/run.mjs";
import { readWebReport } from "../src/web/evidence.mjs";

assert.equal(process.platform, "win32", "NVDA smoke requires a dedicated Windows desktop");
const root = resolve("aloud-report", "web-nvda-smoke");
mkdirSync(root, { recursive: true });
const html = readFileSync(new URL("./web-fixture/index.html", import.meta.url));
const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(html); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
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
];
const path = join(root, "screens.json");
writeFileSync(path, JSON.stringify([{ id: "nvda", screens }]));
try {
  const cfg = loadConfig(undefined, { out: root, web: { screenReader: "nvda", screens: path, timeoutMs: 30000 } });
  const report = await captureWeb(cfg);
  const evidence = readWebReport(report);
  assert.equal(Object.keys(evidence.screens).length, 4);
  assert.ok(evidence.screens["repeated-long"].steps.at(-1).speech.join(" ").length > 64);
  const repeat = await captureWeb(cfg);
  assert.equal(Object.keys(readWebReport(repeat).screens).length, 4);
  console.log("NVDA fixtures completed twice; review retained command logs before promoting support.");
} finally { await new Promise((resolve) => server.close(resolve)); }
