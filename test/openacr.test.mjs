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
// The policy notes that tell a clean-but-partial row from an incomplete one;
// both are "not-evaluated".
const PARTLY_TESTED = /^The automated tests passed but cover only part of this criterion\./;
const INCOMPLETE = /^Some tests for this criterion did not run/;

describe("real VoiceOver provenance", () => {
  const voiceOver = {
    requestId: "request-1", bundleId: "org.example.app",
    initialSpeechUnavailable: true,
    toolchain: { xcode: "Xcode 27.0", simulatorUdid: "device-1" },
    coverage: { complete: false, start: "current-focus", reason: "step-limit", maxSteps: 20, elapsedMs: 1000 },
  };
  const real = { errors: 0, ruleIds: [], utterances: 2, transcriptSource: "voiceover", voiceOver };
  it("labels mixed real and computed iOS screens and keeps speech criteria unevaluated", () => {
    const acr = build({ android: null, ios: { screens: {
      actual: real,
      computed: { errors: 0, ruleIds: [], utterances: 3, transcriptSource: "computed-voiceover" },
    } } });
    const notes = findCriterion(acr, "302.1").notes;
    assert.match(notes, /iOS actual has 2 raw VoiceOver utterance/);
    assert.match(notes, /partial traversal \(step-limit\)/);
    assert.match(notes, /initial speech read timed out/);
    assert.match(notes, /1 iOS screens.*computed utterances/);
    assert.match(acr.evaluation_methods_used, /XCUIVoiceOverService/);
    assert.equal(findCriterion(acr, "302.1").level, "not-evaluated");
    assert.equal(findCriterion(acr, "2.4.3").level, "not-evaluated");
    const computed = build({ android: null, ios: { screens: {
      actual: { errors: 0, ruleIds: [], utterances: 2 },
      computed: { errors: 0, ruleIds: [], utterances: 3 },
    } } });
    assert.deepEqual(eachAdherence(acr).map((c) => c.adherence.level), eachAdherence(computed).map((c) => c.adherence.level));
  });
  it("rejects missing, inconsistent, complete and wrong-platform real speech evidence", () => {
    for (const mutate of [
      (s) => { delete s.voiceOver; },
      (s) => { delete s.voiceOver.toolchain; },
      (s) => { s.voiceOver.coverage.complete = true; },
      (s) => { s.transcriptSource = "computed-voiceover"; },
      (s) => { s.utterances = null; },
      (s) => { s.voiceOver.initialSpeechUnavailable = 1; },
    ]) {
      const screen = structuredClone(real);
      mutate(screen);
      assert.throws(() => build({ android: null, ios: { screens: { home: screen } } }), /invalid audit/);
    }
    assert.throws(() => build({ ios: null, android: { screens: { home: real } } }), /another platform/);
  });
});

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
    const a = normalizeAudit({ home: { errors: 1, ruleIds: ["native-target-size-minimum"] } });
    assert.equal(a.screens.home.errors, 1);
    assert.equal(a.generated, null);
  });

  it("returns a baseline written before the target-size reclassification as written", () => {
    // buildAcr checks the old ids against the platform they are filed
    // under before it reads them in the current classification.
    const raw = readJson("fixtures/baseline-ios-legacy.json");
    const a = normalizeAudit(raw);
    assert.deepEqual(a.screens, raw);
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
    assert.throws(() => build({ android: bad }), /native-new-rule.*src\/rules\/catalog\.mjs/);
  });

  it("rejects a report-only warning filed as a gating baseline error", () => {
    const bad = normalizeAudit({ home: { errors: 1, ruleIds: ["native-duplicate-speakable"] } });
    assert.throws(() => build({ android: bad }), /native-duplicate-speakable.*report-only warning/);
  });

  it("derives the criterion mapping from the rule catalog", () => {
    // A deliberate snapshot: changing what a rule counts toward changes
    // conformance levels, so it should change this test too.
    const mapping = Object.fromEntries(
      Object.entries(AUTOMATED_CRITERIA).map(([num, { rules }]) => [num, [...rules].sort()]),
    );
    assert.deepEqual(mapping, {
      "1.1.1": ["ios-image-unlabeled", "native-image-button-unlabeled"],
      "1.3.1": ["native-edittext-unlabeled"],
      "2.5.8": ["ios-target-size-minimum", "native-target-size-minimum"],
      "4.1.2": [
        "ios-image-unlabeled",
        "ios-interactive-unlabeled",
        "native-edittext-unlabeled",
        "native-image-button-unlabeled",
        "native-interactive-unlabeled",
      ],
    });
    assert.deepEqual(Object.keys(RULES).sort(), [
      "ios-image-unlabeled",
      "ios-interactive-unlabeled",
      "ios-target-size-minimum",
      "native-edittext-unlabeled",
      "native-image-button-unlabeled",
      "native-interactive-unlabeled",
      "native-target-size-minimum",
    ]);
  });

  it("counts an unlabeled iOS image against 1.1.1 and, conservatively, 4.1.2", () => {
    // The dump cannot tell a static image from a tappable one with no
    // button trait, so an iOS image failure must not leave 4.1.2 at supports.
    const acr = build({ android: null, ios: normalizeAudit({ home: { errors: 1, ruleIds: ["ios-image-unlabeled"] } }) });
    assert.equal(findCriterion(acr, "1.1.1").level, "partially-supports");
    assert.match(findCriterion(acr, "1.1.1").notes, /iOS home: ios-image-unlabeled/);
    assert.equal(findCriterion(acr, "4.1.2").level, "partially-supports");
    assert.match(findCriterion(acr, "4.1.2").notes, /iOS home: ios-image-unlabeled/);
  });

  it("scopes each covers note to the platform whose rules check it", () => {
    // No iOS rule judges image controls for 1.1.1 (an unlabeled iOS
    // Button reaches 4.1.2 only), so the note must not claim it does.
    const acr = build({ android: null, ios: normalizeAudit({ home: { errors: 1, ruleIds: ["ios-interactive-unlabeled"] } }) });
    assert.equal(findCriterion(acr, "1.1.1").level, "not-evaluated");
    assert.match(findCriterion(acr, "1.1.1").notes, PARTLY_TESTED);
    assert.match(findCriterion(acr, "1.1.1").notes, /image controls \(Android\) and image-role elements \(iOS\)/);
    assert.equal(findCriterion(acr, "4.1.2").level, "partially-supports");
  });

  it("points warning-only criteria at their related evidence without a level", () => {
    const adherence = findCriterion(build(), "2.4.6");
    assert.equal(adherence.level, "not-evaluated");
    assert.match(adherence.notes, /\(native-duplicate-speakable, ios-duplicate-speakable\) as warnings/);
  });
});

describe("findFailures", () => {
  it("lists screens whose error rules intersect the criterion rules", () => {
    const audits = [
      {
        platform: "Android",
        screens: {
          "pay-tab": { errors: 1, ruleIds: ["native-target-size-minimum"] },
          home: { errors: 0, ruleIds: [] },
        },
      },
    ];
    const failures = findFailures(["native-target-size-minimum", "ios-target-size-minimum"], audits);
    assert.deepEqual(failures, [
      { platform: "Android", screen: "pay-tab", ruleIds: ["native-target-size-minimum"] },
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
    // workflow). A clean criterion is only partly tested: the rules
    // check part of it, so it never reaches "supports".
    const audits = [
      { platform: "Android", screens: android.screens },
      { platform: "iOS", screens: ios.screens },
    ];
    for (const [num, { rules }] of Object.entries(AUTOMATED_CRITERIA)) {
      const adherence = findCriterion(acr, num);
      const failures = findFailures(rules, audits);
      // A criterion only one platform's rules check cannot be supported
      // for the two-platform app (1.3.1 is Android-only).
      const everyPlatform = new Set(rules.map((r) => RULES[r].platform)).size === 2;
      if (failures.length === 0) {
        assert.equal(adherence.level, "not-evaluated", num);
        assert.match(adherence.notes, everyPlatform ? PARTLY_TESTED : INCOMPLETE, num);
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
    // The shared builder's wording: accurate for native and web products.
    assert.equal(acr.chapters.hardware.notes, "Example App is not a hardware product. Hardware criteria do not apply.");
  });

  it("uses the report date it was given, not the wall clock", () => {
    assert.equal(acr.report_date, "2026-08-26");
  });
});

describe("buildAcr on evidence from before the target-size reclassification", () => {
  const legacy = normalizeAudit(readJson("fixtures/baseline-android-legacy.json"));

  it("leaves 2.5.8 unevaluated instead of failing it on the old 48dp findings", () => {
    // orders-list failed the old 48dp rule. That says nothing about the
    // 24dp minimum, so the screen neither fails nor passes 2.5.8.
    const adherence = findCriterion(build({ android: legacy, ios: null }), "2.5.8");
    assert.equal(adherence.level, "not-evaluated");
    assert.match(adherence.notes, /no violations on 2 Android screens/);
    assert.match(adherence.notes, /Evidence on 1 Android screens predates the current rules for this criterion/);
    assert.match(adherence.notes, /native-touch-target-small as errors/);
    assert.match(adherence.notes, /24x24dp/);
    assert.doesNotMatch(adherence.notes, /Missing tree checks/);
  });

  it("still evaluates the other criteria on those screens", () => {
    const acr = build({ android: legacy, ios: null });
    for (const num of ["4.1.2", "1.3.1"]) {
      assert.equal(findCriterion(acr, num).level, "not-evaluated", num);
      assert.match(findCriterion(acr, num).notes, PARTLY_TESTED, num);
    }
    const mixed = normalizeAudit(readJson("fixtures/baseline-ios-legacy.json"));
    const ios = build({ android: null, ios: mixed });
    assert.equal(findCriterion(ios, "4.1.2").level, "partially-supports");
    assert.equal(findCriterion(ios, "2.5.8").level, "not-evaluated");
  });

  it("reads a mixed old entry's other rules as failing and leaves 2.5.8 unchecked", () => {
    const acr = build({ android: null, ios: normalizeAudit(readJson("fixtures/baseline-ios-legacy.json")) });
    const adherence = findCriterion(acr, "4.1.2");
    assert.match(adherence.notes, /iOS pay: ios-interactive-unlabeled/);
    assert.doesNotMatch(adherence.notes, /ios-touch-target-small/);
  });

  it("rejects an old id filed under the other platform instead of dropping it", () => {
    // An iOS baseline passed as Android: its only errors were the old 44pt
    // id. Dropping it first would count iOS screens as clean Android ones.
    for (const android of [
      normalizeAudit({ pay: { errors: 1, ruleIds: ["ios-touch-target-small"] } }),
      { screens: { pay: { errors: 1, ruleIds: ["ios-touch-target-small"] } } },
    ]) {
      assert.throws(() => build({ android, ios: null }), /"ios-touch-target-small" \(Android pay\): this rule runs on iOS/);
    }
    assert.throws(
      () => build({ android: null, ios: normalizeAudit({ pay: { errors: 1, ruleIds: ["native-touch-target-small"] } }) }),
      /"native-touch-target-small" \(iOS pay\): this rule runs on Android/,
    );
  });

  it("migrates screens passed to buildAcr without normalizeAudit too", () => {
    const acr = build({ android: { screens: readJson("fixtures/baseline-android-legacy.json") }, ios: null });
    assert.equal(findCriterion(acr, "2.5.8").level, "not-evaluated");
  });

  it("accepts summaries that already mark a criterion unchecked, and rejects malformed marks", () => {
    const summary = normalizeAudit({ screens: { home: { errors: 0, ruleIds: [], uncheckedCriteria: ["2.5.8"] } } });
    assert.equal(findCriterion(build({ android: summary, ios: null }), "2.5.8").level, "not-evaluated");
    // Only a criterion a reclassified rule used to count toward can be
    // unchecked on completed evidence; 1.1.1 was never reclassified.
    for (const uncheckedCriteria of [[], ["2.5.8", "2.5.8"], ["9.9.9"], ["2.4.6"], ["1.1.1"], ["4.1.2"], "2.5.8"]) {
      assert.throws(() => normalizeAudit({ home: { errors: 0, ruleIds: [], uncheckedCriteria } }), /uncheckedCriteria/);
    }
    assert.throws(() => normalizeAudit({ home: { errors: null, ruleIds: [], uncheckedCriteria: ["2.5.8"] } }),
      /needs completed tree checks/);
  });

  it("still validates against schema and catalog", () => {
    const acr = build({ android: legacy });
    assert.equal(validateOpenACR(acr, "openacr-0.1.0.json").result, true);
    assert.equal(validateOpenACRCatalogValues(acr, catalog).result, true);
  });
});

describe("buildAcr on a failing fixture", () => {
  const failing = normalizeAudit({
    "pay-tab": { errors: 2, ruleIds: ["native-target-size-minimum"] },
    home: { errors: 0, ruleIds: [] },
  });
  const acr = build({ android: failing });

  it("downgrades the mapped criterion to partially-supports with evidence", () => {
    const adherence = findCriterion(acr, "2.5.8");
    assert.equal(adherence.level, "partially-supports");
    assert.ok(adherence.notes.includes("pay-tab"));
    assert.ok(adherence.notes.includes("native-target-size-minimum"));
  });

  it("leaves unrelated automated criteria partly tested, not failing", () => {
    assert.equal(findCriterion(acr, "4.1.2").level, "not-evaluated");
    assert.match(findCriterion(acr, "4.1.2").notes, PARTLY_TESTED);
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
    assert.equal(findCriterion(acr, "4.1.2").level, "not-evaluated");
    assert.match(findCriterion(acr, "4.1.2").notes, PARTLY_TESTED);
  });

  it("counts only applicable platforms as checked for a criterion", () => {
    const acr = build({
      android: summary({ home: completed }),
      ios: summary({ home: completed, settings: completed }),
    });
    const adherence = findCriterion(acr, "1.3.1");
    // The iOS half of the software component was never checked for 1.3.1,
    // so a clean Android result cannot support the row.
    assert.equal(adherence.level, "not-evaluated");
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
    assert.match(findCriterion(acr, "4.1.2").notes, INCOMPLETE);
    assert.match(findCriterion(acr, "1.3.1").notes, INCOMPLETE);
    // An Android-only audit is all the software component there is to
    // check, so it is partly tested there rather than incomplete.
    const androidOnly = findCriterion(build({ android: summary({ home: completed }), ios: null }), "1.3.1");
    assert.equal(androidOnly.level, "not-evaluated");
    assert.match(androidOnly.notes, PARTLY_TESTED);
  });

  it("keeps a known failure on the platform that has rules when the other has none", () => {
    const acr = build({
      android: summary({ home: { errors: 1, ruleIds: ["native-edittext-unlabeled"], utterances: null } }),
      ios: summary({ home: completed }),
    });
    const adherence = findCriterion(acr, "1.3.1");
    assert.equal(adherence.level, "partially-supports");
    assert.match(adherence.notes, /no applicable.*iOS/i);
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
      const result = spawnSync(process.execPath, [join(HERE, "../bin/aloud.mjs"), "openacr", "--config", configPath], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /JSON|invalid audit/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("retains TalkBack focus provenance without adding conformance coverage", () => {
  const summary = { screens: { fixture: {
    errors: 0, warns: 0, ruleIds: [], utterances: 2, transcriptSource: "talkback-focus",
    talkBackFocus: { coverage: { complete: true, reason: "forward-edge", start: "backward-edge", maxSteps: 100 },
      requestId: "request", target: "org.example", speechSource: "talkback-tts-request-listener",
      talkbackCommit: "229212fdf5842191d0a93fc95d9ca1423b346866" },
  } } };
  const acr = build({ android: normalizeAudit(summary), ios: null });
  const yaml = toYaml(acr);
  assert.match(yaml, /both native traversal boundaries verified/);
  assert.match(yaml, /does not prove audible delivery/);
  for (const complete of [false, undefined]) {
    const invalid = structuredClone(summary); invalid.screens.fixture.talkBackFocus.coverage.complete = complete;
    assert.throws(() => build({ android: normalizeAudit(invalid), ios: null }), /TalkBack focus needs complete traversal provenance/);
  }
  assert.throws(() => build({ android: null, ios: normalizeAudit(summary) }), /another platform/);
});

it("keeps logging-engine request accounting separate from audible delivery and conformance", () => {
  const c = readJson("fixtures/logging-tts-android14/capture.json");
  const summary = { generated: "2026-09-15T00:00:00.000Z", screens: { nested: {
    errors: null, warns: null, ruleIds: [], utterances: 8, transcriptSource: "talkback-focus",
    talkBackFocus: { coverage: c.coverage, requestId: c.requestId, target: c.target,
      speechSource: "logging-tts", talkbackCommit: c.commands[0].talkbackCommit,
      loggingTts: { schemaVersion: 1, source: "logging-tts", output: "synthetic-silence", complete: true,
        engine: "org.irs_public.aloud.tts", clientSession: c.commands[0].tts.clientSession,
        engineSession: "22222222-2222-4222-8222-222222222222", requests: 9, queueEvents: 1 } },
  } } };
  const acr = build({ android: normalizeAudit(summary), ios: null });
  assert.match(findCriterion(acr, "302.1").notes, /synthetic silence, not spoken audio/);
  assert.equal(findCriterion(acr, "302.1").level, "not-evaluated");
  for (const mutate of [
    (t) => { t.loggingTts.complete = false; }, (t) => { t.loggingTts.output = "speech"; },
    (t) => { t.loggingTts.requests = 1; }, (t) => { t.loggingTts.engineSession = "missing"; },
    (t) => { t.speechSource = "talkback-tts-request-listener"; },
  ]) {
    const invalid = structuredClone(summary); mutate(invalid.screens.nested.talkBackFocus);
    assert.throws(() => build({ android: normalizeAudit(invalid), ios: null }), /logging TTS/);
  }
});
