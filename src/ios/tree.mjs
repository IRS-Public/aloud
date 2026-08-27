// Normalize an `idb ui describe-all --json` dump, compute the per-screen
// VoiceOver transcript, and run the iOS 508 rules. Pure functions — the
// device call lives in walk.mjs; fixtures cover this file in
// test/ios-checks.test.mjs.
//
// Same scope note as the Android rules: this is the high-confidence subset
// the dump can prove. Apple's own audit (performAccessibilityAudit) and the
// Xcode 27 real-VoiceOver API layer on later — rule ids here are stable and
// live in the user's iOS baseline file (see `aloud baseline`).

import { INTERACTIVE_ROLES, composeUtterance, isFocusable } from "./voiceover.mjs";

// idb v1.1.8 (the brew-installed release) emits ONE flat JSON array in
// depth-first pre-order — an approximation of VoiceOver's swipe order, not
// a guarantee (VoiceOver also sorts geometrically). Fields verified against
// FBSimulatorAccessibilityCommands.m @ v1.1.8: AXLabel, AXValue
// (string|number|bool|null), type (role with the "AX" prefix stripped),
// help (the accessibilityHint surfaces here through Apple's mac-AX
// translation), enabled, frame {x,y,width,height} in POINTS, AXUniqueId
// (the RN testID), role_description.
export function normalizeElements(dump) {
  const list = Array.isArray(dump) ? dump : JSON.parse(dump);
  return list.map((e) => ({
    label: nullish(e.AXLabel),
    // bare booleans read as switch state — "false" spoken aloud helps no one
    value: e.AXValue === true ? "on" : e.AXValue === false ? "off" : nullish(e.AXValue),
    hint: nullish(e.help),
    role: e.type ?? e.role ?? "",
    roleDescription: nullish(e.role_description),
    enabled: e.enabled !== false,
    testID: nullish(e.AXUniqueId),
    frame: normFrame(e.frame ?? e.AXFrame),
    raw: e,
  }));
}

const nullish = (v) => (v === null || v === undefined || v === "null" ? "" : String(v));

function normFrame(f) {
  if (!f) return null;
  if (typeof f === "object") {
    const { x, y, width, height } = f;
    if ([x, y, width, height].some((n) => typeof n !== "number")) return null;
    return { x, y, w: width, h: height };
  }
  // AXFrame string form: "{{x, y}, {w, h}}"
  const m = String(f).match(/\{\{(-?[\d.]+),\s*(-?[\d.]+)\},\s*\{(-?[\d.]+),\s*(-?[\d.]+)\}\}/);
  return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
}

const describe = (el) =>
  `${el.role || "?"}${el.testID ? ` testID=${el.testID}` : ""}` +
  `${el.frame ? ` @[${Math.round(el.frame.x)},${Math.round(el.frame.y)} ${Math.round(el.frame.w)}x${Math.round(el.frame.h)}pt]` : ""}`;

// The computed transcript: what VoiceOver would speak stepping through the
// screen in tree order. Elements with nothing to say are skipped, matching
// VoiceOver's focus behavior.
export function computeTranscript(elements) {
  return elements.filter(isFocusable).map(composeUtterance).filter(Boolean);
}

export function runIosChecks(elements) {
  const violations = [];
  const add = (ruleId, wcag, el, detail, severity = "error") =>
    violations.push({ ruleId, wcag, severity, element: describe(el), detail });

  for (const el of elements) {
    const visible = el.frame && el.frame.w > 0 && el.frame.h > 0;
    if (!visible) continue;
    const interactive = INTERACTIVE_ROLES.has(el.role);

    // 4.1.2 Name, Role, Value — an unlabeled control announces as just
    // "button": nothing tells the user what it does.
    if (interactive && el.enabled && !el.label && !el.value) {
      add("ios-interactive-unlabeled", "4.1.2", el, "interactive element with no label or value");
    }

    // 4.1.2 — an image element VoiceOver can reach but cannot describe.
    if (el.role === "Image" && !el.label && !el.value) {
      add("ios-image-unlabeled", "4.1.2", el, "image element without an accessibility label");
    }

    // Target size — 44x44pt is the Apple platform minimum (HIG; Apple's
    // hitRegion audit uses the same bar. WCAG 2.5.8 AA is 24px — we hold
    // the platform bar, same policy as the Android 48dp rule).
    if (interactive && el.enabled && (el.frame.w < 44 || el.frame.h < 44)) {
      add(
        "ios-touch-target-small",
        "2.5.8",
        el,
        `touch target ${Math.round(el.frame.w)}x${Math.round(el.frame.h)}pt (minimum 44x44pt)`,
      );
    }
  }

  // 4.1.2 — two controls that announce identically are indistinguishable.
  // Warn-only, like the Android rule: lists legitimately repeat labels.
  const spoken = new Map();
  for (const el of elements) {
    if (!INTERACTIVE_ROLES.has(el.role) || !el.enabled) continue;
    if (!(el.frame && el.frame.w > 0 && el.frame.h > 0)) continue;
    const utterance = composeUtterance(el).toLowerCase();
    if (!utterance) continue;
    if (spoken.has(utterance)) {
      add("ios-duplicate-speakable", "4.1.2", el, `same announcement: "${utterance}"`, "warn");
    } else {
      spoken.set(utterance, el);
    }
  }

  return violations;
}
