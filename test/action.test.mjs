/**
 * Tests for the "aloud acr" GitHub Action (action.yml). The shape checks
 * read the action file; the run checks execute the action's build step
 * with bash, the way the runner does, against the findings fixtures, with
 * GITHUB_ACTION_PATH at this checkout and temp files standing in for
 * GITHUB_OUTPUT and GITHUB_STEP_SUMMARY. The setup-node and npm ci steps
 * need the network and are exercised by the CI job instead. Device-free.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { load } from "js-yaml";

import { validateAcr } from "../src/acr/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURES = join(HERE, "fixtures/acr");
const action = load(readFileSync(join(ROOT, "action.yml"), "utf8"));
const buildStep = action.runs.steps.find((step) => step.id === "build");

let dir;
before(() => {
  // The real path: macOS tmpdir is a symlink, and the step resolves the real one.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "aloud-action-")));
});
after(() => rmSync(dir, { recursive: true, force: true }));

// Run the build step as the runner would: bash, in the workspace, with the
// step's env filled in from `inputs` (unset inputs get their defaults).
function runBuild(inputs, { summary = true } = {}) {
  const output = join(dir, `output-${Math.random().toString(36).slice(2)}`);
  const stepSummary = join(dir, `summary-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(output, "");
  const env = { PATH: process.env.PATH, GITHUB_ACTION_PATH: ROOT, GITHUB_OUTPUT: output };
  if (summary) env.GITHUB_STEP_SUMMARY = stepSummary;
  for (const [name, expression] of Object.entries(buildStep.env)) {
    const input = expression.match(/^\$\{\{ inputs\.([a-z-]+) \}\}$/)[1];
    env[name] = inputs[input] ?? action.inputs[input].default ?? "";
  }
  const result = spawnSync("bash", ["-c", buildStep.run], { cwd: dir, env, encoding: "utf8" });
  return {
    ...result,
    outputs: readFileSync(output, "utf8"),
    summary: existsSync(stepSummary) ? readFileSync(stepSummary, "utf8") : null,
  };
}

// Read a GITHUB_OUTPUT file the way the runner does: name=value lines and
// name<<DELIMITER blocks. Returns { name: value }; throws on anything else.
function parseOutputs(text) {
  const outputs = {};
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const block = lines[i].match(/^([\w-]+)<<(.+)$/);
    if (block) {
      const end = lines.indexOf(block[2], i + 1);
      assert.ok(end > i, `unterminated ${block[1]} block`);
      outputs[block[1]] = lines.slice(i + 1, end).join("\n");
      i = end;
      continue;
    }
    const pair = lines[i].match(/^([\w-]+)=(.*)$/);
    assert.ok(pair, `unexpected output line ${JSON.stringify(lines[i])}`);
    outputs[pair[1]] = pair[2];
  }
  return outputs;
}

describe("action.yml", () => {
  it("is a composite action with the documented inputs and an acr output", () => {
    assert.equal(action.name, "aloud acr");
    assert.equal(action.runs.using, "composite");
    assert.deepEqual(Object.keys(action.inputs), ["findings", "out", "policy", "catalog", "date"]);
    assert.equal(action.inputs.findings.required, true);
    assert.equal(action.inputs.out.default, "acr.yaml");
    assert.equal(action.outputs.acr.value, "${{ steps.build.outputs.acr }}");
  });

  it("pins every action it uses by full commit SHA and sets up Node 24", () => {
    const uses = action.runs.steps.filter((step) => step.uses);
    assert.ok(uses.length > 0);
    for (const step of uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, step.uses);
    const node = uses.find((step) => step.uses.startsWith("actions/setup-node@"));
    assert.equal(String(node.with["node-version"]), "24");
  });

  it("installs only runtime dependencies, without install scripts, in the action path", () => {
    const install = action.runs.steps.find((step) => /npm ci/.test(step.run ?? ""));
    assert.match(install.run, /cd "\$GITHUB_ACTION_PATH"/);
    assert.match(install.run, /npm ci --omit=dev --ignore-scripts/);
  });

  it("never expands an expression inside a script", () => {
    for (const step of action.runs.steps.filter((s) => s.run)) {
      assert.doesNotMatch(step.run, /\$\{\{/, step.name);
      assert.equal(step.shell, "bash", step.name);
    }
  });
});

describe("action build step", () => {
  it("writes a valid draft, sets the acr output, and appends the level table", () => {
    const result = runBuild({ findings: join(FIXTURES, "valid.json"), out: "reports/acr.yaml" });
    assert.equal(result.status, 0, result.stderr);
    const file = join(dir, "reports/acr.yaml");
    assert.deepEqual(parseOutputs(result.outputs), { acr: file });
    const acr = load(readFileSync(file, "utf8"));
    assert.deepEqual(validateAcr(acr), { valid: true, problems: [] });
    assert.equal(acr.report_date, "2026-09-01");
    assert.match(result.summary, /### Draft OpenACR: Fixture Site 2\.0\.0/);
    assert.match(result.summary, /\| supports \| 1 \|/);
  });

  it("defaults the output to acr.yaml and passes policy, catalog, and date through", () => {
    const catalog = join(ROOT, "node_modules/@openacr/openacr/catalog/2.5-edition-wcag-2.2-508-en.yaml");
    const result = runBuild({
      findings: join(FIXTURES, "valid.json"),
      policy: join(FIXTURES, "policy.json"),
      catalog,
      date: "2026-09-30",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseOutputs(result.outputs), { acr: join(dir, "acr.yaml") });
    const acr = load(readFileSync(join(dir, "acr.yaml"), "utf8"));
    assert.equal(acr.report_date, "2026-09-30");
    const untested = acr.chapters.success_criteria_level_aa.criteria.find((c) => c.num === "1.4.3");
    assert.equal(untested.components[0].adherence.notes, "Fixture policy: this criterion was not tested.");
  });

  it("treats odd paths as paths, not flags or shell code", () => {
    const out = "-odd $(touch pwned) dir/acr.yaml";
    const result = runBuild({ findings: join(FIXTURES, "valid.json"), out });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(dir, out)));
    assert.equal(existsSync(join(dir, "pwned")), false);
    assert.deepEqual(parseOutputs(result.outputs), { acr: join(dir, out) });
  });

  it("writes the acr output with a random heredoc delimiter", () => {
    const first = runBuild({ findings: join(FIXTURES, "valid.json"), out: "delim.yaml" });
    const second = runBuild({ findings: join(FIXTURES, "valid.json"), out: "delim.yaml" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.outputs, /^acr<<ALOUD_ACR_[0-9a-f-]{36}\n/);
    assert.notEqual(first.outputs.split("\n")[0], second.outputs.split("\n")[0]);
  });

  it("refuses an out path with a line break, writing nothing", () => {
    for (const out of ["forged.yaml\nevil=1", "forged.yaml\r"]) {
      const result = runBuild({ findings: join(FIXTURES, "valid.json"), out });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must not contain a line break/);
      assert.equal(result.outputs, "");
      assert.equal(result.summary, null);
      assert.equal(existsSync(join(dir, "forged.yaml")), false);
    }
  });

  it("runs without a step summary outside GitHub Actions", () => {
    const result = runBuild({ findings: join(FIXTURES, "valid.json"), out: "nosummary.yaml" }, { summary: false });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary, null);
  });

  it("fails the step on invalid findings, writing no draft and no output", () => {
    const result = runBuild({ findings: join(FIXTURES, "invalid-criterion.json"), out: "bad/acr.yaml" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /aloud acr: invalid findings:/);
    assert.equal(existsSync(join(dir, "bad/acr.yaml")), false);
    assert.equal(result.outputs, "");
    assert.equal(result.summary, null);
  });

  it("fails the step when the findings input is empty", () => {
    const result = runBuild({ findings: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--findings <file\.json> is required/);
    assert.equal(result.outputs, "");
  });
});
