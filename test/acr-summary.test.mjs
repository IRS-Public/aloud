/**
 * Tests for src/acr/summary.mjs: the conformance-level count written to a
 * CI job summary. Built from the real builder on the findings fixture, plus
 * hand-made reports for the edge cases. Device-free.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildAcr } from "../src/acr/build.mjs";
import { ADHERENCE_LEVELS } from "../src/acr/levels.mjs";
import { levelCounts, summaryMarkdown } from "../src/acr/summary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const findings = JSON.parse(readFileSync(join(HERE, "fixtures/acr/valid.json"), "utf8"));

// A minimal report: one chapter, each row at the given level.
function report(levels, extraChapters = {}) {
  return {
    product: { name: "Tiny", version: "1" },
    report_date: "2026-09-30",
    chapters: {
      only: {
        criteria: levels.map((level, index) => ({
          num: `1.${index}`,
          components: [{ name: "web", adherence: { level, notes: "n" } }],
        })),
      },
      ...extraChapters,
    },
  };
}

describe("levelCounts", () => {
  it("counts every component row of a built draft, in level order", () => {
    const { levels, rows, disabledChapters } = levelCounts(buildAcr(findings));
    assert.deepEqual(Object.keys(levels), ADHERENCE_LEVELS);
    assert.equal(levels.supports, 1);
    assert.equal(levels["partially-supports"], 1);
    assert.equal(levels["does-not-support"], 0);
    assert.equal(rows, Object.values(levels).reduce((sum, n) => sum + n, 0));
    assert.equal(disabledChapters, 1, "the hardware chapter is disabled by default");
  });

  it("skips disabled chapters", () => {
    const acr = report(["supports"], { hardware: { disabled: true, notes: "Not hardware." } });
    assert.deepEqual(levelCounts(acr).levels.supports, 1);
    assert.equal(levelCounts(acr).rows, 1);
    assert.equal(levelCounts(acr).disabledChapters, 1);
  });

  it("throws on a level OpenACR does not define, or on no chapters", () => {
    assert.throws(() => levelCounts(report(["supports", "passes"])), /criterion 1\.1 in chapter only has unknown level "passes"/);
    assert.throws(() => levelCounts(report([undefined])), /unknown level undefined/);
    assert.throws(() => levelCounts({}), /needs an OpenACR object with chapters/);
    assert.throws(() => levelCounts(null), /needs an OpenACR object with chapters/);
  });
});

describe("summaryMarkdown", () => {
  it("names the product and file, lists every level, and says it is a draft", () => {
    const text = summaryMarkdown(report(["supports", "not-evaluated", "not-evaluated"]), { file: "out/acr.yaml" });
    assert.equal(
      text,
      [
        "### Draft OpenACR: Tiny 1",
        "",
        "Written to `out/acr.yaml` (report date 2026-09-30).",
        "",
        "| Conformance level | Rows |",
        "|---|---:|",
        "| supports | 1 |",
        "| partially-supports | 0 |",
        "| does-not-support | 0 |",
        "| not-applicable | 0 |",
        "| not-evaluated | 2 |",
        "| **Total** | **3** |",
        "",
        "This is a draft for human review, not a conformance claim: every not-evaluated row still needs testing.",
        "",
      ].join("\n"),
    );
  });

  it("mentions disabled chapters and omits the file line when no file is given", () => {
    const one = summaryMarkdown(report(["supports"], { hardware: { disabled: true } }));
    assert.doesNotMatch(one, /Written to/);
    assert.match(one, /and 1 chapter is disabled\.$/m);
    const two = summaryMarkdown(report(["supports"], { a: { disabled: true }, b: { disabled: true } }));
    assert.match(two, /and 2 chapters are disabled\.$/m);
  });
});
