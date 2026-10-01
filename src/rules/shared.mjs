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
// toward (empty for a platform-guideline warn, which then has no `wcag`
// either). `extra` adds platform fields after the common ones (Android ATF
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
      // A guideline warn maps to no criterion, so it has no primary one.
      ...(rule.criteria.length ? { wcag: rule.criteria[0] } : {}),
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

// ── WCAG 2.5.8 target size ──
// Both engines measure in a unit that approximates one CSS px (Android dp,
// iOS points), so the criterion's 24 CSS px becomes 24 units.
export const TARGET_SIZE_MINIMUM = 24;

// Floating-point slack for the spacing geometry: bounds converted from
// pixels can land a hair off an exact tangent.
const EPSILON = 1e-9;

// The 2.5.8 spacing exception. An undersized target still passes when a
// circle of TARGET_SIZE_MINIMUM diameter centred on its bounding box
// intersects no other target and no other undersized target's circle.
// Each target is { box: { x1, y1, x2, y2 }, undersized } in the rule's unit;
// `others` are the screen's other targets. A circle that only touches a box
// or another circle at one point does not intersect it. Returns the first
// conflict ({ other, with: "target" | "circle" }), or null when the
// exception applies.
export function spacingConflict(target, others) {
  const radius = TARGET_SIZE_MINIMUM / 2;
  const centre = centreOf(target.box);
  for (const other of others) {
    if (other === target) continue;
    if (distanceToBox(centre, other.box) < radius - EPSILON) return { other, with: "target" };
    const apart = Math.hypot(centre.x - centreOf(other.box).x, centre.y - centreOf(other.box).y);
    if (other.undersized && apart < TARGET_SIZE_MINIMUM - EPSILON) return { other, with: "circle" };
  }
  return null;
}

const centreOf = (box) => ({ x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 });

// Distance from a point to the nearest point of a box (zero inside it).
function distanceToBox(point, box) {
  const dx = Math.max(box.x1 - point.x, 0, point.x - box.x2);
  const dy = Math.max(box.y1 - point.y, 0, point.y - box.y2);
  return Math.hypot(dx, dy);
}
