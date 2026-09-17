// External-app acceptance on a disposable iOS 27 simulator; not a device-free unit test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const pin = JSON.parse(readFileSync(new URL("./wikipedia.json", import.meta.url))).ios;
const out = resolve(process.env.ALOUD_REAL_APP_OUT ?? "aloud-report/real-app-ios");
mkdirSync(out, { recursive: true });
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024, ...options });
const simctl = (...args) => run("xcrun", ["simctl", ...args]);
const toolchain = run("xcodebuild", ["-version"]);
assert.match(toolchain, /^Xcode 27\./m, "real VoiceOver validation requires Xcode 27");
const developerDirectory = process.env.DEVELOPER_DIR ?? run("xcode-select", ["-p"]).trim();
const releaseChannel = /release[ _-]?candidate/i.test(developerDirectory) ? "release-candidate"
  : /beta/i.test(developerDirectory + toolchain) ? "beta" : "unverified";
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
const results = { app: { ...pin, ...appVersion }, toolchain: { version: toolchain, developerDirectory, releaseChannel }, simulator: device, cases: {} };
writeFileSync(join(out, "provenance.json"), JSON.stringify(results, null, 2));
async function launch(root) {
  try { simctl("terminate", device.udid, pin.bundleId); } catch { /* not running */ }
  const output = simctl("launch", device.udid, pin.bundleId, "-DidShowOnboarding5.3", "NO", "-WMFEnableHomeTabForTesting", "NO", "-AppleLanguages", "(en)");
  writeFileSync(root + "-launch.log", output);
  const pid = Number(output.trim().match(/: (\d+)$/)?.[1]);
  assert.ok(pid > 0, "simctl did not return the Wikipedia PID");
  await new Promise((r) => setTimeout(r, 5000));
  process.kill(pid, 0); // Simulator app processes run on this host. Fail early if launch crashed.
}
let failed = false;
try {
  // Capture the same external screen twice. Each invocation exercises harness background/foreground transitions.
  for (const mode of ["apple", "voiceover"]) for (let attempt = 1; attempt <= 2; attempt++) {
    const id = `${mode}-onboarding-${attempt}`, root = join(out, id), config = root + ".json";
    writeFileSync(config, JSON.stringify({ out: root, app: { name: "Wikipedia", ios: { bundleId: pin.bundleId } },
      nav: { mode: "current-screen", screenId: id }, ios: { voiceOverMaxSteps: 10 } }));
    try {
      console.log(`${id}: launching Wikipedia`);
      await launch(root);
      const log = run(process.execPath, ["bin/aloud.mjs", "ios", "--config", config, "--no-gate",
        ...(mode === "apple" ? ["--apple-audit"] : ["--voiceover", "real"])], { timeout: 600000 });
      writeFileSync(root + ".log", log);
      const summary = JSON.parse(readFileSync(join(root, "ios/summary.json")));
      assert.ok(summary.screens[id]);
      if (mode === "voiceover") {
        const speech = JSON.parse(readFileSync(join(root, `ios/${id}.transcript.json`)));
        assert.equal(speech.source, "voiceover");
        assert.equal(speech.voiceOver.coverage.complete, false);
        assert.equal(speech.voiceOver.voiceOverRestored, true);
        assert.ok(speech.transcript.some((line) => /Wikipedia|encyclopedia|language/i.test(line)), "speech must contain target content");
        results.cases[id] = { status: "captured", coverage: speech.voiceOver.coverage, utterances: speech.transcript.length };
      } else {
        const tree = JSON.parse(readFileSync(join(root, `ios/${id}.tree.json`)));
        assert.equal(tree.appleAudit.status, "completed");
        assert.equal(tree.appleAudit.bundleId, pin.bundleId);
        results.cases[id] = { status: "captured", issues: tree.appleAudit.issues.length };
      }
    } catch (error) {
      failed = true;
      appendFileSync(root + ".log", `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.stack}`);
      results.cases[id] = { status: "failed", error: error.message };
    }
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
    console.log(id, results.cases[id].status);
  }
} finally {
  simctl("shutdown", device.udid);
}
assert.equal(failed, false, "external iOS capture failed; inspect results and raw evidence");
