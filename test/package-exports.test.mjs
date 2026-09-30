/**
 * Tests for the package's public entry points (package.json "exports").
 * Node resolves a package's own name from inside it once "exports" is set,
 * so each import below goes through the same map an installed consumer
 * would. Importing the web drivers loads no browser or screen reader; they
 * start nothing until called. Device-free.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const require = createRequire(import.meta.url);

// Each named entry and the source file it must be.
const ENTRIES = {
  "@irs-public/aloud": "../src/index.mjs",
  "@irs-public/aloud/acr": "../src/acr/index.mjs",
  "@irs-public/aloud/rules": "../src/rules/catalog.mjs",
  "@irs-public/aloud/web/nvda": "../src/web/nvda.mjs",
  "@irs-public/aloud/web/voiceover": "../src/web/voiceover.mjs",
  "@irs-public/aloud/web/dependencies": "../src/web/dependencies.mjs",
};

describe("package exports", () => {
  it("resolves every named entry to the same module as its source path", async () => {
    for (const [specifier, file] of Object.entries(ENTRIES)) {
      const byName = await import(specifier);
      const byPath = await import(file);
      assert.equal(byName, byPath, specifier);
    }
  });

  it("exposes the OpenACR engine at the root and at ./acr", async () => {
    const root = await import("@irs-public/aloud");
    const acr = await import("@irs-public/aloud/acr");
    for (const name of ["buildAcr", "toYaml", "validateAcr", "validateFindings", "summaryMarkdown", "levelCounts"]) {
      assert.equal(typeof root[name], "function", name);
      assert.equal(root[name], acr[name], name);
    }
    assert.deepEqual(Object.keys(root).sort(), Object.keys(acr).sort());
  });

  it("keeps the APIs the USWDS harness uses from the web drivers", async () => {
    const nvda = await import("@irs-public/aloud/web/nvda");
    for (const name of ["startNvda", "nvdaCommand", "stopNvda"]) assert.equal(typeof nvda[name], "function", name);
    const dependencies = await import("@irs-public/aloud/web/dependencies");
    for (const name of ["webDependency", "axeCoreSource"]) assert.equal(typeof dependencies[name], "function", name);
    const voiceover = await import("@irs-public/aloud/web/voiceover");
    for (const name of ["startVoiceOver", "voiceOverCommand", "settleVoiceOver", "stopVoiceOver"]) {
      assert.equal(typeof voiceover[name], "function", name);
    }
  });

  it("exposes the rule catalog at ./rules", async () => {
    const rules = await import("@irs-public/aloud/rules");
    assert.equal(typeof rules.RULES, "object");
    assert.equal(typeof rules.ruleSpec, "function");
  });

  it("keeps deep src/, bin/, and example paths working, as before 0.2.0", async () => {
    const deep = await import("@irs-public/aloud/src/acr/index.mjs");
    assert.equal(deep, await import("../src/acr/index.mjs"));
    const compat = await import("@irs-public/aloud/src/report/openacr.mjs");
    assert.equal(typeof compat.buildAcr, "function");
    assert.equal(require.resolve("@irs-public/aloud/bin/aloud.mjs"), join(ROOT, "bin/aloud.mjs"));
    assert.equal(
      require.resolve("@irs-public/aloud/examples/aloud.config.example.json"),
      join(ROOT, "examples/aloud.config.example.json"),
    );
  });

  it("resolves the findings schema and package.json", () => {
    const schema = require("@irs-public/aloud/findings.schema.json");
    assert.deepEqual(schema, JSON.parse(readFileSync(join(ROOT, "src/acr/findings.schema.json"), "utf8")));
    assert.equal(require("@irs-public/aloud/package.json").version, pkg.version);
  });

  it("points every export at a file that exists and ships in the package", () => {
    // A "files" entry is a directory ("src/"), a file, or a one-star glob.
    const matches = (entry, target) => {
      if (entry.endsWith("/")) return target.startsWith(entry);
      const [head, tail] = entry.split("*");
      if (tail === undefined) return target === entry;
      return target.startsWith(head) && target.endsWith(tail) && !target.slice(head.length).includes("/");
    };
    const shipped = (target) => pkg.files.some((entry) => matches(entry, target));
    for (const [key, target] of Object.entries(pkg.exports)) {
      assert.match(target, /^\.\//, key);
      const relative = target.slice(2);
      if (relative === "package.json") continue;
      if (relative.includes("*")) {
        assert.ok(shipped(relative.replace("*", "x")), `${key} -> ${target} is not in "files"`);
        continue;
      }
      assert.ok(existsSync(join(ROOT, relative)), `${key} -> ${target} does not exist`);
      assert.ok(shipped(relative), `${key} -> ${target} is not in "files"`);
    }
  });

  it("ships the bin, the GitHub Action, the examples, and the changelog", () => {
    for (const entry of ["bin/", "src/", "examples/*.json", "action.yml", "CHANGELOG.md", "src/acr/findings.schema.json"]) {
      assert.ok(pkg.files.includes(entry), entry);
    }
    assert.equal(pkg.bin.aloud, "bin/aloud.mjs");
    assert.ok(existsSync(join(ROOT, "action.yml")));
  });
});
