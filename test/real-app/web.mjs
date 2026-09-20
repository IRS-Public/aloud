// Live external application, independent of Aloud's controlled fixture.
// TodoMVC stores these disposable tasks in the fresh browser context only.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfig } from "../../src/config.mjs";
import { captureWeb } from "../../src/web/run.mjs";
import { readWebReport } from "../../src/web/evidence.mjs";

const screenReader = process.env.ALOUD_WEB_READER ?? "none";
assert.ok(["none", "nvda"].includes(screenReader));
const root = resolve("aloud-report", `web-external-${screenReader}`);
mkdirSync(root, { recursive: true });
const url = "https://todomvc.com/examples/react/dist/";
const spoken = (speechIncludes) => screenReader === "nvda" ? { speechIncludes } : {};
const createTask = [
    { action: "fill", selector: ".new-todo", value: "Validate browser evidence" },
    { action: "press", key: "Enter" },
    { action: "wait", selector: ".todo-list li label:text-is('Validate browser evidence')" },
    { action: "press", key: "Tab", expect: { focused: "#toggle-all", ...spoken("Toggle All Input") } },
];
const completeTask = [
    ...createTask,
    { action: "press", key: "Tab", expect: { focused: ".todo-list .toggle" } },
    { action: "press", key: "Space", expect: { focused: ".todo-list .toggle", ...spoken("checked") } },
    { action: "wait", selector: ".todo-list li.completed" },
];
// This deployment resets its in-memory tasks on navigation. Each named
// checkpoint establishes its own state through the app's public controls.
const screens = [
  { id: "create-task", url, ready: ".new-todo", steps: createTask },
  { id: "complete-task", url, ready: ".new-todo", steps: completeTask },
  { id: "filter-completed", url, expectedUrl: `${url}#/completed`, ready: ".new-todo", steps: [
    ...completeTask,
    { action: "click", selector: 'a[href="#/"]' },
    { action: "press", key: "Tab", expect: { focused: 'a[href="#/active"]' } },
    { action: "press", key: "Tab", expect: { focused: 'a[href="#/completed"]', ...spoken("Completed") } },
    { action: "press", key: "Enter" },
    { action: "wait", selector: 'a.selected[href="#/completed"]' },
    { action: "wait", selector: ".todo-list li.completed" },
  ] },
];
const path = join(root, "screens.json");
writeFileSync(path, `${JSON.stringify([{ id: "todomvc", screens }], null, 2)}\n`);
const cfg = loadConfig(undefined, { out: root, web: { screenReader, screens: path, timeoutMs: 30000 } });
const results = [];
for (let iteration = 1; iteration <= 2; iteration++) {
  const report = await captureWeb(cfg);
  const evidence = readWebReport(report);
  assert.equal(Object.keys(evidence.screens).length, screens.length);
  for (const screen of Object.values(evidence.screens)) {
    assert.ok(screen.ariaSnapshot.includes("Validate browser evidence"));
    assert.equal(screen.speechSource, screenReader === "nvda" ? "nvda-guidepup" : "none");
  }
  results.push({ iteration, runId: evidence.run.runId, environment: evidence.run.environment,
    findings: Object.fromEntries(Object.entries(evidence.screens).map(([id, screen]) => [id,
      screen.axe.violations.map((finding) => finding.id)])) });
}
writeFileSync(join(root, "validation.json"), `${JSON.stringify({
  validatedAt: new Date().toISOString(), target: url,
  source: "Live TodoMVC React deployment; content is not a pinned golden baseline",
  screenReader, results,
}, null, 2)}\n`);
console.log(`External TodoMVC validation completed twice with ${screenReader}; raw evidence: ${root}`);
