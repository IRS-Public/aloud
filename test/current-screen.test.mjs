import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), "aloud-current-screen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls.jsonl");
  const logcat = join(dir, "logcat.txt");
  writeFileSync(calls, "");
  writeFileSync(logcat, "stale speech from another run\n");
  const device = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify([command, ...args]) + '\\n');
const out = text => process.stdout.write(text);
if (command === 'xcrun') {
  const a = args.slice(1);
  if (a[0] === 'list') out(JSON.stringify({ devices: { runtime: [{ state: 'Booted', udid: 'sim-1' }] } }));
  else if (a[0] === 'ui' && a.length === 3) out('dark');
  else if (a[0] === 'io') fs.writeFileSync(a[3], 'image');
} else if (command === 'idb') {
  out(JSON.stringify([{ AXLabel: 'Checkout', type: 'Button', AXFrame: '{{0, 0}, {100, 50}}' }]));
} else if (command === 'adb') {
  if (args[0] === 'logcat') {
    if (args.includes('-c')) fs.writeFileSync(process.env.MOCK_LOGCAT, '');
    if (args.includes('-d')) out(fs.readFileSync(process.env.MOCK_LOGCAT, 'utf8'));
  } else if (args[0] === 'shell') {
    const a = args.slice(1);
    if (a[0] === 'getprop') out('1');
    else if (a[0] === 'cmd' && a.length === 3) out('Night mode: yes');
    else if (a[0] === 'log') fs.appendFileSync(process.env.MOCK_LOGCAT, 'I/A11Y_AUDIT: ' + a.at(-1) + '\\n');
    else if (a[0] === 'pm') out('package:com.android.talkback\\npackage:com.google.android.tts');
    else if (a[0] === 'stat') out('10001');
    else if (a[0] === 'dumpsys') out('com.google.android.marvin.talkback.TalkBackService');
    else if (a[0] === 'settings' && a[1] === 'put' && a[3] === 'accessibility_enabled' && a[4] === '1') {
      fs.appendFileSync(process.env.MOCK_LOGCAT, 'V/talkback: SpeechControllerImpl: Speaking fragment text="Checkout", utteranceId=talkback_1, TtsSpan=none\\n');
    }
  }
}
`;
  for (const cmd of ["xcrun", "idb", "adb", "sleep"]) {
    writeFileSync(join(bin, cmd), device);
    chmodSync(join(bin, cmd), 0o755);
  }
  const config = join(dir, "config.json");
  const out = join(dir, "report");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ADB_PATH: join(bin, "adb"),
    ANDROID_HOME: join(dir, "sdk"),
    ANDROID_SDK_ROOT: join(dir, "sdk"),
    ALOUD_CONFIG: config,
    ALOUD_HOME: ROOT,
    MOCK_CALLS: calls,
    MOCK_LOGCAT: logcat,
  };
  const configure = (nav = { mode: "current-screen" }) => writeFileSync(config, JSON.stringify({
    app: { android: { package: "com.example.app" }, ios: { bundleId: "com.example.app" } },
    nav,
    out,
  }));
  configure();
  return {
    dir, out, env, configure,
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
    run: (script, args = []) => spawnSync(process.execPath, [join(ROOT, script), ...args], { env, encoding: "utf8", timeout: 25000 }),
  };
}

test("iOS current-screen preserves the running screen and dark appearance", (t) => {
  const r = rig(t);
  const result = r.run("src/ios/walk.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!r.calls().some(c => c[0] === "xcrun" && ["terminate", "launch"].includes(c[2])), "must not restart the selected screen");
  assert.ok(!r.calls().some(c => c[0] === "xcrun" && c[2] === "ui" && c.length === 6), "must not change appearance");
  const transcript = JSON.parse(readFileSync(join(r.out, "ios", "current.transcript.json"), "utf8"));
  assert.ok(transcript.transcript.some(s => s.includes("Checkout")));
});

test("iOS deep links still cold-start and honor explicit light appearance", (t) => {
  const r = rig(t);
  const manifest = join(r.dir, "screens.json");
  writeFileSync(manifest, JSON.stringify([{ id: "checkout", screens: [{ id: "checkout", url: "example://checkout", dark: false, settleMs: 0 }] }]));
  r.configure({ mode: "deeplinks", screens: manifest });
  const result = r.run("src/ios/walk.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(r.calls().some(c => c[2] === "terminate"));
  assert.ok(r.calls().some(c => c[2] === "launch"));
  assert.ok(r.calls().some(c => c[2] === "openurl" && c.at(-1) === "example://checkout"));
  assert.deepEqual(r.calls().filter(c => c[2] === "ui" && c.length === 6).map(c => c.at(-1)), ["light", "dark"]);
});

test("Android current-screen brackets TalkBack startup speech without changing the app or appearance", (t) => {
  const r = rig(t);
  const result = spawnSync("bash", [join(ROOT, "src/android/run.sh"), "--pass", "transcript", "--no-gate"], {
    env: r.env, encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  const transcript = JSON.parse(readFileSync(join(r.out, "android", "current.transcript.json"), "utf8"));
  assert.deepEqual(transcript.transcript, ["Checkout"]);
  const calls = r.calls();
  assert.ok(!calls.some(c => c[0] === "adb" && c[1] === "shell" && c[2] === "am" && c.includes("com.example.app")), "must not restart the app");
  assert.ok(!calls.some(c => c[0] === "adb" && c[2] === "cmd" && c.length === 6), "must not change appearance");
  const clear = calls.findIndex(c => c[1] === "logcat" && c.includes("-c"));
  const start = calls.findIndex(c => c.at(-1) === "screen-start:current");
  const enable = calls.findIndex(c => c[2] === "settings" && c[3] === "put" && c[5] === "accessibility_enabled" && c[6] === "1");
  const end = calls.findIndex(c => c.at(-1) === "screen-end:current");
  assert.ok(clear >= 0 && clear < start && start < enable && enable < end, "capture must start before TalkBack speaks");
  assert.equal(calls.filter(c => c[2] === "settings" && c[3] === "put" && c[5] === "accessibility_enabled" && c[6] === "1").length, 1, "enable TalkBack once");
});


test("iOS current-screen launches an explicitly installed build before capture", (t) => {
  const r = rig(t);
  const app = join(r.dir, "Example.app");
  const result = spawnSync("bash", [join(ROOT, "src/ios/run.sh"), "--app", app, "--no-gate"], {
    env: r.env, encoding: "utf8", timeout: 25000,
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = r.calls();
  const install = calls.findIndex(c => c[2] === "install" && c.at(-1) === app);
  const launch = calls.findIndex(c => c[2] === "launch" && c.at(-1) === "com.example.app");
  const capture = calls.findIndex(c => c[0] === "idb");
  assert.ok(install >= 0 && install < launch && launch < capture, "the installed app must open before capture");
  assert.equal(calls.filter(c => c[2] === "launch").length, 1);
  assert.ok(!calls.some(c => c[2] === "terminate"));
});

test("Android current-screen launches an explicitly installed APK before speech capture", (t) => {
  const r = rig(t);
  const apk = join(r.dir, "example.apk");
  const result = spawnSync("bash", [join(ROOT, "src/android/run.sh"), "--apk", apk, "--pass", "transcript", "--no-gate"], {
    env: r.env, encoding: "utf8", timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = r.calls();
  const install = calls.findIndex(c => c[0] === "adb" && c[1] === "install" && c.at(-1) === apk);
  const launch = calls.findIndex(c => c[2] === "am" && c[3] === "start" && c.at(-1) === "com.example.app/.MainActivity");
  const capture = calls.findIndex(c => c.at(-1) === "screen-start:current");
  assert.ok(install >= 0 && install < launch && launch < capture, "the installed app must open before capture");
  assert.deepEqual(JSON.parse(readFileSync(join(r.out, "android", "current.transcript.json"), "utf8")).transcript, ["Checkout"]);
});
