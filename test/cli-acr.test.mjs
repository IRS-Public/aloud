/**
 * Command-line tests for the two OpenACR commands in bin/aloud.mjs:
 * `aloud acr` (any findings document) and `aloud openacr` (aloud's own
 * audit results). Each test runs the real CLI in a child process against
 * fixtures and checks the exit code, the message, and the YAML written.
 * Device-free.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { dump, load } from "js-yaml";

import { validateAcr } from "../src/acr/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "../bin/aloud.mjs");
const FIXTURES = join(HERE, "fixtures/acr");
const fixture = (name) => join(FIXTURES, name);
const BUNDLED_CATALOG = join(
  dirname(createRequire(import.meta.url).resolve("@openacr/openacr/package.json")),
  "catalog/2.5-edition-wcag-2.2-508-en.yaml",
);

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "aloud-cli-acr-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

// Run `aloud <args>` in the temp dir, so nothing lands in the repo.
function aloud(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8" });
}

function readAcr(file) {
  return load(readFileSync(file, "utf8"));
}

function row(acr, chapter, num) {
  return acr.chapters[chapter].criteria.find((c) => c.num === num);
}

describe("aloud acr", () => {
  it("writes a valid OpenACR from a valid findings file", () => {
    const out = join(dir, "valid.yaml");
    const result = aloud("acr", "--findings", fixture("valid.json"), "--out", out);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /draft OpenACR → .*valid\.yaml \(report_date 2026-09-01\)/);
    const acr = readAcr(out);
    assert.deepEqual(validateAcr(acr), { valid: true, problems: [] });
    assert.equal(acr.product.name, "Fixture Site");
    assert.equal(acr.report_date, "2026-09-01");
    assert.equal(row(acr, "success_criteria_level_a", "1.1.1").components[0].adherence.level, "supports");
    assert.equal(row(acr, "success_criteria_level_a", "2.1.1").components[0].adherence.level, "partially-supports");
    assert.equal(row(acr, "success_criteria_level_aa", "1.4.3").components[0].adherence.level, "not-evaluated");
  });

  it("applies --policy, --catalog, and --date", () => {
    const out = join(dir, "policy.yaml");
    const result = aloud(
      "acr",
      "--findings", fixture("valid.json"),
      "--policy", fixture("policy.json"),
      "--catalog", BUNDLED_CATALOG,
      "--date", "2026-09-30",
      "--out", out,
    );
    assert.equal(result.status, 0, result.stderr);
    const acr = readAcr(out);
    assert.equal(acr.report_date, "2026-09-30");
    assert.equal(acr.catalog, "2.5-edition-wcag-2.2-508-en");
    const untested = row(acr, "success_criteria_level_aa", "1.4.3").components[0].adherence;
    assert.equal(untested.notes, "Fixture policy: this criterion was not tested.");
    assert.deepEqual(validateAcr(acr), { valid: true, problems: [] });
  });

  it("defaults the output to acr-draft.yaml in the working directory", () => {
    const result = aloud("acr", "--findings", fixture("valid.json"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(validateAcr(readAcr(join(dir, "acr-draft.yaml"))).valid, true);
  });

  it("exits non-zero and names an unknown criterion, writing nothing", () => {
    const out = join(dir, "bad-criterion.yaml");
    const result = aloud("acr", "--findings", fixture("invalid-criterion.json"), "--out", out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^aloud acr: invalid findings:/m);
    assert.match(result.stderr, /findings\[1\]\.criterion: "9\.9\.9" is not a criterion in catalog 2\.5-edition-wcag-2\.2-508-en/);
    assert.equal(existsSync(out), false);
  });

  it("exits non-zero on a policy that would claim more than the evidence shows", () => {
    const out = join(dir, "bad-policy.yaml");
    const result = aloud("acr", "--findings", fixture("valid.json"), "--policy", fixture("invalid-policy.json"), "--out", out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /aloud acr: invalid policy for "untested".*may not map to "supports"/);
    assert.equal(existsSync(out), false);
  });

  it("explains a missing --findings flag, a missing file, and malformed JSON", () => {
    const missingFlag = aloud("acr");
    assert.notEqual(missingFlag.status, 0);
    assert.match(missingFlag.stderr, /aloud acr: --findings <file\.json> is required/);

    const missingFile = aloud("acr", "--findings", join(dir, "nope.json"));
    assert.notEqual(missingFile.status, 0);
    assert.match(missingFile.stderr, /aloud acr: findings file not found: .*nope\.json/);

    const broken = join(dir, "broken.json");
    writeFileSync(broken, '{"product":');
    const badJson = aloud("acr", "--findings", broken);
    assert.notEqual(badJson.status, 0);
    assert.match(badJson.stderr, /aloud acr: findings file .*broken\.json is not valid JSON/);

    const unknownFlag = aloud("acr", "--findings", fixture("valid.json"), "--nope");
    assert.notEqual(unknownFlag.status, 0);
  });

  it("rejects a --date or provenance.date that is not on the calendar", () => {
    const out = join(dir, "bad-date.yaml");
    for (const date of ["2026-02-31", "2026-13-45", "2026-00-10"]) {
      const result = aloud("acr", "--findings", fixture("valid.json"), "--date", date, "--out", out);
      assert.notEqual(result.status, 0, date);
      assert.match(result.stderr, /aloud acr: --date must be a real calendar date as YYYY-MM-DD/, date);
    }
    const findings = JSON.parse(readFileSync(fixture("valid.json"), "utf8"));
    findings.provenance = { ...findings.provenance, date: "2026-02-30" };
    const file = join(dir, "bad-provenance-date.json");
    writeFileSync(file, JSON.stringify(findings));
    const result = aloud("acr", "--findings", file, "--out", out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provenance\.date: "2026-02-30" is not a real calendar date/);
    assert.equal(existsSync(out), false);
  });
});

describe("aloud openacr", () => {
  it("keeps its flags and writes a valid draft from a baseline", () => {
    const configPath = join(dir, "openacr.config.json");
    writeFileSync(configPath, JSON.stringify({ app: { name: "Fixture App", version: "1.0.0" } }));
    const out = join(dir, "openacr.yaml");
    const result = aloud(
      "openacr",
      "--config", configPath,
      "--android", join(HERE, "fixtures/baseline-android.json"),
      "--ios", join(HERE, "fixtures/baseline-ios.json"),
      "--date", "2026-08-26",
      "--version", "3.1.4",
      "--catalog", BUNDLED_CATALOG,
      "--out", out,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /draft OpenACR → .*openacr\.yaml \(report_date 2026-08-26\)/);
    const acr = readAcr(out);
    assert.deepEqual(validateAcr(acr), { valid: true, problems: [] });
    assert.equal(acr.product.version, "3.1.4");
    assert.equal(row(acr, "success_criteria_level_a", "1.1.1").components[0].adherence.level, "supports");
    assert.equal(row(acr, "success_criteria_level_aa", "2.5.8").components[0].adherence.level, "partially-supports");
    assert.match(acr.notes, /replace the placeholder contact email/);
  });

  it("rejects an impossible --date", () => {
    const configPath = join(dir, "date.config.json");
    writeFileSync(configPath, JSON.stringify({ app: { name: "Fixture App", version: "1.0.0" } }));
    const out = join(dir, "bad-date-openacr.yaml");
    const result = aloud(
      "openacr",
      "--config", configPath,
      "--android", join(HERE, "fixtures/baseline-android.json"),
      "--date", "2026-02-31",
      "--out", out,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /aloud openacr: --date must be a real calendar date as YYYY-MM-DD; got "2026-02-31"/);
    assert.equal(existsSync(out), false);
  });

  it("explains in its own terms a --catalog that differs from the bundled catalog", () => {
    const configPath = join(dir, "catalog.config.json");
    writeFileSync(configPath, JSON.stringify({ app: { name: "Fixture App", version: "1.0.0" } }));
    // The bundled catalog with one criterion removed.
    const catalog = load(readFileSync(BUNDLED_CATALOG, "utf8"));
    const chapter = catalog.chapters.find((c) => c.id === "success_criteria_level_a");
    chapter.criteria = chapter.criteria.filter((c) => c.id !== "1.2.1");
    const trimmed = join(dir, "trimmed.yaml");
    writeFileSync(trimmed, dump(catalog));
    const out = join(dir, "trimmed-openacr.yaml");
    const result = aloud(
      "openacr",
      "--config", configPath,
      "--android", join(HERE, "fixtures/baseline-android.json"),
      "--catalog", trimmed,
      "--out", out,
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /aloud openacr: the replacement catalog must have the same chapters and criteria, in the same order, as the bundled 2\.5-edition-wcag-2\.2-508-en catalog/,
    );
    assert.doesNotMatch(result.stderr, /findings/);
    assert.equal(existsSync(out), false);
  });

  it("exits non-zero with a clear message when there is no audit input", () => {
    const configPath = join(dir, "empty.config.json");
    writeFileSync(configPath, JSON.stringify({
      app: { name: "Fixture App", version: "1.0.0" },
      baseline: { android: join(dir, "absent-android.json"), ios: join(dir, "absent-ios.json") },
    }));
    const result = aloud("openacr", "--config", configPath, "--out", join(dir, "none.yaml"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /aloud openacr: no audit input/);
  });
});
