#!/usr/bin/env node
// Aggregate the per-screen audit reports into summary.json, an evidence
// page (index.html), and — with --gate — a ratchet check against the
// baseline: counts only go down; a screen fails if its error count rises
// above the baseline or a rule id appears that the baseline has never seen.
//
//   node src/report/report.mjs --dir <report-dir>                       # summarize only
//   node src/report/report.mjs --dir <report-dir> --baseline <f> --gate # summarize + ratchet
//   … --allow-mixed   combine per-screen evidence from different runs
//
// Every per-screen file records where it came from (src/provenance.mjs).
// The summary states that provenance, and refuses to combine files from
// different runs (another commit, a dirty tree, another aloud, machine,
// or CI run, or files written before provenance next to newer ones)
// unless --allow-mixed is passed; the summary then lists every source.
//
// With no flags, the report dir and baseline come from the resolved
// config (env ALOUD_CONFIG): <out>/android and baseline.android, or the
// iOS pair when the dir is named "ios" or ends in "-ios" (see platform.mjs).

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReportHtml } from "./html.mjs";
import { validateTalkBackFocusCapture, focusTranscript } from "../android/talkback-focus.mjs";
import { focusTtsSummary, validateFocusTts } from "../android/tts-evidence.mjs";
import { validateVoiceOverCapture } from "../ios/voiceover-capture.mjs";
import { reportWeb } from "../web/report.mjs";
import { cliArgs } from "../cli-args.mjs";
import { platformForReportDir } from "./platform.mjs";
import { readTreeReport } from "./tree-report.mjs";
import { keepAccepted } from "./accepted.mjs";
import { migrationNote, readBaseline, readEvidenceProvenance } from "./validation.mjs";
import { combineProvenance } from "../provenance.mjs";

const args = cliArgs("report.mjs", {
  dir: { type: "string" },
  out: { type: "string" },
  baseline: { type: "string" },
  gate: { type: "boolean" },
  "allow-mixed": { type: "boolean" },
});
const opt = args.opt;
const GATE = args.flag("gate");
const ALLOW_MIXED = args.flag("allow-mixed");

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
const PLATFORM = platformForReportDir(OUT);
const isIos = PLATFORM === "ios";
const BASELINE = opt("baseline", isIos ? cfg?.baseline?.ios : cfg?.baseline?.android);

if (!existsSync(OUT)) {
  console.error(`no reports at ${OUT} — run the audit walk first`);
  process.exit(1);
}

if (PLATFORM === "web") {
  try { reportWeb(OUT, { gate: GATE }); }
  catch (error) { console.error(error.message); process.exit(1); }
  process.exit(0);
}
// Reject malformed baselines before emitting summaries or accepting a gate.
// Entries naming reclassified rule ids are read in the current
// classification (see readBaseline), with a note saying so. Without
// --gate an existing baseline is still read, for the accepted reasons the
// summary and the evidence page show; a missing one is fine. A summary
// run never needed the baseline before, so there an invalid one is a
// warning and the report is written without accepted reasons, so a
// capture-only leg (--no-gate) still produces its evidence.
let baseline = null;
let migratedScreens = new Set();
if (BASELINE && (GATE || existsSync(BASELINE))) {
  let loaded = null;
  try {
    loaded = readBaseline(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {}, BASELINE);
  } catch (error) {
    if (GATE) throw error;
    console.warn(
      `warning: ignoring the baseline for this report (no --gate): ${error.message}. ` +
        "Accepted reasons are left out; fix the baseline before gating.",
    );
  }
  if (loaded) {
    baseline = loaded.baseline;
    migratedScreens = new Set(loaded.migrated.map(({ screen }) => screen));
    const note = GATE ? migrationNote(loaded.migrated, BASELINE) : "";
    if (note) console.warn(note);
  }
}

const read = (f) => JSON.parse(readFileSync(join(OUT, f), "utf8"));
const screens = {};
// Each evidence file's provenance, for the summary (see combineProvenance).
const sources = [];
for (const f of readdirSync(OUT).sort()) {
  if (f.endsWith(".tree.json")) {
    // ATF reports are recomputed from their native evidence; older
    // ordinary reports come back with any criteria they cannot speak to
    // marked unchecked (see tree-report.mjs).
    const raw = read(f);
    sources.push({ file: f, provenance: readEvidenceProvenance(raw, f) });
    const r = readTreeReport(raw, f, { isIos });
    screens[r.screen] = { ...screens[r.screen], ...r };
  } else if (f.endsWith(".transcript.json")) {
    const r = read(f);
    sources.push({ file: f, provenance: readEvidenceProvenance(r, f) });
    if (r.source === "voiceover" || r.voiceOver !== undefined) {
      if (r.source !== "voiceover" || !r.voiceOver || r.voiceOver.screen !== r.screen) {
        throw new Error(`invalid real VoiceOver evidence in ${f}`);
      }
      const v = r.voiceOver;
      // Revalidate persisted data: a hand-edited or incomplete transcript
      // must not turn an unverified traversal into a passing report.
      validateVoiceOverCapture(v,
        { requestId: v.requestId, screen: r.screen, bundleId: v.bundleId, maxSteps: v.coverage?.maxSteps });
      const raw = v.steps.flatMap((step) => step.utterance === null ? [] : [step.utterance]);
      if (JSON.stringify(raw) !== JSON.stringify(r.transcript) || typeof v.toolchain?.xcode !== "string" ||
          !v.toolchain.xcode.trim() || typeof v.toolchain?.simulatorUdid !== "string" || !v.toolchain.simulatorUdid.trim()) {
        throw new Error(`VoiceOver transcript or toolchain does not match raw evidence in ${f}`);
      }
    }
    if (r.source === "talkback-focus" || r.talkBackFocus !== undefined) {
      if (r.source !== "talkback-focus" || r.talkBackFocus?.screen !== r.screen) throw new Error(`invalid TalkBack evidence in ${f}`);
      validateTalkBackFocusCapture(r.talkBackFocus);
      if (!r.talkBackFocus.coverage.complete || JSON.stringify(focusTranscript(r.talkBackFocus)) !== JSON.stringify(r.transcript)) {
        throw new Error(`incomplete or mismatched TalkBack evidence in ${f}`);
      }
    }
    screens[r.screen] = { ...screens[r.screen], transcript: r.transcript, source: r.source,
      ...(r.talkBackFocus ? { talkBackFocus: r.talkBackFocus } : {}),
      ...(r.talkBackFocus?.speechSource === "logging-tts" ? { loggingTts: focusTtsSummary(r.talkBackFocus),
        loggingTtsRequests: validateFocusTts(r.talkBackFocus).requests.filter((request) => request.sequence >= r.talkBackFocus.commands.findIndex((c) => c.action === "first")) } : {}),
      ...(r.voiceOver ? { voiceOver: r.voiceOver } : {}),
    };
  }
}

const ids = Object.keys(screens).sort();
if (ids.length === 0) {
  console.error("no per-screen reports found — nothing to aggregate");
  process.exit(1);
}

// One report describes one run. Refuse files from different runs before
// writing anything, unless the caller explicitly allows the mix.
let provenance;
try {
  provenance = combineProvenance(sources, { allowMixed: ALLOW_MIXED, what: `report dir ${OUT}` });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (provenance?.mixed) console.warn(`warning: --allow-mixed: ${OUT} combines evidence from ${provenance.mixed.length} different runs`);

const requirementsPath = join(OUT, "capture-requirements.json");
if (existsSync(requirementsPath)) {
  const requirements = JSON.parse(readFileSync(requirementsPath, "utf8"));
  if (requirements.schemaVersion !== 1 || (!requirements.talkBackFocus && !requirements.androidAtf) ||
      ["talkBackFocus", "loggingTts", "androidAtf"].some((k) => requirements[k] !== undefined && requirements[k] !== true) ||
      (requirements.loggingTts && !requirements.talkBackFocus) ||
      (requirements.androidAtf && (!Array.isArray(requirements.atfScreens) || !requirements.atfScreens.length ||
        !requirements.atfScreens.every((id) => typeof id === "string" && id.length > 0) || new Set(requirements.atfScreens).size !== requirements.atfScreens.length))) {
    throw new Error("invalid capture requirements");
  }
  for (const id of ids) {
    if (requirements.talkBackFocus && (screens[id].source !== "talkback-focus" || !screens[id].talkBackFocus?.coverage.complete)) {
      throw new Error(`${id}: requested TalkBack traversal did not complete; raw evidence is retained`);
    }
    if (requirements.loggingTts && !screens[id].loggingTts?.complete) throw new Error(`${id}: requested logging TTS capture did not complete`);
  }
  if (requirements.androidAtf) {
    for (const id of new Set([...ids, ...requirements.atfScreens])) {
      if (!screens[id]?.atfSummary || !requirements.atfScreens.includes(id)) throw new Error(`${id}: requested Android ATF checks did not complete`);
    }
  }
}

// Accepted reasons from the baseline, for the errors this run still found.
// A reason for a rule id that no longer fires is stale and is not shown.
for (const id of ids) {
  const gate = screens[id].gate;
  if (!gate || !baseline?.[id]?.accepted) continue;
  const { kept } = keepAccepted(baseline[id].accepted, gate.ruleIds);
  if (kept.length) screens[id].accepted = kept;
}

const summary = {
  generated: new Date().toISOString(),
  ...(provenance ? { provenance } : {}),
  screens: Object.fromEntries(
    ids.map((id) => {
      const s = screens[id];
      return [
        id,
        {
          errors: s.gate?.errors ?? null,
          warns: s.violations ? s.violations.filter((v) => v.severity === "warn").length : null,
          ruleIds: s.gate?.ruleIds ?? [],
          ...(s.accepted ? { accepted: s.accepted } : {}),
          ...(s.uncheckedCriteria ? { uncheckedCriteria: s.uncheckedCriteria } : {}),
          utterances: s.transcript?.length ?? null,
          ...(s.atfSummary ? { androidAtf: s.atfSummary } : {}),
          ...(s.source ? { transcriptSource: s.source } : {}),
          ...(s.talkBackFocus ? { talkBackFocus: {
            coverage: s.talkBackFocus.coverage, requestId: s.talkBackFocus.requestId,
            target: s.talkBackFocus.target, speechSource: s.talkBackFocus.speechSource,
            talkbackCommit: s.talkBackFocus.commands[0].talkbackCommit,
            ...(s.loggingTts ? { loggingTts: s.loggingTts } : {}),
          } } : {}),
          ...(s.voiceOver ? { voiceOver: { coverage: s.voiceOver.coverage,
            initialSpeechUnavailable: s.voiceOver.steps[0]?.utterance === null,
            requestId: s.voiceOver.requestId, bundleId: s.voiceOver.bundleId, toolchain: s.voiceOver.toolchain,
          } } : {}),
          ...(s.appleAudit ? { appleAudit: {
            status: s.appleAudit.status, issues: s.appleAudit.issues.length, reportOnly: true,
          } } : {}),
        },
      ];
    }),
  ),
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));

// ── evidence page ──
// A screenshot exists only when the tree pass ran for that screen; the page
// omits the figure otherwise instead of rendering a broken image.
const shots = new Set(ids.filter((id) => existsSync(join(OUT, "shots", `${id}.png`))));

// Optional reconstructed audio: <report-dir>/speech-audio/manifest.json maps
// screen ids to utterance clips ({ i, file, text }). Produced by a separate
// step; when absent the page renders nothing audio-related.
const audioManifestPath = join(OUT, "speech-audio", "manifest.json");
let audioManifest = null;
if (existsSync(audioManifestPath)) {
  try {
    audioManifest = JSON.parse(readFileSync(audioManifestPath, "utf8"));
  } catch {
    console.warn(`ignoring unreadable audio manifest at ${audioManifestPath}`);
  }
}

writeFileSync(
  join(OUT, "index.html"),
  renderReportHtml({ screens, ids, generated: summary.generated, shots, audioManifest, provenance }),
);
console.log(`summary: ${ids.length} screens → ${join(OUT, "summary.json")}`);

// ── ratchet gate ──
if (GATE) {
  if (!BASELINE) {
    console.error("--gate needs a baseline: pass --baseline <file> or set ALOUD_CONFIG");
    process.exit(1);
  }
  const failures = [];
  for (const id of ids) {
    if (screens[id].source === "voiceover") {
      failures.push(`${id}: VoiceOver traversal is partial (${screens[id].voiceOver.coverage.reason}) — use --no-gate for partial capture evidence`);
    }
    const gate = screens[id].gate;
    if (!gate) {
      failures.push(`${id}: no completed tree checks — run the tree pass before gating, or use --no-gate for capture-only evidence`);
      continue;
    }
    if (screens[id].uncheckedCriteria) {
      failures.push(
        `${id}: tree report predates the current target-size rules, so WCAG ` +
          `${screens[id].uncheckedCriteria.join(", ")} was not checked — re-run the tree pass`,
      );
      continue;
    }
    const base = baseline[id];
    if (!base) {
      failures.push(
        `${id}: not in baseline (${gate.errors} error(s)) — run \`aloud baseline\` to accept`,
      );
      continue;
    }
    if (gate.errors > base.errors) {
      // A migrated entry allows its old count less one per retired id
      // (see readBaseline), which is still what the old entry allowed.
      const hint = migratedScreens.has(id)
        ? " (the entry predates the target-size reclassification, so it allows its old count less one per retired rule id; " +
          "if these errors are known, run `aloud baseline` to accept them)"
        : "";
      failures.push(`${id}: ${gate.errors} error(s), baseline allows ${base.errors}${hint}`);
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
