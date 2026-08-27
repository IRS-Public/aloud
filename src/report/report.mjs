#!/usr/bin/env node
// Aggregate the per-screen audit reports into summary.json, an evidence
// page (index.html), and — with --gate — a ratchet check against the
// baseline: counts only go down; a screen fails if its error count rises
// above the baseline or a rule id appears that the baseline has never seen.
//
//   node src/report/report.mjs --dir <report-dir>                       # summarize only
//   node src/report/report.mjs --dir <report-dir> --baseline <f> --gate # summarize + ratchet
//
// With no flags, the report dir and baseline come from the resolved
// config (env ALOUD_CONFIG): <out>/android and baseline.android, or the
// iOS pair when the dir ends in "ios".

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const GATE = args.includes("--gate");

// Resolved config (written by bin/aloud.mjs) fills in whatever the flags
// do not. There are no repo-relative defaults: this tool audits someone
// else's app, so every path must be explicit.
const cfg = process.env.ALOUD_CONFIG
  ? JSON.parse(readFileSync(process.env.ALOUD_CONFIG, "utf8"))
  : null;

const OUT = opt("dir", opt("out", cfg?.out ? join(cfg.out, "android") : null));
if (!OUT) {
  console.error("no report dir: pass --dir <dir> or set ALOUD_CONFIG");
  process.exit(1);
}
const isIos = /ios\/?$/.test(OUT);
const BASELINE = opt("baseline", isIos ? cfg?.baseline?.ios : cfg?.baseline?.android);

if (!existsSync(OUT)) {
  console.error(`no reports at ${OUT} — run the audit walk first`);
  process.exit(1);
}

const read = (f) => JSON.parse(readFileSync(join(OUT, f), "utf8"));
const screens = {};
for (const f of readdirSync(OUT).sort()) {
  if (f.endsWith(".tree.json")) {
    const r = read(f);
    screens[r.screen] = { ...screens[r.screen], ...r };
  } else if (f.endsWith(".transcript.json")) {
    const r = read(f);
    screens[r.screen] = { ...screens[r.screen], transcript: r.transcript, source: r.source };
  }
}

const ids = Object.keys(screens).sort();
if (ids.length === 0) {
  console.error("no per-screen reports found — nothing to aggregate");
  process.exit(1);
}

const summary = {
  generated: new Date().toISOString(),
  screens: Object.fromEntries(
    ids.map((id) => {
      const s = screens[id];
      return [
        id,
        {
          errors: s.gate?.errors ?? null,
          warns: s.violations ? s.violations.filter((v) => v.severity === "warn").length : null,
          ruleIds: s.gate?.ruleIds ?? [],
          utterances: s.transcript?.length ?? null,
        },
      ];
    }),
  ),
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));

// ── evidence page ──
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const rows = ids
  .map((id) => {
    const s = screens[id];
    const shot = `shots/${id}.png`;
    const violations = (s.violations ?? [])
      .map(
        (v) =>
          `<li class="${v.severity}"><code>${esc(v.ruleId)}</code> (WCAG ${esc(v.wcag)}) — ${esc(v.detail)}<br><small>${esc(v.element)}</small></li>`,
      )
      .join("");
    const transcript = (s.transcript ?? []).map((u) => `<li>${esc(u)}</li>`).join("");
    // A transcript.json without a source field is an Android TalkBack
    // capture from an older walker; only "computed-voiceover" changes the label.
    const spokenLabel =
      s.source === "computed-voiceover" ? "VoiceOver transcript (computed)" : "TalkBack transcript";
    return `<section>
  <h2>${esc(s.title ?? id)} <small>${esc(id)}</small></h2>
  <div class="cols">
    <figure><img src="${shot}" alt="${esc(id)}" loading="lazy"></figure>
    <div>
      <h3>${spokenLabel} (${s.transcript?.length ?? 0})</h3>
      <ol class="say">${transcript || "<li class='none'>no capture in this run</li>"}</ol>
      <h3>Violations (${s.violations?.length ?? 0})</h3>
      <ul class="v">${violations || "<li class='none'>none</li>"}</ul>
    </div>
  </div>
</section>`;
  })
  .join("\n");

writeFileSync(
  join(OUT, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>aloud 508 audit — spoken output &amp; tree checks</title>
<style>
  :root { --accent:#1a1a2e; --ink:#111113; --line:#d5d7db; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; color: var(--ink); margin: 2rem auto; max-width: 1100px; padding: 0 1rem; }
  h1 { color: var(--accent); } h2 small { color: #777; font-weight: 400; }
  section { border-top: 1px solid var(--line); padding: 1.2rem 0; }
  .cols { display: flex; gap: 1.5rem; align-items: flex-start; }
  figure { margin: 0; } img { width: 220px; border: 1px solid var(--line); border-radius: 8px; }
  ol.say li { background: #16181b; color: #fff; border-radius: 6px; padding: 4px 10px; margin: 4px 0; font-family: ui-monospace, monospace; font-size: 13px; list-style: none; }
  ul.v li.error { color: #a01919; } ul.v li.warn { color: #8a5a00; } li.none { color: #999; }
</style></head><body>
<h1>aloud 508 audit — spoken output &amp; tree checks</h1>
<p>${ids.length} screens · generated ${esc(summary.generated)}</p>
${rows}
</body></html>`,
);
console.log(`summary: ${ids.length} screens → ${join(OUT, "summary.json")}`);

// ── ratchet gate ──
if (GATE) {
  if (!BASELINE) {
    console.error("--gate needs a baseline: pass --baseline <file> or set ALOUD_CONFIG");
    process.exit(1);
  }
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  const failures = [];
  for (const id of ids) {
    const gate = screens[id].gate;
    if (!gate) continue; // transcript-only run
    const base = baseline[id];
    if (!base) {
      failures.push(
        `${id}: not in baseline (${gate.errors} error(s)) — run \`aloud baseline\` to accept`,
      );
      continue;
    }
    if (gate.errors > base.errors) {
      failures.push(`${id}: ${gate.errors} error(s), baseline allows ${base.errors}`);
    }
    const newRules = gate.ruleIds.filter((r) => !base.ruleIds.includes(r));
    if (newRules.length) {
      failures.push(`${id}: new rule id(s) ${newRules.join(", ")}`);
    }
  }
  if (failures.length) {
    console.error(`\n✗ 508 gate failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("✓ 508 gate passed");
}
