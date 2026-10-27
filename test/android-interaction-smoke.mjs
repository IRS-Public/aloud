// Native acceptance: pinned companion + logging TTS + synthetic fixture on Android 14 userdebug.
// Spanish amounts are content; the emulator's English TalkBack state words stay independent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { adb, shell } from "../src/android/adb.mjs";
import { enable, findTalkBack } from "../src/android/talkback.mjs";
import { saveAccessibilityState, restoreAccessibilityState, TTS_KEYS } from "../src/android/accessibility-state.mjs";
import { createInteractionCapturer, validateInteractionTts } from "../src/android/talkback-interaction.mjs";

const out = resolve(process.env.ALOUD_INTERACTION_SMOKE_OUT ?? "aloud-report/interaction-smoke");
const target = "org.irs_public.aloud.fixture", results = { complete: false };
mkdirSync(out, { recursive: true });
const stateFile = join(out, "original-state.json");
const original = saveAccessibilityState(stateFile, findTalkBack(), { tts: true });
const settings = () => Object.fromEntries([...TTS_KEYS, "accessibility_enabled", "enabled_accessibility_services"]
  .map((key) => [key, shell("settings", "get", "secure", key)]));
const prefsPath = "/data/user_de/0/com.android.talkback/shared_prefs/com.android.talkback_preferences.xml";
const originalPrefs = original.files["com.android.talkback_preferences.xml"] ? shell("cat", prefsPath) : null;
const amounts = {
  en: ["1257 dollars and 93 cents", "1263 dollars and 14 cents", "1268 dollars and 37 cents"],
  es: ["1257 dólares con 93 centavos", "1263 dólares con 14 centavos", "1268 dólares con 37 centavos"],
};
function journey(language) {
  const [first, middle, last] = amounts[language];
  const move = (action, amount, checked) => ({ action, expect: {
    checkable: true, checked, speechIncludes: [amount, ...(checked ? ["checked"] : [])],
    ...(checked ? { speechExcludes: ["not checked"] } : {}),
  } });
  const activate = () => ({ action: "activate", expect: {
    checkable: true, checked: true, speechIncludes: ["checked"], speechExcludes: ["not checked"],
  } });
  return { id: `radio-${language}`, steps: [
    move("first", first, false), move("next", middle, false), move("next", last, false),
    move("first", first, false), activate(),
    move("next", middle, false), move("previous", first, true),
    move("next", middle, false), move("next", last, false), activate(),
    move("previous", middle, false), move("next", last, true),
    move("previous", middle, false), move("previous", first, false), activate(),
    move("next", middle, false), move("previous", first, true),
  ] };
}
async function launch(mode) {
  shell("am", "force-stop", target);
  shell("am", "start", "-W", "-n", `${target}/.MainActivity`, "--es", "mode", mode);
  await new Promise((resolve) => setTimeout(resolve, 3500));
}
const captureFile = (root, id) => join(root, "talkback-interaction", `${id}.json`);
const readCapture = (root, id) => JSON.parse(readFileSync(captureFile(root, id), "utf8"));
function assertReceipts(capture, root = out) {
  const accounting = validateInteractionTts(capture);
  assert.equal(accounting.complete, true);
  assert.ok(accounting.requests.length > 0, "silent capture must not pass amount assertions");
  assert.ok(accounting.requests.every((request) => request.result === 0 && ["done", "stop"].includes(request.terminal)));
  const directory = join(root, "tts-logging", accounting.clientSession);
  assert.ok(existsSync(join(directory, "client.jsonl")), "raw client journal must be retained");
  return { requests: accounting.requests.length, clientSession: accounting.clientSession, directory };
}
function assertRadioJourney(capture, scenario, root = out) {
  assert.equal(capture.observationComplete, true);
  assert.equal(capture.complete, true);
  const steps = capture.commands.filter((command) => command.action !== "hello");
  assert.deepEqual(steps.map((command) => command.action), scenario.steps.map((step) => step.action));
  const activations = steps.filter((command) => command.action === "activate");
  assert.equal(activations.length, 3, "select first, then last, then first again");
  for (const command of activations) {
    assert.equal(command.before.className, "android.widget.RadioButton");
    assert.equal(command.before.checked, false);
    assert.equal(command.after.checked, true);
    assert.equal(command.before.id, command.after.id, "activation must preserve accessibility focus");
    assert.equal(command.before.windowId, command.after.windowId);
    assert.ok(command.stateEvents.some((event) => event.source?.id === command.before.id),
      "capture must retain a state/click event from the activated radio");
  }
  assert.equal(activations[0].after.id, activations[2].after.id, "return to the same first radio");
  assert.notEqual(activations[0].after.id, activations[1].after.id, "other radio has distinct native identity");
  return assertReceipts(capture, root);
}
async function rejectScenario(scenario, mode = "radio-en") {
  await launch(mode);
  let error;
  try { await createInteractionCapturer({ out, target, loggingTts: true })(scenario); }
  catch (failure) { error = failure; }
  assert.ok(error, `${scenario.id}: incorrect expectations must fail`);
  const capture = readCapture(out, scenario.id);
  assert.equal(capture.observationComplete, true, `${scenario.id}: must reach assertions, not fail setup`);
  assert.equal(capture.complete, false);
  assert.ok(capture.commands.length > 1);
  assert.ok(existsSync(join(out, "talkback-interaction", `${scenario.id}.commands.jsonl`)));
  assertReceipts(capture);
  results[scenario.id] = { rejected: true, message: error.message, commands: capture.commands.length };
  return capture;
}

try {
  results.deviceLocale = shell("getprop", "persist.sys.locale");
  enable({ tts: "logging", diagnosis: false });
  // Exercise the public CLI once as well as the reusable API; neither changes device setup.
  await launch("radio-en");
  const english = journey("en"), scenarioPath = join(out, "radio-en.scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(english, null, 2));
  const cliOut = join(out, "cli"), beforeCli = settings();
  let cliLog;
  try {
    cliLog = execFileSync(process.execPath, ["bin/aloud.mjs", "android-interaction", "--scenario", scenarioPath,
      "--package", target, "--out", cliOut, "--tts", "logging"], { timeout: 150000, stdio: "pipe" });
  } catch (error) {
    writeFileSync(join(out, "cli.log"), String(error.stdout ?? "") + String(error.stderr ?? ""));
    throw error;
  }
  writeFileSync(join(out, "cli.log"), cliLog);
  assert.deepEqual(settings(), beforeCli, "CLI must leave accessibility/TTS setup unchanged");
  results.english = assertRadioJourney(readCapture(cliOut, english.id), english, cliOut);

  await launch("radio-es");
  const spanish = journey("es");
  results.spanishContent = assertRadioJourney(
    await createInteractionCapturer({ out, target, loggingTts: true })(spanish), spanish);

  await rejectScenario({ id: "wrong-amount", steps: [
    { action: "first", expect: { checked: false, speechIncludes: ["9999 dollars and 99 cents"] } },
  ] });
  await rejectScenario({ id: "wrong-state", steps: [
    { action: "first", expect: { checked: true, speechIncludes: [amounts.en[0]] } },
  ] });
  const contrary = await rejectScenario({ id: "contrary-state-speech", steps: [
    { action: "first", expect: { checked: false, speechIncludes: [amounts.en[0]] } },
    { action: "activate", expect: { checked: true } },
    { action: "next", expect: { checked: false, speechIncludes: [amounts.en[1]] } },
    { action: "previous", expect: { checked: true, speechIncludes: [amounts.en[0], "checked"],
      speechExcludes: ["not checked"] } },
  ] }, "radio-contrary");
  assert.equal(contrary.commands.at(-1).after.checked, true);
  assert.ok(contrary.commands.at(-1).speech.some((utterance) => /not checked/i.test(utterance.text)),
    "contrary speech must actually be observed, not inferred from the node state");
  const unrelated = await rejectScenario({ id: "unrelated-event", steps: [
    { action: "first", expect: { checked: false, speechIncludes: [amounts.en[0]] } },
    { action: "activate", expect: { checked: true, speechIncludes: ["checked"] } },
  ] }, "radio-unrelated");
  const activation = unrelated.commands.at(-1);
  assert.equal(activation.action, "activate");
  assert.equal(activation.after.checked, false);
  assert.ok(activation.stateEvents.some((event) => event.source && event.source.id !== activation.before.id),
    "negative fixture must actually emit an unrelated node change");
  assert.ok(!activation.stateEvents.some((event) => event.type === "TYPE_VIEW_CLICKED" && event.source?.id === activation.before.id));
  results.complete = true;
} catch (error) {
  results.error = error.message;
  throw error;
} finally {
  try { writeFileSync(join(out, "logcat.txt"), adb(["logcat", "-d", "-v", "threadtime"])); }
  catch { /* Preserve the capture error if diagnostics are unavailable. */ }
  try {
    restoreAccessibilityState(stateFile);
    assert.deepEqual(settings(), { ...original.settings, ...original.ttsSettings });
    if (originalPrefs !== null) assert.equal(shell("cat", prefsPath), originalPrefs);
    results.originalStateRestored = true;
  } catch (error) {
    results.complete = false;
    results.cleanupError = error.message;
    throw error;
  } finally {
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  }
}
console.log("Radio interaction acceptance passed: native state, refocus speech, assertions and restoration");
