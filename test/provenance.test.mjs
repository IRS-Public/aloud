/**
 * Tests for src/provenance.mjs (where evidence came from) and for the
 * places that carry it: report.mjs's summary.json and its refusal to mix
 * runs, and the OpenACR adapter's findings provenance and notes. The IO
 * is driven with a fake environment and a fake exec, plus one real git
 * repo in a temp dir for the report-dir exclusion. Device-free.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  PROVENANCE_SCHEMA_VERSION,
  collectProvenance,
  combineProvenance,
  describeProvenance,
  formatProvenance,
  formatTools,
  githubRun,
  probeTools,
  readGitState,
  validateProvenance,
  validateSummaryProvenance,
} from "../src/provenance.mjs";
import { aloudFindings, buildAloudAcr, normalizeAudit } from "../src/acr/from-aloud.mjs";
import { validateFindings } from "../src/acr/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const ALOUD_COMMIT = "c".repeat(40);
const RUNTIME = { platform: "darwin", arch: "arm64", osRelease: "25.6.0", node: "v22.12.0" };
const ACTIONS_ENV = {
  GITHUB_ACTIONS: "true",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "example/app",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
};

// A valid record; overrides replace top-level fields.
const record = (overrides = {}) => formatProvenance({
  app: { commit: APP_COMMIT, workingTreeDirty: false },
  aloud: { version: "0.1.0", commit: ALOUD_COMMIT, workingTreeDirty: false },
  runtime: RUNTIME,
  env: {},
  tools: { talkback: "abc123" },
  ...overrides,
});

// A fake exec that answers git and tool probes from a table keyed by
// "cwd: command args", and records every call. Missing keys throw, the way
// a missing tool or a non-repo directory does.
function fakeExec(table) {
  const calls = [];
  const exec = (command, args, { cwd } = {}) => {
    calls.push({ command, args, cwd });
    const key = `${cwd ?? ""}: ${[command, ...args].join(" ")}`;
    for (const [pattern, answer] of Object.entries(table)) {
      if (key === pattern || key.startsWith(pattern)) {
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
    throw new Error(`ENOENT ${key}`);
  };
  return { exec, calls };
}

describe("githubRun", () => {
  it("is null outside GitHub Actions", () => {
    assert.equal(githubRun({}), null);
    assert.equal(githubRun({ CI: "true" }), null);
  });

  it("names the exact attempt's URL inside Actions", () => {
    assert.deepEqual(githubRun(ACTIONS_ENV), {
      server: "https://github.com",
      repository: "example/app",
      runId: "123",
      runAttempt: "2",
      runUrl: "https://github.com/example/app/actions/runs/123/attempts/2",
    });
  });

  it("leaves the URL out when the repository is unknown, and drops a trailing slash", () => {
    assert.equal(githubRun({ GITHUB_RUN_ID: "9" }).runUrl, null);
    const run = githubRun({ ...ACTIONS_ENV, GITHUB_SERVER_URL: "https://ghe.example/", GITHUB_RUN_ATTEMPT: "" });
    assert.equal(run.runUrl, "https://ghe.example/example/app/actions/runs/123");
  });
});

describe("formatProvenance and validation", () => {
  it("assembles a valid record with sorted tools and nulls for the unknown", () => {
    const value = formatProvenance({ aloud: { version: "0.1.0" }, runtime: RUNTIME, tools: { z: "1", a: " 2 ", gone: null, blank: "" } });
    assert.equal(value.schemaVersion, PROVENANCE_SCHEMA_VERSION);
    assert.equal(value.commit, null);
    assert.equal(value.workingTreeDirty, null);
    assert.deepEqual(value.aloud, { version: "0.1.0", commit: null, workingTreeDirty: null });
    assert.equal(value.github, null);
    assert.deepEqual(Object.entries(value.tools), [["a", "2"], ["z", "1"]]);
  });

  it("rejects malformed records", () => {
    const cases = [
      ["an unknown field", (r) => { r.surprise = 1; }, /unknown field/],
      ["another schema version", (r) => { r.schemaVersion = 2; }, /schemaVersion/],
      ["a short commit", (r) => { r.commit = "abc123"; }, /commit/],
      ["a string dirty flag", (r) => { r.workingTreeDirty = "no"; }, /workingTreeDirty/],
      ["a missing platform", (r) => { delete r.platform; }, /platform/],
      ["a missing aloud version", (r) => { delete r.aloud.version; }, /aloud.version/],
      ["an unknown aloud field", (r) => { r.aloud.extra = true; }, /unknown field/],
      ["a relative run URL", (r) => { r.github = { ...githubRun(ACTIONS_ENV), runUrl: "/runs/1" }; }, /runUrl/],
      ["a blank tool version", (r) => { r.tools.talkback = " "; }, /tools/],
      ["an array of tools", (r) => { r.tools = []; }, /tools/],
    ];
    for (const [name, mutate, pattern] of cases) {
      const value = structuredClone(record());
      mutate(value);
      assert.throws(() => validateProvenance(value), pattern, name);
    }
    assert.throws(() => formatTools([]), /object/);
  });

  it("accepts a summary's single record or its mixed form, and nothing looser", () => {
    const one = record();
    assert.equal(validateSummaryProvenance(one), one);
    const mixed = { schemaVersion: 1, mixed: [{ provenance: one, files: ["a.tree.json"] }, { provenance: null, files: ["b.tree.json"] }] };
    assert.equal(validateSummaryProvenance(mixed), mixed);
    assert.throws(() => validateSummaryProvenance({ schemaVersion: 1, mixed: [mixed.mixed[0]] }), /at least two/);
    assert.throws(() => validateSummaryProvenance({ ...mixed, extra: 1 }), /unknown field/);
    assert.throws(() => validateSummaryProvenance({ schemaVersion: 1, mixed: [mixed.mixed[0], { provenance: null, files: [] }] }), /files/);
  });

  it("describes a record in one sentence", () => {
    const text = describeProvenance(record({ env: ACTIONS_ENV, app: { commit: APP_COMMIT, workingTreeDirty: true } }));
    assert.match(text, /^Evidence from commit aaaaaaaaaaaa plus uncommitted changes, checked by aloud 0\.1\.0 \(cccccccccccc\)/);
    assert.match(text, /run https:\/\/github\.com\/example\/app\/actions\/runs\/123\/attempts\/2/);
    assert.match(text, /tools: talkback abc123\.$/);
    assert.equal(describeProvenance(undefined), "No provenance recorded.");
  });
});

describe("collectProvenance with a fake exec", () => {
  it("records nulls, not a clean tree, when git is missing", () => {
    const { exec } = fakeExec({});
    const value = collectProvenance({ cwd: "/app", env: {}, exec, runtime: RUNTIME, aloudHome: ROOT });
    assert.equal(value.commit, null);
    assert.equal(value.workingTreeDirty, null);
    assert.equal(value.aloud.commit, null);
    assert.equal(value.aloud.version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    assert.deepEqual(value.tools, {});
  });

  it("reads the app's commit and dirty state, excluding the report dir", () => {
    const app = realpathSync(mkdtempSync(join(tmpdir(), "aloud-provenance-app-")));
    try {
      const { exec, calls } = fakeExec({
        [`${app}: git rev-parse --show-toplevel`]: `${app}\n`,
        [`${app}: git rev-parse HEAD`]: `${APP_COMMIT}\n`,
        [`${app}: git status`]: " M src/app.js\n",
      });
      const value = collectProvenance({
        cwd: app, exclude: [join(app, "aloud-report"), "/elsewhere/report"], env: ACTIONS_ENV, exec, runtime: RUNTIME, aloudHome: ROOT,
      });
      assert.equal(value.commit, APP_COMMIT);
      assert.equal(value.workingTreeDirty, true);
      assert.equal(value.github.runUrl, "https://github.com/example/app/actions/runs/123/attempts/2");
      const status = calls.find((call) => call.cwd === app && call.args[0] === "status");
      // The report dir inside the repo is excluded; one outside it is ignored.
      assert.deepEqual(status.args.slice(-2), [":/", ":(top,exclude)aloud-report"]);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it("reports no aloud commit when aloud sits inside another repo (installed under node_modules)", () => {
    const { exec } = fakeExec({
      [`${ROOT}: git rev-parse --show-toplevel`]: `${dirname(ROOT)}\n`,
      [`${ROOT}: git rev-parse HEAD`]: `${OTHER_COMMIT}\n`,
      [`${ROOT}: git status`]: "",
    });
    const value = collectProvenance({ cwd: "/app", env: {}, exec, runtime: RUNTIME, aloudHome: ROOT });
    assert.equal(value.aloud.commit, null);
    assert.equal(value.aloud.workingTreeDirty, null);
  });

  it("reads aloud's own checkout when it is the repo's top level", () => {
    const { exec } = fakeExec({
      [`${ROOT}: git rev-parse --show-toplevel`]: `${ROOT}\n`,
      [`${ROOT}: git rev-parse HEAD`]: `${ALOUD_COMMIT}\n`,
      [`${ROOT}: git status`]: "",
    });
    const value = collectProvenance({ cwd: "/app", env: {}, exec, runtime: RUNTIME, aloudHome: ROOT });
    assert.equal(value.aloud.commit, ALOUD_COMMIT);
    assert.equal(value.aloud.workingTreeDirty, false);
  });

  it("probes tool versions, keeping the lines asked for, and lets known versions win", () => {
    const { exec } = fakeExec({
      [": xcodebuild -version"]: "Xcode 27.0\nBuild version 18A1\n",
      [": adb version"]: "\nAndroid Debug Bridge version 1.0.41\nVersion 35.0.2\n",
      [": broken --version"]: new Error("exit 1"),
    });
    const probes = {
      xcode: { command: ["xcodebuild", "-version"], lines: 2 },
      adb: ["adb", "version"],
      broken: ["broken", "--version"],
      talkback: ["adb", "version"],
    };
    assert.deepEqual(probeTools(probes, { exec }), {
      xcode: "Xcode 27.0 Build version 18A1",
      adb: "Android Debug Bridge version 1.0.41",
      broken: null,
      talkback: "Android Debug Bridge version 1.0.41",
    });
    const value = collectProvenance({ cwd: "/app", env: {}, exec, runtime: RUNTIME, aloudHome: ROOT, probes, tools: { talkback: "abc123" } });
    assert.deepEqual(value.tools, { adb: "Android Debug Bridge version 1.0.41", talkback: "abc123", xcode: "Xcode 27.0 Build version 18A1" });
  });
});

describe("readGitState in a real repo", () => {
  const hasGit = spawnSync("git", ["--version"]).status === 0;

  it("does not count the report dir inside the app repo as an app change", { skip: !hasGit && "git is not installed" }, () => {
    const app = mkdtempSync(join(tmpdir(), "aloud-provenance-git-"));
    const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: app, encoding: "utf8" });
    try {
      git("init", "-q");
      writeFileSync(join(app, "app.js"), "console.log(1);\n");
      git("add", ".");
      git("commit", "-q", "-m", "init");
      const head = git("rev-parse", "HEAD").trim();
      mkdirSync(join(app, "aloud-report", "android"), { recursive: true });
      writeFileSync(join(app, "aloud-report", "android", "home.tree.json"), "{}");

      const excluded = readGitState(app, { exclude: [join(app, "aloud-report")] });
      assert.equal(excluded.commit, head);
      assert.equal(excluded.workingTreeDirty, false);
      assert.equal(readGitState(app).workingTreeDirty, true);

      writeFileSync(join(app, "app.js"), "console.log(2);\n");
      assert.equal(readGitState(app, { exclude: [join(app, "aloud-report")] }).workingTreeDirty, true);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});

describe("combineProvenance", () => {
  const tree = record({ tools: { atf: "4.1.1" } });
  const transcript = record({ tools: { talkback: "abc123" } });

  it("returns undefined when no file recorded provenance", () => {
    assert.equal(combineProvenance([{ file: "a.tree.json" }, { file: "b.tree.json", provenance: undefined }]), undefined);
  });

  it("merges the tools of files from one run", () => {
    const value = combineProvenance([{ file: "a.tree.json", provenance: tree }, { file: "a.transcript.json", provenance: transcript }]);
    assert.equal(value.commit, APP_COMMIT);
    assert.deepEqual(value.tools, { atf: "4.1.1", talkback: "abc123" });
    assert.doesNotThrow(() => validateProvenance(value));
  });

  it("refuses files from another commit, naming both", () => {
    const other = record({ app: { commit: OTHER_COMMIT, workingTreeDirty: false } });
    assert.throws(
      () => combineProvenance([{ file: "a.tree.json", provenance: tree }, { file: "b.tree.json", provenance: other }], { what: "report dir x" }),
      (error) => /report dir x mixes evidence/.test(error.message) &&
        /aaaaaaaaaaaa/.test(error.message) && /bbbbbbbbbbbb/.test(error.message) && /--allow-mixed/.test(error.message),
    );
  });

  it("refuses a dirty tree, another CI run, or a file without provenance next to newer ones", () => {
    for (const other of [
      record({ app: { commit: APP_COMMIT, workingTreeDirty: true } }),
      record({ env: ACTIONS_ENV }),
      undefined,
    ]) {
      assert.throws(() => combineProvenance([{ file: "a.tree.json", provenance: tree }, { file: "b.tree.json", provenance: other }]), /mixes evidence/);
    }
  });

  it("refuses conflicting tool versions within one run", () => {
    const newer = record({ tools: { atf: "4.2.0" } });
    assert.throws(
      () => combineProvenance([{ file: "a.tree.json", provenance: tree }, { file: "b.tree.json", provenance: newer }]),
      /tool versions differ: atf 4\.1\.1 vs 4\.2\.0 \(b\.tree\.json\)/,
    );
    const allowed = combineProvenance([{ file: "a.tree.json", provenance: tree }, { file: "b.tree.json", provenance: newer }], { allowMixed: true });
    assert.equal(allowed.mixed.length, 2);
    assert.doesNotThrow(() => validateSummaryProvenance(allowed));
  });

  it("lists every group when mixing is allowed", () => {
    const other = record({ app: { commit: OTHER_COMMIT, workingTreeDirty: false } });
    const value = combineProvenance([
      { file: "a.tree.json", provenance: tree },
      { file: "a.transcript.json", provenance: tree },
      { file: "b.tree.json", provenance: other },
      { file: "old.tree.json", provenance: undefined },
    ], { allowMixed: true });
    assert.deepEqual(value.mixed.map((group) => group.files), [["a.tree.json", "a.transcript.json"], ["b.tree.json"], ["old.tree.json"]]);
    assert.equal(value.mixed[2].provenance, null);
    assert.doesNotThrow(() => validateSummaryProvenance(value));
    assert.match(describeProvenance(value), /Combined with --allow-mixed from 3 different runs/);
  });
});

describe("report summaries", () => {
  const violation = { ruleId: "native-interactive-unlabeled", severity: "error" };
  const treeReport = (screen, provenance) => ({
    screen,
    violations: [violation],
    gate: { errors: 1, ruleIds: [violation.ruleId] },
    ...(provenance ? { provenance } : {}),
  });

  function reportDir(t, reports) {
    const cwd = mkdtempSync(join(tmpdir(), "aloud-provenance-report-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const out = join(cwd, "android");
    mkdirSync(out);
    for (const [file, report] of Object.entries(reports)) writeFileSync(join(out, file), JSON.stringify(report));
    const run = (...flags) => spawnSync(process.execPath, [
      join(ROOT, "bin/aloud.mjs"), "report", "--dir", out,
      "--baseline", join(cwd, "baseline.json"), "--out", join(cwd, "config"), ...flags,
    ], { cwd, encoding: "utf8", env: { ...process.env, ALOUD_CONFIG: "" } });
    const summary = () => JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    return { run, summary, out };
  }

  it("states the run's provenance in summary.json and on the evidence page", (t) => {
    const f = reportDir(t, {
      "home.tree.json": treeReport("home", record({ tools: { atf: "4.1.1" } })),
      "settings.tree.json": treeReport("settings", record({ tools: { talkback: "abc123" } })),
    });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const provenance = f.summary().provenance;
    assert.equal(provenance.commit, APP_COMMIT);
    assert.deepEqual(provenance.tools, { atf: "4.1.1", talkback: "abc123" });
    assert.match(readFileSync(join(f.out, "index.html"), "utf8"), /Evidence from commit aaaaaaaaaaaa/);
  });

  it("writes no provenance for report dirs written before provenance", (t) => {
    const f = reportDir(t, { "home.tree.json": treeReport("home") });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Object.hasOwn(f.summary(), "provenance"), false);
  });

  it("refuses evidence from different commits unless --allow-mixed", (t) => {
    const f = reportDir(t, {
      "home.tree.json": treeReport("home", record()),
      "settings.tree.json": treeReport("settings", record({ app: { commit: OTHER_COMMIT, workingTreeDirty: false } })),
    });
    const refused = f.run();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /mixes evidence from different runs/);
    assert.throws(() => f.summary(), /ENOENT/);

    const allowed = f.run("--allow-mixed");
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stderr, /--allow-mixed/);
    const provenance = f.summary().provenance;
    assert.equal(provenance.mixed.length, 2);
    assert.doesNotThrow(() => normalizeAudit(f.summary()));
  });

  it("rejects malformed provenance in an evidence file", (t) => {
    const bad = { ...record(), commit: "not-a-commit" };
    const f = reportDir(t, { "home.tree.json": treeReport("home", bad) });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /home\.tree\.json provenance\.commit/);
  });
});

describe("OpenACR provenance", () => {
  const screens = { home: { errors: 0, ruleIds: [], utterances: 3 } };
  const summary = (provenance) => normalizeAudit({ generated: "2026-09-30T00:00:00.000Z", ...(provenance ? { provenance } : {}), screens });
  const inputs = (overrides = {}) => ({ appName: "Example App", productVersion: "1.0.0", ...overrides });

  it("keeps a summary's provenance and rejects a malformed one", () => {
    const one = record();
    assert.deepEqual(summary(one).provenance, one);
    assert.equal(Object.hasOwn(summary(), "provenance"), false);
    assert.throws(() => summary({ ...one, commit: "abc" }), /invalid audit: report summary provenance\.commit/);
  });

  it("states commit, run, and tools in the findings and the draft's notes", () => {
    const android = summary(record({ env: ACTIONS_ENV, tools: { talkback: "abc123" } }));
    const ios = summary(record({ env: ACTIONS_ENV, tools: { xcode: "Xcode 27.0" } }));
    const doc = aloudFindings(inputs({ android, ios }));
    assert.doesNotThrow(() => validateFindings(doc));
    assert.equal(doc.provenance.commit, APP_COMMIT);
    assert.equal(doc.provenance.workingTreeDirty, false);
    assert.equal(doc.provenance.runUrl, "https://github.com/example/app/actions/runs/123/attempts/2");
    assert.deepEqual(doc.provenance.tools.map((tool) => tool.name), ["aloud", "Node.js", "talkback", "xcode"]);
    assert.ok(doc.notes.some((note) => /^Android evidence provenance: commit aaaaaaaaaaaa/.test(note)));

    const acr = buildAloudAcr(inputs({ android, ios, date: "2026-09-30" }));
    assert.match(acr.notes, new RegExp(`The evidence comes from commit ${APP_COMMIT}, run https://github\\.com/example/app/actions/runs/123/attempts/2`));
    assert.match(acr.notes, /Tools: aloud 0\.1\.0 \(cccccccccccc\), Node\.js v22\.12\.0, talkback abc123, xcode Xcode 27\.0\./);
  });

  it("refuses Android and iOS evidence from different commits unless allowMixed", () => {
    const android = summary(record());
    const ios = summary(record({ app: { commit: OTHER_COMMIT, workingTreeDirty: false } }));
    assert.throws(() => aloudFindings(inputs({ android, ios })), /Android: commit aaaaaaaaaaaa.*iOS: commit bbbbbbbbbbbb.*--allow-mixed/);
    const doc = aloudFindings(inputs({ android, ios, allowMixed: true }));
    assert.equal(doc.provenance.commit, undefined);
    assert.ok(doc.notes.some((note) => /combined with --allow-mixed/.test(note)));
  });

  it("allows different machines and CI runs for one commit", () => {
    const android = summary(record({ env: ACTIONS_ENV }));
    const ios = summary(record({ runtime: { ...RUNTIME, platform: "linux", arch: "x64" } }));
    const doc = aloudFindings(inputs({ android, ios }));
    assert.equal(doc.provenance.commit, APP_COMMIT);
    assert.equal(doc.provenance.runUrl, undefined);
  });

  it("refuses a summary already written with --allow-mixed unless allowMixed", () => {
    const mixed = {
      schemaVersion: 1,
      mixed: [
        { provenance: record(), files: ["home.tree.json"] },
        { provenance: record({ app: { commit: OTHER_COMMIT, workingTreeDirty: false } }), files: ["settings.tree.json"] },
      ],
    };
    const android = summary(mixed);
    assert.throws(() => aloudFindings(inputs({ android })), /written with --allow-mixed/);
    const doc = aloudFindings(inputs({ android, allowMixed: true }));
    assert.ok(doc.notes.some((note) => /^Android evidence provenance: Combined with --allow-mixed/.test(note)));
  });

  it("says when an input records no provenance, without refusing it", () => {
    const android = normalizeAudit({ home: { errors: 0, ruleIds: [] } });
    const ios = summary(record());
    const doc = aloudFindings(inputs({ android, ios }));
    assert.ok(doc.notes.some((note) => /^Android evidence records no provenance/.test(note)));
    assert.equal(doc.provenance.commit, APP_COMMIT);
    const baselinesOnly = aloudFindings(inputs({ android }));
    assert.equal(Object.hasOwn(baselinesOnly, "provenance"), false);
  });
});
