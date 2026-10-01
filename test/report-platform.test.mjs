import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { configBaselineFor, isIosReportDir, platformForReportDir } from "../src/report/platform.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "aloud-report-platform-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("report dir platform", () => {
  it("treats only a dir named ios or ending in -ios as iOS", () => {
    for (const dir of ["ios", "ios/", "ios//", "ios/.", "out/ios/.", "out/ios/./", "out/ios", "/abs/out/ios/", "my-ios", "out/shop-ios/", "out/ios/android/.."]) {
      assert.equal(isIosReportDir(dir), true, dir);
      assert.equal(platformForReportDir(dir), "ios", dir);
    }
    for (const dir of ["android", "android/", "out/android", "radios", "out/radios/", "ios-archive/android", "iosx", "myios", "/"]) {
      assert.equal(isIosReportDir(dir), false, dir);
      assert.equal(platformForReportDir(dir), "android", dir);
    }
  });

  it("resolves . and .. against the working dir, as the aloud command does", (t) => {
    const root = tempDir(t);
    const ios = join(root, "ios");
    mkdirSync(join(ios, "screens"), { recursive: true });
    const probe = `import { platformForReportDir as p } from ${JSON.stringify(join(ROOT, "src/report/platform.mjs"))};
console.log([p("."), p("./"), p("screens/.."), p("..")].join(","));`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: ios, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "ios,ios,ios,android");
  });

  it("detects web evidence from dir contents, whatever the name", (t) => {
    const root = tempDir(t);
    const byRun = join(root, "ios");
    mkdirSync(byRun);
    writeFileSync(join(byRun, "web-run.json"), "{}");
    assert.equal(platformForReportDir(byRun), "web");
    assert.equal(platformForReportDir(`${byRun}/`), "web");
    const byScreen = join(root, "web");
    mkdirSync(byScreen);
    writeFileSync(join(byScreen, "home.web.json"), "{}");
    assert.equal(platformForReportDir(byScreen), "web");
  });

  it("rejects a missing or empty dir instead of guessing", () => {
    for (const dir of [undefined, null, "", "  ", 42]) {
      assert.throws(() => platformForReportDir(dir), /report dir must be a non-empty path/);
    }
  });

  it("report and baseline pick the Android baseline for a dir named radios", (t) => {
    const root = tempDir(t);
    const out = join(root, "radios");
    mkdirSync(out);
    const gate = { errors: 0, ruleIds: [] };
    writeFileSync(join(out, "home.tree.json"), JSON.stringify({ screen: "home", violations: [], gate }));
    const androidBaseline = join(root, "baseline-android.json");
    const iosBaseline = join(root, "baseline-ios.json");
    writeFileSync(androidBaseline, JSON.stringify({ home: gate }));
    const config = join(root, "config.resolved.json");
    writeFileSync(config, JSON.stringify({ out: root, baseline: { android: androidBaseline, ios: iosBaseline } }));
    const env = { ...process.env, ALOUD_CONFIG: config };

    // The iOS baseline does not exist, so a gate against it would fail on
    // the unaccepted "home" screen.
    const report = spawnSync(process.execPath, [join(ROOT, "src/report/report.mjs"), "--dir", out, "--gate"], { cwd: root, encoding: "utf8", env });
    assert.equal(report.status, 0, report.stderr);

    const baseline = spawnSync(process.execPath, [join(ROOT, "src/report/baseline.mjs"), out], { cwd: root, encoding: "utf8", env });
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout + baseline.stderr, /baseline-android\.json/);
  });

  it("report and baseline pick the iOS baseline for --dir . inside an ios dir", (t) => {
    const root = tempDir(t);
    const out = join(root, "ios");
    mkdirSync(out);
    const gate = { errors: 0, ruleIds: [] };
    writeFileSync(join(out, "home.tree.json"), JSON.stringify({ screen: "home", violations: [], gate }));
    const androidBaseline = join(root, "baseline-android.json");
    const iosBaseline = join(root, "baseline-ios.json");
    writeFileSync(iosBaseline, JSON.stringify({ home: gate }));
    const config = join(root, "config.resolved.json");
    writeFileSync(config, JSON.stringify({ out: root, baseline: { android: androidBaseline, ios: iosBaseline } }));
    const env = { ...process.env, ALOUD_CONFIG: config };

    // The Android baseline does not exist, so gating "." as Android would
    // fail on the unaccepted "home" screen.
    const report = spawnSync(process.execPath, [join(ROOT, "src/report/report.mjs"), "--dir", ".", "--gate"], { cwd: out, encoding: "utf8", env });
    assert.equal(report.status, 0, report.stderr);

    const baseline = spawnSync(process.execPath, [join(ROOT, "src/report/baseline.mjs"), "."], { cwd: out, encoding: "utf8", env });
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout + baseline.stderr, /baseline-ios\.json/);
  });

  it("refuses to guess a config baseline for a dir the old scripts counted as iOS", () => {
    const cfg = { baseline: { android: "/b/android.json", ios: "/b/ios.json" } };
    for (const dir of ["out/app_ios", "out/app.ios/", "/abs/app_ios"]) {
      assert.throws(() => configBaselineFor(dir, platformForReportDir(dir), cfg), /before 0\.2\.0 it counted as iOS\. Pass --baseline/, dir);
    }
    for (const dir of ["build/iOS", "out/app-iOS"]) {
      assert.throws(() => configBaselineFor(dir, platformForReportDir(dir), cfg), /counts as Android .*\)\. Pass --baseline/, dir);
    }
    assert.equal(configBaselineFor("out/radios", "android", cfg), "/b/android.json");
    assert.equal(configBaselineFor("out/myios", "android", cfg), "/b/android.json");
    assert.equal(configBaselineFor("out/app-ios", "ios", cfg), "/b/ios.json");
    assert.equal(configBaselineFor("out/ios", "ios", {}), undefined);
  });

  it("report and baseline stop on out/app_ios without --baseline, and accept it with one", (t) => {
    const root = tempDir(t);
    const out = join(root, "app_ios");
    mkdirSync(out);
    const gate = { errors: 0, ruleIds: [] };
    writeFileSync(join(out, "home.tree.json"), JSON.stringify({ screen: "home", violations: [], gate }));
    const iosBaseline = join(root, "baseline-ios.json");
    writeFileSync(iosBaseline, JSON.stringify({ home: gate }));
    const config = join(root, "config.resolved.json");
    writeFileSync(config, JSON.stringify({ out: root, baseline: { android: join(root, "baseline-android.json"), ios: iosBaseline } }));
    const env = { ...process.env, ALOUD_CONFIG: config };
    const run = (script, ...args) => spawnSync(process.execPath, [join(ROOT, "src/report", script), ...args], { cwd: root, encoding: "utf8", env });

    for (const result of [run("report.mjs", "--dir", out, "--gate"), run("baseline.mjs", out)]) {
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /counted as iOS\. Pass --baseline/);
      assert.doesNotMatch(result.stderr, /    at /);
    }
    assert.equal(run("report.mjs", "--dir", out, "--gate", "--baseline", iosBaseline).status, 0);
  });
});
