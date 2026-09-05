import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function report(t, checked, unchecked, gate = true) {
  const out = mkdtempSync(join(tmpdir(), "aloud-capture-report-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const baseline = {};
  for (const id of [...checked, ...unchecked]) {
    baseline[id] = { errors: 0, ruleIds: [] };
    writeFileSync(join(out, `${id}.transcript.json`), JSON.stringify({
      screen: id, source: "talkback", transcript: ["Ready"],
    }));
  }
  for (const id of checked) {
    writeFileSync(join(out, `${id}.tree.json`), JSON.stringify({
      screen: id, violations: [], gate: baseline[id],
    }));
  }
  const baselinePath = join(out, "baseline.json");
  writeFileSync(baselinePath, JSON.stringify(baseline));
  const res = spawnSync(process.execPath, [
    join(ROOT, "src", "report", "report.mjs"), "--dir", out, "--baseline", baselinePath,
    ...(gate ? ["--gate"] : []),
  ], { encoding: "utf8", env: { ...process.env, ALOUD_CONFIG: "" } });
  return { ...res, out };
}

describe("report gate requires completed tree checks", () => {
  for (const [name, checked] of [["transcript-only reports", []], ["partially checked reports", ["checked"]]]) {
    it(`fails ${name} and identifies the unchecked screen`, (t) => {
      const res = report(t, checked, ["unchecked"]);
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stderr, /unchecked: .*tree checks/i);
      assert.doesNotMatch(res.stdout, /508 gate passed/);
    });
  }

  it("still generates transcript-only evidence when gating is disabled", (t) => {
    const res = report(t, [], ["unchecked"], false);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(join(res.out, "summary.json")), true);
    assert.equal(existsSync(join(res.out, "index.html")), true);
  });

  it("passes a report whose screens all have completed checks", (t) => {
    const res = report(t, ["checked"], []);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /508 gate passed/);
  });
});
