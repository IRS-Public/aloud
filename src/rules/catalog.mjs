// The one source of truth for aloud's tree rules and the WCAG criteria
// they give evidence toward. The Android (src/android/ui-tree.mjs) and iOS
// (src/ios/tree.mjs) rule engines take each finding's severity and criteria
// from here, and the OpenACR draft (src/report/openacr.mjs) derives its
// criterion mapping from here, so the three can no longer disagree.
//
// Rule ids are stable strings: they live in adopters' committed baselines.
// Renaming one needs an alias for old baselines, not an edit here alone.
//
// Scope: these are the rules whose findings feed the tree gate (errors) or
// the report (warns). The pinned Android ATF checks (src/android/atf-evidence.mjs)
// and Apple's accessibility audit are separate report-only evidence with
// their own identifiers; they never gate and are not listed here.

// Every rule the tree engines can emit.
//   platform  "Android" or "iOS" — the engine that emits it
//   severity  "error" counts toward the gate; "warn" is report-only
//   criteria  WCAG 2.2 success criteria the rule gives evidence toward,
//             primary first. A finding's `wcag` field is the primary one.
//             Only a warn may list none: a platform-guideline check
//             (Material, Apple HIG) that no WCAG criterion requires.
//   what      plain description of what the rule flags
export const RULES = deepFreeze({
  // ── Android (uiautomator or ATF-companion node trees) ──
  "native-interactive-unlabeled": {
    platform: "Android",
    severity: "error",
    criteria: ["4.1.2"],
    what: "interactive element with no speakable text",
  },
  // An image control is both a UI component with no name (4.1.2) and
  // non-text content acting as a control with no text alternative (1.1.1).
  "native-image-button-unlabeled": {
    platform: "Android",
    severity: "error",
    criteria: ["4.1.2", "1.1.1"],
    what: "image control without a content description",
  },
  // A field with no name fails 4.1.2; a visible label that is not exposed
  // to the screen reader is also an information-and-relationships gap (1.3.1).
  "native-edittext-unlabeled": {
    platform: "Android",
    severity: "error",
    criteria: ["4.1.2", "1.3.1"],
    what: "text field with no label, hint, or content description",
  },
  // WCAG 2.5.8 Target Size (Minimum) asks for 24x24 CSS px. One dp
  // approximates one CSS px (both are defined against a ~160dpi reference),
  // so the rule holds 24x24dp, with the criterion's spacing exception.
  "native-target-size-minimum": {
    platform: "Android",
    severity: "error",
    criteria: ["2.5.8"],
    what: "touch target under 24x24dp that the 2.5.8 spacing exception does not cover",
  },
  // Platform guidance, not a WCAG requirement: Material Design asks for
  // 48x48dp, twice what 2.5.8 needs. Report-only, and mapped to no
  // criterion. The id predates the 24dp rule; it was an error counted
  // against 2.5.8, and old baselines still list it (see RECLASSIFIED).
  "native-touch-target-small": {
    platform: "Android",
    severity: "warn",
    criteria: [],
    what: "touch target under the 48x48dp Material Design guideline",
  },
  // Warn-only: lists legitimately repeat labels. Identical names leave the
  // user unable to tell controls apart, so the evidence also bears on
  // whether labels describe purpose (2.4.6).
  "native-duplicate-speakable": {
    platform: "Android",
    severity: "warn",
    criteria: ["4.1.2", "2.4.6"],
    what: "interactive elements that announce identical labels",
  },

  // ── iOS (idb accessibility dumps) ──
  "ios-interactive-unlabeled": {
    platform: "iOS",
    severity: "error",
    criteria: ["4.1.2"],
    what: "interactive element with no label or value",
  },
  // The rule judges elements with the Image role: a missing text
  // alternative for non-text content is 1.1.1. An image button dumps as
  // Button only when the developer set the button trait; a tappable image
  // with a gesture recognizer and no trait still dumps as Image, and that
  // is a 4.1.2 name-and-role failure. The dump cannot tell the two apart,
  // so the rule also counts against 4.1.2 rather than risk a silent pass.
  "ios-image-unlabeled": {
    platform: "iOS",
    severity: "error",
    criteria: ["1.1.1", "4.1.2"],
    what: "image element without an accessibility label",
  },
  // WCAG 2.5.8 at 24x24pt. One iOS point approximates one CSS px (both
  // are defined against a ~160dpi reference), same policy as Android.
  "ios-target-size-minimum": {
    platform: "iOS",
    severity: "error",
    criteria: ["2.5.8"],
    what: "touch target under 24x24pt that the 2.5.8 spacing exception does not cover",
  },
  // Platform guidance, not a WCAG requirement: the Apple Human Interface
  // Guidelines ask for 44x44pt. Report-only, mapped to no criterion; the
  // id predates the 24pt rule (see RECLASSIFIED).
  "ios-touch-target-small": {
    platform: "iOS",
    severity: "warn",
    criteria: [],
    what: "touch target under the 44x44pt Apple Human Interface Guidelines size",
  },
  "ios-toggle-raw-value": {
    platform: "iOS",
    severity: "warn",
    criteria: ["4.1.2"],
    what: 'control announcing a raw "1"/"0" where a switch state should speak on/off',
  },
  "ios-list-row-not-interactive": {
    platform: "iOS",
    severity: "warn",
    criteria: ["4.1.2"],
    what: "list row with no interactive trait among interactive siblings",
  },
  "ios-duplicate-speakable": {
    platform: "iOS",
    severity: "warn",
    criteria: ["4.1.2", "2.4.6"],
    what: "interactive elements that announce identical labels",
  },
});

// What the automation checks for each criterion the rules reach — exactly
// that, never more. The OpenACR draft quotes these in its adherence notes.
//   covers    what the rules check. For a criterion only warnings reach,
//             this describes the report-only evidence instead.
//   warnings  optional sentence naming report-only warnings that add
//             related evidence to a criterion error rules also reach.
export const CRITERIA = deepFreeze({
  "1.1.1": {
    covers: "image controls (Android) and image-role elements (iOS) must carry a text label",
  },
  "1.3.1": {
    covers: "text fields must expose a label a screen reader can announce (Android check only)",
  },
  "2.4.6": {
    covers: "interactive elements that announce identical labels",
  },
  "2.5.8": {
    covers:
      "enabled touch targets must be at least 24x24 (dp on Android, pt on iOS; each approximates " +
      "one CSS px), unless the spacing exception applies: a 24-unit circle centred on the " +
      "undersized target intersects no other target and no other undersized target's circle. " +
      "The inline, user-agent control, essential, and equivalent-control exceptions need human " +
      "judgment, so a flagged target may still meet the criterion on review. Automation does not " +
      "judge some targets at all, so review them by hand: disabled targets, targets with no on-screen " +
      "area, targets nested inside a labeled clickable ancestor of at least 24dp or clipped at a " +
      "scroll edge (Android), and switch-family controls (iOS)",
  },
  "4.1.2": {
    covers:
      "interactive elements, image controls (Android), image-role elements (iOS), and text fields " +
      "must expose an accessible name",
    warnings:
      "Report-only warnings add related evidence: elements that announce identical labels " +
      "(native-duplicate-speakable, ios-duplicate-speakable), " +
      'iOS controls announcing a raw "1"/"0" where a switch state should speak on/off (ios-toggle-raw-value), ' +
      "and iOS list rows with no interactive trait among interactive siblings (ios-list-row-not-interactive); " +
      "warnings do not gate.",
  },
});

// Rule ids whose classification changed after adopters had committed them
// to baselines. Each entry records what the id used to count toward and
// the rule that now carries that criterion. Readers of persisted evidence
// (src/report/validation.mjs, src/report/openacr.mjs) use this to read old
// baselines, tree reports, and summaries without error and without
// treating them as evidence they never were.
//   was        the severity and criteria the id had before
//   successor  the error rule that now gives evidence toward those criteria
//   change     plain description, quoted in notes and error messages
//
// The touch-target ids held the platform bars (48dp, 44pt) as 2.5.8
// errors. 2.5.8 asks for 24 CSS px, so a screen that met the criterion
// was reported as failing it. A finding under the old rule says nothing
// about the 24-unit bar, and a screen with none under it met 2.5.8.
export const RECLASSIFIED = deepFreeze({
  "native-touch-target-small": {
    was: { severity: "error", criteria: ["2.5.8"] },
    successor: "native-target-size-minimum",
    change: "the 48x48dp check became a report-only guideline; 2.5.8 is now checked at 24x24dp",
  },
  "ios-touch-target-small": {
    was: { severity: "error", criteria: ["2.5.8"] },
    successor: "ios-target-size-minimum",
    change: "the 44x44pt check became a report-only guideline; 2.5.8 is now checked at 24x24pt",
  },
});

export const PLATFORMS = Object.freeze(["Android", "iOS"]);
export const SEVERITIES = Object.freeze(["error", "warn"]);

// Look up a rule an engine is about to emit. An id the catalog does not
// know, or one filed by the wrong engine, throws: a finding with no
// catalog entry would reach no criterion and could hide a failure.
export function ruleSpec(ruleId, platform) {
  if (!Object.hasOwn(RULES, ruleId)) {
    throw new Error(`unknown rule id "${ruleId}": add it to src/rules/catalog.mjs`);
  }
  const rule = RULES[ruleId];
  if (platform !== undefined && rule.platform !== platform) {
    throw new Error(`rule id "${ruleId}" runs on ${rule.platform}, not ${platform}`);
  }
  return rule;
}

// Split a gate-shaped entry ({ errors, ruleIds }, as baselines and
// summaries store it) written before a reclassification. Reclassified ids
// leave the error list. The old count does not say how many errors each
// id accounted for, only that each accounted for at least one, so the
// remaining count is the fewest the entry proves: one per kept id (zero
// when none remain). Anything higher could let a kept rule regress
// unnoticed. `unchecked` names the criteria the entry holds no current
// evidence for: the old findings cannot say whether the successor rule
// would have fired. The entry must already be valid; this never throws.
export function splitReclassified({ errors, ruleIds }) {
  const retired = ruleIds.filter((id) => Object.hasOwn(RECLASSIFIED, id));
  if (retired.length === 0) return { errors, ruleIds, retired, unchecked: [] };
  const kept = ruleIds.filter((id) => !Object.hasOwn(RECLASSIFIED, id));
  return {
    errors: kept.length,
    ruleIds: kept,
    retired,
    unchecked: [...new Set(retired.flatMap((id) => RECLASSIFIED[id].was.criteria))],
  };
}

// The criteria a reclassification can leave unchecked on a platform's
// evidence ("Android", "iOS", or undefined for either).
export function reclassifiedCriteria(platform) {
  return [...new Set(Object.entries(RECLASSIFIED)
    .filter(([id]) => platform === undefined || RULES[id].platform === platform)
    .flatMap(([, entry]) => entry.was.criteria))];
}

// Rule ids that give evidence toward a criterion, in catalog order,
// optionally limited to one severity.
export function rulesForCriterion(criterion, severity) {
  return Object.entries(RULES)
    .filter(([, rule]) => rule.criteria.includes(criterion))
    .filter(([, rule]) => severity === undefined || rule.severity === severity)
    .map(([id]) => id);
}

// Check the catalog's own shape when the module loads, so a malformed
// edit fails every import instead of producing a quietly wrong report.
function validateCatalog() {
  const fail = (reason) => {
    throw new Error(`invalid rule catalog: ${reason}`);
  };
  const used = new Set();
  for (const [id, rule] of Object.entries(RULES)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(`rule id "${id}" must be lowercase kebab-case`);
    if (!PLATFORMS.includes(rule.platform)) fail(`${id} has unknown platform "${rule.platform}"`);
    if (!SEVERITIES.includes(rule.severity)) fail(`${id} has unknown severity "${rule.severity}"`);
    if (typeof rule.what !== "string" || !rule.what.trim()) fail(`${id} needs a description`);
    if (!Array.isArray(rule.criteria)) fail(`${id} needs a criteria list`);
    if (rule.criteria.length === 0 && rule.severity === "error") {
      fail(`${id} is an error, so it must map to at least one criterion`);
    }
    if (new Set(rule.criteria).size !== rule.criteria.length) fail(`${id} repeats a criterion`);
    for (const criterion of rule.criteria) {
      if (!/^\d\.\d+\.\d+$/.test(criterion)) fail(`${id} has malformed criterion "${criterion}"`);
      if (!Object.hasOwn(CRITERIA, criterion)) fail(`${id} maps to ${criterion}, which has no covers text`);
      used.add(criterion);
    }
  }
  for (const [id, entry] of Object.entries(RECLASSIFIED)) {
    const rule = RULES[id];
    const successor = RULES[entry.successor];
    if (!rule) fail(`reclassified ${id} must stay in the catalog: old baselines name it`);
    if (rule.severity === entry.was.severity && isSameList(rule.criteria, entry.was.criteria)) {
      fail(`reclassified ${id} still has its old severity and criteria`);
    }
    if (!successor || successor.platform !== rule.platform || successor.severity !== "error") {
      fail(`reclassified ${id} needs an error successor on ${rule.platform}`);
    }
    if (!entry.was.criteria.every((criterion) => successor.criteria.includes(criterion))) {
      fail(`successor ${entry.successor} must carry every criterion ${id} used to`);
    }
    if (typeof entry.change !== "string" || !entry.change.trim()) fail(`reclassified ${id} needs a change note`);
  }
  for (const [criterion, entry] of Object.entries(CRITERIA)) {
    if (!used.has(criterion)) fail(`criterion ${criterion} has covers text but no rule maps to it`);
    if (typeof entry.covers !== "string" || !entry.covers.trim()) fail(`criterion ${criterion} needs covers text`);
    if (entry.warnings !== undefined && rulesForCriterion(criterion, "error").length === 0) {
      fail(`criterion ${criterion} has a warnings sentence but no error rules`);
    }
  }
}

function isSameList(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function deepFreeze(value) {
  for (const inner of Object.values(value)) {
    if (inner && typeof inner === "object") deepFreeze(inner);
  }
  return Object.freeze(value);
}

validateCatalog();
