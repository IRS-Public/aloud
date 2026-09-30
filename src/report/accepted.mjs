// Accepted findings: the reason a baselined error is allowed to stand.
//
// A baseline entry says how many errors a screen may have and under which
// rule ids. It does not say why. An entry may also carry
//
//   accepted: [{ ruleId, kind, summary, issue? }]
//
// one per rule id the team has looked at and accepted for now:
//   ruleId   one of the entry's ruleIds, and a rule the catalog knows
//   kind     "product-bug"    a defect in the app, not fixed yet
//            "platform-gap"   the platform (OS, screen reader, system
//                             control) causes it, not the app
//            "accepted-risk"  a known defect the team chose to ship
//   summary  one plain sentence, at most 140 characters
//   issue    optional tracker reference: an http(s) URL or an id such
//            as "APP-123"
//
// Accepting a finding changes nothing in the ratchet: the error still
// counts, and still fails the criterion in the OpenACR draft. The reason is
// carried into summary.json, the evidence page, and the draft's notes so a
// reader can see why the failure stands. Baselines without `accepted` stay
// valid; `aloud baseline` warns about ids that have no reason.
//
// Pure functions only; malformed input throws.

import { RULES } from "../rules/catalog.mjs";

export const ACCEPTED_KINDS = Object.freeze(["product-bug", "platform-gap", "accepted-risk"]);
export const MAX_ACCEPTED_SUMMARY_LENGTH = 140;
const MAX_ISSUE_LENGTH = 300;

// Plain labels for the report page and the CLI.
export const ACCEPTED_KIND_LABELS = Object.freeze({
  "product-bug": "Product bug",
  "platform-gap": "Platform gap",
  "accepted-risk": "Accepted risk",
});

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const FIELDS = new Set(["ruleId", "kind", "summary", "issue"]);

export const isIssueUrl = (issue) => /^https?:\/\/\S+$/.test(issue);

// One sentence: no line breaks, and no second sentence (a stop followed by
// a space and a capital letter). "e.g. the Home tab" still reads as one.
function checkSummary(summary, field) {
  if (typeof summary !== "string" || summary.trim() === "") {
    throw new Error(`${field}.summary must be a non-empty sentence`);
  }
  if (summary !== summary.trim()) {
    throw new Error(`${field}.summary must not start or end with spaces`);
  }
  if (summary.length > MAX_ACCEPTED_SUMMARY_LENGTH) {
    throw new Error(
      `${field}.summary is ${summary.length} characters; keep it to one sentence of at most ` +
        `${MAX_ACCEPTED_SUMMARY_LENGTH}`,
    );
  }
  if (/[\r\n]/.test(summary) || /[.!?]\s+[A-Z]/.test(summary)) {
    throw new Error(`${field}.summary must be a single sentence`);
  }
}

// A tracker reference is a URL or a bare id; either way it holds no
// spaces, so it cannot smuggle a second summary into the report.
function checkIssue(issue, field) {
  if (typeof issue !== "string" || issue.length === 0 || /\s/.test(issue) || issue.length > MAX_ISSUE_LENGTH) {
    throw new Error(
      `${field}.issue must be an http(s) URL or a tracker id with no spaces (at most ${MAX_ISSUE_LENGTH} characters)`,
    );
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(issue) && !isIssueUrl(issue)) {
    throw new Error(`${field}.issue links must be http(s) URLs`);
  }
}

// Validate one accepted entry against the rule ids of its screen.
export function validateAcceptedEntry(entry, ruleIds, field) {
  if (!isRecord(entry)) throw new Error(`${field} must be an object`);
  const unknown = Object.keys(entry).filter((key) => !FIELDS.has(key));
  if (unknown.length) throw new Error(`${field} has unknown field(s) ${unknown.join(", ")}`);
  if (typeof entry.ruleId !== "string" || entry.ruleId.trim() === "") {
    throw new Error(`${field}.ruleId must be a non-empty string`);
  }
  if (!Object.hasOwn(RULES, entry.ruleId)) {
    throw new Error(`${field}.ruleId "${entry.ruleId}" is not a rule in src/rules/catalog.mjs`);
  }
  if (!ruleIds.includes(entry.ruleId)) {
    throw new Error(`${field}.ruleId "${entry.ruleId}" is not one of this screen's baselined rule ids`);
  }
  if (!ACCEPTED_KINDS.includes(entry.kind)) {
    throw new Error(`${field}.kind must be one of ${ACCEPTED_KINDS.join(", ")}; got ${JSON.stringify(entry.kind)}`);
  }
  checkSummary(entry.summary, field);
  if (entry.issue !== undefined) checkIssue(entry.issue, field);
  return entry;
}

// Validate a screen's accepted list: an array of valid entries, at most one
// per rule id. field names the list, such as `baseline screen "home".accepted`.
export function validateAccepted(accepted, ruleIds, field) {
  if (!Array.isArray(accepted)) throw new Error(`${field} must be an array`);
  const seen = new Set();
  accepted.forEach((entry, index) => {
    validateAcceptedEntry(entry, ruleIds, `${field}[${index}]`);
    if (seen.has(entry.ruleId)) throw new Error(`${field} lists rule id "${entry.ruleId}" more than once`);
    seen.add(entry.ruleId);
  });
  return accepted;
}

// Split a screen's accepted list by whether each rule id still fires.
// Entries for ids no longer in ruleIds are stale: the finding is gone (or
// its rule was reclassified), so the reason no longer applies.
export function keepAccepted(accepted = [], ruleIds) {
  return {
    kept: accepted.filter((entry) => ruleIds.includes(entry.ruleId)),
    dropped: accepted.filter((entry) => !ruleIds.includes(entry.ruleId)),
  };
}

// Add or replace the entry for one rule id; the list stays sorted by rule
// id so re-baselining produces stable diffs.
export function withAccepted(accepted = [], entry) {
  return [...accepted.filter((e) => e.ruleId !== entry.ruleId), entry]
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

// Per screen, the baselined rule ids that carry no accepted reason.
// baseline is a validated map of screen id -> entry.
export function unexplainedRuleIds(baseline) {
  return Object.entries(baseline)
    .map(([screen, entry]) => ({
      screen,
      ruleIds: entry.ruleIds.filter((id) => !(entry.accepted ?? []).some((e) => e.ruleId === id)),
    }))
    .filter(({ ruleIds }) => ruleIds.length > 0);
}

// Read the --accept/--kind/--summary/--issue flags into
// { screen, entry }, or null when none were given. Flags that only make
// sense together must come together; a lone --kind is a mistake, never
// quietly ignored. Values are trimmed; the entry itself is validated when
// it is merged, against the screen it names.
export function parseAcceptFlags({ accept, kind, summary, issue } = {}) {
  const given = (value) => value !== undefined && value !== "";
  if (!given(accept)) {
    const stray = [["kind", kind], ["summary", summary], ["issue", issue]]
      .filter(([, value]) => given(value))
      .map(([name]) => `--${name}`);
    if (stray.length) throw new Error(`${stray.join(", ")} only apply with --accept <screen>:<ruleId>`);
    return null;
  }
  const match = /^([^:\s]+):([^:\s]+)$/.exec(accept.trim());
  if (!match) throw new Error(`--accept must be <screen>:<ruleId>; got ${JSON.stringify(accept)}`);
  const missing = [["kind", kind], ["summary", summary]].filter(([, value]) => !given(value)).map(([name]) => `--${name}`);
  if (missing.length) throw new Error(`--accept needs ${missing.join(" and ")}`);
  const entry = { ruleId: match[2], kind: kind.trim(), summary: summary.trim() };
  if (given(issue)) entry.issue = issue.trim();
  return { screen: match[1], entry };
}
