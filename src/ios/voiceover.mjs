// Compose "what VoiceOver would say" for one accessibility element.
//
// VoiceOver's default announcement order is label, value, traits, hint —
// the order is a stable convention (reproduced by cashapp/AccessibilitySnapshot,
// which we treat as the reference implementation), not a formal spec. The
// output is comma-joined with lowercase trait words. Real VoiceOver can
// use different punctuation and casing; retain its raw output and define
// comparisons separately. Ratchet baselines currently store tree-error
// counts and rule IDs, not transcript text.
//
// Input is a NORMALIZED element (see tree.mjs): { label, value, hint,
// role, enabled }. Pure function, unit-tested in test/ios-checks.test.mjs.

const ROLE_WORDS = {
  Button: "button",
  Link: "link",
  Image: "image",
  TextField: "text field",
  SecureTextField: "secure text field",
  SearchField: "search field",
  Switch: "switch",
  Toggle: "switch",
  // A React Native Switch reaches the mac-AX dump as "CheckBox" (verified
  // against the IRS app: UISwitch → AXCheckBox translation, so the role
  // string is "CheckBox" with that capital B — iOS has no checkbox trait
  // of its own). Real VoiceOver speaks it as a switch.
  CheckBox: "switch",
  Slider: "adjustable",
  Heading: "heading",
  Tab: "tab",
  RadioButton: "radio button",
};

export const roleWord = (role) => ROLE_WORDS[role] ?? "";

export function composeUtterance(el) {
  const parts = [];
  const label = (el.label ?? "").trim();
  const value = String(el.value ?? "").trim();
  const hint = (el.hint ?? "").trim();
  if (label) parts.push(label);
  if (value && value !== label) parts.push(value);
  const role = roleWord(el.role);
  if (role) parts.push(role);
  if (el.enabled === false) parts.push("dimmed");
  if (hint) parts.push(hint);
  return parts.join(", ");
}

// Would VoiceOver stop on this element at all? Focusable ≈ has something to
// speak, or is an interactive control (which VoiceOver announces even when
// unlabeled — that failure mode is exactly what the checks flag).
export const INTERACTIVE_ROLES = new Set([
  "Button",
  "Link",
  "TextField",
  "SecureTextField",
  "SearchField",
  "Switch",
  "Toggle",
  "CheckBox",
  "Slider",
  "Tab",
  "RadioButton",
  "Cell",
]);

export function isFocusable(el) {
  return Boolean(
    (el.label ?? "").trim() || String(el.value ?? "").trim() || INTERACTIVE_ROLES.has(el.role),
  );
}
