/**
 * Unit tests for the aloud evidence adapter (src/acr/from-aloud.mjs): the
 * native baselines, report summaries, and report-only web summary become a
 * findings document the shared builder accepts, with today's conformance
 * semantics: met only on complete, clean evidence; failures partial, never
 * "all"; gaps incomplete; web report-only. Device-free.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { TRUNCATION_MARKER, buildAcr, validateFindings } from "../src/acr/index.mjs";
import {
  ALOUD_MAX_NOTE_LENGTH,
  AUTOMATED_CRITERIA,
  aloudFindings,
  buildAloudAcr,
  normalizeAudit,
} from "../src/acr/from-aloud.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(HERE, p), "utf8"));

const android = normalizeAudit(readJson("fixtures/baseline-android.json"));
const ios = normalizeAudit(readJson("fixtures/baseline-ios.json"));
const inputs = (overrides = {}) => ({ android, ios, appName: "Example App", productVersion: "1.0.0", ...overrides });
const finding = (doc, criterion, component) =>
  doc.findings.find((f) => f.criterion === criterion && (component === undefined || f.component === component));

const summary = (screens) => normalizeAudit({ generated: "2026-09-05T00:00:00.000Z", screens });
const clean = { errors: 0, ruleIds: [], utterances: null };
const transcriptOnly = { errors: null, ruleIds: [], utterances: 2 };

// A minimal report-only web summary, shaped like src/web/evidence.mjs webSummary.
const web = {
  schemaVersion: 1,
  platform: "web",
  generated: "2026-09-18T00:00:00.000Z",
  reportOnly: true,
  environment: { browser: "chromium", browserVersion: "140.0", screenReader: "none" },
  screens: {
    home: {
      errors: null,
      ruleIds: [],
      utterances: null,
      web: { reportOnly: true, coverage: { scenarioComplete: true, fullTraversal: false }, speechSource: "none" },
    },
  },
};

describe("aloudFindings", () => {
  it("writes a findings document the contract accepts", () => {
    const doc = aloudFindings(inputs());
    const validated = validateFindings(doc);
    assert.equal(validated.catalog, "2.5-edition-wcag-2.2-508-en");
    assert.deepEqual(doc.components, ["software"]);
    assert.equal(doc.product.description, "Example App mobile app for iOS and Android.");
    assert.equal(doc.author.name, "Automated draft — aloud openacr");
    assert.equal(doc.author.email, undefined);
  });

  it("treats the config's placeholder email as no email, so the draft asks for a real one", () => {
    assert.equal(aloudFindings(inputs({ authorEmail: "todo@example.com" })).author.email, undefined);
    const acr = buildAloudAcr(inputs({ authorEmail: "todo@example.com", date: "2026-08-26" }));
    assert.equal(acr.author.email, "todo@example.com");
    assert.match(acr.notes, /replace the placeholder contact email/);
    assert.equal(aloudFindings(inputs({ authorEmail: "a11y@example.gov" })).author.email, "a11y@example.gov");
  });

  it("is plain JSON, so it can be saved and built later with `aloud acr`", () => {
    const doc = aloudFindings(inputs());
    assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
    const saved = buildAcr(JSON.parse(JSON.stringify(doc)), { date: "2026-08-26", maxNoteLength: ALOUD_MAX_NOTE_LENGTH });
    assert.deepEqual(saved, buildAloudAcr(inputs({ date: "2026-08-26" })));
  });

  it("marks clean, complete criteria met and mapped failures failing with a partial share", () => {
    const doc = aloudFindings(inputs());
    assert.equal(finding(doc, "1.1.1").status, "met");
    const targets = finding(doc, "2.5.8");
    assert.equal(targets.status, "failing");
    assert.equal(targets.failingShare, "some");
    assert.match(targets.notes.at(-1), /^Screens with violations: Android orders-list: native-target-size-minimum$/);
  });

  it("never claims a failure affects all of the product", () => {
    const failing = summary({
      a: { errors: 1, ruleIds: ["native-interactive-unlabeled"] },
      b: { errors: 1, ruleIds: ["native-interactive-unlabeled"] },
    });
    const doc = aloudFindings(inputs({ android: failing, ios: null }));
    assert.equal(finding(doc, "4.1.2").failingShare, "some");
    const acr = buildAloudAcr(inputs({ android: failing, ios: null, date: "2026-09-05" }));
    assert.doesNotMatch(JSON.stringify(acr.chapters), /does-not-support/);
  });

  it("marks missing tree checks incomplete and a platform without rules untested", () => {
    const partial = aloudFindings(inputs({ android: summary({ home: clean, pay: transcriptOnly }), ios: null }));
    for (const num of Object.keys(AUTOMATED_CRITERIA)) assert.equal(finding(partial, num).status, "incomplete", num);
    const iosOnly = aloudFindings(inputs({ android: null, ios: summary({ home: clean }) }));
    assert.equal(finding(iosOnly, "1.3.1").status, "untested");
    assert.equal(finding(iosOnly, "4.1.2").status, "met");
    // Android clean, iOS present but without 1.3.1 rules: the one software
    // component is only half checked, so it is incomplete, not met.
    const both = aloudFindings(inputs({ android: summary({ home: clean }), ios: summary({ home: clean }) }));
    assert.equal(finding(both, "1.3.1").status, "incomplete");
    assert.equal(finding(both, "4.1.2").status, "met");
  });

  it("never says nothing ran on rows where related checks did run", () => {
    const acr = buildAloudAcr(inputs({ web, date: "2026-09-05" }));
    const notes = (chapter, num, component) =>
      acr.chapters[chapter].criteria.find((c) => c.num === num).components.find((c) => c.name === component)
        .adherence.notes;
    for (const text of [
      notes("success_criteria_level_aa", "2.4.6", "software"),
      notes("success_criteria_level_aa", "2.4.6", "web"),
      notes("functional_performance_criteria", "302.1", "none"),
    ]) {
      assert.doesNotMatch(text, /No automated test covers/);
      assert.match(text, /^No automated test establishes whether this criterion is met yet\. Needs human review\./);
    }
  });

  it("keeps 302.1 and warning-only criteria untested, with their related evidence", () => {
    const doc = aloudFindings(inputs());
    const transcript = finding(doc, "302.1");
    assert.equal(transcript.status, "untested");
    assert.equal(transcript.component, undefined);
    assert.match(transcript.notes[0], /^Related evidence: Transcript coverage is unavailable/);
    assert.equal(finding(doc, "2.4.6").status, "untested");
    assert.match(finding(doc, "2.4.6").notes[0], /as warnings; warnings do not gate/);
    assert.equal(finding(doc, "2.5.5").status, "untested");
  });

  it("reports web evidence on the web component only, as untested", () => {
    const doc = aloudFindings(inputs({ web }));
    assert.deepEqual(doc.components, ["software", "web"]);
    const webFindings = doc.findings.filter((f) => f.component === "web");
    assert.ok(webFindings.length > 50);
    assert.ok(webFindings.every((f) => f.status === "untested"));
    assert.match(webFindings[0].notes[0], /no screen reader was run/);
    const acr = buildAloudAcr(inputs({ web, date: "2026-09-18" }));
    const row412 = acr.chapters.success_criteria_level_a.criteria.find((c) => c.num === "4.1.2");
    assert.deepEqual(row412.components.map((c) => [c.name, c.adherence.level]), [["software", "supports"], ["web", "not-evaluated"]]);
  });

  it("describes a web-only product as an application", () => {
    const doc = aloudFindings(inputs({ android: null, ios: null, web }));
    assert.deepEqual(doc.components, ["web"]);
    assert.equal(doc.product.description, "Example App application.");
    assert.equal(finding(doc, "302.1"), undefined);
  });

  it("rejects missing input, a missing app name, and a malformed web summary", () => {
    assert.throws(() => aloudFindings(inputs({ android: null, ios: null })), /no audit input/);
    assert.throws(() => aloudFindings(inputs({ appName: "" })), /app name/);
    for (const mutate of [
      (w) => { w.reportOnly = false; },
      (w) => { w.screens.home.web.coverage.fullTraversal = true; },
      (w) => { w.screens.home.errors = 0; },
      (w) => { w.screens = {}; },
      (w) => { delete w.environment; },
    ]) {
      const broken = structuredClone(web);
      mutate(broken);
      assert.throws(() => aloudFindings(inputs({ web: broken })), /invalid report-only web summary/);
    }
  });
});

describe("buildAloudAcr", () => {
  it("never supports a criterion without complete, clean evidence", () => {
    const scenarios = [
      inputs(),
      inputs({ android: summary({ home: clean, pay: transcriptOnly }), ios: null }),
      inputs({ android: summary({ home: clean }), ios: summary({ home: transcriptOnly }) }),
      inputs({ android: normalizeAudit(readJson("fixtures/baseline-android-legacy.json")), ios: null }),
    ];
    for (const scenario of scenarios) {
      const doc = aloudFindings(scenario);
      const acr = buildAloudAcr({ ...scenario, date: "2026-09-05" });
      for (const chapter of Object.values(acr.chapters)) {
        for (const criterion of chapter.criteria ?? []) {
          for (const { name, adherence } of criterion.components) {
            if (adherence.level !== "supports") continue;
            assert.equal(finding(doc, criterion.num, name)?.status, "met", criterion.num);
          }
        }
      }
    }
  });

  it("caps a long failure list with an explicit marker and keeps the coverage caveat", () => {
    const screens = {};
    for (let i = 0; i < 200; i++) screens[`screen-${i}`] = { errors: 1, ruleIds: ["native-target-size-minimum"] };
    const acr = buildAloudAcr(inputs({ android: summary(screens), ios: null, date: "2026-09-05" }));
    const row = acr.chapters.success_criteria_level_aa.criteria.find((c) => c.num === "2.5.8").components[0].adherence;
    assert.equal(row.level, "partially-supports");
    assert.ok(row.notes.length <= ALOUD_MAX_NOTE_LENGTH);
    assert.ok(row.notes.endsWith(TRUNCATION_MARKER));
    assert.match(row.notes, /violations on 200 of 200 Android screens/);
    assert.match(row.notes, /part of this criterion only/);
    assert.match(row.notes, /A human review must complete the rest/);
    assert.match(row.notes, /Screens with violations: Android screen-0: native-target-size-minimum/);
  });
});
