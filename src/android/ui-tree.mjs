// Parse a `uiautomator dump` XML into a node tree and run Section 508-style
// checks over it. Pure functions — no adb — so the rules are unit-testable
// on fixture dumps (test/android-checks.test.mjs).
//
// Scope note: the dump exposes text/content-desc/bounds/clickable etc. but
// NOT stateDescription, roleDescription, hints, or paneTitle — those need an
// AccessibilityNodeInfo harness (ATF), which is the planned phase-2 upgrade.
// These rules are the high-confidence subset that the dump can prove.

// ── parser ──
// uiautomator XML is flat-attribute <node> elements, nested or self-closing.
// A tiny stack parser is enough; no XML library needed for this format.
export function parseUiDump(xml) {
  // Reject partial dumps and command diagnostics rather than extracting a
  // plausible node from arbitrary text. uiautomator emits one hierarchy
  // containing only nested/self-closing nodes, with quoted attributes.
  const document = String(xml).trim().replace(/^<\?xml\s[^?]*\?>\s*/, "");
  const hierarchy = document.match(/^<hierarchy\b([^<>]*)>([\s\S]*)<\/hierarchy\s*>$/);
  if (!hierarchy) throw new Error("invalid uiautomator dump: expected a complete hierarchy");
  parseAttributes(hierarchy[1]);
  const body = hierarchy[2];
  const nodes = [];
  const stack = [];
  const tagRe = /<node\b((?:[^"'<>]|"[^"<]*"|'[^'<]*')*?)(\/?)>|<\/node\s*>/y;
  const whitespace = /\s*/y;
  let offset = 0;
  let m;
  while (offset < body.length) {
    whitespace.lastIndex = offset;
    whitespace.exec(body);
    offset = whitespace.lastIndex;
    if (offset === body.length) break;
    tagRe.lastIndex = offset;
    m = tagRe.exec(body);
    if (!m) throw new Error("invalid uiautomator dump: malformed node XML");
    offset = tagRe.lastIndex;
    if (m[0].startsWith("</node")) {
      if (!stack.length) throw new Error("invalid uiautomator dump: unmatched closing node");
      stack.pop();
      continue;
    }
    const attrs = parseAttributes(m[1]);
    const node = {
      ...attrs,
      bounds: parseBounds(attrs.bounds),
      children: [],
      parent: stack.length ? stack[stack.length - 1] : null,
    };
    if (node.parent) node.parent.children.push(node);
    nodes.push(node);
    if (m[2] !== "/") stack.push(node);
  }
  if (stack.length) throw new Error("invalid uiautomator dump: unclosed node");
  return nodes;
}

function parseAttributes(text) {
  const attrs = {};
  const attrRe = /\s+([\w-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  let offset = 0;
  while (text.slice(offset).trim()) {
    attrRe.lastIndex = offset;
    const m = attrRe.exec(text);
    if (!m || Object.hasOwn(attrs, m[1])) {
      throw new Error("invalid uiautomator dump: malformed or duplicate attribute");
    }
    attrs[m[1]] = (m[2] ?? m[3])
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    offset = attrRe.lastIndex;
  }
  return attrs;
}

function parseBounds(s) {
  const m = s && s.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

const truthy = (v) => v === "true";
// ATF's TouchTargetSizeCheck exempts controls whose tap is handled by a
// bigger clickable ancestor; mirror it. A display-only control (native
// Switch behind a Pressable row with pointerEvents="none") dumps as
// clickable, but the row is the real target — if a labeled, enabled,
// clickable ancestor meets the 48dp bar, the descendant is not judged.
const insideLargeClickableAncestor = (n, px2dp) => {
  for (let a = n.parent; a; a = a.parent) {
    if (
      truthy(a.clickable) &&
      truthy(a.enabled) &&
      a.bounds &&
      px2dp(a.bounds.w) >= 48 &&
      px2dp(a.bounds.h) >= 48 &&
      speakableDeep(a)
    ) {
      return true;
    }
  }
  return false;
};

const clippedByScroll = (n) => {
  for (let a = n.parent; a; a = a.parent) {
    if (truthy(a.scrollable) && a.bounds && n.bounds) {
      if (n.bounds.y2 >= a.bounds.y2 || n.bounds.y1 <= a.bounds.y1) return true;
    }
  }
  return false;
};
const speakableSelf = (n) => Boolean((n.text || "").trim() || (n["content-desc"] || "").trim() || (n.hint || "").trim());
const speakableDeep = (n) => speakableSelf(n) || n.children.some(speakableDeep);

// Finding no violations only means something after capturing app content.
// A layout root, system dialog, or launcher is not evidence about the app.
// Unlabeled controls DO count: those are evidence the rules should flag.
export function validateUiCapture(nodes, appPackage) {
  const app = nodes.filter((n) => n.package === appPackage);
  if (!app.length) throw new Error(`no nodes from target app ${appPackage}; check the foreground app`);
  const usable = app.some((n) =>
    n.class?.trim() && n.bounds && n.bounds.w > 0 && n.bounds.h > 0 &&
    (speakableSelf(n) || ["focusable", "clickable", "long-clickable", "checkable"].some((key) => truthy(n[key]))),
  );
  if (!usable) {
    throw new Error(`no visible accessibility content from target app ${appPackage}; check that the screen has rendered`);
  }
}

const describe = (n) =>
  `${(n.class || "?").replace(/^android\.widget\./, "")}` +
  `${n["resource-id"] ? ` id=${n["resource-id"]}` : ""}` +
  `${n.bounds ? ` @[${n.bounds.x1},${n.bounds.y1} ${n.bounds.w}x${n.bounds.h}px]` : ""}`;

// ── rules ──
// Rule ids are stable strings (they live in the user's committed baseline,
// like axe rule ids do in a web ratchet gate). Mapped WCAG SC per rule.

export function runChecks(nodes, { densityDpi, appPackage }) {
  if (!appPackage) {
    throw new Error("runChecks: appPackage is required (config app.android.package)");
  }
  const px2dp = (px) => (px * 160) / densityDpi;
  const app = nodes.filter((n) => n.package === appPackage);
  const violations = [];
  // severity "error" counts toward the ratchet gate; "warn" is report-only
  // (duplicate labels are genuinely ambiguous but list-heavy screens repeat
  // labels legitimately — a warn keeps the signal without gating on it).
  const add = (ruleId, wcag, node, detail, severity = "error") =>
    violations.push({ ruleId, wcag, severity, element: describe(node), detail,
      ...(node.nativeId !== undefined ? { nativeId: node.nativeId, source: "accessibility-node-info" } : {}) });

  for (const n of app) {
    const interactive = truthy(n.clickable) || truthy(n["long-clickable"]) || truthy(n.checkable);
    // Nodes with non-positive bounds are clipped/offscreen (observed live:
    // scrolled-out list rows dump with negative heights) — a screen reader
    // can't reach them here, so no rule should judge them.
    const visible = n.bounds && n.bounds.w > 0 && n.bounds.h > 0;
    if (!visible) continue;

    // 4.1.2 Name, Role, Value — an interactive element with no speakable text
    // anywhere in its subtree is announced as just "button"/"unlabeled".
    // The focusable check keeps a11y-hidden overlays (sheet scrims marked
    // accessible={false} focusable={false}) out: uiautomator dumps include
    // views TalkBack never focuses, and an unfocusable clickable layer is
    // unreachable by screen reader and keyboard alike.
    if (
      interactive &&
      truthy(n.enabled) &&
      truthy(n.focusable) &&
      !speakableDeep(n) &&
      !insideLargeClickableAncestor(n, px2dp)
    ) {
      add(
        "native-interactive-unlabeled",
        "4.1.2",
        n,
        "clickable element with no text or content-desc in its subtree",
      );
    }

    // 4.1.2 — image-only controls need an explicit label; text can't save
    // them because there is none to inherit.
    if (
      /Image(Button|View)$/.test(n.class || "") &&
      interactive &&
      !speakableSelf(n) &&
      !n.children.length
    ) {
      add("native-image-button-unlabeled", "4.1.2", n, "image control without content-desc");
    }

    // Target size — 48x48dp is the Android platform minimum (ATF's
    // TouchTargetSizeCheck; WCAG 2.5.8 AA is 24dp, 2.5.5 AAA is 44dp — we
    // hold the platform bar). Skip elements clipped at a scrollable
    // ancestor's edge: the dump reports only the visible slice, so the
    // "small" height is the viewport cut, not the element's real size.
    if (
      interactive &&
      truthy(n.enabled) &&
      !clippedByScroll(n) &&
      !insideLargeClickableAncestor(n, px2dp)
    ) {
      // Round before comparing: a minHeight:48 view renders 125px at 420dpi
      // (47.62dp) — sub-pixel rasterization, not a real size deficit.
      const w = Math.round(px2dp(n.bounds.w));
      const h = Math.round(px2dp(n.bounds.h));
      if (w < 48 || h < 48) {
        add(
          "native-touch-target-small",
          "2.5.8",
          n,
          `touch target ${Math.round(w)}x${Math.round(h)}dp (minimum 48x48dp)`,
        );
      }
    }

    // 1.3.1 / 4.1.2 — editable fields need a label a screen reader can
    // announce; an empty EditText with no content-desc reads as "edit box".
    if (
      (n.class || "").endsWith("EditText") &&
      !(n.text || "").trim() &&
      !(n.hint || "").trim() &&
      !(n["content-desc"] || "").trim()
    ) {
      add(
        "native-edittext-unlabeled",
        "4.1.2",
        n,
        "editable field with no label, hint, or content-desc",
      );
    }
  }

  // 4.1.2 — two interactive elements announcing identically are
  // indistinguishable to a screen-reader user (ATF DuplicateSpeakableText).
  const spoken = new Map();
  for (const n of app) {
    if (!(truthy(n.clickable) && truthy(n.enabled))) continue;
    if (!(n.bounds && n.bounds.w > 0 && n.bounds.h > 0)) continue;
    const label = ((n.text || "").trim() || (n["content-desc"] || "").trim()).toLowerCase();
    if (!label) continue;
    if (spoken.has(label)) {
      const first = spoken.get(label);
      if (first.flagged !== true) {
        add(
          "native-duplicate-speakable",
          "4.1.2",
          n,
          `same announcement as ${describe(first.node)}: "${label}"`,
          "warn",
        );
        first.flagged = true;
      } else {
        add("native-duplicate-speakable", "4.1.2", n, `same announcement: "${label}"`, "warn");
      }
    } else {
      spoken.set(label, { node: n, flagged: false });
    }
  }

  return violations;
}
