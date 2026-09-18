import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { readWebReport } from "../src/web/evidence.mjs";
import { load } from "js-yaml";

const cli = (...args) => new Promise((resolveResult, reject) => {
  const child = spawn(process.execPath, ["bin/aloud.mjs", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (value) => stdout += value);
  child.stderr.on("data", (value) => stderr += value);
  child.on("error", reject);
  child.on("close", (status) => resolveResult({ status, stdout, stderr }));
});
const require = createRequire(import.meta.url);
const { validateOpenACR } = require("@openacr/openacr/dist/validateOpenACR.js");
const { validateOpenACRCatalogValues } = require("@openacr/openacr/dist/validateOpenACRCatalogValues.js");

test("Chromium CLI captures forms and dialogs, regenerates evidence, and refuses incomplete results", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "aloud-web-browser-"));
  const html = readFileSync(new URL("./web-fixture/index.html", import.meta.url));
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/login" }); res.end(); return; }
    if (req.url === "/missing") { res.writeHead(404); res.end("Missing"); return; }
    res.setHeader("Content-Type", "text/html");
    res.end(req.url === "/empty" ? "<!doctype html><html lang=en><title>Empty</title><body></body></html>" : html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const configPath = join(dir, "config.json");
  const screensPath = join(dir, "screens.json");
  const out = join(dir, "reports");
  const config = { app: { name: "Web fixture", version: "1" }, out, web: { url, screens: screensPath } };
  const manifest = [{ id: "account", screens: [
    { id: "form-error", url: "/", ready: "#email", steps: [
      { action: "press", key: "Tab", expect: { focused: "#email" } },
      { action: "press", key: "Tab", expect: { focused: "#submit" } },
      { action: "press", key: "Enter", expect: { focused: "#email" } },
      { action: "wait", selector: "#error:text-is('Enter an email address')" },
    ] },
    { id: "modal", url: "/", steps: [
      { action: "click", selector: "#open", expect: { focused: "#close" } },
      { action: "press", key: "Escape", expect: { focused: "#open" } },
    ] },
    { id: "status", url: "/", steps: [
      { action: "click", selector: "#update" },
      { action: "wait", selector: "#status:text-is('Your account is up to date')" },
    ] },
  ] }];
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(screensPath, JSON.stringify(manifest));
  try {
    const result = await cli("web", "--config", configPath);
    assert.equal(result.status, 0, result.stderr);
    const reportDir = join(out, "web");
    const evidence = readWebReport(reportDir);
    assert.equal(Object.keys(evidence.screens).length, 3);
    assert.ok(evidence.screens["form-error"].ariaSnapshot.includes("Enter an email address"));
    assert.ok(evidence.screens["form-error"].axe.violations.some((r) => r.id === "button-name"));
    assert.equal(evidence.screens["form-error"].steps[2].focused, true);
    assert.equal(evidence.screens.modal.steps[1].focused, true);
    assert.ok(evidence.screens.status.ariaSnapshot.includes("Your account is up to date"));
    assert.ok(readFileSync(join(reportDir, "index.html"), "utf8").includes("No screen reader was run"));
    const regenerated = await cli("report", "--dir", reportDir, "--out", out);
    assert.equal(regenerated.status, 0, regenerated.stderr);
    assert.equal((await cli("report", "--dir", reportDir, "--gate", "--out", out)).status, 1);
    assert.equal((await cli("baseline", reportDir, "--out", out)).status, 1);
    const acrPath = join(dir, "web.yaml");
    const acrResult = await cli("openacr", "--config", configPath, "--report-web", reportDir, "--out", acrPath);
    assert.equal(acrResult.status, 0, acrResult.stderr);
    const acr = load(readFileSync(acrPath, "utf8"));
    const catalog = load(readFileSync(join(dirname(require.resolve("@openacr/openacr/package.json")), "catalog", `${acr.catalog}.yaml`), "utf8"));
    assert.equal(validateOpenACR(acr, "openacr-0.1.0.json").result, true);
    assert.equal(validateOpenACRCatalogValues(acr, catalog).result, true);
    assert.ok(acr.chapters.success_criteria_level_a.criteria.every((c) => c.components.every((v) => v.adherence.level === "not-evaluated")));
    assert.equal(acr.chapters.success_criteria_level_a.criteria[0].components[0].name, "web");
    const mixedResult = await cli("openacr", "--config", configPath, "--android", "test/fixtures/baseline-android.json", "--report-web", reportDir, "--out", acrPath);
    assert.equal(mixedResult.status, 0, mixedResult.stderr);
    const mixed = load(readFileSync(acrPath, "utf8"));
    assert.equal(validateOpenACRCatalogValues(mixed, catalog).result, true);
    assert.deepEqual(mixed.chapters.success_criteria_level_a.criteria[0].components.map((c) => c.name), ["software", "web"]);
    assert.ok(mixed.chapters.success_criteria_level_a.criteria.every((c) => c.components.find((v) => v.name === "web").adherence.level === "not-evaluated"));
    // A hand-edited summary cannot replace the receipt-checked raw input.
    writeFileSync(join(reportDir, "summary.json"), '{"screens":{}}');
    assert.equal((await cli("report", "--dir", reportDir, "--out", out)).status, 0);
    // Native APIs are never invoked on an unsupported host.
    if (process.platform !== "win32") {
      const wrongHost = await cli("web", "--config", configPath, "--screen-reader", "nvda");
      assert.equal(wrongHost.status, 1); assert.match(wrongHost.stderr, /requires Windows/);
      assert.equal(readWebReport(reportDir).run.runId, evidence.run.runId);
    }
    for (const [path, steps, error] of [
      ["/redirect", [], /unexpected final URL/], ["/missing", [], /successful document/],
      ["/empty", [], /no exposed page content/],
      ["/", [{ action: "press", key: "Tab", expect: { focused: "#submit" } }], /assertion failed/],
    ]) {
      writeFileSync(screensPath, JSON.stringify([{ id: "negative", screens: [{ id: "negative", url: path, steps }] }]));
      const failed = await cli("web", "--config", configPath);
      assert.equal(failed.status, 1, failed.stdout); assert.match(failed.stderr, error);
      assert.equal(JSON.parse(readFileSync(join(reportDir, "web-run.json"))).status, "failed");
      assert.ok(!existsSync(join(reportDir, "summary.json")));
      assert.equal((await cli("report", "--dir", reportDir, "--out", out)).status, 1);
      assert.equal((await cli("openacr", "--config", configPath, "--report-web", reportDir, "--out", acrPath)).status, 1);
    }
    assert.ok(readdirSync(out).some((name) => name.startsWith("web.previous-")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
