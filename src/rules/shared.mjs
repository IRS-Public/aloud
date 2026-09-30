// Helpers shared by the Android (src/android/ui-tree.mjs) and iOS
// (src/ios/tree.mjs) rule engines. Pure functions, platform-blind: each
// engine passes in how to describe an element and what it announces, so
// the findings each platform emits are exactly what they were before these
// helpers were shared.

// A box a screen reader can reach has a positive width and height. Both
// platforms normalize their bounds to { w, h }; clipped or offscreen
// elements dump with zero or negative sizes, and no rule judges them.
export const hasArea = (box) => Boolean(box && box.w > 0 && box.h > 0);

// Collect findings in the order the rules report them. severity "error"
// counts toward the ratchet gate; "warn" is report-only. `extra` adds
// platform fields after the common ones (Android ATF node ids).
export function createFindings(describe, extra = () => ({})) {
  const violations = [];
  const add = (ruleId, wcag, element, detail, severity = "error") => {
    violations.push({
      ruleId,
      wcag,
      severity,
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
