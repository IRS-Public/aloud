// Turn aloud's own audit evidence into a findings document
// (src/acr/findings.mjs), so aloud's native drafts go through the same
// builder (src/acr/build.mjs) as any other evidence source.
//
//   import { aloudFindings, buildAloudAcr } from "@irs-public/aloud/src/acr/from-aloud.mjs";
//
// Inputs are the ones `aloud openacr` reads: the Android and iOS baselines
// or report summaries (normalizeAudit), and the report-only web summary
// (src/web/evidence.mjs webSummary). The rule catalog (src/rules/catalog.mjs)
// decides which criterion each rule counts toward.
//
// The findings say only what automation can prove:
//   - A criterion aloud's error rules map to is "partly-tested" when every
//     applicable screen completed tree checks with no mapped failures:
//     the rules check part of each criterion only (the catalog's covers
//     text), so a clean result cannot support the whole criterion. Never
//     "met": no rule set covers a whole criterion.
//   - A mapped failure is "failing" with failingShare "some": the audit
//     sees the screens it was given, so it cannot prove the failure affects
//     all of the product.
//   - Missing or stale tree checks make it "incomplete"; a criterion no
//     supplied platform has rules for is "untested".
//   - 302.1 and the criteria only warnings reach are "untested", with
//     their related evidence (transcript coverage, warnings) in the notes.
//   - Web evidence is report-only: every web row is "untested".
//   - A failure the baseline accepts (src/report/accepted.mjs) is still a
//     failure: its reason becomes one of the finding's issues, so the
//     draft's notes explain it. That holds for every kind, platform gaps
//     included: the checks ran and found the violation, so the product
//     partially supports the criterion whatever the cause. Nothing
//     accepted ever reads as "met" or as unevaluated.
//   - Where the evidence came from (src/provenance.mjs) becomes the
//     findings' provenance and the draft's notes. Inputs from different
//     code (another app commit, uncommitted changes, another aloud) are
//     refused unless allowMixed is set, and then the notes say so.
//     Baselines, and summaries written before provenance, record none;
//     the notes say that too, and the draft then names no commit for the
//     whole product.
// Native evidence is reported on the catalog's "software" component and
// web evidence on "web", as the drafts always have been.
//
// Malformed or contradictory evidence throws before any finding is made.

import { validateAtfSummary } from "../android/atf-evidence.mjs";
import { validateVoiceOverCoverage } from "../ios/voiceover-capture.mjs";
import {
  CRITERIA,
  RECLASSIFIED,
  RULES as RULE_CATALOG,
  reclassifiedCriteria,
  rulesForCriterion,
  splitReclassified,
} from "../rules/catalog.mjs";
import { isIssueUrl, keepAccepted, validateAccepted } from "../report/accepted.mjs";
import { readSummaryProvenance } from "../report/validation.mjs";
import {
  codeIdentity,
  describeCode,
  describeProvenance,
  isMixedProvenance,
  validateProvenance,
} from "../provenance.mjs";
import { DRAFT_AUTHOR, buildAcr } from "./build.mjs";
import { DEFAULT_CATALOG_ID, checkCatalog, checkCatalogId, hasNoComponents, indexCatalog, loadCatalog } from "./catalog.mjs";

// The catalog aloud's drafts are built against. WCAG 2.2 is required: the
// target-size rules map to 2.5.8, which exists only there.
export const CATALOG_ID = DEFAULT_CATALOG_ID;

// aloud's notes carry more than the builder's default 1500 characters
// allows: the 2.5.8 coverage text alone is about 900, and the failing
// screens are listed after it. The screen list comes last, so when a note
// is capped only that list is cut, and the cut is marked.
export const ALOUD_MAX_NOTE_LENGTH = 3000;

// The builder states a finding's issues (aloud's accepted reasons) before
// its notes, so a long list of them could push the coverage caveat out of
// a capped note. The cap for a findings document therefore grows by the
// longest issues statement it holds (an upper bound on the builder's
// "Known issues: ..." text), and only the screen list is ever cut.
export function aloudMaxNoteLength(findings) {
  const issuesLength = (issues) =>
    issues.reduce((n, i) => n + i.id.length + i.summary.length + (i.kind?.length ?? 0) + (i.url?.length ?? 0) + 8, 16);
  return ALOUD_MAX_NOTE_LENGTH + Math.max(0, ...findings.findings.map((f) => (f.issues ? issuesLength(f.issues) : 0)));
}

const DEFAULT_AUTHOR_NAME = "Automated draft — aloud openacr";
const HOW_IT_WORKS = "https://github.com/IRS-Public/aloud/blob/main/docs/how-it-works.md";

// ── audit rule → WCAG evidence ──
// RULES lists the rules that can appear in baseline ruleIds: errors only,
// since the walkers gate errors and warn-only rules never reach a baseline.
export const RULES = Object.freeze(Object.fromEntries(
  Object.entries(RULE_CATALOG).filter(([, rule]) => rule.severity === "error"),
));

// Criteria the audit gives partial evidence for: every criterion at least
// one error rule maps to. "covers" states exactly what the automation
// checks, never more. "extra" names report-only warnings that add related
// evidence.
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

// Criteria only report-only warnings reach stay untested; their notes point
// at the related evidence. 2.5.5 (AAA, 44 CSS px) is not a criterion any
// rule maps to: the platform-guideline warnings measure near its bar but
// not against its exceptions, so its note is written here. The 302.1 note
// names the transcript coverage, so it is built per run from the actual
// screen counts.
const RELATED_EVIDENCE = {
  "2.5.5":
    "Related evidence: where tree checks completed, report-only platform-guideline warnings flag " +
    "targets under 48x48dp on Android (native-touch-target-small) and 44x44pt on iOS " +
    "(ios-touch-target-small); the gating target-size rules check the 24-unit minimum of 2.5.8 only. " +
    "Review the findings and criterion exceptions before drawing a conformance conclusion.",
};
for (const [num, entry] of Object.entries(CRITERIA)) {
  if (AUTOMATED_CRITERIA[num]) continue;
  RELATED_EVIDENCE[num] =
    `Related evidence: the audit flags ${entry.covers} ` +
    `(${rulesForCriterion(num, "warn").join(", ")}) as warnings; warnings do not gate.`;
}

// ── evidence validation ──

const PLATFORMS = ["Android", "iOS"];
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isUuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

// Each transcript source and the platform whose screen reader produces it.
const TRANSCRIPT_SOURCES = {
  talkback: "Android",
  "talkback-focus": "Android",
  "computed-voiceover": "iOS",
  voiceover: "iOS",
};

// The TalkBack build the focus pipeline is verified against, and the
// speech sources it records.
const TALKBACK_COMMIT = "229212fdf5842191d0a93fc95d9ca1423b346866";
const TALKBACK_SPEECH_SOURCES = ["talkback-tts-request-listener", "logging-tts"];
const LOGGING_TTS_ENGINE = "org.irs_public.aloud.tts";

// TalkBack focus speech counts only with complete traversal between both
// native edges, from the pinned TalkBack build.
function checkTalkBackFocus(s, invalid) {
  const t = s.talkBackFocus;
  const coverage = isRecord(t) ? t.coverage : undefined;
  const complete =
    s.transcriptSource === "talkback-focus" &&
    isCount(s.utterances) &&
    isRecord(t) &&
    coverage?.complete === true &&
    coverage.start === "backward-edge" &&
    coverage.reason === "forward-edge" &&
    Number.isInteger(coverage.maxSteps) &&
    coverage.maxSteps >= 1 &&
    coverage.maxSteps <= 200 &&
    TALKBACK_SPEECH_SOURCES.includes(t.speechSource) &&
    t.talkbackCommit === TALKBACK_COMMIT &&
    isText(t.requestId) &&
    isText(t.target);
  if (!complete) invalid("TalkBack focus needs complete traversal provenance");
  if (t.speechSource === "logging-tts") {
    checkLoggingTts(t.loggingTts, s.utterances, invalid);
  } else if (t.loggingTts !== undefined) {
    invalid("logging TTS accounting needs explicit speech provenance");
  }
}

// The recording engine must account for every request it received, in a
// session both the client and the engine name.
function checkLoggingTts(l, utterances, invalid) {
  const accounted =
    isRecord(l) &&
    l.schemaVersion === 1 &&
    l.source === "logging-tts" &&
    l.output === "synthetic-silence" &&
    l.complete === true &&
    l.engine === LOGGING_TTS_ENGINE &&
    isCount(l.requests) &&
    l.requests >= 1 &&
    l.requests >= utterances &&
    isCount(l.queueEvents) &&
    isUuid(l.clientSession) &&
    isUuid(l.engineSession);
  if (!accounted) invalid("logging TTS needs complete engine accounting");
  const hasOutcomes = l.completedRequests !== undefined || l.stoppedRequests !== undefined;
  if (hasOutcomes && (
    !isCount(l.completedRequests) ||
    !isCount(l.stoppedRequests) ||
    l.completedRequests + l.stoppedRequests !== l.requests
  )) {
    invalid("logging TTS request outcomes do not match the request count");
  }
}

// Real VoiceOver speech is always partial and must say who captured it.
function checkVoiceOver(s, invalid) {
  if (s.transcriptSource !== "voiceover" || !isCount(s.utterances) || !isRecord(s.voiceOver)) {
    invalid("real VoiceOver needs a speech count and capture provenance");
  }
  try {
    validateVoiceOverCoverage(s.voiceOver.coverage);
  } catch {
    invalid("real VoiceOver needs valid partial-coverage metadata");
  }
  const unavailable = s.voiceOver.initialSpeechUnavailable;
  if (unavailable !== undefined && typeof unavailable !== "boolean") {
    invalid("real VoiceOver initial-read coverage must be a boolean");
  }
  const { requestId, bundleId, toolchain } = s.voiceOver;
  if (![requestId, bundleId, toolchain?.xcode, toolchain?.simulatorUdid].every(isText)) {
    invalid("real VoiceOver needs capture identity and toolchain");
  }
}

// A missing tree check is an explicit null, never an implicit zero. Reject
// malformed or contradictory evidence before any criterion can see it.
// platform is "Android", "iOS", or "input" when it is not known yet.
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

    // Tree check counts.
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
    // Accepted reasons name the screen's own rule ids, as written.
    if (s.accepted !== undefined) {
      try {
        validateAccepted(s.accepted, s.ruleIds, "accepted");
      } catch (error) {
        invalid(error.message);
      }
    }

    // Transcript counts and where they came from.
    if (s.utterances != null && !isCount(s.utterances)) {
      invalid("utterances must be a non-negative integer or null");
    }
    if (s.transcriptSource !== undefined) {
      if (!Object.hasOwn(TRANSCRIPT_SOURCES, s.transcriptSource)) invalid("unknown transcript source");
      const owner = TRANSCRIPT_SOURCES[s.transcriptSource];
      if (PLATFORMS.includes(platform) && owner !== platform) {
        invalid("transcript source belongs to another platform");
      }
    }
    if (s.transcriptSource === "talkback-focus" || s.talkBackFocus !== undefined) checkTalkBackFocus(s, invalid);
    if (s.transcriptSource === "voiceover" || s.voiceOver !== undefined) checkVoiceOver(s, invalid);

    // Report-only native audits.
    if (s.appleAudit !== undefined) {
      const a = s.appleAudit;
      if (!isRecord(a) || a.status !== "completed" || !isCount(a.issues) || a.reportOnly !== true) {
        invalid("Apple audit summary must contain completed, report-only evidence and a valid issue count");
      }
      if (platform === "Android") invalid("Apple audit evidence belongs to iOS");
    }

    // Only a rule reclassification leaves a criterion unchecked on
    // completed evidence, so only the criteria a reclassified rule on this
    // platform used to count toward may be listed.
    if (s.uncheckedCriteria !== undefined) {
      const unchecked = s.uncheckedCriteria;
      const allowed = reclassifiedCriteria(PLATFORMS.includes(platform) ? platform : undefined);
      const wellFormed =
        Array.isArray(unchecked) &&
        unchecked.length > 0 &&
        new Set(unchecked).size === unchecked.length &&
        unchecked.every((num) => allowed.includes(num));
      if (!wellFormed) {
        invalid(`uncheckedCriteria must list unique criteria a reclassified rule used to count toward (${allowed.join(", ")})`);
      }
      if (s.errors === null) invalid("uncheckedCriteria needs completed tree checks");
    }
  }
}

// Refuse rule ids the catalog does not know as errors, or that belong to
// the other platform. Without this, a new audit rule with baseline errors
// would be invisible to every mapped criterion and the report would claim
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

// Evidence written before a rule reclassification (RECLASSIFIED in
// src/rules/catalog.mjs) lists reclassified ids as errors. Read it in the
// current classification: those ids leave the error list, and the criteria
// they used to count toward become unchecked on that screen, so the draft
// neither fails a criterion on findings that no longer mean failure nor
// passes it on evidence that never checked the current rule. An accepted
// reason for a reclassified id leaves with it. Returns new screen objects;
// the input is not modified.
function migrateScreens(screens) {
  return Object.fromEntries(Object.entries(screens).map(([id, s]) => {
    if (s.errors === null) return [id, s];
    const { errors, ruleIds, unchecked } = splitReclassified(s);
    if (unchecked.length === 0) return [id, s];
    const uncheckedCriteria = [...new Set([...(s.uncheckedCriteria ?? []), ...unchecked])];
    const { accepted: written, ...rest } = s;
    const { kept } = keepAccepted(written, ruleIds);
    return [id, { ...rest, errors, ruleIds, uncheckedCriteria, ...(kept.length ? { accepted: kept } : {}) }];
  }));
}

// The report-only web summary must say it is report-only, per screen, and
// must not claim tree checks or full traversal it never ran.
function validateWebSummary(web) {
  const screenOk = (s) =>
    isRecord(s) &&
    s.errors === null &&
    s.ruleIds?.length === 0 &&
    s.web?.reportOnly === true &&
    s.web?.coverage?.scenarioComplete === true &&
    s.web?.coverage?.fullTraversal === false;
  const valid =
    isRecord(web) &&
    web.platform === "web" &&
    web.reportOnly === true &&
    isRecord(web.screens) &&
    Object.keys(web.screens).length > 0 &&
    Object.values(web.screens).every(screenOk) &&
    isRecord(web.environment);
  if (!valid) throw new Error("invalid report-only web summary");
  if (web.provenance !== undefined) validateProvenance(web.provenance, "invalid report-only web summary: provenance");
}

// ── inputs ──
// Baselines are a flat map { screenId: { errors, ruleIds, accepted? } };
// report.mjs's summary.json wraps the same shape as
// { generated, provenance?, screens: {...} }. Normalize both. The screens
// come back as written: aloudFindings checks their rule ids against the
// platform they are filed under before reading them in the current
// classification. A summary's provenance comes back validated; baselines
// and older summaries have none.
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
  if (Object.hasOwn(data, "screens")) {
    let provenance;
    try {
      provenance = readSummaryProvenance(data, "report summary");
    } catch (error) {
      throw new Error(`invalid audit: ${error.message}`);
    }
    if (provenance) audit.provenance = provenance;
  }
  return audit;
}

// ── provenance ──

// Each input's provenance, labeled by platform. A summary written with
// --allow-mixed holds several records; one without provenance holds none.
// complete says every piece of the input's evidence has a record: false
// for a baseline or an older summary, and for a mixed summary that
// includes files written before provenance.
function provenanceSources({ android, ios, web }) {
  return [["Android", android], ["iOS", ios], ["Web", web]]
    .filter(([, input]) => input != null)
    .map(([label, input]) => {
      const value = input.provenance;
      const mixed = isMixedProvenance(value);
      const groups = !value ? [] : mixed ? value.mixed.map((group) => group.provenance) : [value];
      return {
        label,
        value,
        records: groups.filter(Boolean),
        mixed,
        complete: groups.length > 0 && groups.every(Boolean),
      };
    });
}

const codeKey = (record) => JSON.stringify(codeIdentity(record));

// What differs between records that name different code, as advice: the
// fix for a second commit is not the fix for uncommitted changes.
function sameCodeAdvice(records) {
  const differs = (field) => new Set(records.map((record) => JSON.stringify(codeIdentity(record)[field]))).size > 1;
  const advice = [];
  if (differs("commit")) advice.push("re-run the audits on one commit");
  else if (differs("workingTreeDirty")) {
    advice.push("the commits match but the working tree state differs: commit or stash the changes and re-run the audits");
  }
  if (differs("aloudVersion") || differs("aloudCommit")) advice.push("re-run the audits with one version of aloud");
  return advice.join("; ");
}

// Refuse inputs from different code unless allowMixed: a draft describes
// one version of the product. Machines, runtimes, and CI runs may differ
// (Android and iOS evidence often come from different runners); the code
// may not. A summary that already combines different runs needs
// allowMixed too.
function checkSameCode(sources, allowMixed) {
  if (allowMixed) return;
  for (const source of sources) {
    if (source.mixed) {
      throw new Error(
        `the ${source.label} report summary combines evidence from different runs (it was written with --allow-mixed); ` +
          "pass --allow-mixed to build a draft from it anyway",
      );
    }
  }
  const byCode = new Map();
  for (const { label, records } of sources) {
    for (const record of records) {
      const key = codeKey(record);
      if (!byCode.has(key)) byCode.set(key, { record, labels: [] });
      byCode.get(key).labels.push(label);
    }
  }
  if (byCode.size > 1) {
    const groups = [...byCode.values()];
    const detail = groups.map(({ record, labels }) => `${labels.join(" and ")}: ${describeCode(record)}`).join("; ");
    throw new Error(
      `the audit inputs come from different code, so they cannot describe one version of the product (${detail}); ` +
        `${sameCodeAdvice(groups.map((group) => group.record))}, or pass --allow-mixed to combine them anyway`,
    );
  }
}

// The findings' provenance (src/acr/findings.schema.json), which the
// builder states for the whole draft. The commit, its working tree state
// (null when it could not be read), and the run are set only when every
// input, and every part of a mixed input, recorded provenance and they
// all agree: a baseline beside a summary could come from any build, so
// naming the summary's commit would cover evidence it does not describe.
// The tools, aloud and Node.js included, are every recorded input's.
// Undefined when no input recorded provenance.
function findingsProvenance(sources) {
  const records = sources.flatMap((source) => source.records);
  if (records.length === 0) return undefined;
  const provenance = {};
  const complete = sources.every((source) => source.complete);
  const codes = new Set(records.map(codeKey));
  if (complete && codes.size === 1 && records[0].commit) {
    provenance.commit = records[0].commit;
    provenance.workingTreeDirty = records[0].workingTreeDirty;
  }
  const runUrls = new Set(records.map((record) => record.githubRunUrl));
  const [runUrl] = runUrls;
  if (complete && runUrls.size === 1 && runUrl) provenance.runUrl = runUrl;
  const tools = [];
  const add = (name, version) => {
    if (!tools.some((tool) => tool.name === name && tool.version === version)) tools.push({ name, version });
  };
  for (const record of records) {
    add("aloud", `${record.aloud.version}${record.aloud.commit ? ` (${record.aloud.commit.slice(0, 12)})` : ""}`);
  }
  for (const record of records) add("Node.js", record.node);
  const named = records.flatMap((record) => Object.entries(record.tools));
  named.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, version] of named) add(name, version);
  provenance.tools = tools;
  return provenance;
}

// One report note per input saying where its evidence came from, then a
// note when different code was combined. The builder already states the
// draft-wide commit, run, and tools (shared, from findingsProvenance), so
// an input's note gives only what that sentence does not: the code when
// there is no draft-wide commit, the machine, and the run when there is
// no draft-wide one. Tools are never repeated here.
function provenanceNotes(sources, allowMixed, shared = {}) {
  const notes = sources.map(({ label, value, mixed }) => {
    if (!value) {
      return `${label} evidence records no provenance (a baseline, or a report written before aloud recorded provenance).`;
    }
    if (mixed) return `${label} evidence provenance: ${describeProvenance(value)}`;
    const parts = [];
    if (!shared.commit) parts.push(describeCode(value));
    parts.push(`Node ${value.node} on ${value.platform} ${value.architecture}`);
    if (!shared.runUrl && value.githubRunUrl) parts.push(`run ${value.githubRunUrl}`);
    return `${label} evidence provenance: ${parts.join("; ")}.`;
  });
  const codes = new Set(sources.flatMap((s) => s.records).map(codeKey));
  if (allowMixed && (codes.size > 1 || sources.some((s) => s.mixed))) {
    notes.push(
      "The inputs were combined with --allow-mixed although they come from different runs or code; " +
        "the draft does not describe a single version of the product.",
    );
  }
  return notes;
}

// ── coverage text ──
// Coverage strings such as "12 Android screens and 12 iOS screens" are
// always computed from the audits actually read, never hardcoded, so
// partial runs stay honest.
function screenCoverage(audits) {
  return audits
    .map(({ platform, screens }) => `${Object.keys(screens).length} ${platform} screens`)
    .join(" and ");
}

// The audits limited to the screens predicate accepts; platforms left with
// no screens are dropped.
function selectScreens(audits, predicate) {
  return audits
    .map(({ platform, screens }) => ({
      platform,
      screens: Object.fromEntries(Object.entries(screens).filter(([, s]) => predicate(s))),
    }))
    .filter(({ screens }) => Object.keys(screens).length > 0);
}

function transcriptCoverage(audits) {
  const ordinary = selectScreens(audits, (s) => s.transcriptSource !== "voiceover");
  const spoken = selectScreens(ordinary, (s) => s.utterances > 0);
  const silent = selectScreens(ordinary, (s) => s.utterances === 0);
  const real = selectScreens(audits, (s) => s.transcriptSource === "voiceover");
  const unknown = selectScreens(audits, (s) => s.utterances == null);
  const speech = (platform) => (platform === "iOS" ? "computed utterances" : "captured speech");
  const realNote = (id, s) =>
    `iOS ${id} has ${s.utterances} raw VoiceOver utterance(s) with partial traversal ` +
    `(${s.voiceOver.coverage.reason}); complete traversal and focus order have not been established.` +
    (s.voiceOver.initialSpeechUnavailable ? " The initial speech read timed out." : "");
  return [
    ...spoken.map((audit) => `${screenCoverage([audit])} have ${speech(audit.platform)}.`),
    ...silent.map((audit) => `${screenCoverage([audit])} have no ${speech(audit.platform)}.`),
    ...real.flatMap((audit) => Object.entries(audit.screens).map(([id, s]) => realNote(id, s))),
    unknown.length ? `Transcript coverage is unavailable for ${screenCoverage(unknown)}.` : "",
  ].filter(Boolean).join(" ");
}

function transcriptMethods(audits) {
  const screens = audits.flatMap((audit) => Object.values(audit.screens));
  let methods = screens.some((s) => s.transcriptSource === "voiceover")
    ? "Transcript sources are recorded per screen. Real VoiceOver output is captured through " +
      "XCUIVoiceOverService, starting at current focus; partial speech does not establish conformance. " +
      "Other iOS output is computed; Android output uses the TalkBack speech log."
    : "Transcripts, when present, are TalkBack speech-log output on Android and computed VoiceOver output on iOS.";
  if (screens.some((s) => s.transcriptSource === "talkback-focus")) {
    methods +=
      " Screens marked talkback-focus use the pinned TalkBack gesture pipeline and speech-request " +
      "listener, with both native traversal boundaries verified. This does not prove audible delivery, " +
      "correct focus order, or WCAG conformance.";
  }
  if (screens.some((s) => s.talkBackFocus?.speechSource === "logging-tts")) {
    methods +=
      " Logging TTS captures additionally verify durable requests against independent engine receipts " +
      "and Android terminal callbacks, retaining stopped requests explicitly. The recording engine " +
      "generates synthetic silence, not spoken audio; request accounting does not establish audible " +
      "delivery or conformance.";
  }
  return methods;
}

function webNote(web) {
  const { browser, browserVersion, screenReader } = web.environment;
  const speeches = {
    none: "none; no screen reader was run",
    nvda: "NVDA command output formatted by Guidepup",
    voiceover: "VoiceOver command output formatted by Guidepup",
  };
  if (!Object.hasOwn(speeches, screenReader)) throw new Error(`invalid report-only web summary: unknown screen reader ${screenReader}`);
  const speech = speeches[screenReader];
  // Safari is driven through Apple Events, which changes what its evidence
  // can say; the HTML report states the same limits.
  const safari = browser === "safari"
    ? " In Safari, setup actions (click, fill, wait) ran as untrusted page scripts, Tab and Shift+Tab " +
      "were sent as Option+Tab and Option+Shift+Tab, and the structural evidence is a DOM outline, " +
      "not Safari's accessibility tree."
    : "";
  return (
    `Experimental web checks captured ${Object.keys(web.screens).length} named state(s) in ` +
    `${browser} ${browserVersion}. Speech source: ${speech}.${safari} Scripted scenario completion does not ` +
    "establish full traversal or conformance. All web results are report-only; review raw axe results, " +
    "incomplete checks, and interaction evidence in the HTML report."
  );
}

// ── findings ──

// For one criterion, list the screens whose baseline error rule ids
// intersect the criterion's rules, per platform. Each failure also lists
// the accepted reasons the screen gives for those rule ids, when it gives
// any (the field is absent otherwise, as it always was).
export function findFailures(criterionRules, audits) {
  const failures = [];
  for (const { platform, screens } of audits) {
    for (const [id, s] of Object.entries(screens)) {
      const hit = (s.ruleIds ?? []).filter((r) => criterionRules.includes(r));
      if (!hit.length) continue;
      const accepted = (s.accepted ?? []).filter((entry) => hit.includes(entry.ruleId));
      failures.push({ platform, screen: id, ruleIds: hit, ...(accepted.length ? { accepted } : {}) });
    }
  }
  return failures;
}

// The findings issues for a criterion's accepted failures. Screens that
// accept the same rule for the same reason share one issue, so a reason
// repeated across many screens is stated once. A tracker URL becomes the
// issue's link; a bare tracker id is named in the summary.
function acceptedIssues(failures) {
  const groups = new Map();
  for (const { platform, screen, accepted = [] } of failures) {
    for (const entry of accepted) {
      const key = JSON.stringify([entry.ruleId, entry.kind, entry.summary, entry.issue ?? null]);
      if (!groups.has(key)) groups.set(key, { entry, screens: [] });
      groups.get(key).screens.push(`${platform} ${screen}`);
    }
  }
  return [...groups.values()].map(({ entry, screens }) => {
    const tracked = entry.issue !== undefined && !isIssueUrl(entry.issue) ? ` (tracked as ${entry.issue})` : "";
    return {
      id: `${entry.ruleId} on ${screens.join(", ")}`,
      kind: entry.kind,
      summary: `Accepted in the baseline: ${entry.summary.replace(/\.$/, "")}${tracked}`,
      ...(entry.issue !== undefined && isIssueUrl(entry.issue) ? { url: entry.issue } : {}),
    };
  });
}

// The finding for a criterion aloud's error rules map to.
function automatedFinding(num, audits) {
  const auto = AUTOMATED_CRITERIA[num];
  const platforms = new Set(auto.rules.map((r) => RULES[r].platform));
  const applicable = audits.filter(({ platform }) => platforms.has(platform));
  const unsupported = audits.filter(({ platform }) => !platforms.has(platform));
  const unchecked = (s) => (s.uncheckedCriteria ?? []).includes(num);
  const completed = selectScreens(applicable, (s) => s.errors !== null && !unchecked(s));
  const stale = selectScreens(applicable, (s) => s.errors !== null && unchecked(s));
  const missing = selectScreens(applicable, (s) => s.errors === null || unchecked(s));
  const noTree = selectScreens(applicable, (s) => s.errors === null);
  const failures = findFailures(auto.rules, completed);
  const checked = screenCoverage(completed);

  let status;
  let result;
  if (applicable.length === 0) {
    status = "untested";
    result = "No completed tree checks for this criterion";
  } else if (completed.length === 0) {
    status = "incomplete";
    result = "No completed tree checks for this criterion";
  } else if (failures.length > 0) {
    // A known failure stands even when other screens are incomplete. An
    // accepted failure of any kind is still a failure; its reason is in
    // the finding's issues.
    status = "failing";
    result = `The automated tree checks found violations on ${failures.length} of ${checked}`;
  } else {
    // A platform with no rules for this criterion is part of the same
    // software component, so a clean result elsewhere cannot support it.
    // Even a clean result on every platform checks only part of the
    // criterion (auto.covers), so it is partly tested, never met.
    status = missing.length || unsupported.length ? "incomplete" : "partly-tested";
    result = `The automated tree checks found no violations on ${checked}`;
  }

  const notes = [result];
  notes.push(`Automated checks cover part of this criterion only: ${auto.covers}`);
  if (auto.extra) notes.push(auto.extra);
  if (noTree.length) {
    notes.push(`Missing tree checks on ${screenCoverage(noTree)}; those screens remain unevaluated.`);
  }
  if (stale.length) {
    const stalePlatforms = new Set(stale.map(({ platform }) => platform));
    const retired = Object.keys(RECLASSIFIED).filter((id) =>
      RECLASSIFIED[id].was.criteria.includes(num) && stalePlatforms.has(RULE_CATALOG[id].platform));
    notes.push(
      `Evidence on ${screenCoverage(stale)} predates the current rules for this criterion ` +
        `(it lists ${retired.join(" or ")} as errors: ${retired.map((id) => RECLASSIFIED[id].change).join("; ")}); ` +
        "re-run the audit, as those screens remain unevaluated.",
    );
  }
  if (unsupported.length) {
    notes.push(
      `No applicable automated checks for ${unsupported.map(({ platform }) => platform).join(" or ")}; ` +
        "this criterion remains unevaluated on that platform.",
    );
  }
  notes.push(`A human review must complete the rest. See ${HOW_IT_WORKS}`);
  // Last, so a capped note cuts this list and nothing above it.
  if (failures.length) {
    const detail = failures.map((f) => `${f.platform} ${f.screen}: ${f.ruleIds.join(", ")}`).join("; ");
    notes.push(`Screens with violations: ${detail}`);
  }
  const issues = acceptedIssues(failures);

  return {
    criterion: num,
    component: "software",
    status,
    ...(status === "failing" ? { failingShare: "some" } : {}),
    ...(issues.length ? { issues } : {}),
    notes,
  };
}

// Read, validate, and migrate the native audits, in platform order.
function readAudits({ android, ios }) {
  const audits = [];
  for (const [platform, audit] of [["Android", android], ["iOS", ios]]) {
    if (audit == null) continue;
    // Validate the screens as written, then read them in the current
    // classification.
    validateScreens(audit.screens, platform);
    validateRuleIds(audit.screens, platform);
    audits.push({ platform, screens: migrateScreens(audit.screens) });
  }
  return audits;
}

// What the native audits cover as a whole: tree check counts and the
// report-only Apple and ATF evidence. android and ios are the audits as
// passed in; audits are the validated, migrated ones.
function nativeCoverageNotes(audits, android, ios) {
  const notes = [];
  const completed = selectScreens(audits, (s) => s.errors !== null);
  const missing = selectScreens(audits, (s) => s.errors === null);
  const counts = completed.map(({ platform, screens }) => `${Object.keys(screens).length} on ${platform}`);
  notes.push(completed.length
    ? `Tree checks for labels and touch-target size completed (${counts.join(", ")}).`
    : "No completed tree checks are present in the input.");
  if (missing.length) notes.push(`Missing tree checks on ${screenCoverage(missing)}.`);
  const appleScreens = Object.values(ios?.screens ?? {}).filter((s) => s.appleAudit);
  if (appleScreens.length) {
    const issues = appleScreens.reduce((sum, s) => sum + s.appleAudit.issues, 0);
    notes.push(
      `Apple accessibility audits completed on ${appleScreens.length} iOS screen(s), with ${issues} ` +
        "finding(s) requiring review. These native results are report-only and do not assign " +
        "conformance levels. Review the separate Apple evidence in the HTML report.",
    );
  }
  const atfScreens = Object.values(android?.screens ?? {}).filter((s) => s.androidAtf);
  if (atfScreens.length) {
    notes.push(
      `ATF 4.1.1 (aloud-node-v1) executed on ${atfScreens.length} Android screen(s), using ` +
        "AccessibilityNodeInfo snapshots. Native results remain report-only and add no conformance " +
        "coverage. The HTML report preserves skipped results and unselected checks; neither counts as a pass.",
    );
  }
  return notes;
}

// Report-level notes, stated in the report notes after the builder's own.
function reportNotes({ audits, android, ios, web, sources, allowMixed, provenance }) {
  const notes = [`The findings come from aloud's automated 508 audit (${HOW_IT_WORKS}).`];
  if (audits.length) notes.push(...nativeCoverageNotes(audits, android, ios));
  if (web) notes.push(webNote(web));
  if (audits.length) notes.push(transcriptCoverage(audits), transcriptMethods(audits));
  notes.push(...provenanceNotes(sources, allowMixed, provenance));
  return notes;
}

// How the evidence was produced. The builder follows it with its level
// policy sentence. It restates the coverage so the section reads on its own.
function evaluationMethods({ audits, android, ios, web }) {
  const parts = [];
  if (audits.length) {
    const atf = Object.values(android?.screens ?? {}).some((s) => s.androidAtf);
    parts.push(
      "Automated accessibility-tree checks use device or simulator dumps " +
        (atf
          ? "(AccessibilityNodeInfo in Android ATF mode, uiautomator in standard Android mode, idb on iOS)."
          : "(uiautomator on Android, idb on iOS)."),
      ...nativeCoverageNotes(audits, android, ios),
      transcriptCoverage(audits),
      transcriptMethods(audits),
      "Rules: src/android/ui-tree.mjs and src/ios/tree.mjs; WCAG mapping: src/rules/catalog.mjs.",
    );
  }
  if (web) parts.push(webNote(web));
  return parts.join(" ");
}

// Convert aloud's audit inputs into a findings document for the builder.
//
//   android, ios      normalized audits ({ screens, generated? }); either may be null
//   web               the report-only web summary, or null
//   appName           product name (config app.name); required
//   productVersion    product version
//   appDescription    product description (defaults from the inputs)
//   authorName, authorEmail
//   catalog           the catalog object the draft will be built against
//                     (default: the bundled CATALOG_ID catalog); used to
//                     list the criteria that have a web component
//   allowMixed        combine inputs whose provenance names different code
//                     (default: refuse)
//
// Throws on missing or malformed evidence, and on inputs from different
// code unless allowMixed.
export function aloudFindings({
  android,
  ios,
  web,
  appName,
  productVersion,
  appDescription,
  authorName,
  authorEmail,
  catalog,
  allowMixed = false,
}) {
  if (!appName) {
    throw new Error("buildAcr needs an app name (config app.name)");
  }
  const audits = readAudits({ android, ios });
  if (audits.length === 0 && !web) throw new Error("no audit input: provide at least one platform audit");
  if (web) validateWebSummary(web);
  const sources = provenanceSources({ android, ios, web });
  checkSameCode(sources, allowMixed);
  const provenance = findingsProvenance(sources);

  const index = indexCatalog(catalog ?? loadCatalog({ id: CATALOG_ID }));
  const findings = [];
  if (audits.length) {
    for (const num of Object.keys(AUTOMATED_CRITERIA)) findings.push(automatedFinding(num, audits));
    for (const [num, note] of Object.entries(RELATED_EVIDENCE)) {
      findings.push({ criterion: num, component: "software", status: "untested", notes: [note] });
    }
    findings.push({
      criterion: "302.1",
      status: "untested",
      notes: [
        `Related evidence: ${transcriptCoverage(audits)}`,
        transcriptMethods(audits),
        `See ${HOW_IT_WORKS}`,
      ],
    });
  }
  if (web) {
    const note = webNote(web);
    for (const entry of index.criteria.values()) {
      if (hasNoComponents(entry) || !entry.components.includes("web")) continue;
      findings.push({ criterion: entry.id, component: "web", status: "untested", notes: [note] });
    }
  }

  const product = {
    name: appName,
    description: appDescription || (web ? `${appName} application.` : `${appName} mobile app for iOS and Android.`),
  };
  if (productVersion !== undefined && productVersion !== null) product.version = String(productVersion);
  // The config's default email is the builder's placeholder; leave it out
  // so the draft says it must be replaced.
  const author = { name: authorName || DEFAULT_AUTHOR_NAME };
  if (authorEmail && authorEmail !== DRAFT_AUTHOR.email) author.email = authorEmail;

  return {
    schemaVersion: 1,
    product,
    author,
    ...(provenance ? { provenance } : {}),
    catalog: CATALOG_ID,
    components: [...(audits.length ? ["software"] : []), ...(web ? ["web"] : [])],
    findings,
    notes: reportNotes({ audits, android, ios, web, sources, allowMixed, provenance }),
    evaluationMethods: evaluationMethods({ audits, android, ios, web }),
  };
}

// aloud's drafts always state CATALOG_ID, so a replacement catalog must
// have its chapters and criteria, in the same order; only labels and
// components may differ. Say so in the terms of the caller, who wrote no
// findings file and has no catalog field to change. Throws on a mismatch.
function checkReplacementCatalog(catalog) {
  checkCatalog(catalog, "replacement catalog");
  try {
    checkCatalogId(catalog, CATALOG_ID);
  } catch {
    throw new Error(
      `the replacement catalog must have the same chapters and criteria, in the same order, as the ` +
        `bundled ${CATALOG_ID} catalog, because aloud's drafts state that catalog id; ` +
        "only its labels and components may differ",
    );
  }
}

// Build the draft OpenACR for aloud's audit inputs: aloudFindings, then the
// shared builder. Takes aloudFindings's inputs plus the report date. A
// catalog, when given, replaces the bundled one (checkReplacementCatalog).
export function buildAloudAcr({ date, catalog, ...inputs }) {
  // The evidence is checked first, so a bad audit is reported as such
  // whatever catalog comes with it.
  const findings = aloudFindings({ ...inputs, catalog });
  if (catalog) checkReplacementCatalog(catalog);
  return buildAcr(findings, {
    date,
    ...(catalog ? { catalog } : {}),
    maxNoteLength: aloudMaxNoteLength(findings),
  });
}
