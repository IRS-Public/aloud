// External-app acceptance on a disposable iOS 27 simulator; not a device-free unit test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeElements, validateIosCapture } from "../../src/ios/tree.mjs";
const pin = JSON.parse(readFileSync(new URL("./wikipedia.json", import.meta.url))).ios;
const out = resolve(process.env.ALOUD_REAL_APP_OUT ?? "aloud-report/real-app-ios");
mkdirSync(out, { recursive: true });
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024, ...options });
const simctl = (...args) => run("xcrun", ["simctl", ...args]);
const toolchain = run("xcodebuild", ["-version"]);
assert.match(toolchain, /^Xcode 27\./m, "real VoiceOver validation requires Xcode 27");
const developerDirectory = process.env.DEVELOPER_DIR ?? run("xcode-select", ["-p"]).trim();
const directoryChannelHint = /release[ _-]?candidate/i.test(developerDirectory) ? "release-candidate"
  : /beta/i.test(developerDirectory + toolchain) ? "beta" : "unverified";
// Apple lists this same build as the September 14 release. A runner's directory
// can retain its RC name after that build ships; retain both pieces of evidence.
const releasedBuild = /^Xcode 27\.0$/m.test(toolchain) && /^Build version 27A266a$/m.test(toolchain);
const releaseChannel = releasedBuild ? "released" : directoryChannelHint;
const releaseReference = releasedBuild ? { url: "https://developer.apple.com/news/releases/", date: "2026-09-14", checked: "2026-09-17" } : null;
const available = JSON.parse(simctl("list", "devices", "available", "-j")).devices;
const device = Object.entries(available).filter(([runtime]) => /iOS-27/.test(runtime))
  .flatMap(([, list]) => list).find((d) => d.name.includes("iPhone") && d.isAvailable);
assert.ok(device, "an iOS 27 simulator is required");
assert.ok(process.env.ALOUD_WIKIPEDIA_APP, "set ALOUD_WIKIPEDIA_APP to the pinned simulator build");
assert.ok(process.env.ALOUD_WIKIPEDIA_SOURCE, "set ALOUD_WIKIPEDIA_SOURCE to the pinned checkout");
assert.equal(run("git", ["-C", process.env.ALOUD_WIKIPEDIA_SOURCE, "rev-parse", "HEAD"]).trim(), pin.revision);
writeFileSync(join(out, "source-build.diff"), run("git", ["-C", process.env.ALOUD_WIKIPEDIA_SOURCE, "diff", "HEAD"]));
const appBundle = (key) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(process.env.ALOUD_WIKIPEDIA_APP, "Info.plist")]).trim();
assert.equal(appBundle("CFBundleIdentifier"), pin.bundleId);
const appVersion = { version: appBundle("CFBundleShortVersionString"), build: appBundle("CFBundleVersion") };
if (device.state !== "Booted") simctl("boot", device.udid);
simctl("bootstatus", device.udid, "-b");
simctl("install", device.udid, process.env.ALOUD_WIKIPEDIA_APP);
const results = { app: { ...pin, ...appVersion }, toolchain: { version: toolchain, developerDirectory, directoryChannelHint, releaseChannel, releaseReference }, simulator: device, cases: {} };
writeFileSync(join(out, "provenance.json"), JSON.stringify(results, null, 2));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function elements(logPath) {
  const raw = run("idb", ["ui", "describe-all", "--udid", device.udid], { timeout: 30000 }).trim();
  if (logPath) writeFileSync(logPath, raw);
  const items = normalizeElements(raw.startsWith("[") ? JSON.parse(raw) : raw.split("\n").filter(Boolean).map(JSON.parse));
  validateIosCapture(items);
  return items;
}
async function tap(identifier, { byLabel = false } = {}) {
  const matches = elements().filter((el) => (byLabel ? el.label === identifier && el.role === "Button" : el.testID === identifier) && el.enabled && el.frame?.w > 0 && el.frame?.h > 0);
  assert.equal(matches.length, 1, `expected one Wikipedia control: ${identifier}`);
  const f = matches[0].frame;
  run("idb", ["ui", "tap", String(Math.round(f.x + f.w / 2)), String(Math.round(f.y + f.h / 2)), "--udid", device.udid]);
  await pause(2000);
}
function enableBridge() {
  for (const key of ["ApplicationAccessibilityEnabled", "AccessibilityEnabled"]) {
    simctl("spawn", device.udid, "defaults", "write", "com.apple.Accessibility", key, "-bool", "true");
  }
}
async function launch(root) {
  try { simctl("terminate", device.udid, pin.bundleId); } catch { /* not running */ }
  enableBridge();
  const output = simctl("launch", device.udid, pin.bundleId, "-DidShowOnboarding5.3", "NO", "-WMFEnableHomeTabForTesting", "NO", "-AppleLanguages", "(en)");
  writeFileSync(root + "-launch.log", output);
  const pid = Number(output.trim().match(/: (\d+)$/)?.[1]);
  assert.ok(pid > 0, "simctl did not return the Wikipedia PID");
  await pause(5000);
  process.kill(pid, 0); // Simulator app processes run on this host. Fail early if launch crashed.
  let lastError;
  // The first idb connection after boot can consume its 30-second read budget.
  // Retry readiness before capture, retaining every returned preparation tree.
  const deadline = Date.now() + 90000;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    process.kill(pid, 0);
    try {
      const before = elements(root + `-launch-tree-${attempt}.json`);
      assert.ok(before.some((el) => el.testID === "App Onboarding Next Button"), "Wikipedia did not reach the requested onboarding screen");
      return;
    } catch (error) {
      lastError = error;
      appendFileSync(root + "-readiness.log", `attempt ${attempt}: ${error.message}\n`);
    }
    await pause(500);
  }
  throw lastError;
}
function verifyResizeRejection(root, id, error) {
  assert.match(String(error.stderr), /accessibility content changed during the Apple audit/);
  const native = JSON.parse(readFileSync(join(root, `ios/apple-audit/${id}.json`)));
  assert.equal(native.status, "completed");
  assert.equal(native.bundleId, pin.bundleId);
  assert.equal(native.screen, id);
  const dir = join(root, "ios/capture-trees");
  const latest = (phase) => {
    const name = readdirSync(dir).filter((f) => f.startsWith(`${id}.${phase}.`)).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
    assert.ok(name, `missing ${phase} tree`);
    return normalizeElements(JSON.parse(readFileSync(join(dir, name)))).map(({ raw, ...el }) => el);
  };
  const before = latest("before"), after = latest("after-apple-audit");
  const skip = "App Onboarding Skip Button";
  const a = before.filter((el) => el.testID === skip), b = after.filter((el) => el.testID === skip);
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert.notDeepEqual(a[0].frame, b[0].frame, "expected the observed Skip button resize");
  const withoutSkipFrame = (els) => els.map((el) => el.testID === skip ? { ...el, frame: null } : el);
  assert.deepEqual(withoutSkipFrame(before), withoutSkipFrame(after), "unexpected content change beyond the known button resize");
  assert.throws(() => run(process.execPath, ["src/report/report.mjs", "--dir", join(root, "ios")]));
  return { status: "unsupported", reason: "Apple audit resized the Skip button; pairing rejected", before: a[0].frame, after: b[0].frame, rejectionVerified: true };
}
let failed = false;
try {
  // Keep the first rejected pairing distinct from a new capture of the changed,
  // post-audit state. Never relabel or overwrite that first capture as successful.
  const cases = [
    ...[1, 2].map((attempt) => ({ mode: "voiceover", id: `voiceover-onboarding-${attempt}`, expected: /Wikipedia|encyclopedia|language/i })),
    { mode: "apple", id: "apple-onboarding-initial", expectedResize: true, expected: /encyclopedia/i },
    { mode: "apple", id: "apple-onboarding-settled", launchFresh: false, requires: "apple-onboarding-initial", expected: /encyclopedia/i },
    { mode: "apple", id: "apple-exploration", launchFresh: false, requires: "apple-onboarding-settled", prepare: "next", expected: /New ways to explore|Places tab/i },
    { mode: "apple", id: "apple-saved-after-deeplink", launchFresh: false, requires: "apple-exploration", prepare: "skip", url: "wikipedia://saved", expected: /No saved pages yet|Saved articles|Reading lists/i },
  ];
  for (const { mode, id, prepare, url, expected, expectedResize, launchFresh = true, requires } of cases) {
    const root = join(out, id), config = root + ".json";
    try {
      console.log(`${id}: ${launchFresh ? "launching Wikipedia" : "preserving the prepared app state"}`);
      if (requires) assert.ok(["captured", "unsupported"].includes(results.cases[requires]?.status), `prerequisite ${requires} failed`);
      if (launchFresh) await launch(root);
      else enableBridge();
      if (prepare) await tap(prepare === "next" ? "App Onboarding Next Button" : "App Onboarding Skip Button");
      const nav = { mode: "current-screen", screenId: id };
      if (url) {
        // simctl openurl can leave a SpringBoard confirmation over the app.
        // Confirm it explicitly during preparation, before current-screen capture.
        // This does not establish unattended CLI deeplinks-mode compatibility.
        simctl("openurl", device.udid, url);
        await pause(2000);
        const opened = elements(root + "-open-url-tree.json");
        if (opened.some((el) => el.label === "Open in “Wikipedia”?")) await tap("Open", { byLabel: true });
        await pause(5000);
        assert.ok(elements(root + "-prepared-tree.json").some((el) => expected.test(el.label)), "deep link did not reach Saved after preparation");
      }
      writeFileSync(config, JSON.stringify({ out: root, app: { name: "Wikipedia", ios: { bundleId: pin.bundleId } }, nav, ios: { voiceOverMaxSteps: 10 } }));
      const log = run(process.execPath, ["bin/aloud.mjs", "ios", "--config", config, "--no-gate",
        ...(mode === "apple" ? ["--apple-audit"] : ["--voiceover", "real"])], { timeout: 600000 });
      writeFileSync(root + ".log", log);
      const summary = JSON.parse(readFileSync(join(root, "ios/summary.json")));
      assert.ok(summary.screens[id]);
      const speech = JSON.parse(readFileSync(join(root, `ios/${id}.transcript.json`)));
      assert.ok(speech.transcript.some((line) => expected.test(line)), "transcript must identify the requested screen");
      if (mode === "voiceover") {
        assert.equal(speech.source, "voiceover");
        assert.equal(speech.voiceOver.coverage.complete, false);
        assert.equal(speech.voiceOver.voiceOverRestored, true);
        results.cases[id] = { status: "captured", coverage: speech.voiceOver.coverage, utterances: speech.transcript.length };
      } else {
        const tree = JSON.parse(readFileSync(join(root, `ios/${id}.tree.json`)));
        assert.equal(tree.appleAudit.status, "completed");
        assert.equal(tree.appleAudit.bundleId, pin.bundleId);
        results.cases[id] = { status: "captured", issues: tree.appleAudit.issues.length };
      }
      if (url) results.cases[id].navigation = { mode: "current-screen", preparedUrl: url, confirmationHandledDuringSetup: true };
    } catch (error) {
      appendFileSync(root + ".log", `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.stack}`);
      results.cases[id] = { status: "failed", error: error.message };
      if (expectedResize) {
        try { results.cases[id] = verifyResizeRejection(root, id, error); }
        catch (verificationError) { appendFileSync(root + ".log", `\n${verificationError.stack}`); }
      }
      if (results.cases[id].status === "failed") failed = true;
    }
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
    console.log(id, results.cases[id].status);
  }
} finally {
  simctl("shutdown", device.udid);
}
assert.equal(failed, false, "external iOS capture failed; inspect results and raw evidence");
