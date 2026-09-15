// Optional XCTest evidence alongside the idb tree checks. Apple findings
// are report-only until calibrated; an unsuccessful capture always fails.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateScreenId } from "../screen-id.mjs";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "apple-audit");
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim().length > 0;

export function parseAppleAudit(log, expected) {
  const prefix = `ALOUD-APPLE-AUDIT:${expected.requestId}:`;
  const matches = String(log).split(/\r?\n/).filter((line) => line.includes(prefix));
  if (matches.length !== 1) throw new Error("Apple audit did not produce exactly one completion record");
  const payload = matches[0].slice(matches[0].indexOf(prefix) + prefix.length).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error("invalid Apple audit payload");
  let result;
  try {
    result = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    throw new Error("invalid Apple audit JSON");
  }
  if (!isRecord(result) || result.schemaVersion !== 1 || result.status !== "completed" ||
      result.source !== "apple-accessibility-audit" || result.auditTypes !== "all") {
    throw new Error("Apple audit did not complete all requested checks");
  }
  for (const key of ["requestId", "screen", "bundleId"]) {
    if (!isText(expected[key]) || result[key] !== expected[key]) {
      throw new Error(`Apple audit ${key} does not match the requested capture`);
    }
  }
  if (!Array.isArray(result.issues)) throw new Error("Apple audit issues must be an array");
  for (const issue of result.issues) {
    if (!isRecord(issue) || !isText(issue.typeMask) || !/^\d+$/.test(issue.typeMask) ||
        !Array.isArray(issue.types) || !issue.types.length || !issue.types.every(isText) ||
        !isText(issue.compactDescription) || typeof issue.detailedDescription !== "string") {
      throw new Error("malformed Apple audit issue");
    }
    if (issue.element !== null) {
      const el = issue.element;
      if (!isRecord(el) || typeof el.label !== "string" || typeof el.identifier !== "string" ||
          !isRecord(el.frame) || !["x", "y", "width", "height"].every((k) => Number.isFinite(el.frame[k])) ||
          el.frame.width < 0 || el.frame.height < 0) throw new Error("malformed Apple audit element");
    }
  }
  return result;
}

export function createAppleAuditor({ out, udid, bundleId, run = execFileSync }) {
  if (!isText(udid) || !isText(bundleId)) throw new Error("Apple audit needs a simulator UDID and app bundle ID");
  const evidenceDir = resolve(out, "apple-audit");
  const projectDir = join(evidenceDir, "harness");
  mkdirSync(evidenceDir, { recursive: true });
  cpSync(HARNESS, projectDir, { recursive: true });
  const command = (tool, args, logPath, env = {}, timeout = 300_000) => {
    let output;
    try {
      output = run(tool, args, {
        cwd: projectDir, env: { ...process.env, ...env }, encoding: "utf8",
        stdio: "pipe", timeout, maxBuffer: 64 * 1024 * 1024,
      });
      writeFileSync(logPath, output ?? "");
    } catch (err) {
      writeFileSync(logPath, `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message}`);
      throw new Error(`Apple audit ${tool} failed — see ${logPath}`, { cause: err });
    }
    return String(output ?? "");
  };
  command("xcodegen", ["generate", "--spec", join(projectDir, "project.yml")], join(evidenceDir, "generate.log"));
  const buildArgs = [
    "-project", join(projectDir, "AloudAppleAudit.xcodeproj"), "-scheme", "AloudAppleAudit",
    "-destination", `platform=iOS Simulator,id=${udid}`,
    "-derivedDataPath", join(evidenceDir, "build"), "-parallel-testing-enabled", "NO",
    "CODE_SIGNING_ALLOWED=NO",
  ];
  console.log("── build Apple accessibility audit harness ──");
  command("xcodebuild", ["build-for-testing", ...buildArgs], join(evidenceDir, "build.log"));
  return {
    capture(screen) {
      validateScreenId(screen, "Apple audit screen");
      const requestId = randomUUID();
      console.log(`    Apple accessibility audit: ${screen}`);
      const log = command("xcodebuild", [
        "test-without-building", ...buildArgs,
        "-only-testing:AloudAppleAuditUITests/AppleAuditTests/testCurrentScreen",
        "-resultBundlePath", join(evidenceDir, `${screen}.xcresult`),
      ], join(evidenceDir, `${screen}.log`), {
        TEST_RUNNER_ALOUD_AUDIT_REQUEST_ID: requestId,
        TEST_RUNNER_ALOUD_AUDIT_SCREEN: screen,
        TEST_RUNNER_ALOUD_AUDIT_BUNDLE_ID: bundleId,
      });
      const result = parseAppleAudit(log, { requestId, screen, bundleId });
      writeFileSync(join(evidenceDir, `${screen}.json`), `${JSON.stringify(result, null, 2)}\n`);
      return result;
    },
  };
}
