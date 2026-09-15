import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { TALKBACK_COMMIT } from "./talkback-companion/patch.mjs";
import { validateUiCapture } from "./ui-tree.mjs";

export const ATF_VERSION = "4.1.1";
export const ATF_ARTIFACT = "com.google.android.apps.common.testing.accessibility.framework:accessibility-test-framework";
export const ATF_SUITE = "aloud-node-v1";
const prefix = "com.google.android.apps.common.testing.accessibility.framework.checks.";
export const ATF_CHECKS = [
  ["atf-speakable-text-present", "SpeakableTextPresentCheck", ["native-interactive-unlabeled", "native-image-button-unlabeled", "native-edittext-unlabeled"]],
  ["atf-editable-content-desc", "EditableContentDescCheck", []],
  ["atf-touch-target-size", "TouchTargetSizeCheck", ["native-touch-target-small"]],
  ["atf-duplicate-speakable-text", "DuplicateSpeakableTextCheck", ["native-duplicate-speakable"]],
  ["atf-redundant-description", "RedundantDescriptionCheck", []],
  ["atf-class-name", "ClassNameCheck", []],
].map(([ruleId, name, overlaps]) => ({ ruleId, className: prefix + name, overlaps }));
export const ATF_UNSELECTED = ["ClickableSpanCheck", "DuplicateClickableBoundsCheck", "TextContrastCheck",
  "ImageContrastCheck", "TraversalOrderCheck", "LinkPurposeUnclearCheck", "TextSizeCheck"].map((name) => ({
  className: prefix + name, status: "not-selected", reason: "Outside the fixture-validated aloud-node-v1 suite",
}));
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const string = (v) => typeof v === "string" && v.length > 0;
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const check = (yes, message) => { if (!yes) throw new Error(`invalid Android ATF evidence: ${message}`); };
const equal = isDeepStrictEqual;
export const sha256 = (raw) => createHash("sha256").update(raw).digest("hex");

export function validateAtfReceipt(receipt, expected) {
  for (const key of ["requestId", "screen", "target", "phase"]) check(receipt?.[key] === expected[key], `${key} mismatch`);
  check(receipt.schemaVersion === 1 && receipt.source === "android-atf" && UUID.test(receipt.requestId) && UUID.test(receipt.session) &&
    receipt.file === `${receipt.requestId}.${receipt.phase}.json` && ["capture", "verify"].includes(receipt.phase) &&
    count(receipt.bytes) && receipt.bytes > 0 && receipt.bytes <= 8 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(receipt.sha256), "receipt");
  if (expected.session) check(receipt.session === expected.session, "companion session changed");
  return receipt;
}

export function validateAtfSnapshot(raw, receipt, expected) {
  validateAtfReceipt(receipt, expected);
  check(typeof raw === "string" && raw.endsWith("\n") && Buffer.byteLength(raw) === receipt.bytes && sha256(raw) === receipt.sha256,
    "missing, truncated, or changed artifact");
  const v = JSON.parse(raw);
  for (const key of ["requestId", "screen", "target", "phase", "session", "source", "schemaVersion"]) check(v[key] === receipt[key], `artifact ${key}`);
  check(v.status === "completed" && v.error === null, `capture did not complete (${v.error ?? v.status})`);
  check(Array.isArray(v.observedChanges) && v.observedChanges.length === 0, "screen changed during native capture");
  check(v.talkbackCommit === TALKBACK_COMMIT && count(v.pid) && v.pid > 0 && count(v.windowId) && count(v.elapsedMs) && count(v.changeSequence), "producer identity");
  check(equal(v.framework, { artifact: ATF_ARTIFACT, version: ATF_VERSION, suite: ATF_SUITE, origin: "ACCESSIBILITY_NODE_INFOS" }), "framework provenance");
  check(count(v.runtime?.sdk) && v.runtime.sdk >= 26 && ["release", "fingerprint", "locale"].every((k) => string(v.runtime[k])) &&
    count(v.densityDpi) && v.densityDpi > 0, "runtime provenance");
  check(equal(v.propertySupport, { hintText: v.runtime.sdk >= 26, stateDescription: v.runtime.sdk >= 30,
    paneTitle: v.runtime.sdk >= 28, roleDescription: true }), "property availability");
  check(Array.isArray(v.nodes) && v.nodes.length > 0 && v.nodes.length <= 500, "node inventory");
  const byId = new Map();
  for (const n of v.nodes) {
    check(n && typeof n.id === "string" && /^\d+$/.test(n.id) && !byId.has(n.id) && n.windowId === v.windowId && n.packageName === v.target &&
      (n.parentId === null || typeof n.parentId === "string") && Array.isArray(n.children) && n.children.length === n.childCount &&
      n.children.every((id) => typeof id === "string") && new Set(n.children).size === n.children.length, "node identity or children");
    check(["viewId", "className", "text", "description", "hintText", "stateDescription", "paneTitle", "roleDescription"].every((k) =>
      n[k] === null || (typeof n[k] === "string" && n[k].length <= 65536)), "node text");
    check(["enabled", "visible", "important", "clickable", "longClickable", "focusable", "checkable", "checked", "scrollable", "editable", "showingHint"].every((k) =>
      typeof n[k] === "boolean") && /^-?\d+ -?\d+ -?\d+ -?\d+$/.test(n.bounds), "node properties");
    for (const [k, available] of Object.entries(v.propertySupport)) check(available || n[k] === null, `unavailable ${k} was invented`);
    byId.set(n.id, n);
  }
  const roots = v.nodes.filter((n) => n.parentId === null);
  check(roots.length === 1, "expected one active-window root");
  const seen = new Set();
  function visit(n, depth) {
    check(n && !seen.has(n.id) && depth <= 50, "missing, cyclic, or deep node graph");
    seen.add(n.id);
    for (const id of n.children) { const c = byId.get(id); check(c?.parentId === n.id, "parent/child mismatch"); visit(c, depth + 1); }
  }
  visit(roots[0], 0);
  check(seen.size === byId.size, "disconnected nodes");
  check(Array.isArray(v.checks) && v.checks.length === ATF_CHECKS.length, "missing native checks");
  for (const [i, c] of v.checks.entries()) {
    check(c.ruleId === ATF_CHECKS[i].ruleId && c.className === ATF_CHECKS[i].className && c.version === ATF_VERSION &&
      c.status === "completed" && c.error === null && Array.isArray(c.results) && c.results.length <= 5000, "native check did not complete or inventory changed");
    for (const r of c.results) check((r.elementId === null || byId.has(r.elementId)) && count(r.resultId) && r.resultId > 0 &&
      ["ERROR", "WARNING", "INFO", "NOT_RUN"].includes(r.type) && string(r.message), "native result identity or type");
  }
  validateUiCapture(atfTreeNodes(v), v.target);
  return v;
}

export function validateAtfEvidence(evidence) {
  check(evidence?.schemaVersion === 1 && evidence.source === "android-atf" && evidence.complete === true &&
    UUID.test(evidence.requestId) && string(evidence.screen) && string(evidence.target) &&
    /^[0-9]+(?: [0-9]+)*$/.test(evidence.targetPidBefore) && evidence.targetPidBefore === evidence.targetPidAfter, "incomplete capture or target process changed");
  const expected = { requestId: evidence.requestId, screen: evidence.screen, target: evidence.target };
  const a = validateAtfSnapshot(evidence.capture?.raw, evidence.capture?.receipt, { ...expected, phase: "capture" });
  const b = validateAtfSnapshot(evidence.verification?.raw, evidence.verification?.receipt, { ...expected, phase: "verify", session: a.session });
  check(a.pid === b.pid && a.windowId === b.windowId && a.changeSequence === b.changeSequence && a.densityDpi === b.densityDpi && equal(a.runtime, b.runtime) &&
    equal(a.nodes, b.nodes), "screen or companion changed around the screenshot");
  return a;
}

// Keep the original tree-rule data shape, adding exact snapshot identity and known native hints.
export function atfTreeNodes(snapshot) {
  const nodes = snapshot.nodes.map((n) => {
    const [x1, y1, x2, y2] = n.bounds.split(" ").map(Number);
    return { nativeId: n.id, package: n.packageName, class: n.className ?? "", text: n.text ?? "",
      "resource-id": n.viewId ?? "", "content-desc": n.description ?? "", hint: n.hintText ?? "",
      bounds: n.visible ? { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 } : null,
      ...Object.fromEntries([["enabled", "enabled"], ["clickable", "clickable"], ["long-clickable", "longClickable"],
        ["focusable", "focusable"], ["checkable", "checkable"], ["scrollable", "scrollable"]].map(([k, prop]) => [k, String(n[prop])])),
      children: [], parent: null };
  });
  const byId = new Map(nodes.map((n) => [n.nativeId, n]));
  snapshot.nodes.forEach((n, i) => { nodes[i].parent = byId.get(n.parentId) ?? null; nodes[i].children = n.children.map((id) => byId.get(id)); });
  return nodes;
}

export function atfFindings(snapshot, treeViolations = []) {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const label = (id) => { const n = byId.get(id); return (n?.text?.trim() || n?.description?.trim() || "").toLowerCase(); };
  return snapshot.checks.flatMap((c, i) => c.results.filter((r) => r.type !== "NOT_RUN").map((r) => ({
    ...r, ruleId: c.ruleId, className: c.className, version: c.version, source: "android-atf", reportOnly: true,
    potentialDuplicates: [...new Set(treeViolations.filter((v) => ATF_CHECKS[i].overlaps.includes(v.ruleId) &&
      (v.nativeId === r.elementId || (c.ruleId === "atf-duplicate-speakable-text" && label(r.elementId) && label(r.elementId) === label(v.nativeId))))
      .map((v) => v.ruleId))],
  })));
}

export function atfSummary(evidence) {
  const v = validateAtfEvidence(evidence);
  return { status: "completed", reportOnly: true, source: "android-atf", framework: v.framework, requestId: v.requestId,
    target: v.target, runtime: v.runtime, nodeCount: v.nodes.length, propertySupport: v.propertySupport,
    checks: v.checks.map((c) => ({ ruleId: c.ruleId, className: c.className, version: c.version, status: c.status,
      results: Object.fromEntries(["ERROR", "WARNING", "INFO", "NOT_RUN"].map((t) => [t, c.results.filter((r) => r.type === t).length])) })),
    unselected: ATF_UNSELECTED };
}

export function validateAtfSummary(s) {
  check(s?.status === "completed" && s.reportOnly === true && s.source === "android-atf" && UUID.test(s.requestId) &&
    string(s.target) && count(s.nodeCount) && s.nodeCount > 0 && s.nodeCount <= 500 &&
    equal(s.framework, { artifact: ATF_ARTIFACT, version: ATF_VERSION, suite: ATF_SUITE, origin: "ACCESSIBILITY_NODE_INFOS" }) &&
    count(s.runtime?.sdk) && s.runtime.sdk >= 26 && ["release", "fingerprint", "locale"].every((k) => string(s.runtime[k])) &&
    equal(s.propertySupport, { hintText: true, stateDescription: s.runtime.sdk >= 30, paneTitle: s.runtime.sdk >= 28, roleDescription: true }) &&
    equal(s.unselected, ATF_UNSELECTED), "summary provenance or scope");
  check(Array.isArray(s.checks) && s.checks.length === ATF_CHECKS.length, "summary missing native checks");
  for (const [i, c] of s.checks.entries()) check(c.ruleId === ATF_CHECKS[i].ruleId && c.className === ATF_CHECKS[i].className &&
    c.version === ATF_VERSION && c.status === "completed" && c.results &&
    equal(Object.keys(c.results).sort(), ["ERROR", "INFO", "NOT_RUN", "WARNING"]) && Object.values(c.results).every(count), "summary check execution");
  return s;
}
