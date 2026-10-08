/**
 * Tests that keep the documentation honest. The example findings document
 * builds a valid draft; the USWDS harness adapter example maps every
 * harness status and builds valid drafts; docs/openacr.md and
 * docs/harness-integration.md show those examples exactly and state the
 * status tables the code uses; and every relative link in the README and
 * docs resolves, anchors included. Device-free.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import {
  DEFAULT_POLICY,
  STATUSES,
  STATUS_KINDS,
  adherenceFor,
  buildAcr,
  levelCounts,
  validateAcr,
  validateFindings,
} from "../src/acr/index.mjs";
import { STATUS_MAP, harnessToFindings } from "../examples/harness-to-findings.example.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const readJson = (file) => JSON.parse(read(file));

const EXAMPLE_FINDINGS = "examples/findings.example.json";
const ADAPTER = "examples/harness-to-findings.example.mjs";
const HARNESS_REPORT = "test/fixtures/harness/report.json";

// The text of a Markdown section: from its heading to the next heading of
// the same or a higher level.
function section(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.replace(/^#+ /, "") === heading && /^#+ /.test(line));
  assert.notEqual(start, -1, `no section "${heading}"`);
  const depth = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((line, i) => i > start && /^#+ /.test(line) && line.match(/^#+/)[0].length <= depth);
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

// The fenced code blocks of a given language in a piece of Markdown.
const codeBlocks = (markdown, language) =>
  [...markdown.matchAll(new RegExp("^```" + language + "\\n([\\s\\S]*?)^```$", "gm"))].map((match) => match[1]);

describe("examples/findings.example.json", () => {
  const example = readJson(EXAMPLE_FINDINGS);

  it("passes the findings contract and uses every status", () => {
    validateFindings(example);
    const used = new Set(example.findings.map((finding) => finding.status));
    assert.deepEqual([...used].sort(), [...STATUSES].sort());
  });

  it("builds a valid draft with the levels docs/openacr.md states", () => {
    const acr = buildAcr(example);
    assert.deepEqual(validateAcr(acr), { valid: true, problems: [] });
    assert.deepEqual(levelCounts(acr).levels, {
      supports: 3,
      "partially-supports": 1,
      "does-not-support": 1,
      "not-applicable": 2,
      "not-evaluated": 120,
    });
  });

  it("is shown in full in docs/openacr.md", () => {
    const shown = codeBlocks(section(read("docs/openacr.md"), "A full example"), "json");
    assert.equal(shown.length, 1);
    assert.deepEqual(JSON.parse(shown[0]), example);
  });
});

describe("docs/openacr.md policy tables", () => {
  const doc = read("docs/openacr.md");

  it("state every status with its kind and default level", () => {
    const rows = [...section(doc, "The default policy").matchAll(/^\| `([a-z-]+)` \| ([a-z-]+) \| `([a-z-]+)`/gm)];
    assert.deepEqual(rows.map((row) => row[1]).sort(), [...STATUSES].sort());
    for (const [, status, kind, level] of rows) {
      assert.equal(kind, STATUS_KINDS[status], `kind of ${status}`);
      const expected = DEFAULT_POLICY[status].level;
      assert.equal(level, typeof expected === "string" ? expected : expected.some, `level of ${status}`);
    }
  });

  it("group every status under its kind", () => {
    const rows = [...section(doc, "The status vocabulary").matchAll(/^\| ([a-z-]+) \| ((?:`[a-z-]+`(?:, )?)+) \|/gm)];
    const documented = Object.fromEntries(
      rows.flatMap(([, kind, list]) => list.match(/[a-z-]+/g).map((status) => [status, kind])),
    );
    assert.deepEqual(documented, { ...STATUS_KINDS });
  });
});

describe("the USWDS harness adapter example", () => {
  const report = readJson(HARNESS_REPORT);
  const knownIssues = [
    { name: "DP-EXPANDED-STATE", kind: "core-bug", summary: "The calendar toggle does not say whether it is open." },
  ];
  const [{ component, findings }] = harnessToFindings(report, { knownIssues, version: "3.13.0" });
  const byCriterion = new Map(findings.findings.map((finding) => [finding.criterion, finding]));

  it("maps exactly the harness statuses onto findings statuses", () => {
    assert.deepEqual(Object.keys(STATUS_MAP).sort(), [
      "awaiting-review",
      "consumer-responsibility",
      "human-reviewed",
      "incomplete",
      "met",
      "not-met",
      "not-met-known-issue",
      "not-triggered",
      "partly-tested",
      "platform-limitation",
      "standard-interpretation",
      "unreviewed",
      "untested",
    ]);
    for (const status of Object.values(STATUS_MAP)) assert.ok(STATUSES.includes(status), status);
    // The fixture uses every harness status.
    const used = new Set(report.components[0].criteria.map((row) => row.status));
    for (const status of Object.keys(STATUS_MAP)) assert.ok(used.has(status), `fixture lacks ${status}`);
  });

  it("writes one valid findings document per component, without project rows", () => {
    assert.equal(component, "date-picker");
    validateFindings(findings);
    assert.equal(findings.product.name, "USWDS date-picker");
    assert.equal(findings.product.version, "3.13.0");
    assert.equal(byCriterion.has("APG-RADIO"), false);
    assert.equal(findings.findings.length, 16);
    for (const row of report.components[0].criteria.filter((r) => r.profile !== "project")) {
      assert.equal(byCriterion.get(row.criterion).status, STATUS_MAP[row.status], row.criterion);
    }
  });

  it("derives failingShare from whether every check failed and none passed anywhere", () => {
    assert.equal(byCriterion.get("2.1.1").failingShare, "some");
    assert.equal(byCriterion.get("2.1.2").failingShare, "all");
    assert.equal(byCriterion.get("4.1.2").failingShare, "all");
    for (const criterion of ["1.1.1", "2.4.7", "1.3.1"]) {
      assert.equal(byCriterion.get(criterion).failingShare, undefined, criterion);
    }
  });

  it("does not count a check that never ran as a failure", () => {
    const copy = structuredClone(report);
    const row = copy.components[0].criteria.find((r) => r.criterion === "4.1.2");
    row.checks.push({
      ...structuredClone(row.checks[0]),
      id: "DP-S09",
      status: "no-evidence",
      environments: [],
      passedIn: [],
      issues: [],
    });
    const [{ findings: changed }] = harnessToFindings(copy);
    const finding = changed.findings.find((f) => f.criterion === "4.1.2");
    assert.equal(finding.failingShare, "some");
    assert.deepEqual(finding.evidence[1], { id: "DP-S09" });
  });

  it("maps awaiting-review rows to partly-tested, saying the wording awaits a person", () => {
    const finding = byCriterion.get("3.3.2");
    assert.equal(finding.status, "partly-tested");
    assert.equal(finding.notes.at(-1), "The tests keep the wording as written; whether it is clear awaits a person's review");
  });

  it("maps human-reviewed rows to human-reviewed, naming the reviewer and their judgment", () => {
    assert.deepEqual(byCriterion.get("3.3.1").notes, [
      "Scope of the checks, not a result: Typing a date outside the allowed range marks the field invalid and names the range. Not tested: the message the browser shows for a date it cannot read.",
      "Reviewed by octocat on 2026-09-29: The browser's message names the field and asks for a date in the format shown.",
    ]);
    // An older report used the status for approved wording alone, with no review.
    const unrecorded = structuredClone(report);
    delete unrecorded.components[0].criteria.find((r) => r.criterion === "3.3.1").review;
    assert.throws(() => harnessToFindings(unrecorded), /3\.3\.1: a human-reviewed row needs the review it rests on/);
  });

  it("gives a shared row's site part its own note", () => {
    assert.deepEqual(byCriterion.get("2.4.6").notes, [
      "Scope of the checks, not a result: The label and hint are tied to the field.",
      "Left to each site: a label that names the date its own form asks for.",
    ]);
  });

  it("notes a feature an environment lacks, without counting it as evidence or an issue", () => {
    const finding = byCriterion.get("1.4.11");
    assert.equal(finding.status, "met");
    // A summary the registry does not have falls back to the issue's name.
    assert.deepEqual(finding.notes, ["Not applicable in webkit: WEBKIT-FORCED-COLORS"]);
    assert.deepEqual(finding.evidence, [{ id: "DP-FC01", environments: ["chromium", "firefox"] }]);
    assert.equal(finding.issues, undefined);
  });

  it("labels a scope statement so the draft never states it as a result", () => {
    assert.equal(byCriterion.get("1.1.1").notes[0], "Scope of the checks, not a result: The icon-only calendar toggle has an accessible name.");
    // Triage reasons for rows no check can fail stay as written.
    assert.deepEqual(byCriterion.get("1.2.2").notes, ["The date picker has no video."]);
    assert.deepEqual(byCriterion.get("2.4.2").notes, ["Every page needs a title."]);
    // A standard-interpretation row's reason is its citation, copied as written.
    const interpreted = byCriterion.get("4.1.1");
    assert.equal(interpreted.status, "standard-interpretation");
    assert.deepEqual(interpreted.notes, [report.components[0].criteria.find((r) => r.criterion === "4.1.1").reason]);
    assert.equal(interpreted.evidence, undefined);
    const uncited = structuredClone(report);
    uncited.components[0].criteria.find((r) => r.criterion === "4.1.1").reason = "";
    assert.throws(() => harnessToFindings(uncited), /4\.1\.1: a standard-interpretation row needs a reason/);
  });

  it("carries issues, notes, evidence, and provenance", () => {
    assert.deepEqual(byCriterion.get("4.1.2").issues, [
      { id: "DP-EXPANDED-STATE", kind: "core-bug", summary: "The calendar toggle does not say whether it is open." },
    ]);
    // An issue the registry does not know still names itself.
    assert.match(byCriterion.get("2.4.7").issues[0].summary, /Known issue DP-WEBKIT-FOCUS-RING/);
    assert.deepEqual(byCriterion.get("2.1.1").notes, [
      "Scope of the checks, not a result: Every control works from the keyboard.",
      "Failing checks: DP-K03 (passed only in chromium)",
      "Some tests did not run in: webkit",
    ]);
    assert.deepEqual(byCriterion.get("2.1.2").notes, ["Failing checks: DP-K05 (passed nowhere)"]);
    assert.deepEqual(byCriterion.get("1.3.1").notes, ["Some tests did not run in: chromium, firefox"]);
    // Evidence environments are where each check's tests ran, pass or fail.
    assert.deepEqual(byCriterion.get("2.1.1").evidence, [
      { id: "DP-K01", environments: ["chromium", "firefox", "webkit"] },
      { id: "DP-K03", environments: ["chromium", "firefox"] },
    ]);
    assert.deepEqual(byCriterion.get("2.1.2").evidence, [
      { id: "DP-K05", environments: ["chromium", "firefox", "webkit"] },
    ]);
    assert.equal(byCriterion.get("2.4.11").evidence, undefined);
    assert.deepEqual(findings.provenance, {
      commit: report.run.commit,
      workingTreeDirty: false,
      date: "2026-09-30",
      tools: [{ name: "USWDS accessibility harness" }],
    });
  });

  it("builds a valid draft at the levels docs/harness-integration.md states", () => {
    const acr = buildAcr(findings);
    assert.equal(validateAcr(acr).valid, true);
    const level = (criterion) =>
      Object.values(acr.chapters)
        .flatMap((chapter) => chapter.criteria ?? [])
        .find((entry) => entry.num === criterion).components[0].adherence.level;
    assert.equal(level("1.1.1"), "supports");
    assert.equal(level("3.3.2"), "not-evaluated");
    assert.equal(level("3.3.1"), "supports");
    assert.equal(level("2.4.6"), "supports");
    assert.equal(level("2.1.1"), "partially-supports");
    assert.equal(level("2.1.2"), "does-not-support");
    assert.equal(level("1.4.11"), "supports");
    assert.equal(level("2.4.7"), "not-evaluated");
    assert.equal(level("2.4.2"), "not-applicable");
    assert.equal(level("4.1.1"), "supports");
  });

  it("refuses unknown statuses and profiles, runs with unhandled errors, and known-bug runs", () => {
    const withRow = (change) => {
      const copy = structuredClone(report);
      Object.assign(copy.components[0].criteria[0], change);
      return copy;
    };
    assert.throws(() => harnessToFindings(withRow({ status: "passing" })), /unknown harness status "passing"/);
    assert.throws(() => harnessToFindings(withRow({ profile: "additional-wcag23" })), /unknown harness profile/);
    assert.throws(
      () => harnessToFindings({ ...report, run: { ...report.run, unhandledErrors: 2 } }),
      /unhandled errors/,
    );
    assert.throws(
      () => harnessToFindings({ ...report, run: { ...report.run, knownBugsEnabled: true } }),
      /switched known bugs on/,
    );
    assert.throws(() => harnessToFindings({}), /not a harness report\.json/);
  });

  it("is shown exactly in docs/harness-integration.md, with its status table", () => {
    const doc = read("docs/harness-integration.md");
    assert.deepEqual(codeBlocks(section(doc, "The adapter"), "js"), [read(ADAPTER)]);
    const rows = [...section(doc, "Status mapping").matchAll(/^\| `([a-z-]+)` \| [^|]+ \| `([a-z-]+)` \| `([a-z-]+)`/gm)];
    assert.deepEqual(Object.fromEntries(rows.map(([, from, to]) => [from, to])), { ...STATUS_MAP });
    for (const [, , status, level] of rows) assert.equal(level, adherenceFor(status).level, status);
  });
});

describe("the harness adapter from the command line", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "aloud-harness-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("writes findings that aloud acr turns into a draft", () => {
    const registry = join(dir, "known-issues.mjs");
    writeFileSync(registry, 'export const knownIssues = [{ name: "WEBKIT-FORCED-COLORS", kind: "absent-feature", summary: "Safari has no high-contrast mode." }];\n');
    const env = { PATH: process.env.PATH, USWDS_VERSION: "3.13.0" };
    const out = join(dir, "findings");
    const adapter = spawnSync(process.execPath, [join(ROOT, ADAPTER), join(ROOT, HARNESS_REPORT), out, registry], {
      encoding: "utf8",
      env,
    });
    assert.equal(adapter.status, 0, adapter.stderr);
    assert.deepEqual(readdirSync(out), ["date-picker.json"]);
    const written = JSON.parse(readFileSync(join(out, "date-picker.json"), "utf8"));
    assert.equal(written.product.version, "3.13.0");
    assert.ok(written.findings.find((f) => f.criterion === "1.4.11").notes.includes("Not applicable in webkit: Safari has no high-contrast mode."));

    const draft = join(dir, "acr.yaml");
    const acr = spawnSync(process.execPath, [join(ROOT, "bin/aloud.mjs"), "acr", "--findings", join(out, "date-picker.json"), "--out", draft], {
      encoding: "utf8",
      env,
    });
    assert.equal(acr.status, 0, acr.stderr);
    assert.match(readFileSync(draft, "utf8"), /^title: USWDS date-picker Accessibility Conformance Report \(draft\)$/m);
  });
});

// GitHub's heading anchors: lower case, punctuation dropped, spaces to
// hyphens, and "-1", "-2", ... on repeats.
function anchors(markdown) {
  const seen = new Map();
  const out = new Set();
  const text = markdown.replace(/^```[\s\S]*?^```$/gm, "");
  for (const [, heading] of text.matchAll(/^#{1,6} (.+)$/gm)) {
    const slug = heading
      .trim()
      .toLowerCase()
      .replace(/`/g, "")
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    out.add(count ? `${slug}-${count}` : slug);
  }
  return out;
}

describe("documentation links", () => {
  const files = [
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    ...readdirSync(join(ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`),
  ];

  it("resolve to files and headings that exist", () => {
    const broken = [];
    for (const file of files) {
      const markdown = read(file).replace(/^```[\s\S]*?^```$/gm, "");
      const targets = [
        ...[...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]),
        ...[...markdown.matchAll(/<img [^>]*src="([^"]+)"/g)].map((match) => match[1]),
      ];
      for (const target of targets) {
        if (/^[a-z]+:/i.test(target)) continue;
        const [path, anchor] = target.split("#");
        const resolved = path ? join(ROOT, dirname(file), path) : join(ROOT, file);
        if (!existsSync(resolved)) {
          broken.push(`${file}: ${target} (no such file)`);
          continue;
        }
        if (anchor && resolved.endsWith(".md") && !anchors(readFileSync(resolved, "utf8")).has(anchor)) {
          broken.push(`${file}: ${target} (no heading "#${anchor}" in ${relative(ROOT, resolved)})`);
        }
      }
    }
    assert.deepEqual(broken, []);
  });
});
