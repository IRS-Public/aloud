import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, validateForLeg } from "../src/config.mjs";
import { WEB_DEFAULTS, webScreens, validateWebConfig } from "../src/web/config.mjs";
import { hash, readWebReport, validateWebCapture, webSummary } from "../src/web/evidence.mjs";
import { renderWebReport, reportWeb } from "../src/web/report.mjs";
import { nvdaCommand } from "../src/web/nvda.mjs";
import { buildAcr, normalizeAudit } from "../src/report/openacr.mjs";
import { captureWeb } from "../src/web/run.mjs";

function fixture() {
  const screen = { id: "home", url: "https://example.test/", expectedUrl: "https://example.test/", steps: [] };
  const run = { schemaVersion: 1, platform: "web", runId: "fixture", status: "completed", cleanupComplete: true,
    generated: "2026-09-18T00:00:00Z", receipts: {}, screens: [screen],
    environment: { os: "linux", osVersion: "fixture", browser: "chromium", browserVersion: "fixture", playwright: "1.63.0", axe: "4.13.0", screenReader: "none", locale: "en-US", viewport: { width: 1280, height: 800 } } };
  const capture = { schemaVersion: 1, platform: "web", runId: "fixture", screen: "home", title: "<script>alert(1)</script>",
    status: "completed", requestedUrl: screen.url, url: screen.url, steps: [], navigationSpeech: [], speechSource: "none",
    ariaSnapshot: '- heading "Home"', snapshotSource: "playwright-aria-snapshot",
    coverage: { scope: "scripted-scenario", scenarioComplete: true, fullTraversal: false },
    axe: { testEngine: { name: "axe-core", version: "4.13.0" }, url: screen.url,
      violations: [{ id: "button-name", tags: ["wcag412"], help: "Name buttons", description: "Labels", nodes: [{ target: ["#button"], html: "<button></button>" }] }], incomplete: [], passes: [], inapplicable: [] } };
  return { run, screen, capture };
}

test("web configuration resolves paths and requires an explicit target", () => {
  const cfg = loadConfig(undefined, { web: { url: "https://example.test/" } });
  assert.equal(cfg.web.screenReader, "none");
  assert.doesNotThrow(() => validateForLeg(cfg, "web"));
  assert.throws(() => validateForLeg(loadConfig(), "web"), /needs/);
  for (const patch of [{ url: "file:///etc/passwd" }, { url: "https://u:p@example.test" }, { screenReader: "computed" }, { timeoutMs: -1 }, { headed: "true" }, { viewport: { width: 0, height: 800 } }, { surprise: true }]) {
    assert.throws(() => validateWebConfig({ ...structuredClone(WEB_DEFAULTS), ...patch }));
  }
  const dir = mkdtempSync(join(tmpdir(), "aloud-web-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ web: { screens: "screens.json", storageState: "auth.json" } }));
    const loaded = loadConfig(path);
    assert.equal(loaded.web.screens, join(dir, "screens.json"));
    assert.equal(loaded.web.storageState, join(dir, "auth.json"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("web scenarios preserve named states, resolve URLs, and reject unsupported actions", () => {
  const web = { ...WEB_DEFAULTS, url: "https://example.test/" };
  const manifest = (steps, extra = {}) => [{ id: "flow", screens: [{ id: "form", url: "/form", steps, ...extra }] }];
  assert.equal(webScreens(web, manifest([]))[0].expectedUrl, "https://example.test/form");
  assert.throws(() => webScreens(web, null, ["missing"]), /requires a web screens manifest/);
  assert.throws(() => webScreens(web, manifest([]), ["missing"]), /no web screens/);
  for (const steps of [[{ action: "eval", value: "bad" }], [{ action: "press", key: "Tab", expect: { speechIncludes: "Name" } }], [{ action: "nvda", command: "next" }], [{ action: "click", selector: "button", key: "Tab" }]]) {
    assert.throws(() => webScreens(web, manifest(steps)));
  }
  assert.throws(() => webScreens(web, manifest([], { id: "../escape" })), /screen id/);
  assert.throws(() => webScreens(web, manifest([], { eval: "bad" })), /unknown field/);
  assert.throws(() => webScreens({ ...web, screenReader: "nvda" }, manifest([{ action: "click", selector: "button", expect: { speechIncludes: "Done" } }])), /setup actions/);
});

test("structural captures cannot invent speech, completeness, or an unexpected target", () => {
  const { run, screen, capture } = fixture();
  assert.doesNotThrow(() => validateWebCapture(capture, run, screen));
  for (const mutate of [
    (c) => c.navigationSpeech.push("invented"), (c) => c.coverage.fullTraversal = true,
    (c) => c.url = "https://example.test/login", (c) => c.status = "failed",
    (c) => delete c.axe.incomplete, (c) => c.axe.testEngine.version = "other",
  ]) {
    const changed = structuredClone(capture); mutate(changed);
    assert.throws(() => validateWebCapture(changed, run, screen));
  }
});

test("NVDA command logs preserve duplicates and long output without retrying failures", async () => {
  const long = "Announced content ".repeat(50);
  const log = ["Same", "Same", long];
  let commands = 0;
  const reader = { clearSpokenPhraseLog: async () => {}, press: async () => { commands++; }, spokenPhraseLog: async () => log };
  assert.deepEqual(await nvdaCommand(reader, "press", "Tab", 1000), log);
  assert.equal(commands, 1);
  reader.press = async () => { commands++; throw new Error("disconnected"); };
  await assert.rejects(nvdaCommand(reader, "press", "Tab", 1000), /disconnected/);
  assert.equal(commands, 2);
  reader.press = async () => { commands++; return new Promise(() => {}); };
  await assert.rejects(nvdaCommand(reader, "press", "Tab", 10), /timed out/);
  assert.equal(commands, 3);
});

test("persisted web evidence checks inventory, receipts, cleanup, and refuses gating", () => {
  const { run, capture } = fixture();
  const dir = mkdtempSync(join(tmpdir(), "aloud-web-evidence-"));
  const write = () => writeFileSync(join(dir, "web-run.json"), JSON.stringify(run));
  try {
    mkdirSync(join(dir, "shots"));
    writeFileSync(join(dir, "home.web.json"), JSON.stringify(capture));
    writeFileSync(join(dir, "shots", "home.png"), "fixture image");
    run.receipts.home = { capture: hash(readFileSync(join(dir, "home.web.json"))), screenshot: hash("fixture image") }; write();
    const evidence = readWebReport(dir);
    assert.equal(webSummary(evidence).screens.home.errors, null);
    assert.equal(webSummary(evidence).screens.home.utterances, null);
    assert.throws(() => normalizeAudit(webSummary(evidence)), /report-web/);
    const html = renderWebReport(evidence);
    assert.ok(html.includes("No screen reader was run"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes("<script>alert"));
    assert.throws(() => reportWeb(dir, { gate: true }), /report-only/);
    run.cleanupComplete = false; write(); assert.throws(() => readWebReport(dir), /did not complete/);
    run.cleanupComplete = true; run.screens.push({ ...run.screens[0], id: "missing" }); write(); assert.throws(() => readWebReport(dir), /missing or unexpected/);
    run.screens.pop(); run.receipts.home.capture = "changed"; write(); assert.throws(() => readWebReport(dir), /receipt mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("NVDA persisted assertions must match captured command text and preserve repeated phrases", () => {
  const { run, capture, screen } = fixture();
  run.environment.screenReader = "nvda";
  capture.speechSource = "nvda-guidepup";
  screen.steps = [{ action: "press", key: "Enter", expect: { speechIncludes: "Saved" } }];
  capture.steps = [{ sequence: 0, action: screen.steps[0], completed: true, speech: ["Saved", "Saved"], focused: null, assertionsPassed: true }];
  assert.doesNotThrow(() => validateWebCapture(capture, run, screen));
  capture.steps[0].speech = ["Something else"];
  assert.throws(() => validateWebCapture(capture, run, screen), /contradictory assertion/);
  capture.steps[0].assertionsPassed = false;
  assert.throws(() => validateWebCapture(capture, run, screen), /failed scenario/);
});

test("actual capture lifecycle retains failed pairing and cleanup instead of producing a report", async () => {
  for (const mode of ["changed-page", "cleanup", "scan-timeout"]) {
    const dir = mkdtempSync(join(tmpdir(), "aloud-web-lifecycle-"));
    const { capture } = fixture();
    let reads = 0, browserClosed = false;
    const page = { goto: async () => ({ ok: () => true }), url: () => capture.url,
      locator: () => ({ waitFor: async () => {}, ariaSnapshot: async () => ++reads > 1 && mode === "changed-page" ? "Changed" : capture.ariaSnapshot }),
      screenshot: async ({ path }) => writeFileSync(path, "fixture image") };
    const context = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, newPage: async () => page,
      close: async () => { if (mode === "cleanup") throw new Error("context cleanup failed"); } };
    const browser = { version: () => "fixture", newContext: async () => context, close: async () => { browserClosed = true; } };
    try {
      const cfg = loadConfig(undefined, { out: dir, web: { url: capture.url, timeoutMs: 100 } });
      await assert.rejects(captureWeb(cfg, { dependencies: {
        playwright: { chromium: { launch: async () => browser } },
        axe: { default: class { async analyze() { return mode === "scan-timeout" ? new Promise(() => {}) : capture.axe; } } },
      } }), mode === "cleanup" ? /cleanup failed/ : mode === "scan-timeout" ? /axe scan timed out/ : /page changed/);
      assert.equal(browserClosed, true);
      assert.equal(JSON.parse(readFileSync(join(dir, "web", "web-run.json"))).status, "failed");
      assert.throws(() => readWebReport(join(dir, "web")), /did not complete/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("web-only OpenACR selects web components and never grants conformance", () => {
  const { run, capture } = fixture();
  const web = webSummary({ run, screens: { home: capture } });
  const acr = buildAcr({ appName: "Fixture", productVersion: "1", date: "2026-09-18", web,
    catalog: { chapters: [{ id: "success_criteria_level_a", criteria: [{ id: "4.1.2", components: ["web", "software"] }] }] } });
  assert.deepEqual(acr.chapters.success_criteria_level_a.criteria[0].components.map((c) => [c.name, c.adherence.level]), [["web", "not-evaluated"]]);
  assert.match(acr.notes, /no screen reader was run/);
  web.screens.home.web.coverage.fullTraversal = true;
  assert.throws(() => buildAcr({ appName: "Fixture", web, catalog: { chapters: [] } }), /invalid report-only/);
});
