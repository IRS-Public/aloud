import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_PACKAGE = "com.example.app";
const frame = { x: 0, y: 0, width: 200, height: 100 };
const iosButton = { type: "Button", AXLabel: "Continue", enabled: true, frame };
const androidButton = (extra = "", packageName = APP_PACKAGE) =>
  `<node package="${packageName}" class="android.widget.Button" text="Continue" ` +
  `clickable="true" focusable="true" enabled="true" bounds="[0,0][200,100]" ${extra}/>`;
const hierarchy = (content) => `<?xml version="1.0"?><hierarchy rotation="0">${content}</hierarchy>`;

// Exercise the production entry points and file writes. Only device commands
// are fake; navigation, capture retries, parsers, and rules remain real.
const DEVICE_MOCK = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
const root = process.env.ALOUD_MOCK_ROOT;
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ command, args }) + "\\n");
const fixtures = JSON.parse(fs.readFileSync(path.join(root, "dumps.json"), "utf8"));
function dump() {
  const counter = path.join(root, "count");
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(count + 1));
  process.stdout.write(fixtures[Math.min(count, fixtures.length - 1)]);
}
if (command === "idb" && args.join(" ") === "ui describe-all --udid test-device") {
  dump();
} else if (command === "xcrun") {
  if (args.join(" ") === "simctl list devices booted -j") {
    console.log(JSON.stringify({ devices: { test: [{ state: "Booted", udid: "test-device" }] } }));
  } else if (args.join(" ") === "simctl ui test-device appearance") {
    console.log("light");
  } else if (args[1] === "io" && args[3] === "screenshot") {
    fs.writeFileSync(args[4], "mock screenshot");
  } else if (!["terminate", "launch", "openurl", "ui"].includes(args[1])) {
    throw Error("unexpected simctl call: " + args.join(" "));
  }
} else if (command === "adb") {
  const text = args.join(" ");
  if (text === "shell getprop sys.boot_completed") console.log("1");
  else if (text === "shell wm density") console.log("Physical density: 160");
  else if (text === "shell cmd uimode night") console.log("Night mode: no");
  else if (text === "shell cat /sdcard/a11y-dump.xml") dump();
  else if (args[0] === "pull") fs.writeFileSync(args[2], "mock screenshot");
  else if (!(text === "wait-for-device" || /^(shell (am|uiautomator|rm|screencap|cmd) )/.test(text))) {
    throw Error("unexpected adb call: " + text);
  }
} else if (command === "xcodegen") {
  console.log("generated mock project");
} else if (command === "xcodebuild") {
  if (args[0] === "test-without-building") {
    if (process.env.ALOUD_MOCK_NATIVE_FAILURE) throw Error("native audit unavailable");
    const requestId = process.env.TEST_RUNNER_ALOUD_AUDIT_REQUEST_ID;
    const result = {
      schemaVersion: 1, source: "apple-accessibility-audit", status: "completed", auditTypes: "all",
      requestId, screen: process.env.TEST_RUNNER_ALOUD_AUDIT_SCREEN,
      bundleId: process.env.TEST_RUNNER_ALOUD_AUDIT_BUNDLE_ID,
      issues: [{ typeMask: "1", types: ["contrast"], compactDescription: "Low contrast",
        detailedDescription: "Check colors", element: null }],
    };
    console.log("ALOUD-APPLE-AUDIT:" + requestId + ":" + Buffer.from(JSON.stringify(result)).toString("base64"));
  }
} else {
  throw Error("unexpected device command: " + command + " " + args.join(" "));
}
`;

async function capture(t, platform, dumps, { appleAudit = false, nativeFailure = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aloud-capture-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const out = join(root, platform);
  mkdirSync(bin);
  for (const command of ["adb", "idb", "xcrun", "xcodegen", "xcodebuild"]) {
    writeFileSync(join(bin, command), DEVICE_MOCK, { mode: 0o755 });
  }
  writeFileSync(join(root, "dumps.json"), JSON.stringify(dumps));
  const screens = join(root, "screens.json");
  writeFileSync(screens, JSON.stringify([
    { id: "flow", screens: [{ id: "capture", url: "example://capture", settleMs: 0 }] },
  ]));
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({
    out: root,
    app: { android: { package: APP_PACKAGE }, ios: { bundleId: APP_PACKAGE } },
    ios: { appleAudit },
    nav: { mode: "deeplinks", screens },
  }));
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "src", platform, "walk.mjs"), "--pass", "tree"], {
      env: {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        ADB_PATH: join(bin, "adb"),
        ALOUD_CONFIG: config,
        ALOUD_MOCK_ROOT: root,
        ALOUD_MOCK_NATIVE_FAILURE: nativeFailure ? "1" : "",
      },
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
  });
  assert.equal(result.signal, null, `walker timed out: ${result.stderr}`);
  return { ...result, root, out };
}

function assertCaptureFailed(result, detail) {
  assert.notEqual(result.status, 0, `capture unexpectedly passed: ${result.stdout}`);
  assert.match(result.stderr, /screen "capture".*accessibility capture failed/i);
  if (detail) assert.match(result.stderr, detail);
  assert.equal(existsSync(join(result.out, "capture.tree.json")), false);
  assert.equal(existsSync(join(result.out, "capture.transcript.json")), false);
  assert.equal(existsSync(join(result.out, "shots", "capture.png")), false);
  assert.doesNotMatch(result.stdout, /✓ capture/);
}

function assertCapturePassed(result, errors = 0) {
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(join(result.out, "capture.tree.json"), "utf8"));
  assert.equal(report.gate.errors, errors);
  assert.equal(existsSync(join(result.out, "shots", "capture.png")), true);
}

describe("iOS capture validation", { concurrency: 4 }, () => {
  it("attaches native findings to the selected screen while retaining computed speech and tree counts", async (t) => {
    const result = await capture(t, "ios", [JSON.stringify([iosButton])], { appleAudit: true });
    assertCapturePassed(result);
    const tree = JSON.parse(readFileSync(join(result.out, "capture.tree.json")));
    assert.equal(tree.appleAudit.screen, "capture");
    assert.equal(tree.appleAudit.issues.length, 1);
    assert.deepEqual(tree.gate, { errors: 0, ruleIds: [] });
    const transcript = JSON.parse(readFileSync(join(result.out, "capture.transcript.json")));
    assert.equal(transcript.source, "computed-voiceover");
    const calls = readFileSync(join(result.root, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const navigation = calls.findIndex((c) => c.args.includes("openurl"));
    const shot = calls.findIndex((c) => c.args.includes("screenshot"));
    const native = calls.findIndex((c) => c.args.includes("test-without-building"));
    assert.ok(navigation < shot && shot < native, "native audit must run on the navigated screen after tree evidence");
  });

  it("does not write passing screen artifacts when a requested native audit fails", async (t) => {
    const result = await capture(t, "ios", [JSON.stringify([iosButton])], { appleAudit: true, nativeFailure: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Apple audit xcodebuild failed/);
    assert.equal(existsSync(join(result.out, "capture.tree.json")), false);
    assert.equal(existsSync(join(result.out, "capture.transcript.json")), false);
    assert.doesNotMatch(result.stdout, /✓ capture/);
  });

  it("rejects a screen that changes when XCTest backgrounds and reactivates the app", async (t) => {
    const before = JSON.stringify([iosButton]);
    const after = JSON.stringify([{ ...iosButton, AXLabel: "Back to home" }]);
    const result = await capture(t, "ios", [before, before, after, after], { appleAudit: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /accessibility content changed during the Apple audit/);
    assert.equal(existsSync(join(result.out, "capture.tree.json")), false);
    assert.equal(existsSync(join(result.out, "capture.transcript.json")), false);
  });

  const invalid = [
    ["empty arrays", "[]"],
    ["empty command output", ""],
    ["container-only trees", JSON.stringify([
      { type: "Application", AXLabel: "Example app", frame },
      { type: "Group", frame },
    ])],
    ["malformed JSON", '[{"type":"Button"}'],
    ["non-element JSON", '[42, {}]'],
    ["zero-sized content", JSON.stringify([{ ...iosButton, frame: { ...frame, width: 0 } }])],
  ];
  for (const [name, dump] of invalid) {
    it(`rejects ${name} without writing passing artifacts`, async (t) => {
      assertCaptureFailed(await capture(t, "ios", [dump]));
    });
  }

  it("waits through repeated empty dumps before accepting realized content", async (t) => {
    const dump = JSON.stringify([iosButton]);
    const result = await capture(t, "ios", ["[]", "[]", dump, dump]);
    assertCapturePassed(result);
    assert.ok(Number(readFileSync(join(result.root, "count"), "utf8")) >= 4);
    const transcript = JSON.parse(readFileSync(join(result.out, "capture.transcript.json"), "utf8"));
    assert.deepEqual(transcript.transcript, ["Continue, button"]);
  });

  it("keeps newline-delimited captures and flags an unlabeled control", async (t) => {
    const dump = JSON.stringify({ ...iosButton, AXLabel: null }) + "\n" +
      JSON.stringify({ type: "StaticText", AXLabel: "Ready", frame });
    const result = await capture(t, "ios", [dump]);
    assertCapturePassed(result, 1);
    const transcript = JSON.parse(readFileSync(join(result.out, "capture.transcript.json"), "utf8"));
    assert.deepEqual(transcript.transcript, ["button", "Ready"]);
  });
});

describe("Android capture validation", { concurrency: 4 }, () => {
  const invalid = [
    ["empty output", ""],
    ["command errors returned as text", "ERROR: null root node returned by UiTestAutomationBridge"],
    ["empty hierarchies", hierarchy("")],
    ["foreign app trees", hierarchy(androidButton("", "com.android.launcher"))],
    ["container-only app trees", hierarchy(
      `<node package="${APP_PACKAGE}" class="android.widget.FrameLayout" bounds="[0,0][400,800]"/>`,
    )],
    ["truncated hierarchies containing a valid app node", `<hierarchy>${androidButton()}`],
    ["unbalanced node tags", hierarchy(`<node>${androidButton()}`)],
    ["malformed node attributes", hierarchy(androidButton("broken-attribute"))],
  ];
  for (const [name, dump] of invalid) {
    it(`rejects ${name} without writing passing artifacts`, async (t) => {
      assertCaptureFailed(await capture(t, "android", [dump]));
    });
  }

  it("accepts target app content alongside system UI", async (t) => {
    const result = await capture(t, "android", [hierarchy(
      androidButton("", "com.android.systemui") + androidButton(),
    )]);
    assertCapturePassed(result);
  });

  it("keeps an unlabeled target-app control as audit evidence", async (t) => {
    const result = await capture(t, "android", [hierarchy(androidButton().replace('text="Continue"', 'text=""'))]);
    assertCapturePassed(result, 1);
  });
});
