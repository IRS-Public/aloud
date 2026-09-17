#!/usr/bin/env node
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TALKBACK_COMMIT = "229212fdf5842191d0a93fc95d9ca1423b346866";
const here = dirname(fileURLToPath(import.meta.url));
export function patchAtf(root) {
  const build = join(root, "talkback/build.gradle");
  const text = readFileSync(build, "utf8");
  if (text.split("dependencies {").length !== 2) throw new Error("TalkBack ATF dependency pin mismatch");
  writeFileSync(build, text.replace("dependencies {", `dependencies {
    implementation('com.google.android.apps.common.testing.accessibility.framework:accessibility-test-framework:4.1.1') {
        // Only node-hierarchy checks run here. Do not package instrumentation services or Espresso.
        exclude group: 'androidx.test'
        exclude group: 'androidx.test.espresso'
        exclude group: 'androidx.test.services'
    }`));
  copyFileSync(join(here, "AloudAtf.java"), join(root,
    "talkback/src/main/java/com/google/android/accessibility/talkback/AloudAtf.java"));
}
export function patchLoggingTts(root) {
  const source = join(root, "utils/src/main/java/com/google/android/accessibility/utils/output/FailoverTextToSpeech.java");
  let text = readFileSync(source, "utf8");
  const ledger = "org.irs_public.aloud.tts.RequestLedger";
  function replace(before, after, expected = 1) {
    if (text.split(before).length - 1 !== expected) throw new Error(`TalkBack TTS pin mismatch: ${before}`);
    text = text.replaceAll(before, after);
  }
  replace("    this.context = context;", `    this.context = context;\n    ${ledger}.initialize(context);`);
  replace("tts.speak(", `${ledger}.speak(tts, `, 9);
  for (const [method, event] of [["onStart", "start"], ["onDone", "done"], ["onError", "error"]]) {
    const signature = `    public void ${method}(String utteranceId) {`;
    replace(signature, `${signature}\n      utteranceId = ${ledger}.progress("${event}", utteranceId, false);`);
  }
  replace("    public void onStop(String utteranceId, boolean interrupted) {",
    `    public void onStop(String utteranceId, boolean interrupted) {\n      utteranceId = ${ledger}.progress("stop", utteranceId, interrupted);`);
  for (const signature of ["    public void onAudioAvailable(String utteranceId, byte[] audio) {",
    "    public void onRangeStart(String utteranceId, int start, int end, int frame) {"]) {
    replace(signature, `${signature}\n      utteranceId = ${ledger}.originalId(utteranceId);`);
  }
  writeFileSync(source, text);
  const manifest = join(root, "talkback/src/main/AndroidManifest.xml");
  const xml = readFileSync(manifest, "utf8");
  if (xml.includes("<queries>") || xml.split("</manifest>").length !== 2) throw new Error("TalkBack manifest pin mismatch");
  writeFileSync(manifest, xml.replace("</manifest>",
    '<queries><intent><action android:name="android.intent.action.TTS_SERVICE"/></intent></queries>\n</manifest>'));
  const target = join(root, "utils/src/main/java/org/irs_public/aloud/tts");
  mkdirSync(target, { recursive: true });
  for (const file of ["Journal.java", "RequestLedger.java"]) {
    copyFileSync(join(here, "../tts-shared/src/main/java/org/irs_public/aloud/tts", file), join(target, file));
  }
}
export function patchCompanion(root, { noNative = false } = {}) {
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
  replace(focus, "    isWindowNavigationSupported = !FormFactorUtils.isAndroidTv();",
    `    isWindowNavigationSupported = !FormFactorUtils.isAndroidTv();\n    ${bridge}.setScrollPending(() -> scrollCallback != null);`);
  replace(focus, "return NavigationResult.create(NavigationResult.Type.REACH_EDGE);", `${bridge}.signal("edge");\n      return NavigationResult.create(NavigationResult.Type.REACH_EDGE);`, 2);
  replace(focus, "    if (reachEdge && navigationAction.shouldWrap && navigationResult.isEmpty()) {", `    if (reachEdge && navigationAction.shouldWrap && navigationResult.isEmpty()) {\n      ${bridge}.signal("wrap");`);
  replace(focus, "      final AutoScrollCallback autoScrollCallback = scrollCallback;", `      ${bridge}.signal("scroll-complete");\n      final AutoScrollCallback autoScrollCallback = scrollCallback;`);
  replace(focus, "      scrollCallback.onAutoScrollFailed(scrolledNode);", `      ${bridge}.signal("scroll-failed");\n      scrollCallback.onAutoScrollFailed(scrolledNode);`);
  copyFileSync(join(here, "AloudBridge.java"), join(pkg, "AloudBridge.java"));
  patchLoggingTts(root);
  patchAtf(root);
  if (noNative) {
    const display = join(root, "braille/brailledisplay/src/phone/java/com/google/android/accessibility/braille/brailledisplay/BrailleDisplay.java");
    replace(display, "    this.brailleDisplayManager = new BrailleDisplayManager(accessibilityService, controller);",
      "    this.brailleDisplayManager = null; // Aloud emulator build has no braille native libraries.");
    replace(display, "  public void start() {", "  public void start() {\n    if (brailleDisplayManager == null) return;");
    replace(display, "  public void stop() {", "  public void stop() {\n    if (brailleDisplayManager == null) return;");
    for (const module of ["brltty", "translate"]) {
      replace(join(root, "braille", module, "build.gradle"),
        "    externalNativeBuild {\n        ndkBuild {\n            path file('src/phone/jni/Android.mk')\n        }\n    }\n", "");
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch.mjs <pinned-talkback-source>");
  patchCompanion(process.argv[2], { noNative: process.argv.includes("--no-native") });
}
