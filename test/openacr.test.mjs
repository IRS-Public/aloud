/**
 * Unit tests for the draft OpenACR emitter (src/report/openacr.mjs):
 * the emitted report must validate against the real OpenACR schema and
 * catalog (@openacr/openacr), never contain a silent pass, and state
 * honestly what automation does and does not cover. Device-free — the
 * fixture baselines and small inline fixtures stand in for audit runs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { load } from "js-yaml";

import {
  AUTOMATED_CRITERIA,
  CATALOG_ID,
  RULES,
  buildAcr,
  findFailures,
  normalizeAudit,
  toYaml,
} from "../src/report/openacr.mjs";

// The validator ships as CJS with no type declarations.
const require = createRequire(import.meta.url);
const { validateOpenACR } = require("@openacr/openacr/dist/validateOpenACR.js");
const {
  validateOpenACRCatalogValues,
} = require("@openacr/openacr/dist/validateOpenACRCatalogValues.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(HERE, p), "utf8"));

const catalog = load(
  readFileSync(
    join(dirname(require.resolve("@openacr/openacr/package.json")), "catalog", `${CATALOG_ID}.yaml`),
    "utf8",
  ),
);
const android = normalizeAudit(readJson("fixtures/baseline-android.json"));
const ios = normalizeAudit(readJson("fixtures/baseline-ios.json"));

const build = (overrides = {}) =>
  buildAcr({
    catalog,
    android,
    ios,
    date: "2026-08-26",
    productVersion: "1.0.0",
    appName: "Example App",
    ...overrides,
  });

const eachAdherence = (acr) => {
  const out = [];
  for (const [chapterId, chapter] of Object.entries(acr.chapters)) {
    for (const criterion of chapter.criteria ?? []) {
      for (const component of criterion.components) {
        out.push({ chapter: chapterId, num: criterion.num, adherence: component.adherence });
      }
    }
  }
  return out;
};

const findCriterion = (acr, num) => eachAdherence(acr).find((c) => c.num === num)?.adherence;

describe("normalizeAudit", () => {
  it("accepts the flat baseline map", () => {
    const a = normalizeAudit({ home: { errors: 1, ruleIds: ["native-touch-target-small"] } });
    assert.equal(a.screens.home.errors, 1);
    assert.equal(a.generated, null);
  });

  it("accepts report.mjs summary.json", () => {
    const a = normalizeAudit({
      generated: "2026-08-20T01:02:03.000Z",
      screens: { home: { errors: 0, ruleIds: [], utterances: 4 } },
    });
    assert.equal(a.screens.home.errors, 0);
    assert.equal(a.generated, "2026-08-20T01:02:03.000Z");
  });
});

describe("rule mapping", () => {
  it("maps every audit rule id to at least one automated criterion", () => {
    const mapped = Object.values(AUTOMATED_CRITERIA).flatMap((c) => c.rules);
    for (const ruleId of Object.keys(RULES)) {
      assert.ok(mapped.includes(ruleId), `${ruleId} is not mapped to any criterion`);
    }
  });

  it("rejects a baseline rule id the emitter does not know", () => {
    const bad = normalizeAudit({ home: { errors: 1, ruleIds: ["native-new-rule"] } });
    assert.throws(() => build({ android: bad }), /native-new-rule/);
  });
});

describe("findFailures", () => {
  it("lists screens whose error rules intersect the criterion rules", () => {
    const audits = [
      {
        platform: "Android",
        screens: {
          "pay-tab": { errors: 1, ruleIds: ["native-touch-target-small"] },
          home: { errors: 0, ruleIds: [] },
        },
      },
    ];
    const failures = findFailures(["native-touch-target-small", "ios-touch-target-small"], audits);
    assert.deepEqual(failures, [
      { platform: "Android", screen: "pay-tab", ruleIds: ["native-touch-target-small"] },
    ]);
  });
});

describe("buildAcr on the fixture baselines", () => {
  const acr = build();

  it("validates against the OpenACR schema", () => {
    const result = validateOpenACR(acr, "openacr-0.1.0.json");
    assert.equal(result.message, "Valid!");
    assert.equal(result.result, true);
  });

  it("uses only catalog criteria, components, and terms", () => {
    const result = validateOpenACRCatalogValues(acr, catalog);
    assert.equal(result.message, "Valid!");
    assert.equal(result.result, true);
  });

  it("round-trips through YAML unchanged", () => {
    assert.deepEqual(load(toYaml(acr)), acr);
  });

  it("takes the product name and title from the config, not a hardcoded app", () => {
    assert.equal(acr.product.name, "Example App");
    assert.equal(acr.title, "Example App Accessibility Conformance Report (draft)");
    assert.equal(acr.product.description, "Example App mobile app for iOS and Android.");
  });

  it("refuses to build without an app name", () => {
    assert.throws(() => build({ appName: undefined }), /app name/);
  });

  it("never emits a silent pass: every adherence has a level and notes", () => {
    const rows = eachAdherence(acr);
    assert.ok(rows.length > 50);
    for (const { adherence } of rows) {
      assert.ok(adherence.level);
      assert.ok((adherence.notes ?? "").length > 20);
    }
  });

  it("caveats every automation result as partial coverage", () => {
    // A baseline may legitimately carry accepted errors (the ratchet
    // workflow); expect "supports" only when the criterion is clean.
    const audits = [
      { platform: "Android", screens: android.screens },
      { platform: "iOS", screens: ios.screens },
    ];
    for (const [num, { rules }] of Object.entries(AUTOMATED_CRITERIA)) {
      const adherence = findCriterion(acr, num);
      const failures = findFailures(rules, audits);
      if (failures.length === 0) {
        assert.equal(adherence.level, "supports");
      } else {
        assert.equal(adherence.level, "partially-supports");
        assert.ok(adherence.notes.includes(failures[0].screen));
      }
      assert.ok(adherence.notes.includes("part of this criterion"));
      assert.ok(adherence.notes.includes("human review"));
    }
  });

  it("marks unautomated criteria not-evaluated with a human-review note", () => {
    const adherence = findCriterion(acr, "1.2.1");
    assert.equal(adherence.level, "not-evaluated");
    assert.ok(adherence.notes.includes("human review"));
  });

  it("records the screen-reader transcript coverage with computed counts", () => {
    const androidCount = Object.keys(android.screens).length;
    const iosCount = Object.keys(ios.screens).length;
    assert.ok(acr.notes.includes(`${androidCount} on Android`));
    assert.ok(acr.notes.includes(`${iosCount} on iOS`));
    assert.ok(acr.notes.includes("TalkBack"));
    assert.ok(acr.notes.includes("VoiceOver"));
    const fpc = findCriterion(acr, "302.1");
    assert.ok(fpc.notes.includes(`${androidCount} Android screens`));
    assert.ok(fpc.notes.includes(`${iosCount} iOS screens`));
    assert.ok(fpc.notes.includes("TalkBack"));
    assert.ok(fpc.notes.includes("VoiceOver"));
  });

  it("scales the transcript counts with the input, never a fixed count", () => {
    const two = normalizeAudit({
      home: { errors: 0, ruleIds: [] },
      "pay-tab": { errors: 0, ruleIds: [] },
    });
    const partial = build({ android: two });
    assert.ok(partial.notes.includes("2 on Android"));
    assert.ok(findCriterion(partial, "302.1").notes.includes("2 Android screens"));
  });

  it("disables the hardware chapter with a reason", () => {
    assert.equal(acr.chapters.hardware.disabled, true);
    assert.ok(acr.chapters.hardware.notes.includes("software application"));
  });

  it("uses the report date it was given, not the wall clock", () => {
    assert.equal(acr.report_date, "2026-08-26");
  });
});

describe("buildAcr on a failing fixture", () => {
  const failing = normalizeAudit({
    "pay-tab": { errors: 2, ruleIds: ["native-touch-target-small"] },
    home: { errors: 0, ruleIds: [] },
  });
  const acr = build({ android: failing });

  it("downgrades the mapped criterion to partially-supports with evidence", () => {
    const adherence = findCriterion(acr, "2.5.8");
    assert.equal(adherence.level, "partially-supports");
    assert.ok(adherence.notes.includes("pay-tab"));
    assert.ok(adherence.notes.includes("native-touch-target-small"));
  });

  it("leaves unrelated automated criteria at supports", () => {
    assert.equal(findCriterion(acr, "4.1.2").level, "supports");
  });

  it("still validates against schema and catalog", () => {
    assert.equal(validateOpenACR(acr, "openacr-0.1.0.json").result, true);
    assert.equal(validateOpenACRCatalogValues(acr, catalog).result, true);
  });
});
