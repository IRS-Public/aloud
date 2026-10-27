import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assessReadiness, parseFocusedWindow, parseResumedActivity, waitForAndroidReady } from "../src/android/readiness.mjs";

// Synthetic Android 14 dumpsys shapes, not native acceptance receipts.
const target = "org.example.fixture";
const windowDump = ({ id = "abc123", title = `${target}/.MainActivity`, pkg = target, user = 0 } = {}) =>
  `WINDOW MANAGER WINDOWS (dumpsys window windows)\n  Window #0 Window{${id} u${user} ${title}}:\n    mDisplayId=0\n    mOwnerUid=10123 showForAllUsers=false package=${pkg} appop=NONE\n    mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION}\n    Requested w=400 h=800\n  mCurrentFocus=Window{${id} u${user} ${title}}\n`;
const activityDump = (pkg = target) => `    topResumedActivity=ActivityRecord{abc u0 ${pkg}/.MainActivity t10}\n    mResumedActivity: ActivityRecord{abc u0 ${pkg}/.MainActivity t10}\n`;
const values = (extra = {}) => ({ boot: "1", packages: "package:/system/framework/framework-res.apk", windows: windowDump(), activities: activityDump(), pid: "1234", ...extra });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function harness(t, override, options = {}) {
  const out = mkdtempSync(join(tmpdir(), "aloud-readiness-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  let time = 0;
  const calls = [];
  const runAdb = async (args, opts) => {
    calls.push({ args, opts }); time += 10;
    if (override) {
      const result = override(args, opts, { calls, time, advance: (ms) => { time += ms; } });
      if (result !== undefined) return result;
    }
    const key = args.join(" ");
    if (key === "shell getprop sys.boot_completed") return "1\n";
    if (key === "shell pm path android") return "package:/system/framework/framework-res.apk";
    if (key === "shell dumpsys window") return windowDump();
    if (key === "shell dumpsys activity activities") return activityDump();
    if (key === `shell pidof ${target}`) return "1234";
    if (key === "exec-out screencap -p") return png;
    if (key.startsWith("logcat")) return "Old ANR in com.android.systemui (historical context only)";
    return "diagnostic";
  };
  return { out, calls, run: () => waitForAndroidReady({ out, target, runAdb, timeoutMs: 6000, commandTimeoutMs: 1000,
    intervalMs: 100, now: () => time, sleep: async (ms) => { time += ms; }, ...options }), elapsed: () => time };
}

test("parses the focused window's ownership rather than a title or unrelated window", () => {
  const raw = windowDump({ title: "A custom dialog title" });
  assert.equal(parseFocusedWindow(raw).packageName, target);
  assert.equal(parseFocusedWindow(raw).title, "A custom dialog title");
  assert.deepEqual(parseResumedActivity(activityDump()), { id: "abc", user: 0, packageName: target, component: `${target}/.MainActivity`, taskId: 10 });
  const withOther = raw.replace("  mCurrentFocus=", "  Window #1 Window{def456 u0 Other}:\n    mOwnerUid=1000 showForAllUsers=false package=android appop=NONE\n  mCurrentFocus=");
  assert.equal(parseFocusedWindow(withOther).packageName, target);
});

test("only a CURRENT focused error dialog obstructs readiness", () => {
  for (const title of ["Application Not Responding: com.android.systemui", "Application Error: org.example.crashed"]) {
    const e = assessReadiness(values({ windows: windowDump({ title, pkg: "android" }) }), target);
    assert.equal(e.reason, "current-system-error-dialog");
    assert.equal(e.status, "not-ready");
  }
  const raw = windowDump() + "  mLastANR=Application Not Responding: com.android.systemui\n";
  assert.equal(assessReadiness(values({ windows: raw }), target).status, "ready");
  const staleWindow = raw.replace("  mCurrentFocus=", "  Window #1 Window{def456 u0 Application Not Responding: old.app}:\n    mOwnerUid=1000 showForAllUsers=false package=android appop=NONE\n  mCurrentFocus=");
  assert.equal(assessReadiness(values({ windows: staleWindow }), target).status, "ready");
});

test("unknown and ambiguous output never turns into ready", () => {
  for (const extra of [{ boot: undefined }, { boot: "vendor-complete" }, { packages: "Error: package service unavailable" },
    { windows: "mCurrentFocus=null" }, { windows: "unfamiliar dump" }, { windows: windowDump() + windowDump() },
    { windows: windowDump().replace("package=org.example.fixture", "unfamiliar=fixture") },
    { activities: activityDump() + activityDump("other.app") }, { activities: "none" }, { pid: "123 456" }, { pid: undefined }]) {
    assert.equal(assessReadiness(values(extra), target).status, "unknown", JSON.stringify(extra));
  }
});

test("foreign package, user and missing process are not-ready", () => {
  assert.equal(assessReadiness(values({ windows: windowDump({ pkg: "com.android.settings" }), activities: activityDump("com.android.settings") }), target).reason, "target-not-foreground");
  assert.equal(assessReadiness(values({ windows: windowDump({ pkg: "android" }) }), target).reason, "foreign-focused-window");
  assert.equal(assessReadiness(values({ windows: windowDump({ user: 10 }) }), target).reason, "foreign-focused-window");
  assert.equal(assessReadiness(values({ pid: "" }), target).status, "not-ready");
  assert.equal(assessReadiness(values({ boot: "0" }), target).status, "not-ready");
});

test("stable observations write raw evidence and do not collect a passing audit", async (t) => {
  const h = harness(t), e = await h.run();
  assert.equal(e.status, "ready"); assert.equal(e.reason, "stable-foreground-observed");
  assert.equal(e.observations.length, 2); assert.equal(e.complete, undefined);
  assert.equal(e.observations[1].targetPid, "1234");
  assert.equal(JSON.parse(readFileSync(join(h.out, "readiness.json"))).status, "ready");
  assert.ok(e.commands.every((c) => c.ok && c.file && c.timeoutMs <= 1000));
  assert.ok(!h.calls.some((c) => c.args.includes("uiautomator") || c.args.includes("input") || c.args.includes("force-stop")));
});

test("window or process changes restart stability observation", async (t) => {
  let reads = 0;
  const h = harness(t, (args) => {
    if (args.join(" ") === "shell dumpsys window") return windowDump({ id: ++reads === 1 ? "123abc" : "def456" });
  });
  const e = await h.run(); assert.equal(e.status, "ready"); assert.equal(e.observations.length, 3);
  let pids = 0;
  const p = harness(t, (args) => args.includes("pidof") ? `${++pids === 1 ? 123 : 456}` : undefined);
  assert.equal((await p.run()).observations.length, 3);
});

test("a current ANR fails early with screenshot and raw diagnostics, without dismissing it", async (t) => {
  const h = harness(t, (args) => args.join(" ") === "shell dumpsys window" ? windowDump({ title: "Application Not Responding: com.android.systemui", pkg: "android" }) : undefined);
  const e = await h.run();
  assert.equal(e.status, "not-ready"); assert.equal(e.reason, "current-system-error-dialog"); assert.equal(e.observations.length, 1);
  assert.ok(e.commands.some((c) => c.name === "failure-screen" && c.ok && c.file.endsWith(".png")));
  assert.ok(e.commands.some((c) => c.name === "failure-logcat"));
  assert.ok(h.calls.every(({ args }) => !args.includes("input") && !args.includes("force-stop")));
});

test("total budget caps every slow call and reserves bounded failure evidence", async (t) => {
  const h = harness(t, (_args, opts, clock) => {
    clock.advance(opts.timeout - 10);
    throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT", signal: "SIGKILL", stderr: "device stalled" });
  });
  const e = await h.run();
  assert.equal(e.status, "unknown"); assert.equal(h.elapsed(), 6000);
  assert.ok(e.commands.every((c) => !c.ok && c.timeoutMs <= 1000));
  assert.ok(e.commands.some((c) => c.timeoutMs < 1000));
  assert.ok(readdirSync(h.out).some((f) => f.endsWith(".error.txt")));
});

test("single good observation at deadline cannot pass and diagnostic failure does not hide it", async (t) => {
  let reads = 0;
  const h = harness(t, (args, _opts, clock) => {
    if (args.includes("pidof")) { reads++; clock.advance(4400); return "1234"; }
    if (args[0] === "exec-out") return "invalid PNG";
  });
  const e = await h.run();
  assert.equal(reads, 1); assert.equal(e.status, "unknown"); assert.equal(e.reason, "foreground-not-yet-stable");
  assert.ok(e.commands.some((c) => c.name === "failure-screen" && !c.ok));
});

test("boot mode has no app dependency; all entry arguments reject before adb", async (t) => {
  const h = harness(t, undefined, { target: undefined });
  assert.equal((await h.run()).status, "ready"); assert.ok(!h.calls.some((c) => c.args.includes("pidof")));
  for (const options of [{ target: "a;reboot" }, { timeoutMs: 0 }, { timeoutMs: 300001 }, { timeoutMs: NaN }, { commandTimeoutMs: 0 }, { intervalMs: 0 }]) {
    await assert.rejects(waitForAndroidReady({ out: h.out, runAdb: () => assert.fail("invalid input reached adb"), ...options }));
  }
});

test("standalone and public CLI help and errors need no device", () => {
  for (const prefix of [["src/android/readiness.mjs"], ["bin/aloud.mjs", "android-ready"]]) {
    const help = spawnSync(process.execPath, [...prefix, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /not an accessibility or speech pass/);
    const bad = spawnSync(process.execPath, [...prefix, "--timeout-mz", "123"], { encoding: "utf8" });
    assert.equal(bad.status, 1); assert.match(bad.stderr, /Unknown option/); assert.doesNotMatch(bad.stderr, /\n\s+at /);
    const missing = spawnSync(process.execPath, prefix, { encoding: "utf8" });
    assert.equal(missing.status, 1); assert.match(missing.stderr, /--out <dir> is required/);
  }
});

test("one-second CLI budget remains valid with default command limits", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "aloud-ready-short-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  let time = 0;
  const e = await waitForAndroidReady({ out, timeoutMs: 1000, now: () => time,
    runAdb: async (_args, opts) => { time += opts.timeout; throw new Error("unavailable"); }, sleep: async (ms) => { time += ms; } });
  assert.equal(e.status, "unknown"); assert.equal(e.elapsedMs, 1000);
  assert.ok(e.commands.every((c) => c.timeoutMs <= 1000));
});

test("AOSP full dump excludes the entire saved last-ANR snapshot before current sections", () => {
  const historicalWindow = windowDump({ id: "dead123", title: "Application Not Responding: com.android.systemui", pkg: "android" });
  const focus = (dump) => dump.match(/^  mCurrentFocus=.*$/m)[0];
  const blocks = (dump) => dump.replace(/^WINDOW MANAGER WINDOWS.*\n/m, "").replace(/^  mCurrentFocus=.*\n/m, "");
  const full = (current) => `WINDOW MANAGER LAST ANR (dumpsys window lastanr)
  ANR time: synthetic previous snapshot
${blocks(historicalWindow)}
Last ANR continued
WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
${focus(historicalWindow)}
WINDOW MANAGER POLICY STATE (dumpsys window policy)
WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
${focus(current)}
WINDOW MANAGER WINDOWS (dumpsys window windows)
${blocks(current)}`;
  assert.equal(assessReadiness(values({ windows: full(windowDump()) }), target).status, "ready");
  assert.equal(assessReadiness(values({ windows: full(windowDump()).replaceAll("\n", "\r\n") }), target).status, "ready");
  const currentError = windowDump({ id: "bad123", title: "Application Not Responding: com.android.systemui", pkg: "android" });
  assert.equal(assessReadiness(values({ windows: full(currentError) }), target).reason, "current-system-error-dialog");
  const truncated = full(windowDump()).split("WINDOW MANAGER POLICY STATE")[0];
  assert.equal(parseFocusedWindow(truncated), null, "a history-only dump cannot describe current state");
  assert.equal(parseFocusedWindow(full(windowDump()).replace("WINDOW MANAGER POLICY STATE", "UNRECOGNIZED POLICY STATE")), null);
});

test("resumed aliases must identify the same ActivityRecord and task, not just component", () => {
  assert.ok(parseResumedActivity(activityDump()));
  assert.equal(parseResumedActivity(activityDump().replace("mResumedActivity: ActivityRecord{abc", "mResumedActivity: ActivityRecord{def")), null);
  assert.equal(parseResumedActivity(activityDump().replace(/t10}\n$/, "t20}\n")), null);
  assert.equal(parseResumedActivity(activityDump().replaceAll(" t10", "")), null);
});
