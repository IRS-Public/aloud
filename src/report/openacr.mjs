#!/usr/bin/env node
// Convert the aloud audit results into a draft OpenACR report
// (https://github.com/GSA/openacr). The draft fills in only what the
// automated audit can prove — everything else is "not-evaluated" with a
// note that a human review is required. A 508 office finishes the report.
//
//   aloud openacr --out acr-draft.yaml
//
// Inputs default to the baselines named in the resolved config
// (env ALOUD_CONFIG); point --report / --report-ios at a fresh run's
// report dir (report.mjs writes summary.json there):
//
//   --android <file>      Android baseline
//   --ios <file>          iOS baseline
//   --report <dir>        read <dir>/summary.json instead of --android
//   --report-ios <dir>    read <dir>/summary.json instead of --ios
//   --date <YYYY-MM-DD>   report date (defaults to the report's generated
//                         date, else today; tests pass it for determinism)
//   --version <v>         product version (config app.version otherwise)
//   --catalog <file>      OpenACR catalog YAML override
//   --out <file>          output path (default acr-draft.yaml in cwd)
//
// No import.meta here — the unit tests (node:test) import this module
// directly, and the exported API must stay usable without a module URL.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { dump, load } from "js-yaml";
import { cliArgs } from "../cli-args.mjs";
import { validateVoiceOverCoverage } from "../ios/voiceover-capture.mjs";
import { validateAtfSummary } from "../android/atf-evidence.mjs";
import { readWebReport, webSummary } from "../web/evidence.mjs";
import {
  CRITERIA,
  RECLASSIFIED,
  RULES as RULE_CATALOG,
  reclassifiedCriteria,
  rulesForCriterion,
  splitReclassified,
} from "../rules/catalog.mjs";

// The catalog names the edition the draft is built against. WCAG 2.2 is
// required: the target-size rules map to 2.5.8, which exists only there.
export const CATALOG_ID = "2.5-edition-wcag-2.2-508-en";

// ── audit rule → WCAG evidence ──
// Derived from the rule catalog (src/rules/catalog.mjs), the one source of
// truth the rule engines also read. RULES lists the rules that can appear
// in baseline ruleIds: errors only, since the walkers gate errors and
// warn-only rules never reach a baseline.
export const RULES = Object.freeze(Object.fromEntries(
  Object.entries(RULE_CATALOG).filter(([, rule]) => rule.severity === "error"),
));

// Criteria the audit gives partial evidence for: every criterion at least
// one error rule maps to. "covers" states, in the adherence notes, exactly
// what the automation checks — never more. "extra" names report-only
// warnings that add related evidence.
export const AUTOMATED_CRITERIA = Object.freeze(Object.fromEntries(
  Object.entries(CRITERIA)
    .map(([num, entry]) => [num, entry, rulesForCriterion(num, "error")])
    .filter(([, , rules]) => rules.length > 0)
    .map(([num, entry, rules]) => [num, Object.freeze({
      rules: Object.freeze(rules),
      covers: entry.covers,
      ...(entry.warnings ? { extra: entry.warnings } : {}),
    })]),
));

// Criteria only report-only warnings reach stay not-evaluated; their notes
// point at the related evidence. 2.5.5 (AAA, 44 CSS px) is not a criterion
// any rule maps to: the platform-guideline warnings measure near its bar
// but not against its exceptions, so its note is written here. The 302.1 note
// names the transcript coverage, so it is built per run in buildAcr from
// the actual screen counts.
const SPECIAL_NOTES = {
  "2.5.5":
    "Not evaluated; needs human review. Related evidence: where tree checks completed, report-only " +
    "platform-guideline warnings flag targets under 48x48dp on Android (native-touch-target-small) and " +
    "44x44pt on iOS (ios-touch-target-small); the gating target-size rules check the 24-unit minimum " +
    "of 2.5.8 only. Review the findings and criterion exceptions before drawing a conformance conclusion.",
};
for (const [num, entry] of Object.entries(CRITERIA)) {
  if (AUTOMATED_CRITERIA[num]) continue;
  SPECIAL_NOTES[num] =
    `Not evaluated; needs human review. Related evidence: the audit flags ${entry.covers} ` +
    `(${rulesForCriterion(num, "warn").join(", ")}) as warnings; warnings do not gate.`;
}

// Coverage strings such as "12 Android screens and 12 iOS screens" are
// always computed from the audits actually read, never hardcoded, so
// partial runs stay honest.
function screenCoverage(audits) {
  return audits
    .map(({ platform, screens }) => `${Object.keys(screens).length} ${platform} screens`)
    .join(" and ");
}

function selectScreens(audits, predicate) {
  return audits
    .map(({ platform, screens }) => ({
      platform,
      screens: Object.fromEntries(Object.entries(screens).filter(([, s]) => predicate(s))),
    }))
    .filter(({ screens }) => Object.keys(screens).length > 0);
}

function transcriptCoverage(audits) {
  const ordinary = audits.map((audit) => ({ ...audit, screens: Object.fromEntries(
    Object.entries(audit.screens).filter(([, s]) => s.transcriptSource !== "voiceover"),
  ) }));
  const spoken = selectScreens(ordinary, (s) => s.utterances > 0);
  const silent = selectScreens(ordinary, (s) => s.utterances === 0);
  const real = selectScreens(audits, (s) => s.transcriptSource === "voiceover");
  const unknown = selectScreens(audits, (s) => s.utterances == null);
  return [
    ...spoken.map((audit) =>
      `${screenCoverage([audit])} have ${audit.platform === "iOS" ? "computed utterances" : "captured speech"}.`),
    ...silent.map((audit) =>
      `${screenCoverage([audit])} have no ${audit.platform === "iOS" ? "computed utterances" : "captured speech"}.`),
    ...real.flatMap((audit) => Object.entries(audit.screens).map(([id, s]) =>
      `iOS ${id} has ${s.utterances} raw VoiceOver utterance(s) with partial traversal (${s.voiceOver.coverage.reason}); complete traversal and focus order have not been established.${s.voiceOver.initialSpeechUnavailable ? " The initial speech read timed out." : ""}`)),
    unknown.length ? `Transcript coverage is unavailable for ${screenCoverage(unknown)}.` : "",
  ].filter(Boolean).join(" ");
}

const NOT_EVALUATED_NOTE = "Not covered by the automated audit. Needs human review.";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const PLATFORMS = ["Android", "iOS"];

// A missing tree check is an explicit null, never an implicit zero. Reject
// malformed or contradictory evidence before any criterion can see it.
function validateScreens(screens, platform = "input") {
  if (!isRecord(screens)) throw new Error(`invalid audit (${platform}): screens must be an object`);
  if (Object.keys(screens).length === 0) throw new Error(`invalid audit (${platform}): no screens`);
  for (const [id, s] of Object.entries(screens)) {
    const invalid = (reason) => {
      throw new Error(`invalid audit (${platform} ${id}): ${reason}`);
    };
    if (!isRecord(s)) invalid("screen evidence must be an object");
    if (s.androidAtf !== undefined) {
      if (platform === "iOS") invalid("Android ATF evidence belongs to Android");
      validateAtfSummary(s.androidAtf);
    }
    if (s.errors !== null && !isCount(s.errors)) invalid("errors must be a non-negative integer or null");
    if (!Array.isArray(s.ruleIds) || s.ruleIds.some((r) => typeof r !== "string" || !r)) {
      invalid("ruleIds must be an array of non-empty strings");
    }
    if (new Set(s.ruleIds).size !== s.ruleIds.length) invalid("ruleIds must be unique");
    if ((s.errors === null || s.errors === 0) && s.ruleIds.length > 0) {
      invalid("ruleIds require a positive error count");
    }
    if (s.errors > 0 && (s.ruleIds.length === 0 || s.ruleIds.length > s.errors)) {
      invalid("error count and ruleIds disagree");
    }
    if (s.utterances != null && !isCount(s.utterances)) {
      invalid("utterances must be a non-negative integer or null");
    }
    if (s.transcriptSource !== undefined && !["talkback", "talkback-focus", "computed-voiceover", "voiceover"].includes(s.transcriptSource)) {
      invalid("unknown transcript source");
    }
    if ((platform === "Android" && ["voiceover", "computed-voiceover"].includes(s.transcriptSource)) ||
        (platform === "iOS" && ["talkback", "talkback-focus"].includes(s.transcriptSource))) invalid("transcript source belongs to another platform");
    if (s.transcriptSource === "talkback-focus" || s.talkBackFocus !== undefined) {
      const t = s.talkBackFocus;
      if (s.transcriptSource !== "talkback-focus" || !isCount(s.utterances) || !isRecord(t) ||
          t.coverage?.complete !== true || t.coverage?.start !== "backward-edge" || t.coverage?.reason !== "forward-edge" ||
          !Number.isInteger(t.coverage.maxSteps) || t.coverage.maxSteps < 1 || t.coverage.maxSteps > 200 ||
          !["talkback-tts-request-listener", "logging-tts"].includes(t.speechSource) ||
          t.talkbackCommit !== "229212fdf5842191d0a93fc95d9ca1423b346866" ||
          ![t.requestId, t.target].every((v) => typeof v === "string" && v.trim())) invalid("TalkBack focus needs complete traversal provenance");
      if (t.speechSource === "logging-tts") {
        const l = t.loggingTts;
        if (!isRecord(l) || l.schemaVersion !== 1 || l.source !== "logging-tts" || l.output !== "synthetic-silence" ||
            l.complete !== true || l.engine !== "org.irs_public.aloud.tts" || !isCount(l.requests) || l.requests < 1 ||
            l.requests < s.utterances || !isCount(l.queueEvents) ||
            ![l.clientSession, l.engineSession].every((v) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v))) invalid("logging TTS needs complete engine accounting");
        if ((l.completedRequests !== undefined || l.stoppedRequests !== undefined) &&
            (!isCount(l.completedRequests) || !isCount(l.stoppedRequests) || l.completedRequests + l.stoppedRequests !== l.requests)) {
          invalid("logging TTS request outcomes do not match the request count");
        }
      } else if (t.loggingTts !== undefined) invalid("logging TTS accounting needs explicit speech provenance");
    }
    if (s.transcriptSource === "voiceover" || s.voiceOver !== undefined) {
      if (s.transcriptSource !== "voiceover" || !isCount(s.utterances) || !isRecord(s.voiceOver)) {
        invalid("real VoiceOver needs a speech count and capture provenance");
      }
      try { validateVoiceOverCoverage(s.voiceOver.coverage); }
      catch { invalid("real VoiceOver needs valid partial-coverage metadata"); }
      if (s.voiceOver.initialSpeechUnavailable !== undefined && typeof s.voiceOver.initialSpeechUnavailable !== "boolean") {
        invalid("real VoiceOver initial-read coverage must be a boolean");
      }
      for (const value of [s.voiceOver.requestId, s.voiceOver.bundleId,
        s.voiceOver.toolchain?.xcode, s.voiceOver.toolchain?.simulatorUdid]) {
        if (typeof value !== "string" || !value.trim()) invalid("real VoiceOver needs capture identity and toolchain");
      }
    }
    if (s.appleAudit !== undefined && (!isRecord(s.appleAudit) || s.appleAudit.status !== "completed" ||
        !isCount(s.appleAudit.issues) || s.appleAudit.reportOnly !== true)) {
      invalid("Apple audit summary must contain completed, report-only evidence and a valid issue count");
    }
    if (s.appleAudit !== undefined && platform === "Android") {
      invalid("Apple audit evidence belongs to iOS");
    }
    // Only a rule reclassification leaves a criterion unchecked on
    // completed evidence, so only the criteria a reclassified rule on this
    // platform used to count toward may be listed.
    if (s.uncheckedCriteria !== undefined) {
      const unchecked = s.uncheckedCriteria;
      const allowed = reclassifiedCriteria(PLATFORMS.includes(platform) ? platform : undefined);
      if (!Array.isArray(unchecked) || unchecked.length === 0 || new Set(unchecked).size !== unchecked.length ||
          !unchecked.every((num) => allowed.includes(num))) {
        invalid(`uncheckedCriteria must list unique criteria a reclassified rule used to count toward (${allowed.join(", ")})`);
      }
      if (s.errors === null) invalid("uncheckedCriteria needs completed tree checks");
    }
  }
}

// Evidence written before a rule reclassification (RECLASSIFIED in
// src/rules/catalog.mjs) lists reclassified ids as errors. Read it in the
// current classification: those ids leave the error list, and the criteria
// they used to count toward become unchecked on that screen, so the draft
// neither fails a criterion on findings that no longer mean failure nor
// passes it on evidence that never checked the current rule. Returns new
// screen objects; the input is not modified.
function migrateScreens(screens) {
  return Object.fromEntries(Object.entries(screens).map(([id, s]) => {
    if (s.errors === null) return [id, s];
    const { errors, ruleIds, unchecked } = splitReclassified(s);
    if (unchecked.length === 0) return [id, s];
    const uncheckedCriteria = [...new Set([...(s.uncheckedCriteria ?? []), ...unchecked])];
    return [id, { ...s, errors, ruleIds, uncheckedCriteria }];
  }));
}

// ── inputs ──
// Baselines are a flat map { screenId: { errors, ruleIds } };
// report.mjs's summary.json wraps the same shape as
// { generated, screens: {...} }. Normalize both. The screens come back as
// written: buildAcr checks their rule ids against the platform they are
// filed under before reading them in the current classification.
export function normalizeAudit(data) {
  if (!isRecord(data)) throw new Error("invalid audit: expected a baseline or report object");
  if (data.platform === "web") throw new Error("web evidence requires --report-web so raw captures can be verified");
  const audit = Object.hasOwn(data, "screens")
    ? { screens: data.screens, generated: data.generated ?? null }
    : { screens: data, generated: null };
  validateScreens(audit.screens);
  if (audit.generated !== null && typeof audit.generated !== "string") {
    throw new Error("invalid audit: generated must be a date string or null");
  }
  return audit;
}

// Refuse rule ids the emitter does not know, or that belong to the other
// platform. Without this, a new audit rule with baseline errors would be
// invisible to every mapped criterion and the report would claim
// "supports" while the audit is failing. Runs on the screens as written,
// before migrateScreens drops reclassified ids, so an iOS baseline passed
// as Android still fails on its old 44pt id.
function validateRuleIds(screens, platform) {
  for (const [id, s] of Object.entries(screens)) {
    for (const r of s.ruleIds) {
      const rule = RULE_CATALOG[r];
      if (rule && rule.platform !== platform) {
        throw new Error(`invalid audit rule id "${r}" (${platform} ${id}): this rule runs on ${rule.platform}`);
      }
      // A reclassified id was a gating error when the evidence was written.
      if (Object.hasOwn(RECLASSIFIED, r)) continue;
      if (rule?.severity === "warn") {
        throw new Error(
          `invalid audit rule id "${r}" (${platform} ${id}): this rule is a report-only warning; ` +
            "baselines and gates count errors only",
        );
      }
      if (!RULES[r]) {
        throw new Error(
          `unknown audit rule id "${r}" (${platform} ${id}): add it, with its criteria, ` +
            "to src/rules/catalog.mjs",
        );
      }
    }
  }
}

// For one criterion, list the screens whose baseline error rule ids
// intersect the criterion's rules, per platform.
export function findFailures(criterionRules, audits) {
  const failures = [];
  for (const { platform, screens } of audits) {
    for (const [id, s] of Object.entries(screens)) {
      const hit = (s.ruleIds ?? []).filter((r) => criterionRules.includes(r));
      if (hit.length) failures.push({ platform, screen: id, ruleIds: hit });
    }
  }
  return failures;
}

function adherenceForAutomated(num, audits) {
  const auto = AUTOMATED_CRITERIA[num];
  const platforms = new Set(auto.rules.map((r) => RULES[r].platform));
  const applicable = audits.filter(({ platform }) => platforms.has(platform));
  const unsupported = audits.filter(({ platform }) => !platforms.has(platform));
  const unchecked = (s) => (s.uncheckedCriteria ?? []).includes(num);
  const completed = selectScreens(applicable, (s) => s.errors !== null && !unchecked(s));
  const stale = selectScreens(applicable, (s) => s.errors !== null && unchecked(s));
  const missing = selectScreens(applicable, (s) => s.errors === null || unchecked(s));
  const failures = findFailures(auto.rules, completed);
  const checked = screenCoverage(completed);
  const stalePlatforms = new Set(stale.map(({ platform }) => platform));
  const retired = Object.keys(RECLASSIFIED).filter((id) =>
    RECLASSIFIED[id].was.criteria.includes(num) && stalePlatforms.has(RULE_CATALOG[id].platform));
  const noTree = selectScreens(applicable, (s) => s.errors === null);
  const gaps = [
    noTree.length ? `Missing tree checks on ${screenCoverage(noTree)}; those screens remain unevaluated.` : "",
    stale.length
      ? `Evidence on ${screenCoverage(stale)} predates the current rules for this criterion ` +
        `(it lists ${retired.join(" or ")} as errors: ${retired.map((id) => RECLASSIFIED[id].change).join("; ")}); ` +
        "re-run the audit, as those screens remain unevaluated."
      : "",
    unsupported.length
      ? `No applicable automated checks for ${unsupported.map(({ platform }) => platform).join(" or ")}; this criterion remains unevaluated on that platform.`
      : "",
  ].filter(Boolean).join(" ");
  const coverage =
    `Automated checks cover part of this criterion only: ${auto.covers}. ` +
    (auto.extra ? `${auto.extra} ` : "") +
    (gaps ? `${gaps} ` : "") +
    `A human review must complete the rest. See https://github.com/IRS-Public/aloud/blob/main/docs/how-it-works.md.`;
  if (completed.length === 0) {
    return {
      level: "not-evaluated",
      notes: `No completed tree checks for this criterion. ${coverage}`,
    };
  }
  if (failures.length === 0) {
    return {
      level: missing.length ? "not-evaluated" : "supports",
      notes: `The automated tree checks found no violations on ${checked}. ${coverage}`,
    };
  }
  const detail = failures
    .map((f) => `${f.platform} ${f.screen}: ${f.ruleIds.join(", ")}`)
    .join("; ")
    .slice(0, 1500);
  return {
    level: "partially-supports",
    notes: `The automated tree checks found violations on ${failures.length} of ${checked}: ${detail}. ${coverage}`,
  };
}

// ── report ──
export function buildAcr({
  catalog,
  android,
  ios,
  web,
  date,
  productVersion,
  appName,
  appDescription,
  authorName,
  authorEmail,
}) {
  if (!appName) {
    throw new Error("buildAcr needs an app name (config app.name)");
  }
  // Validate the screens as written, then read them in the current
  // classification.
  const audits = [];
  for (const [platform, audit] of [["Android", android], ["iOS", ios]]) {
    if (audit == null) continue;
    validateScreens(audit.screens, platform);
    validateRuleIds(audit.screens, platform);
    audits.push({ platform, screens: migrateScreens(audit.screens) });
  }
  if (audits.length === 0 && !web) throw new Error("no audit input: provide at least one platform audit");
  if (web && (web.platform !== "web" || web.reportOnly !== true || !isRecord(web.screens) || !Object.keys(web.screens).length ||
    Object.values(web.screens).some((s) => s.errors !== null || s.ruleIds?.length !== 0 || s.web?.reportOnly !== true ||
      s.web?.coverage?.scenarioComplete !== true || s.web?.coverage?.fullTraversal !== false))) throw new Error("invalid report-only web summary");
  const webNotes = web ? ` Experimental web checks captured ${Object.keys(web.screens).length} named state(s) in ${web.environment.browser} ${web.environment.browserVersion}. ` +
    `Speech source: ${web.environment.screenReader === "nvda" ? "NVDA command output formatted by Guidepup" : "none; no screen reader was run"}. ` +
    "Scripted scenario completion does not establish full traversal or conformance. All web results are report-only; review raw axe results, incomplete checks, and interaction evidence in the HTML report." : "";

  const transcriptNotes = transcriptCoverage(audits);
  const hasRealVoiceOver = audits.some((audit) => Object.values(audit.screens).some((s) => s.transcriptSource === "voiceover"));
  let transcriptMethods = hasRealVoiceOver
    ? "Transcript sources are recorded per screen. Real VoiceOver output is captured through XCUIVoiceOverService, starting at current focus; partial speech does not establish conformance. Other iOS output is computed; Android output uses the TalkBack speech log."
    : "Transcripts, when present, are TalkBack speech-log output on Android and computed VoiceOver output on iOS.";
  if (audits.some((audit) => Object.values(audit.screens).some((s) => s.transcriptSource === "talkback-focus"))) {
    transcriptMethods += " Screens marked talkback-focus use the pinned TalkBack gesture pipeline and speech-request listener, with both native traversal boundaries verified. This does not prove audible delivery, correct focus order, or WCAG conformance.";
  }
  if (audits.some((audit) => Object.values(audit.screens).some((s) => s.talkBackFocus?.speechSource === "logging-tts"))) {
    transcriptMethods += " Logging TTS captures additionally verify durable requests against independent engine receipts and Android terminal callbacks, retaining stopped requests explicitly. The recording engine generates synthetic silence, not spoken audio; request accounting does not establish audible delivery or conformance.";
  }
  const note302 =
    `Not evaluated; needs human review. Related evidence: ${transcriptNotes} ${transcriptMethods} ` +
    "See https://github.com/IRS-Public/aloud/blob/main/docs/how-it-works.md.";

  const chapters = {};
  for (const chapter of catalog.chapters) {
    if (chapter.id === "hardware") {
      chapters[chapter.id] = {
        notes: `${appName} is a software application. Hardware criteria do not apply.`,
        disabled: true,
      };
      continue;
    }
    const criteria = chapter.criteria.map((c) => {
      const component = c.components.includes("software") ? "software" : c.components[0];
      let adherence;
      if (AUTOMATED_CRITERIA[c.id]) {
        adherence = adherenceForAutomated(c.id, audits);
      } else if (c.id === "302.1") {
        adherence = { level: "not-evaluated", notes: note302 };
      } else if (SPECIAL_NOTES[c.id]) {
        adherence = { level: "not-evaluated", notes: SPECIAL_NOTES[c.id] };
      } else {
        adherence = { level: "not-evaluated", notes: NOT_EVALUATED_NOTE };
      }
      return { num: c.id, components: [{ name: component, adherence }] };
    });
    chapters[chapter.id] = { criteria: criteria.map((criterion, i) => {
      const components = audits.length ? criterion.components : [];
      const catalogCriterion = chapter.criteria[i];
      if (web && catalogCriterion.components.includes("web")) components.push({ name: "web", adherence: {
        level: "not-evaluated", notes: `Needs human review.${webNotes}`,
      } });
      // Non-web catalog components are left unevaluated in a web-only draft.
      if (!components.length) components.push({ name: catalogCriterion.components[0], adherence: {
        level: "not-evaluated", notes: NOT_EVALUATED_NOTE,
      } });
      return { ...criterion, components };
    }) };
  }

  const completed = selectScreens(audits, (s) => s.errors !== null);
  const missing = selectScreens(audits, (s) => s.errors === null);
  const screenCounts = completed
    .map(({ platform, screens }) => `${Object.keys(screens).length} on ${platform}`)
    .join(", ");
  const treeNotes = completed.length
    ? `Tree checks for labels and touch-target size completed (${screenCounts}).`
    : "No completed tree checks are present in the input.";
  const missingNotes = missing.length ? ` Missing tree checks on ${screenCoverage(missing)}.` : "";
  const appleScreens = Object.values(ios?.screens ?? {}).filter((screen) => screen.appleAudit);
  const appleIssues = appleScreens.reduce((sum, screen) => sum + screen.appleAudit.issues, 0);
  const appleNotes = appleScreens.length
    ? ` Apple accessibility audits completed on ${appleScreens.length} iOS screen(s), with ${appleIssues} finding(s) requiring review. ` +
      "These native results are report-only and do not assign conformance levels. Review the separate Apple evidence in the HTML report."
    : "";
  const atfScreens = Object.values(android?.screens ?? {}).filter((s) => s.androidAtf);
  const atfNotes = atfScreens.length ? ` ATF 4.1.1 (aloud-node-v1) executed on ${atfScreens.length} Android screen(s), using AccessibilityNodeInfo snapshots. ` +
    "Native results remain report-only and add no conformance coverage. The HTML report preserves skipped results and unselected checks; neither counts as a pass." : "";

  return {
    title: `${appName} Accessibility Conformance Report (draft)`,
    product: {
      name: appName,
      version: productVersion,
      description: appDescription || (web ? `${appName} application.` : `${appName} mobile app for iOS and Android.`),
    },
    author: {
      name: authorName || "Automated draft — aloud openacr",
      email: authorEmail || "todo@example.com",
    },
    report_date: date,
    notes:
      "DRAFT. This report is generated from the automated 508 audit " +
      "(https://github.com/IRS-Public/aloud/blob/main/docs/how-it-works.md). It records only what " +
      `automation can prove. ${treeNotes}${missingNotes}${appleNotes}${atfNotes}${webNotes} ${transcriptNotes} ${audits.length ? transcriptMethods : ""} Every criterion marked ` +
      "'not-evaluated' needs a human review. A Section 508 office must complete " +
      "those rows and replace the author contact before publication.",
    evaluation_methods_used:
      (audits.length ? "Automated accessibility-tree checks use device or simulator dumps " +
      (atfScreens.length ? "(AccessibilityNodeInfo in Android ATF mode, uiautomator in standard Android mode, idb on iOS). " : "(uiautomator on Android, idb on iOS). ") +
      `${treeNotes}${missingNotes}${appleNotes}${atfNotes} ${transcriptNotes} ${transcriptMethods} Rules: ` +
      "src/android/ui-tree.mjs and src/ios/tree.mjs; WCAG mapping: src/rules/catalog.mjs. " : "") + webNotes +
      "No human evaluation yet.",
    catalog: CATALOG_ID,
    chapters,
  };
}

export function toYaml(acr) {
  return dump(acr, { lineWidth: 100 });
}

// ── CLI ──
function main() {
  const { opt } = cliArgs("openacr.mjs", {
    android: { type: "string" },
    ios: { type: "string" },
    report: { type: "string" },
    "report-ios": { type: "string" },
    "report-web": { type: "string" },
    date: { type: "string" },
    catalog: { type: "string" },
    version: { type: "string" },
    out: { type: "string" },
  });

  const cfg = process.env.ALOUD_CONFIG
    ? JSON.parse(readFileSync(process.env.ALOUD_CONFIG, "utf8"))
    : null;

  const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

  // One audit per platform: an explicit flag or report dir must exist;
  // a config-default baseline is used only when the file is present.
  const loadAudit = (reportDir, flagPath, cfgPath) => {
    if (reportDir) return normalizeAudit(readJson(join(reportDir, "summary.json")));
    if (flagPath) return normalizeAudit(readJson(flagPath));
    if (cfgPath) {
      try {
        return normalizeAudit(readJson(cfgPath));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }
    return null;
  };

  const android = loadAudit(opt("report", null), opt("android", null), cfg?.baseline?.android);
  const ios = loadAudit(opt("report-ios", null), opt("ios", null), cfg?.baseline?.ios);
  const web = opt("report-web", null) ? webSummary(readWebReport(opt("report-web", null))) : null;
  if (!android && !ios && !web) {
    console.error(
      "no audit input: pass --android/--ios baseline files or --report/--report-ios/--report-web dirs, " +
        "or set baseline paths in aloud.config.json",
    );
    process.exit(1);
  }

  const generated = android?.generated ?? ios?.generated ?? web?.generated;
  const date = opt(
    "date",
    generated ? generated.slice(0, 10) : new Date().toISOString().slice(0, 10),
  );

  // Resolve the catalog inside aloud's own install, not the target repo.
  const requireFromHere = createRequire(process.argv[1]);
  const defaultCatalog = join(
    dirname(requireFromHere.resolve("@openacr/openacr/package.json")),
    "catalog",
    `${CATALOG_ID}.yaml`,
  );
  const catalog = load(readFileSync(opt("catalog", defaultCatalog), "utf8"));

  const appName = cfg?.app?.name;
  const productVersion = opt("version", cfg?.app?.version);
  if (!appName || !productVersion) {
    console.error("openacr needs app.name and app.version (config) or --version");
    process.exit(1);
  }

  const out = opt("out", cfg?.openacr?.out ?? "acr-draft.yaml");
  const acr = buildAcr({
    catalog,
    android,
    ios,
    web,
    date,
    productVersion,
    appName,
    appDescription: cfg?.openacr?.description,
    authorName: cfg?.openacr?.author?.name,
    authorEmail: cfg?.openacr?.author?.email,
  });
  writeFileSync(out, toYaml(acr));
  console.log(`draft OpenACR → ${out} (report_date ${date})`);
}

if (process.argv[1] && process.argv[1].endsWith("openacr.mjs")) main();
