// Opt-in real speech evidence. XCUIVoiceOverService does not expose an end
// identity, so every bounded capture explicitly has partial coverage.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateScreenId } from "../screen-id.mjs";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "voiceover-native");
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.trim().length > 0;
const count = (v) => Number.isSafeInteger(v) && v >= 0;
export const VOICEOVER_STOP_REASONS = ["step-limit", "speech-timeout", "time-limit"];

export function validateVoiceOverCoverage(c) {
  if (!record(c) || c.complete !== false || c.start !== "current-focus" ||
      !VOICEOVER_STOP_REASONS.includes(c.reason) || !Number.isInteger(c.maxSteps) ||
      c.maxSteps < 1 || c.maxSteps > 100 || !count(c.elapsedMs)) {
    throw new Error("invalid VoiceOver partial-coverage metadata");
  }
}

export function parseVoiceOverCapture(log, expected) {
  const prefix = `ALOUD-VOICEOVER:${expected.requestId}:`;
  const lines = String(log).split(/\r?\n/).filter((line) => line.includes(prefix));
  if (lines.length !== 1) throw new Error("VoiceOver did not produce exactly one capture record");
  const payload = lines[0].slice(lines[0].indexOf(prefix) + prefix.length).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error("invalid VoiceOver payload");
  let result;
  try { result = JSON.parse(Buffer.from(payload, "base64").toString("utf8")); }
  catch { throw new Error("invalid VoiceOver JSON"); }
  return validateVoiceOverCapture(result, expected);
}

export function validateVoiceOverCapture(result, expected) {
  if (record(result) && result.schemaVersion === 1 && result.source === "voiceover" && result.status === "failed") {
    for (const key of ["requestId", "screen", "bundleId"]) {
      if (!text(expected[key]) || result[key] !== expected[key]) throw new Error(`VoiceOver failure ${key} does not match request`);
    }
    if (!record(result.error) || !text(result.error.code) || !text(result.error.message)) {
      throw new Error("invalid VoiceOver failure record");
    }
    throw new Error(`VoiceOver capture failed (${result.error.code}): ${result.error.message}`);
  }
  if (!record(result) || result.schemaVersion !== 1 || result.source !== "voiceover" ||
      result.status !== "captured" || !text(result.runtime) ||
      typeof result.voiceOverWasEnabled !== "boolean" || result.voiceOverRestored !== true) {
    throw new Error("invalid VoiceOver capture or unrestored service state");
  }
  for (const key of ["requestId", "screen", "bundleId"]) {
    if (!text(expected[key]) || result[key] !== expected[key]) {
      throw new Error(`VoiceOver ${key} does not match the requested capture`);
    }
  }
  validateVoiceOverCoverage(result.coverage);
  const { maxSteps, reason } = result.coverage;
  if (maxSteps !== expected.maxSteps) throw new Error("VoiceOver step budget does not match request");
  if (!Array.isArray(result.steps) || result.steps.length > maxSteps + 1) {
    throw new Error("invalid VoiceOver step records");
  }
  for (const [i, step] of result.steps.entries()) {
    if (!record(step) || step.sequence !== i || step.action !== (i === 0 ? "current" : "forward")) {
      throw new Error("VoiceOver step sequence is incomplete or out of order");
    }
    if (step.utterance === null) {
      if (reason !== "speech-timeout" || i !== result.steps.length - 1 || !record(step.error) ||
          !text(step.error.domain) || !Number.isInteger(step.error.code) || !text(step.error.description)) {
        throw new Error("invalid VoiceOver speech-timeout evidence");
      }
    } else if (typeof step.utterance !== "string" || step.error !== undefined) {
      throw new Error("invalid VoiceOver utterance");
    }
  }
  if ((reason === "step-limit" && result.steps.length !== maxSteps + 1) ||
      (reason === "speech-timeout" && result.steps.at(-1)?.utterance !== null) ||
      (reason === "time-limit" && (result.coverage.elapsedMs < 120_000 || result.steps.length > maxSteps))) {
    throw new Error("VoiceOver stopping reason contradicts captured steps");
  }
  return result;
}

// Comparison is opt-in and never modifies saved speech. NFC only reconciles
// canonically equivalent Unicode, preserving numbers, punctuation, case,
// whitespace, order and duplicates. No guessed trait-word rewriting.
export function normalizeVoiceOverForComparison(utterances, policy = "exact") {
  if (!Array.isArray(utterances) || !utterances.every((u) => typeof u === "string")) {
    throw new Error("comparison needs an array of utterance strings");
  }
  if (!["exact", "unicode-nfc-v1"].includes(policy)) throw new Error("unknown speech comparison policy");
  return utterances.map((u) => policy === "exact" ? u : u.normalize("NFC"));
}

export function createVoiceOverCapturer({ out, udid, bundleId, maxSteps = 20, run = execFileSync }) {
  if (!text(udid) || !text(bundleId)) throw new Error("VoiceOver needs a simulator UDID and app bundle ID");
  validateVoiceOverCoverage({ complete: false, start: "current-focus", reason: "step-limit", maxSteps, elapsedMs: 0 });
  const evidenceDir = resolve(out, "voiceover");
  const projectDir = join(evidenceDir, "harness");
  mkdirSync(evidenceDir, { recursive: true });
  cpSync(HARNESS, projectDir, { recursive: true });
  const command = (tool, args, name, env = {}) => {
    const logPath = join(evidenceDir, `${name}.log`);
    try {
      const output = String(run(tool, args, {
        cwd: projectDir, env: { ...process.env, ...env }, encoding: "utf8",
        stdio: "pipe", timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
      }) ?? "");
      writeFileSync(logPath, output);
      return output;
    } catch (err) {
      writeFileSync(logPath, `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message}`);
      throw new Error(`VoiceOver ${tool} failed — see ${logPath}`, { cause: err });
    }
  };
  const xcode = command("xcodebuild", ["-version"], "toolchain").trim();
  if (Number(xcode.match(/^Xcode (\d+)/m)?.[1] ?? 0) < 27) {
    throw new Error("real VoiceOver needs Xcode 27+ and an iOS 27+ simulator; select Xcode with DEVELOPER_DIR");
  }
  command("xcodegen", ["generate", "--spec", join(projectDir, "project.yml")], "generate");
  const buildArgs = [
    "-project", join(projectDir, "AloudVoiceOver.xcodeproj"), "-scheme", "AloudVoiceOver",
    "-destination", `platform=iOS Simulator,id=${udid}`,
    "-derivedDataPath", join(evidenceDir, "build"), "-parallel-testing-enabled", "NO",
    "CODE_SIGNING_ALLOWED=NO",
  ];
  console.log("── build real VoiceOver harness ──");
  command("xcodebuild", ["build-for-testing", ...buildArgs], "build");
  return {
    capture(screen) {
      validateScreenId(screen, "VoiceOver screen");
      const requestId = randomUUID();
      console.log(`    Real VoiceOver: ${screen} (bounded capture, partial traversal)`);
      const log = command("xcodebuild", [
        "test-without-building", ...buildArgs,
        "-only-testing:AloudVoiceOverUITests/VoiceOverTests/testCurrentScreen",
        "-resultBundlePath", join(evidenceDir, `${screen}.xcresult`),
      ], screen, {
        TEST_RUNNER_ALOUD_VO_REQUEST_ID: requestId,
        TEST_RUNNER_ALOUD_VO_SCREEN: screen,
        TEST_RUNNER_ALOUD_VO_BUNDLE_ID: bundleId,
        TEST_RUNNER_ALOUD_VO_MAX_STEPS: String(maxSteps),
      });
      const result = { ...parseVoiceOverCapture(log, { requestId, screen, bundleId, maxSteps }),
        toolchain: { xcode, simulatorUdid: udid } };
      writeFileSync(join(evidenceDir, `${screen}.json`), `${JSON.stringify(result, null, 2)}\n`);
      return result;
    },
  };
}
