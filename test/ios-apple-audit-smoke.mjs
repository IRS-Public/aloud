// Real simulator test, deliberately outside the device-free *.test.mjs suite.
// Needs Xcode, xcodegen, and an available iOS 17+ simulator.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAppleAuditor } from "../src/ios/apple-audit.mjs";

const out = resolve(process.env.ALOUD_SMOKE_OUT ?? "aloud-report/apple-smoke");
mkdirSync(out, { recursive: true });
const sh = (tool, args) => execFileSync(tool, args, { encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
const simctl = (...args) => sh("xcrun", ["simctl", ...args]);
const devices = Object.values(JSON.parse(simctl("list", "devices", "available", "-j")).devices).flat();
const device = devices.find((d) => d.name.includes("iPhone") && d.isAvailable);
assert.ok(device, "install an iPhone simulator runtime first");
if (device.state !== "Booted") simctl("boot", device.udid);
simctl("bootstatus", device.udid, "-b");
const bundleId = "org.aloud.audit.AuditFixture";
const auditor = createAppleAuditor({ out, udid: device.udid, bundleId });
const buildDir = join(out, "apple-audit", "build");
sh("xcodebuild", [
  "build", "-project", join(out, "apple-audit/harness/AloudAppleAudit.xcodeproj"),
  "-scheme", "AloudAppleAuditFixture", "-destination", `platform=iOS Simulator,id=${device.udid}`,
  "-derivedDataPath", buildDir, "CODE_SIGNING_ALLOWED=NO",
]);
simctl("install", device.udid, join(buildDir, "Build/Products/Debug-iphonesimulator/AuditFixture.app"));
simctl("launch", device.udid, bundleId);
const result = auditor.capture("fixture");
assert.equal(result.status, "completed");
assert.equal(result.bundleId, bundleId);
assert.ok(result.issues.some((issue) => issue.types.includes("hitRegion")), "must capture the intentional tiny-target finding");
// Stopping the target must not cause the harness to launch it or substitute
// its own host. The failed capture must not produce completed evidence.
simctl("terminate", device.udid, bundleId);
assert.throws(() => auditor.capture("stopped-target"), /Apple audit xcodebuild failed/);
console.log(`Apple simulator smoke passed: ${result.issues.length} issue(s), unavailable target rejected.`);
