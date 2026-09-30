#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { release } from "node:os";
import { pathToFileURL } from "node:url";
import { cliArgs } from "../cli-args.mjs";
import { SNAPSHOT_SOURCES, SPEECH_SOURCES, WEB_READERS, WEB_VERSIONS, validateWebConfig, webScreens } from "./config.mjs";
import { webDependency } from "./dependencies.mjs";
import { hash, validateWebCapture } from "./evidence.mjs";
import { startNvda, nvdaCommand, stopNvda } from "./nvda.mjs";
import { safari as safariLauncher } from "./safari.mjs";
import {
  assertNativeDesktop, safariKey, settleVoiceOver, startVoiceOver, stopVoiceOver, voiceOverCommand, voiceOverListen,
} from "./voiceover.mjs";
import { reportWeb } from "./report.mjs";
import { collectProvenance, formatTools } from "../provenance.mjs";

const json = (path, value) => {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
};
// Each screen reader's start, command, and stop functions. VoiceOver can
// also hold a capture open after a key (`listenMs` press steps).
const READERS = {
  nvda: { start: startNvda, command: nvdaCommand, stop: stopNvda },
  voiceover: { start: startVoiceOver, command: voiceOverCommand, stop: stopVoiceOver, listen: voiceOverListen },
};

async function bounded(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out; capture is incomplete`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function captureWeb(cfg, { flow = [], screenId = "current", dependencies = {} } = {}) {
  const web = cfg.web;
  validateWebConfig(web);
  const manifest = web.screens ? JSON.parse(readFileSync(web.screens, "utf8")) : null;
  const screens = webScreens(web, manifest, flow, screenId);
  if (web.screenReader === "nvda" && process.platform !== "win32" && !dependencies.startReader) throw new Error("NVDA capture requires Windows; no computed speech fallback is available");
  // VoiceOver refuses a developer desktop before any output is touched.
  if (web.screenReader === "voiceover" && !dependencies.startReader) assertNativeDesktop();
  const readerKit = READERS[web.screenReader];
  const browserName = WEB_READERS[web.screenReader];
  const safari = browserName === "safari";
  // Safari is driven through Apple Events and scanned with injected
  // axe-core, so Playwright and its axe adapter are loaded for Chromium only.
  const launcher = safari
    ? dependencies.safari ?? safariLauncher
    : (dependencies.playwright ?? await webDependency("playwright")).chromium;
  const axeModule = safari ? null : dependencies.axe ?? await webDependency("@axe-core/playwright");
  const AxeBuilder = axeModule?.default?.default ?? axeModule?.default;
  const out = resolve(cfg.out, "web");
  // Retain previous and failed evidence. A run never mixes old screen files
  // with new captures, even if it is interrupted before the first screen.
  if (existsSync(out)) renameSync(out, `${out}.previous-${Date.now()}-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(out, "shots"), { recursive: true });
  const run = { schemaVersion: 1, platform: "web", runId: randomUUID(), generated: new Date().toISOString(),
    status: "running", cleanupComplete: false, reportOnly: true, screens, receipts: {},
    environment: { os: process.platform, osVersion: release(), browser: browserName,
      ...(safari ? { axeInjection: "apple-events" } : { playwright: WEB_VERSIONS.playwright, axeAdapter: WEB_VERSIONS["@axe-core/playwright"] }),
      screenReader: web.screenReader, headless: web.screenReader === "none" && !web.headed,
      locale: web.locale, viewport: web.viewport },
    // Where the evidence came from (src/provenance.mjs). The report root
    // holds aloud's own output, so it does not count as an app change.
    provenance: collectProvenance({ exclude: [cfg.out], tools: {
      ...(safari ? {} : { playwright: WEB_VERSIONS.playwright }),
      "@axe-core/playwright": WEB_VERSIONS["@axe-core/playwright"],
      ...(readerKit ? { "@guidepup/guidepup": WEB_VERSIONS["@guidepup/guidepup"] } : {}),
    } }) };
  const saveRun = () => json(join(out, "web-run.json"), run);
  saveRun();
  let browser, reader, context, failure, interrupted = false;
  const abort = () => { interrupted = true; void browser?.close().catch(() => {}); };
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    browser = await launcher.launch({ headless: web.screenReader === "none" && !web.headed });
    run.environment.browserVersion = browser.version();
    context = await browser.newContext({ locale: web.locale, viewport: web.viewport,
      ...(web.storageState ? { storageState: web.storageState } : {}) });
    context.setDefaultTimeout(web.timeoutMs);
    context.setDefaultNavigationTimeout(web.timeoutMs);
    if (readerKit) {
      reader = await (dependencies.startReader ?? readerKit.start)();
      run.environment.screenReaderVersion = reader.version;
      run.environment.guidepup = WEB_VERSIONS["@guidepup/guidepup"];
    }
    const command = (name, argument) => readerKit.command(reader, name, argument, web.timeoutMs);
    const page = await context.newPage();
    // The structural snapshot and axe scan for this browser. Safari has no
    // accessibility snapshot for scripts, so it records a DOM outline.
    const snapshot = safari ? () => page.structuralSnapshot() : () => page.locator("body").ariaSnapshot();
    const snapshotSource = SNAPSHOT_SOURCES[browserName];
    const scan = safari ? () => page.axe() : () => new AxeBuilder({ page }).analyze();
    for (const screen of screens) {
      if (interrupted) throw new Error("web capture interrupted");
      const capture = { schemaVersion: 1, platform: "web", runId: run.runId, screen: screen.id,
        title: screen.title ?? screen.id, requestedUrl: screen.url, status: "running", steps: [],
        speechSource: SPEECH_SOURCES[reader ? web.screenReader : "none"], navigationSpeech: [],
        coverage: { scope: "scripted-scenario", scenarioComplete: false, fullTraversal: false } };
      const file = join(out, `${screen.id}.web.json`);
      try {
        const response = await page.goto(screen.url, { waitUntil: "domcontentloaded" });
        if (!response || !response.ok()) throw new Error(`navigation did not return a successful document (${response?.status() ?? "no response"})`);
        if (screen.ready) await page.locator(screen.ready).waitFor({ state: "visible" });
        await page.locator("body").waitFor({ state: "attached" });
        if (reader) {
          await page.bringToFront();
          if (!await page.evaluate(() => document.hasFocus())) throw new Error("browser document does not own keyboard focus");
          // NVDA starts at the top of the document with Control+Home.
          // VoiceOver has no equivalent key that Aloud has validated, so no
          // command is sent: it records what VoiceOver said while it settled
          // after load and focus. Speech from before that settle, such as
          // the title announced as Safari loaded, is not captured.
          capture.navigationSpeech = web.screenReader === "voiceover"
            ? await settleVoiceOver(reader, web.timeoutMs)
            : await command("press", "Control+Home");
        }
        for (const [sequence, action] of screen.steps.entries()) {
          const step = { sequence, action, completed: false, speech: [], focused: null, assertionsPassed: false };
          capture.steps.push(step);
          json(file, capture);
          if (reader && !await page.evaluate(() => document.hasFocus())) throw new Error("browser document lost keyboard focus");
          if (action.action === web.screenReader) step.speech = await command(action.command);
          else if (action.action === "press") {
            // Safari receives Option+Tab for Tab; record the key actually sent.
            if (web.screenReader === "voiceover") step.sentKey = safariKey(action.key);
            if (reader && action.listenMs) step.speech = await readerKit.listen(reader, action.key, action.listenMs, web.timeoutMs);
            else if (reader) step.speech = await command("press", action.key);
            else await page.keyboard.press(action.key);
          } else if (action.action === "click") await page.locator(action.selector).click();
          else if (action.action === "fill") await page.locator(action.selector).fill(action.value);
          else await page.locator(action.selector).waitFor({ state: "visible" });
          if (action.expect?.focused) {
            // Locators pierce open shadow roots. The active element check must
            // follow those roots too; document.activeElement alone is the host.
            step.focused = await page.locator(action.expect.focused).evaluate((el) => {
              let active = document.activeElement;
              while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
              return active === el;
            });
          }
          step.completed = true;
          step.assertionsPassed = (!action.expect?.focused || step.focused === true) &&
            (!action.expect?.speechIncludes || step.speech.some((s) => s.includes(action.expect.speechIncludes)));
          json(file, capture);
          if (!step.assertionsPassed) throw new Error(`scenario assertion failed at step ${sequence + 1}`);
        }
        capture.url = await page.url();
        if (capture.url !== screen.expectedUrl) throw new Error(`unexpected final URL: ${capture.url}; expected ${screen.expectedUrl}`);
        capture.ariaSnapshot = await snapshot();
        capture.snapshotSource = snapshotSource;
        if (!capture.ariaSnapshot.trim()) throw new Error("no exposed page content was captured");
        capture.axe = await bounded(scan(), web.timeoutMs, "axe scan");
        run.environment.axe ??= capture.axe.testEngine.version;
        await page.screenshot({ path: join(out, "shots", `${screen.id}.png`) });
        if (await page.url() !== capture.url || await snapshot() !== capture.ariaSnapshot) throw new Error("page changed while pairing checks and screenshot; raw evidence retained");
        capture.status = "completed";
        capture.coverage.scenarioComplete = true;
        validateWebCapture(capture, run, screen);
        json(file, capture);
        run.receipts[screen.id] = { capture: hash(readFileSync(file)), screenshot: hash(readFileSync(join(out, "shots", `${screen.id}.png`))) };
        saveRun();
        console.log(`  ✓ ${screen.id}: ${capture.axe.violations.length} axe rule finding(s); report-only`);
      } catch (error) {
        capture.status = "failed"; capture.coverage.scenarioComplete = false; capture.error = error.message;
        json(file, capture);
        throw error;
      }
    }
    if (interrupted) throw new Error("web capture interrupted");
  } catch (error) { failure = error; }
  finally {
    const cleanupErrors = [];
    // Reader first: closing the browser can move desktop focus and generate
    // unrelated speech. A cleanup failure prevents a completed report.
    for (const cleanup of [() => reader && readerKit.stop(reader), () => context?.close(), () => browser?.close()]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error.message); }
    }
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    run.cleanupComplete = cleanupErrors.length === 0;
    if (cleanupErrors.length) failure = new Error(`${failure?.message ?? "capture completed"}; cleanup failed: ${cleanupErrors.join("; ")}`);
    // Versions learned during the run join the tools it started with.
    run.provenance.tools = formatTools({ ...run.provenance.tools, [browserName]: run.environment.browserVersion,
      "axe-core": run.environment.axe, ...(readerKit ? { [web.screenReader]: run.environment.screenReaderVersion } : {}) });
    run.status = failure ? "failed" : "completed";
    if (failure) run.error = failure.message;
    saveRun();
  }
  if (failure) throw new Error(`${failure.message}; raw evidence: ${out}`, { cause: failure });
  reportWeb(out);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { opt } = cliArgs("web/run.mjs", { flow: { type: "string" }, "screen-id": { type: "string" } });
  try {
    if (!process.env.ALOUD_CONFIG) throw new Error("run through aloud web");
    await captureWeb(JSON.parse(readFileSync(process.env.ALOUD_CONFIG, "utf8")), {
      flow: opt("flow", "").split(",").filter(Boolean), screenId: opt("screen-id", "current"),
    });
  } catch (error) { console.error(error.message); process.exit(1); }
}
