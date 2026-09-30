// Helpers shared by the Android (src/android/ui-tree.mjs) and iOS
// (src/ios/tree.mjs) rule engines. Pure functions: each engine passes in
// its platform, how to describe an element, and what it announces. Rule
// severity and WCAG criteria come from the shared catalog, never from the
// engine.

import { PLATFORMS, ruleSpec } from "./catalog.mjs";

// A box a screen reader can reach has a positive width and height. Both
// platforms normalize their bounds to { w, h }; clipped or offscreen
// elements dump with zero or negative sizes, and no rule judges them.
export const hasArea = (box) => Boolean(box && box.w > 0 && box.h > 0);

// Collect findings in the order the rules report them. Each engine names
// its platform; severity and criteria come from the rule catalog
// (src/rules/catalog.mjs), so an engine cannot tag a rule differently from
// the report. An id the catalog does not know, or one from another
// platform, throws. severity "error" counts toward the ratchet gate;
// "warn" is report-only. `wcag` is the primary criterion (kept for older
// readers); `criteria` lists every criterion the rule gives evidence
// toward. `extra` adds platform fields after the common ones (Android ATF
// node ids).
export function createFindings(platform, describe, extra = () => ({})) {
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`createFindings: unknown platform "${platform}"`);
  }
  const violations = [];
  const add = (ruleId, element, detail) => {
    const rule = ruleSpec(ruleId, platform);
    violations.push({
      ruleId,
      wcag: rule.criteria[0],
      criteria: [...rule.criteria],
      severity: rule.severity,
      element: describe(element),
      detail,
      ...extra(element),
    });
  };
  return { violations, add };
}

// Every element that repeats an announcement an earlier element already
// made, in element order. Two controls announcing identically are
// indistinguishable to a screen-reader user (ATF DuplicateSpeakableText).
// An empty announcement is never a duplicate. Each repeat carries the
// element that spoke first and `occurrence`, which counts repeats of that
// announcement (1 = the first repeat).
export function repeatedAnnouncements(elements, announcementOf) {
  const heard = new Map();
  const repeats = [];
  for (const element of elements) {
    const announcement = announcementOf(element);
    if (!announcement) continue;
    const entry = heard.get(announcement);
    if (!entry) {
      heard.set(announcement, { first: element, repeats: 0 });
      continue;
    }
    entry.repeats += 1;
    repeats.push({ element, announcement, first: entry.first, occurrence: entry.repeats });
  }
  return repeats;
}
