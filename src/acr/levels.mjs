// The finding status vocabulary and the policy that turns a status into an
// OpenACR adherence level. A finding's status says what the evidence shows
// ("met", "failing", "untested", ...); the policy decides what a draft ACR
// may claim from it. The default policy is conservative: only passing
// evidence can reach "supports", and anything unproven is "not-evaluated"
// so a person reviews it. Callers may override the policy per status, but
// never so that a failure, or evidence that proves nothing, reads as a pass
// or as "does not apply".
//
// Pure data and functions: no file access, no side effects on import.

// The OpenACR terms every catalog shipped with @openacr/openacr defines.
export const ADHERENCE_LEVELS = Object.freeze([
  "supports",
  "partially-supports",
  "does-not-support",
  "not-applicable",
  "not-evaluated",
]);

// How much of the functionality a failing finding affects. OpenACR says
// "partially supports" when some functionality fails and "does not support"
// when the majority does, so a failure is partial unless the caller says
// it affects all of it.
export const FAILING_SHARES = Object.freeze(["some", "all"]);

// Every status a finding may carry, grouped by what it proves:
//   passing      the evidence shows the criterion is met, or the standard's
//                own interpretation says it always is for this content
//   failing      the evidence shows a defect (failingShare applies)
//   unproven     the criterion applies, but the evidence proves nothing yet
//   out-of-scope the criterion does not apply to this component
// The group decides which levels an override may choose (see resolvePolicy).
export const STATUS_KINDS = Object.freeze({
  met: "passing",
  "human-reviewed": "passing",
  "standard-interpretation": "passing",
  failing: "failing",
  "known-defect": "failing",
  "partly-tested": "unproven",
  "platform-limitation": "unproven",
  incomplete: "unproven",
  untested: "unproven",
  unreviewed: "unproven",
  "not-triggered": "out-of-scope",
  "page-level": "out-of-scope",
});

export const STATUSES = Object.freeze(Object.keys(STATUS_KINDS));

export const isFailingStatus = (status) => kindOf(status) === "failing";

// Levels each kind of status may map to. Only passing evidence may support
// a criterion. A failure may never read as a pass or as "does not apply",
// since either would hide the defect. Unproven evidence may never read as
// a pass or as "does not apply" either: nobody showed the criterion is
// met or irrelevant, so it stays with a person (or is reported as a
// failure by a stricter caller). A status that says the criterion is
// outside the component may only say so, or leave it for review.
const ALLOWED_LEVELS = Object.freeze({
  passing: ADHERENCE_LEVELS,
  failing: Object.freeze(["partially-supports", "does-not-support", "not-evaluated"]),
  unproven: Object.freeze(["partially-supports", "does-not-support", "not-evaluated"]),
  "out-of-scope": Object.freeze(["not-applicable", "not-evaluated"]),
});

// The default status -> level mapping. A failing status maps each failing
// share to a level; every other status maps to a single level. Each note
// states, in plain words, what the status means for the reader of the ACR.
export const DEFAULT_POLICY = deepFreeze({
  met: {
    level: "supports",
    note: "Every automated test for this criterion passed.",
  },
  "human-reviewed": {
    level: "supports",
    note:
      "A person reviewed this and judged the criterion met; the automated tests only check that " +
      "the reviewed content stays as approved. The judgment is that person's, which a test cannot repeat.",
  },
  "standard-interpretation": {
    level: "supports",
    note:
      "The standard's own published interpretation says this criterion is always satisfied for " +
      "this kind of content, so no test applies; the notes cite it.",
  },
  failing: {
    level: { some: "partially-supports", all: "does-not-support" },
    note: "An automated test for this criterion failed.",
  },
  "known-defect": {
    level: { some: "partially-supports", all: "does-not-support" },
    note: "A known defect keeps this criterion from being met.",
  },
  "partly-tested": {
    level: "not-evaluated",
    note:
      "The automated tests passed but cover only part of this criterion. A human review " +
      "must complete the rest.",
  },
  "platform-limitation": {
    level: "not-evaluated",
    note:
      "A browser or screen reader limitation kept this criterion from being verified " +
      "everywhere. Needs human review where it could not be verified.",
  },
  incomplete: {
    level: "not-evaluated",
    note: "Some tests for this criterion did not run, so the evidence is incomplete. Needs human review.",
  },
  // Also the status of rows where related checks ran but cannot establish
  // the criterion (aloud's warning-only and report-only web rows), so the
  // note says nothing established it, not that nothing ran.
  untested: {
    level: "not-evaluated",
    note: "No automated test establishes whether this criterion is met yet. Needs human review.",
  },
  unreviewed: {
    level: "not-evaluated",
    note: "Nobody has reviewed yet whether this criterion applies. Needs human review.",
  },
  "not-triggered": {
    level: "not-applicable",
    note: "Triaged as not applicable: the component has no feature this criterion is about.",
  },
  "page-level": {
    level: "not-applicable",
    note:
      "Page-level: this criterion is about a whole page or site, so the site team is " +
      "responsible for it on their own pages.",
  },
});

function kindOf(status) {
  if (typeof status !== "string" || !Object.hasOwn(STATUS_KINDS, status)) {
    throw new Error(`unknown finding status ${JSON.stringify(status)}: expected one of ${STATUSES.join(", ")}`);
  }
  return STATUS_KINDS[status];
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Check one level against what a status may claim.
function checkLevel(status, level, where) {
  if (!ADHERENCE_LEVELS.includes(level)) {
    throw new Error(
      `invalid policy for "${status}"${where}: ${JSON.stringify(level)} is not an OpenACR level ` +
        `(${ADHERENCE_LEVELS.join(", ")})`,
    );
  }
  const kind = kindOf(status);
  if (!ALLOWED_LEVELS[kind].includes(level)) {
    throw new Error(
      `invalid policy for "${status}"${where}: a ${kind} status may not map to "${level}" ` +
        `(allowed: ${ALLOWED_LEVELS[kind].join(", ")})`,
    );
  }
}

// Normalize one override to { level, note }. An override is either a level
// string or { level?, note? }. For a failing status the level may be one
// string (used for both shares) or { some?, all? }.
function mergeEntry(status, base, override) {
  const entry = typeof override === "string" ? { level: override } : override;
  if (!isRecord(entry)) {
    throw new Error(`invalid policy for "${status}": expected a level or { level, note }`);
  }
  for (const key of Object.keys(entry)) {
    if (key !== "level" && key !== "note") {
      throw new Error(`invalid policy for "${status}": unknown key "${key}" (expected level, note)`);
    }
  }
  if (entry.note !== undefined && (typeof entry.note !== "string" || !entry.note.trim())) {
    throw new Error(`invalid policy for "${status}": note must be a non-empty string`);
  }
  let level = base.level;
  if (entry.level !== undefined) {
    if (isFailingStatus(status)) {
      level = typeof entry.level === "string"
        ? { some: entry.level, all: entry.level }
        : mergeShares(status, base.level, entry.level);
    } else {
      level = entry.level;
    }
  }
  return { level, note: entry.note ?? base.note };
}

function mergeShares(status, base, shares) {
  if (!isRecord(shares)) {
    throw new Error(`invalid policy for "${status}": level must be a level or { some, all }`);
  }
  for (const key of Object.keys(shares)) {
    if (!FAILING_SHARES.includes(key)) {
      throw new Error(`invalid policy for "${status}": unknown failing share "${key}" (expected some, all)`);
    }
  }
  return { ...base, ...shares };
}

// Merge caller overrides into the default policy and check every entry.
// Returns a frozen policy covering every status. Throws on an unknown
// status, a level OpenACR does not define, or a level the status may not
// claim (a failing status may never map to "supports").
export function resolvePolicy(overrides = {}) {
  if (!isRecord(overrides)) throw new Error("invalid policy: expected an object keyed by status");
  for (const status of Object.keys(overrides)) kindOf(status);
  const policy = {};
  for (const status of STATUSES) {
    const entry = Object.hasOwn(overrides, status)
      ? mergeEntry(status, DEFAULT_POLICY[status], overrides[status])
      : DEFAULT_POLICY[status];
    if (isFailingStatus(status)) {
      for (const share of FAILING_SHARES) checkLevel(status, entry.level[share], ` (failingShare "${share}")`);
    } else {
      checkLevel(status, entry.level, "");
    }
    policy[status] = entry;
  }
  return deepFreeze(policy);
}

// The adherence level and policy note for one status. failingShare
// applies to failing statuses only and defaults to "some". Pass a policy
// from resolvePolicy; the default policy is used otherwise.
export function adherenceFor(status, { policy = DEFAULT_POLICY, failingShare } = {}) {
  const failing = kindOf(status) === "failing";
  if (failingShare !== undefined) {
    if (!failing) {
      throw new Error(`failingShare applies only to failing statuses (failing, known-defect), not "${status}"`);
    }
    if (!FAILING_SHARES.includes(failingShare)) {
      throw new Error(`invalid failingShare ${JSON.stringify(failingShare)}: expected some or all`);
    }
  }
  const entry = policy[status];
  if (!entry) throw new Error(`policy has no entry for status "${status}"`);
  const level = failing ? entry.level[failingShare ?? "some"] : entry.level;
  // Re-check, so a hand-built policy object cannot skip resolvePolicy's rules.
  checkLevel(status, level, "");
  return { level, note: entry.note };
}
