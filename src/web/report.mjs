import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readWebReport, webSummary } from "./evidence.mjs";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const phrases = (lines) => lines.length ? `<ol>${lines.map((line) => `<li><q>${esc(line)}</q></li>`).join("")}</ol>` : "<p>No command output captured.</p>";
const results = (rules) => rules.length ? `<ul>${rules.map((rule) => `<li><strong>${esc(rule.help)}</strong> <code>${esc(rule.id)}</code>
  <p>${esc(rule.description)}</p><ul>${rule.nodes.map((node) => `<li><code>${esc(JSON.stringify(node.target))}</code><p>${esc(node.failureSummary ?? "Review raw result")}</p></li>`).join("")}</ul></li>`).join("")}</ul>` : "<p>None reported by the selected engine.</p>";

export function renderWebReport({ run, screens }) {
  const env = run.environment;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>aloud · Experimental web evidence</title><style>
  :root { color-scheme: light dark; font: 16px/1.6 system-ui,sans-serif; }
  body { margin: 0 auto; max-width: 78rem; padding: 2rem; }
  a { color: #126b62; } @media(prefers-color-scheme:dark) { a { color: #81d9cc; } }
  :focus-visible { outline: 3px solid currentColor; outline-offset: 4px; }
  section { border-top: 1px solid #888; margin-top: 2rem; padding-top: 1rem; }
  .note { border-left: 4px solid #888; padding: .5rem 1rem; }
  code, pre { font-family: ui-monospace,monospace; overflow-wrap: anywhere; white-space: pre-wrap; }
  img { display:block; max-width:100%; height:auto; border:1px solid #888; }
  li { margin-bottom: .5rem; } .skip:not(:focus) { position:absolute; left:-10000px; }
  </style></head><body><a class="skip" href="#evidence">Skip to evidence</a>
  <header><p>aloud · Web</p><h1>Experimental web evidence</h1>
  <p>${esc(env.browser)} ${esc(env.browserVersion)} · ${esc(env.os)} ${esc(env.osVersion)} · ${esc(env.locale)} · ${env.viewport.width} × ${env.viewport.height}</p>
  <p>axe-core ${esc(env.axe)} · Playwright ${esc(env.playwright)} · ${esc(run.generated)}</p>
  <p class="note"><strong>Report-only.</strong> These checks cover named page states and scripted actions. Completing a scenario does not establish full page traversal or accessibility conformance. Skipped checks and results requiring review are not passes.</p>
  <p>${env.screenReader === "none" ? "No screen reader was run. ARIA snapshots describe page structure; no speech was computed or captured." : `NVDA ${esc(env.screenReaderVersion)} · Guidepup ${esc(env.guidepup)}. Guidepup formats and groups captured command output. This is not an audio recording or proof of complete speech delivery. Delayed announcements outside command capture windows may be absent.`}</p>
  <nav aria-label="Captured states"><ul>${Object.values(screens).map((s) => `<li><a href="#${esc(s.screen)}">${esc(s.title)}</a></li>`).join("")}</ul></nav></header>
  <main id="evidence">${Object.values(screens).map((s) => `<section id="${esc(s.screen)}"><h2>${esc(s.title)}</h2>
    <p><code>${esc(s.url)}</code></p><p>Scripted scenario completed · full traversal unverified</p>
    <figure><img src="shots/${s.screen}.png" alt="Captured viewport for ${esc(s.title)}"><figcaption>Final checkpoint viewport; automated checks can include content outside this image.</figcaption></figure>
    <h3>Automated findings</h3>${results(s.axe.violations)}
    <h3>Needs review</h3>${results(s.axe.incomplete)}
    <details><summary>Check inventory</summary><p>${s.axe.passes.length} rules reported passes; ${s.axe.inapplicable.length} rules were inapplicable. Raw results retain the engine's rule and element coverage.</p></details>
    <details><summary>Structural ARIA snapshot</summary><pre>${esc(s.ariaSnapshot)}</pre></details>
    ${s.speechSource === "none" ? "" : `<h3>Initial NVDA command (Control+Home)</h3>${phrases(s.navigationSpeech)}`}
    <h3>Scripted actions</h3>${s.steps.length ? `<ol>${s.steps.map((step) => `<li><code>${esc(JSON.stringify(step.action))}</code><p>Completed${step.action.expect ? " · assertions satisfied" : ""}</p>${s.speechSource === "none" ? "" : (["press", "nvda"].includes(step.action.action) ? phrases(step.speech) : "<p>Browser setup action; speech was not captured.</p>")}</li>`).join("")}</ol>` : "<p>No interaction steps requested; only the final page state was checked.</p>"}
    <p><a href="${s.screen}.web.json">Raw capture</a></p></section>`).join("")}</main>
    <footer><p><a href="web-run.json">Run identity, environment, scope, and artifact receipts</a></p></footer></body></html>`;
}

export function reportWeb(dir, { gate = false } = {}) {
  const evidence = readWebReport(dir);
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(webSummary(evidence), null, 2)}\n`);
  writeFileSync(join(dir, "index.html"), renderWebReport(evidence));
  if (gate) throw new Error("Experimental web evidence is report-only; browser regression gating is not enabled");
  console.log(`web evidence: ${Object.keys(evidence.screens).length} state(s) → ${join(dir, "index.html")}`);
  return evidence;
}
