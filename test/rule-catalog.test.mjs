/**
 * Traceability tests for the rule catalog (src/rules/catalog.mjs): every
 * rule id the engines emit is catalogued and every catalogued rule is
 * emitted, every criterion exists in the OpenACR edition the draft is
 * built against, and every criterion the rules reach says what the
 * automation covers. Device-free — reads the rule sources and the
 * installed OpenACR catalog.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { load } from "js-yaml";

import {
  CRITERIA,
  RECLASSIFIED,
  RULES,
  rulesForCriterion,
  ruleSpec,
  splitReclassified,
} from "../src/rules/catalog.mjs";
import { AUTOMATED_CRITERIA, CATALOG_ID } from "../src/report/openacr.mjs";
import { ATF_CHECKS } from "../src/android/atf-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The engines emit through `add("<rule-id>", ...)`, with the id either on
// the same line or on the next one. Collect every literal id per source.
const ENGINES = {
  Android: "../src/android/ui-tree.mjs",
  iOS: "../src/ios/tree.mjs",
};
function emittedIds(path) {
  const source = readFileSync(join(HERE, path), "utf8");
  const ids = [...source.matchAll(/\badd\(\s*"([^"]+)"/g)].map((m) => m[1]);
  // Any add( call without a literal id would escape this check.
  const calls = [...source.matchAll(/\badd\(/g)].length;
  assert.equal(ids.length, calls, `${path}: every add( call must name its rule id as a string literal`);
  return new Set(ids);
}

const openAcrCatalog = load(readFileSync(
  join(dirname(require.resolve("@openacr/openacr/package.json")), "catalog", `${CATALOG_ID}.yaml`),
  "utf8",
));
const openAcrCriteria = new Set(openAcrCatalog.chapters.flatMap((chapter) => chapter.criteria.map((c) => c.id)));

describe("rule catalog traceability", () => {
  it("catalogues exactly the rule ids each engine emits, on the right platform", () => {
    for (const [platform, path] of Object.entries(ENGINES)) {
      const emitted = emittedIds(path);
      const catalogued = Object.keys(RULES).filter((id) => RULES[id].platform === platform);
      for (const id of emitted) {
        assert.ok(Object.hasOwn(RULES, id), `${path} emits ${id}, which is not in the catalog`);
        assert.equal(RULES[id].platform, platform, `${id} is emitted by the ${platform} engine`);
      }
      for (const id of catalogued) {
        assert.ok(emitted.has(id), `${id} is catalogued for ${platform} but ${path} never emits it`);
      }
    }
  });

  it("cross-references ATF checks only to catalogued Android tree rules", () => {
    const overlaps = ATF_CHECKS.flatMap((check) => check.overlaps);
    assert.ok(overlaps.length > 0);
    for (const id of overlaps) {
      assert.ok(Object.hasOwn(RULES, id), `ATF overlap ${id} is not in the catalog`);
      assert.equal(RULES[id].platform, "Android", `ATF overlap ${id} is not an Android rule`);
    }
  });

  it("maps every criterion to one in the OpenACR edition the draft uses", () => {
    for (const [id, rule] of Object.entries(RULES)) {
      for (const criterion of rule.criteria) {
        assert.ok(openAcrCriteria.has(criterion), `${id} maps to ${criterion}, absent from ${CATALOG_ID}`);
      }
    }
    for (const criterion of Object.keys(CRITERIA)) {
      assert.ok(openAcrCriteria.has(criterion), `covers text for ${criterion}, absent from ${CATALOG_ID}`);
    }
  });

  it("maps every error rule to at least one criterion the draft evaluates", () => {
    for (const [id, rule] of Object.entries(RULES)) {
      if (rule.severity !== "error") continue;
      assert.ok(rule.criteria.length > 0, `${id} maps to no criterion`);
      for (const criterion of rule.criteria) {
        assert.ok(AUTOMATED_CRITERIA[criterion]?.rules.includes(id), `${id} does not drive ${criterion}`);
      }
    }
  });

  it("gives every criterion a rule reaches covers text, and no criterion covers text without a rule", () => {
    const used = new Set(Object.values(RULES).flatMap((rule) => rule.criteria));
    for (const criterion of used) {
      assert.ok(CRITERIA[criterion]?.covers?.trim(), `${criterion} has no covers text`);
    }
    assert.deepEqual(Object.keys(CRITERIA).sort(), [...used].sort());
  });

  it("names every report-only warning in the notes of the criteria it reaches", () => {
    for (const criterion of Object.keys(CRITERIA)) {
      const warnings = rulesForCriterion(criterion, "warn");
      if (!warnings.length || !AUTOMATED_CRITERIA[criterion]) continue;
      for (const id of warnings) {
        assert.ok(CRITERIA[criterion].warnings?.includes(id), `${criterion} notes never mention ${id}`);
      }
    }
    // A hand-written count would drift as warnings are added; the ids are
    // the list, so the sentence must not state how many there are.
    for (const [criterion, entry] of Object.entries(CRITERIA)) {
      if (!entry.warnings) continue;
      assert.doesNotMatch(entry.warnings, /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+report-only/i,
        `${criterion} warnings sentence hardcodes a count`);
    }
    // And the notes name no warning the catalog does not map there.
    for (const [criterion, entry] of Object.entries(CRITERIA)) {
      if (!entry.warnings) continue;
      const named = entry.warnings.match(/\b(?:native|ios)-[a-z-]+/g) ?? [];
      for (const id of named) {
        assert.ok(rulesForCriterion(criterion, "warn").includes(id), `${criterion} notes name ${id}, which does not map there`);
      }
    }
  });

  it("keeps each rule's platform, severity, and criteria well formed", () => {
    for (const [id, rule] of Object.entries(RULES)) {
      assert.ok(["error", "warn"].includes(rule.severity), id);
      assert.ok(["Android", "iOS"].includes(rule.platform), id);
      assert.equal(new Set(rule.criteria).size, rule.criteria.length, `${id} repeats a criterion`);
    }
  });

  it("is frozen, so no importer can quietly rewrite a mapping", () => {
    assert.ok(Object.isFrozen(RULES));
    assert.ok(Object.isFrozen(RULES["native-touch-target-small"]));
    assert.ok(Object.isFrozen(RULES["native-touch-target-small"].criteria));
    assert.ok(Object.isFrozen(CRITERIA["2.5.8"]));
    assert.throws(() => {
      RULES["native-touch-target-small"].criteria.push("2.5.5");
    }, TypeError);
  });

  it("ruleSpec fails closed on unknown ids and wrong platforms", () => {
    assert.equal(ruleSpec("ios-target-size-minimum", "iOS").severity, "error");
    assert.throws(() => ruleSpec("ios-new-rule", "iOS"), /unknown rule id/);
    assert.throws(() => ruleSpec("constructor"), /unknown rule id/);
    assert.throws(() => ruleSpec("ios-touch-target-small", "Android"), /runs on iOS/);
  });
});

describe("target-size rules", () => {
  it("gates WCAG 2.5.8 on the 24-unit minimum, not the platform guidelines", () => {
    assert.deepEqual(rulesForCriterion("2.5.8"), ["native-target-size-minimum", "ios-target-size-minimum"]);
    for (const id of ["native-target-size-minimum", "ios-target-size-minimum"]) {
      assert.equal(RULES[id].severity, "error");
      assert.deepEqual(RULES[id].criteria, ["2.5.8"]);
    }
  });

  it("keeps the platform-guideline ids as report-only warnings with no criterion", () => {
    // The ids stay: adopters' committed baselines name them.
    for (const id of ["native-touch-target-small", "ios-touch-target-small"]) {
      assert.equal(RULES[id].severity, "warn");
      assert.deepEqual(RULES[id].criteria, []);
    }
  });

  it("states in the 2.5.8 covers text which exceptions automation cannot judge", () => {
    const covers = CRITERIA["2.5.8"].covers;
    assert.match(covers, /24x24/);
    assert.match(covers, /spacing exception/);
    for (const exception of ["inline", "user-agent control", "essential", "equivalent-control"]) {
      assert.ok(covers.includes(exception), `covers text omits the ${exception} exception`);
    }
    assert.doesNotMatch(covers, /48x48|44x44/);
  });

  it("records each reclassified id's old meaning and its error successor", () => {
    assert.deepEqual(Object.keys(RECLASSIFIED).sort(), ["ios-touch-target-small", "native-touch-target-small"]);
    for (const [id, entry] of Object.entries(RECLASSIFIED)) {
      assert.deepEqual(entry.was, { severity: "error", criteria: ["2.5.8"] });
      assert.equal(RULES[entry.successor].platform, RULES[id].platform);
      assert.equal(RULES[entry.successor].severity, "error");
    }
    assert.ok(Object.isFrozen(RECLASSIFIED["native-touch-target-small"].was.criteria));
  });
});

describe("splitReclassified", () => {
  it("leaves entries without reclassified ids alone", () => {
    const entry = { errors: 2, ruleIds: ["native-interactive-unlabeled"] };
    assert.deepEqual(splitReclassified(entry), { ...entry, retired: [], unchecked: [] });
  });

  it("clears an entry whose only errors came from a reclassified id", () => {
    assert.deepEqual(splitReclassified({ errors: 3, ruleIds: ["native-touch-target-small"] }), {
      errors: 0, ruleIds: [], retired: ["native-touch-target-small"], unchecked: ["2.5.8"],
    });
  });

  it("takes at least one error per retired id from a mixed entry", () => {
    assert.deepEqual(splitReclassified({ errors: 3, ruleIds: ["ios-interactive-unlabeled", "ios-touch-target-small"] }), {
      errors: 2, ruleIds: ["ios-interactive-unlabeled"], retired: ["ios-touch-target-small"], unchecked: ["2.5.8"],
    });
  });
});
