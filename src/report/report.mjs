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
import { renderReportHtml } from "./html.mjs";
import { validateTalkBackFocusCapture, focusTranscript } from "../android/talkback-focus.mjs";
import { focusTtsSummary } from "../android/tts-evidence.mjs";
import { atfSummary, atfFindings, atfTreeNodes, validateAtfEvidence } from "../android/atf-evidence.mjs";
import { runChecks as androidTreeChecks } from "../android/ui-tree.mjs";
import { isDeepStrictEqual } from "node:util";
import { validateVoiceOverCapture } from "../ios/voiceover-capture.mjs";
import { validateBaseline, validateTreeReport } from "./validation.mjs";

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

// Reject malformed baselines before emitting summaries or accepting a gate.
const baseline = GATE && BASELINE
  ? validateBaseline(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {}, BASELINE)
  : null;

const read = (f) => JSON.parse(readFileSync(join(OUT, f), "utf8"));
const screens = {};
for (const f of readdirSync(OUT).sort()) {
  if (f.endsWith(".tree.json")) {
    const r = validateTreeReport(read(f), f);
    if (r.androidAtf !== undefined || r.treeSource === "accessibility-node-info") {
      if (isIos || r.treeSource !== "accessibility-node-info" || r.androidAtf?.screen !== r.screen) throw new Error(`invalid Android ATF source in ${f}`);
      const native = validateAtfEvidence(r.androidAtf);
      const violations = androidTreeChecks(atfTreeNodes(native), { densityDpi: native.densityDpi, appPackage: native.target });
      const errors = violations.filter((v) => v.severity === "error");
      const gate = { errors: errors.length, ruleIds: [...new Set(errors.map((v) => v.ruleId))].sort() };
      if (!isDeepStrictEqual(violations, r.violations) || !isDeepStrictEqual(gate, r.gate)) throw new Error(`Android ATF tree findings differ from native evidence in ${f}`);
      r.atfSummary = atfSummary(r.androidAtf);
      r.atfFindings = atfFindings(native, r.violations);
      r.atfNodes = native.nodes;
    }
    screens[r.screen] = { ...screens[r.screen], ...r };
  } else if (f.endsWith(".transcript.json")) {
    const r = read(f);
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
      ...(r.talkBackFocus?.speechSource === "logging-tts" ? { loggingTts: focusTtsSummary(r.talkBackFocus) } : {}),
      ...(r.voiceOver ? { voiceOver: r.voiceOver } : {}),
    };
  }
}

const ids = Object.keys(screens).sort();
if (ids.length === 0) {
  console.error("no per-screen reports found — nothing to aggregate");
  process.exit(1);
}

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
  renderReportHtml({ screens, ids, generated: summary.generated, shots, audioManifest }),
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
