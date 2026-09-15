#!/usr/bin/env node
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TALKBACK_COMMIT = "229212fdf5842191d0a93fc95d9ca1423b346866";
const here = dirname(fileURLToPath(import.meta.url));
export function patchCompanion(root) {
  const pkg = join(root, "talkback/src/main/java/com/google/android/accessibility/talkback");
  const bridge = "com.google.android.accessibility.talkback.AloudBridge";
  function replace(file, before, after, expected = 1) {
    const text = readFileSync(file, "utf8");
    if (text.split(before).length - 1 !== expected) throw new Error(`TalkBack pin mismatch at ${file}: ${before}`);
    writeFileSync(file, text.replaceAll(before, after));
  }
  const service = join(pkg, "TalkBackService.java");
  replace(service, "            processorPhoneticLetters);\n\n    audioPlaybackMonitor", "            processorPhoneticLetters);\n    AloudBridge.install(this);\n\n    audioPlaybackMonitor");
  replace(service, "  public void onDestroy() {", "  public void onDestroy() {\n    AloudBridge.destroy();");
  replace(service, "  public void onAccessibilityEvent(AccessibilityEvent event) {", "  public void onAccessibilityEvent(AccessibilityEvent event) {\n    AloudBridge.event(event);");
  const focus = join(pkg, "focusmanagement/FocusProcessorForLogicalNavigation.java");
  replace(focus, "return NavigationResult.create(NavigationResult.Type.REACH_EDGE);", `${bridge}.signal("edge");\n      return NavigationResult.create(NavigationResult.Type.REACH_EDGE);`, 2);
  replace(focus, "    if (reachEdge && navigationAction.shouldWrap && navigationResult.isEmpty()) {", `    if (reachEdge && navigationAction.shouldWrap && navigationResult.isEmpty()) {\n      ${bridge}.signal("wrap");`);
  replace(focus, "      final AutoScrollCallback autoScrollCallback = scrollCallback;", `      ${bridge}.signal("scroll-complete");\n      final AutoScrollCallback autoScrollCallback = scrollCallback;`);
  replace(focus, "      scrollCallback.onAutoScrollFailed(scrolledNode);", `      ${bridge}.signal("scroll-failed");\n      scrollCallback.onAutoScrollFailed(scrolledNode);`);
  copyFileSync(join(here, "AloudBridge.java"), join(pkg, "AloudBridge.java"));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch.mjs <pinned-talkback-source>");
  patchCompanion(process.argv[2]);
}
