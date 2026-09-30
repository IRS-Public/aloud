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
  "native-touch-target-small": {
    platform: "Android",
    severity: "error",
    criteria: ["2.5.8"],
    what: "touch target under 48x48dp",
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
  "ios-touch-target-small": {
    platform: "iOS",
    severity: "error",
    criteria: ["2.5.8"],
    what: "touch target under 44x44pt",
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
      "touch targets must meet the platform minimum (48x48dp on Android, 44x44pt on iOS; " +
      "both exceed the 24 CSS px minimum of this criterion)",
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
    if (!Array.isArray(rule.criteria) || rule.criteria.length === 0) {
      fail(`${id} must map to at least one criterion`);
    }
    if (new Set(rule.criteria).size !== rule.criteria.length) fail(`${id} repeats a criterion`);
    for (const criterion of rule.criteria) {
      if (!/^\d\.\d+\.\d+$/.test(criterion)) fail(`${id} has malformed criterion "${criterion}"`);
      if (!Object.hasOwn(CRITERIA, criterion)) fail(`${id} maps to ${criterion}, which has no covers text`);
      used.add(criterion);
    }
  }
  for (const [criterion, entry] of Object.entries(CRITERIA)) {
    if (!used.has(criterion)) fail(`criterion ${criterion} has covers text but no rule maps to it`);
    if (typeof entry.covers !== "string" || !entry.covers.trim()) fail(`criterion ${criterion} needs covers text`);
    if (entry.warnings !== undefined && rulesForCriterion(criterion, "error").length === 0) {
      fail(`criterion ${criterion} has a warnings sentence but no error rules`);
    }
  }
}

function deepFreeze(value) {
  for (const inner of Object.values(value)) {
    if (inner && typeof inner === "object") deepFreeze(inner);
  }
  return Object.freeze(value);
}

validateCatalog();
