/**
 * Unit tests for the draft OpenACR emitter (src/report/openacr.mjs):
 * the emitted report must validate against the real OpenACR schema and
 * catalog (@openacr/openacr), never contain a silent pass, and state
 * honestly what automation does and does not cover. Device-free — the
 * fixture baselines and small inline fixtures stand in for audit runs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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

describe("report-only Apple audit evidence", () => {
  it("acknowledges native findings without expanding conformance coverage", () => {
    const screen = { errors: 0, ruleIds: [], utterances: 1 };
    const without = build({ android: null, ios: { screens: { home: screen } } });
    const withApple = build({ android: null, ios: { screens: { home: {
      ...screen, appleAudit: { status: "completed", issues: 2, reportOnly: true },
    } } } });
    assert.deepEqual(withApple.chapters, without.chapters);
    assert.match(withApple.notes, /2 finding\(s\) requiring review/);
    assert.match(withApple.evaluation_methods_used, /report-only and do not assign conformance levels/);
    assert.match(findCriterion(withApple, "4.1.2").notes, /automated tree checks/);
    assert.doesNotMatch(findCriterion(withApple, "4.1.2").notes, /native audit found no violations/);
  });

  it("rejects incomplete or malformed native summaries", () => {
    for (const appleAudit of [null, {}, { status: "failed", issues: 0, reportOnly: true },
      { status: "completed", issues: -1, reportOnly: true },
      { status: "completed", issues: 0, reportOnly: false },
    ]) assert.throws(() => normalizeAudit({ home: { errors: 0, ruleIds: [], appleAudit } }), /Apple audit/);
  });
});

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

  it("distinguishes baseline screen counts from unverified transcript coverage", () => {
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
    assert.match(fpc.notes, /transcript coverage.*unavailable/i);
  });

  it("scales the baseline coverage counts with the input, never a fixed count", () => {
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


describe("OpenACR evidence coverage", () => {
  const summary = (screens) => normalizeAudit({ generated: "2026-09-05T00:00:00.000Z", screens });
  const completed = { errors: 0, ruleIds: [], utterances: null };
  const transcriptOnly = { errors: null, ruleIds: [], utterances: 2 };

  it("does not pass any tree criterion after a transcript-only run", () => {
    const acr = build({ android: summary({ home: transcriptOnly }), ios: null });
    for (const num of Object.keys(AUTOMATED_CRITERIA)) {
      const adherence = findCriterion(acr, num);
      assert.equal(adherence.level, "not-evaluated", num);
      assert.match(adherence.notes, /no completed tree checks/i);
    }
    assert.doesNotMatch(acr.notes, /tree checks.*run on every audited screen/);
    assert.match(findCriterion(acr, "302.1").notes, /1 Android screens.*captured speech/);
    assert.equal(validateOpenACR(acr, "openacr-0.1.0.json").result, true);
    assert.equal(validateOpenACRCatalogValues(acr, catalog).result, true);
  });

  it("leaves the Android-only criterion unevaluated for iOS-only audits", () => {
    const acr = build({ android: null, ios: summary({ home: completed }) });
    const adherence = findCriterion(acr, "1.3.1");
    assert.equal(adherence.level, "not-evaluated");
    assert.match(adherence.notes, /no applicable.*checks/i);
    assert.equal(findCriterion(acr, "4.1.2").level, "supports");
  });

  it("counts only applicable platforms as checked for a criterion", () => {
    const acr = build({
      android: summary({ home: completed }),
      ios: summary({ home: completed, settings: completed }),
    });
    const adherence = findCriterion(acr, "1.3.1");
    assert.equal(adherence.level, "supports");
    assert.match(adherence.notes, /no violations on 1 Android screens/);
    assert.doesNotMatch(adherence.notes, /no violations on .*iOS screens/);
    assert.match(adherence.notes, /no applicable.*iOS/i);
  });

  it("withholds a clean verdict when applicable screens lack tree checks", () => {
    const acr = build({
      android: summary({ home: completed, payment: transcriptOnly }),
      ios: null,
    });
    for (const num of Object.keys(AUTOMATED_CRITERIA)) {
      const adherence = findCriterion(acr, num);
      assert.equal(adherence.level, "not-evaluated", num);
      assert.match(adherence.notes, /no violations on 1 Android screens/);
      assert.match(adherence.notes, /missing tree checks.*1 Android screens/i);
    }
  });

  it("does not hide known failures when other screens are incomplete", () => {
    const acr = build({
      android: summary({
        home: { errors: 1, ruleIds: ["native-interactive-unlabeled"], utterances: null },
        payment: transcriptOnly,
      }),
      ios: null,
    });
    const adherence = findCriterion(acr, "4.1.2");
    assert.equal(adherence.level, "partially-supports");
    assert.match(adherence.notes, /violations on 1 of 1 Android screens/);
    assert.match(adherence.notes, /Android home: native-interactive-unlabeled/);
    assert.match(adherence.notes, /missing tree checks.*1 Android screens/i);
    assert.equal(findCriterion(acr, "1.1.1").level, "not-evaluated");
  });

  it("does not let a clean platform mask an incomplete applicable platform", () => {
    const acr = build({ android: summary({ home: completed }), ios: summary({ home: transcriptOnly }) });
    assert.equal(findCriterion(acr, "4.1.2").level, "not-evaluated");
    assert.equal(findCriterion(acr, "1.3.1").level, "supports");
  });

  it("counts captured speech separately from absent or empty transcripts", () => {
    const acr = build({
      android: summary({
        spoken: { ...completed, utterances: 2 },
        silent: { ...completed, utterances: 0 },
        treeOnly: completed,
      }),
      ios: null,
    });
    const notes = findCriterion(acr, "302.1").notes;
    assert.match(notes, /1 Android screens.*captured speech/);
    assert.match(notes, /1 Android screens.*no captured speech/);
    assert.match(notes, /transcript coverage.*unavailable.*1 Android screens/i);
    assert.doesNotMatch(notes, /3 Android screens.*captured speech/);
    assert.doesNotMatch(acr.evaluation_methods_used, /transcripts captured per screen/);
    assert.doesNotMatch(findCriterion(acr, "2.5.5").notes, /on every audited screen/);
  });

  it("identifies iOS transcript entries as computed output", () => {
    const acr = build({ android: null, ios: summary({ home: { ...completed, utterances: 2 } }) });
    const notes = findCriterion(acr, "302.1").notes;
    assert.match(notes, /1 iOS screens.*computed utterances/);
    assert.doesNotMatch(notes, /captured speech/);
  });

  it("rejects missing or empty audit inputs, even beside a populated platform", () => {
    assert.throws(() => build({ android: null, ios: null }), /no audit input/i);
    for (const input of [{}, { screens: {} }]) {
      assert.throws(() => build({ android: normalizeAudit(input), ios: null }), /no screens/i);
      assert.throws(() => build({ android: normalizeAudit(input) }), /no screens/i);
    }
  });

  it("rejects malformed evidence instead of interpreting it as a pass", () => {
    const badScreens = [
      null,
      [],
      {},
      { errors: -1, ruleIds: [] },
      { errors: 0.5, ruleIds: [] },
      { errors: "0", ruleIds: [] },
      { errors: 0 },
      { errors: 0, ruleIds: "native-interactive-unlabeled" },
      { errors: 1, ruleIds: [] },
      { errors: 0, ruleIds: ["native-interactive-unlabeled"] },
      { errors: null, ruleIds: ["native-interactive-unlabeled"] },
      { errors: 1, ruleIds: ["native-interactive-unlabeled", "native-edittext-unlabeled"] },
      { errors: 1, ruleIds: [1] },
      { errors: 0, ruleIds: [], utterances: -1 },
    ];
    for (const screen of badScreens) {
      assert.throws(
        () => build({ android: summary({ broken: screen }), ios: null }),
        /invalid audit.*broken/i,
        JSON.stringify(screen),
      );
    }
    for (const input of [null, [], "invalid", { screens: null }, { screens: [] }]) {
      assert.throws(() => build({ android: normalizeAudit(input), ios: null }), /invalid audit/i);
    }
  });

  it("rejects known rule IDs filed under the wrong platform", () => {
    assert.throws(
      () => build({ android: summary({ home: { errors: 1, ruleIds: ["ios-interactive-unlabeled"] } }) }),
      /ios-interactive-unlabeled.*Android/,
    );
  });
});

describe("OpenACR CLI evidence validation", () => {
  it("fails on a malformed configured baseline instead of silently dropping the platform", () => {
    const dir = mkdtempSync(join(tmpdir(), "aloud-openacr-invalid-"));
    try {
      const androidPath = join(dir, "android.json");
      const iosPath = join(dir, "ios.json");
      const configPath = join(dir, "config.json");
      const outputPath = join(dir, "draft.yaml");
      writeFileSync(androidPath, JSON.stringify({ home: { errors: 0, ruleIds: [] } }));
      writeFileSync(iosPath, '{"home":');
      writeFileSync(configPath, JSON.stringify({
        app: { name: "Fixture app", version: "1.0.0" },
        baseline: { android: androidPath, ios: iosPath },
        openacr: { out: outputPath },
      }));
      const result = spawnSync(process.execPath, [join(HERE, "../src/report/openacr.mjs")], {
        encoding: "utf8",
        env: { ...process.env, ALOUD_CONFIG: configPath },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /JSON|invalid audit/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
