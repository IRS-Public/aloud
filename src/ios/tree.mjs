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

// Roles whose value is switch state. UISwitch reaches the mac-AX dump as
// AXCheckBox (verified against the IRS app), so "CheckBox" is a switch here.
const SWITCH_ROLES = new Set(["Switch", "Toggle", "CheckBox"]);

// Roles whose value is legitimately free-form: typed text or a slider
// position. A "1" in these is content, not toggle state.
const VALUE_BEARING_ROLES = new Set(["TextField", "SecureTextField", "SearchField", "Slider"]);

export function normalizeElements(dump) {
  const list = Array.isArray(dump) ? dump : JSON.parse(dump);
  return list.map((e) => {
    const role = e.type ?? e.role ?? "";
    return {
      label: nullish(e.AXLabel),
      value: normValue(e.AXValue, role),
      hint: nullish(e.help),
      role,
      roleDescription: nullish(e.role_description),
      enabled: e.enabled !== false,
      testID: nullish(e.AXUniqueId),
      frame: normFrame(e.frame ?? e.AXFrame),
      raw: e,
    };
  });
}

const nullish = (v) => (v === null || v === undefined || v === "null" ? "" : String(v));

// Bare booleans read as switch state — "false" spoken aloud helps no one.
// Switch-family roles get the same courtesy for numeric state: a UISwitch
// dumps AXValue "1"/"0" through mac-AX, but real VoiceOver speaks
// "on"/"off" — the transcript must match the speech, not the dump (first
// found as a false 508 finding against the IRS app).
function normValue(v, role) {
  if (v === true) return "on";
  if (v === false) return "off";
  if (SWITCH_ROLES.has(role)) {
    if (v === "1" || v === 1) return "on";
    if (v === "0" || v === 0) return "off";
  }
  return nullish(v);
}

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

// Headings arrive either as the Heading role or as a StaticText whose
// role_description says "heading" (UIAccessibilityTraitHeader through mac-AX).
const isHeading = (el) =>
  el.role === "Heading" || /\bheading\b/i.test(el.roleDescription ?? "");

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
    // UISwitch is 51x31pt from Apple's own hands — their audit passes it,
    // so the platform-minimum rule exempts switch-family roles (the row
    // that hosts one typically extends the hit area anyway).
    if (interactive && el.enabled && !SWITCH_ROLES.has(el.role) && (el.frame.w < 44 || el.frame.h < 44)) {
      add(
        "ios-touch-target-small",
        "2.5.8",
        el,
        `touch target ${Math.round(el.frame.w)}x${Math.round(el.frame.h)}pt (minimum 44x44pt)`,
      );
    }

    // 4.1.2 Name, Role, Value — a control speaking a bare "1"/"0" as its
    // value: VoiceOver says "one"/"zero" where a person needs "on"/"off".
    // Booleans and switch-family numeric state normalize upstream; a
    // digit that SURVIVES normalization is a non-switch control wearing
    // toggle state (a custom pressable with a numeric accessibilityValue).
    // Text fields and sliders are exempt: a "1" there is what the user
    // typed or where the thumb sits. Warn-only: the shape has not yet been
    // seen in the wild (the first sighting was the transcript's fault, not
    // the app's), and a button carrying a badge count of "1" is legitimate.
    if (interactive && !VALUE_BEARING_ROLES.has(el.role) && (el.value === "1" || el.value === "0")) {
      add(
        "ios-toggle-raw-value",
        "4.1.2",
        el,
        `control announces raw value "${el.value}" — a switch state should speak on/off`,
        "warn",
      );
    }
  }

  // 4.1.2 — inconsistent interactivity across a visual list: rows that are
  // left-aligned to the same column and same width, where SOME announce as
  // interactive and some as static text. A VoiceOver user hears "button" on
  // one row and nothing on its visual twin — no way to know the second row
  // is tappable. Warn-only: static section footers inside card lists are
  // legitimate. Found in the wild on the IRS app: half a client roster's
  // rows had lost their button trait in a walk-time dump (walk.mjs now
  // re-dumps until the tree settles, which removes the racy case; this
  // rule catches the shape when it is real).
  const columns = new Map();
  for (const el of elements) {
    if (!(el.frame && el.frame.w > 0 && el.frame.h >= 40)) continue;
    if (!el.label) continue;
    // A section heading sharing the list's column is the grouped-list
    // idiom, not a row that lost its trait.
    if (isHeading(el)) continue;
    const key = `${Math.round(el.frame.x)}:${Math.round(el.frame.w)}`;
    (columns.get(key) ?? columns.set(key, []).get(key)).push(el);
  }
  for (const rows of columns.values()) {
    if (rows.length < 3) continue; // a list, not a pair
    // A disabled row still announces its trait ("button, dimmed"), so it
    // shapes the list like an enabled one.
    const interactiveRows = rows.filter((el) => INTERACTIVE_ROLES.has(el.role));
    const staticRows = rows.filter((el) => !INTERACTIVE_ROLES.has(el.role));
    if (!(interactiveRows.length >= 2 && staticRows.length > 0 && interactiveRows.length > staticRows.length)) {
      continue;
    }
    // Height similarity: list rows share a rhythm. A static element much
    // taller than the interactive rows is prose (an intro paragraph), not
    // a row that lost its trait.
    const heights = interactiveRows.map((el) => el.frame.h).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    for (const el of staticRows) {
      if (el.frame.h > median * 1.5) continue;
      // Prose, not a row: a long label is an intro paragraph or help text
      // sharing the column by coincidence (row labels run short; prose
      // runs long). Dot-separators alone can't discriminate — real rows
      // speak "Name. TIN ending in 1234. Status" — so length carries it.
      if (el.label.length > 90) continue;
      add(
        "ios-list-row-not-interactive",
        "4.1.2",
        el,
        `row "${el.label}" sits in a list where ${interactiveRows.length} sibling rows announce as interactive, but this one has no interactive trait`,
        "warn",
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
