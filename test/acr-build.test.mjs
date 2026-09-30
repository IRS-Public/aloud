/**
 * Unit tests for the shared OpenACR builder (src/acr/build.mjs): the
 * output validates against the real OpenACR schema and catalog, every
 * catalog criterion is emitted (not-evaluated when no finding covers it),
 * notes are composed from the finding and capped with an explicit marker,
 * and several components can report on one criterion. The main fixture is
 * shaped like the USWDS accessibility harness's per-component results.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { load } from "js-yaml";

import {
  DEFAULT_POLICY,
  DRAFT_AUTHOR,
  FindingsError,
  TRUNCATION_MARKER,
  buildAcr,
  capNote,
  catalogPath,
  loadCatalog,
  toYaml,
  validateAcr,
} from "../src/acr/index.mjs";

const catalog = loadCatalog();
const catalogCriteria = catalog.chapters.flatMap((chapter) => chapter.criteria.map((c) => ({ ...c, chapter: chapter.id })));

// A USWDS button, as the harness would report it: a passing keyboard
// check, a known defect, criteria triaged as not triggered, and page-level
// criteria the site team owns.
const button = () => ({
  schemaVersion: 1,
  product: { name: "USWDS Button", version: "3.13.0", description: "The USWDS button component." },
  author: { name: "USWDS accessibility team", email: "uswds@gsa.gov" },
  provenance: {
    commit: "0123abc",
    runUrl: "https://github.com/uswds/uswds/actions/runs/42",
    date: "2026-09-30",
    tools: [{ name: "Playwright", version: "1.63.0" }, { name: "aloud", version: "0.1.0" }],
  },
  components: ["web"],
  findings: [
    {
      criterion: "2.1.1",
      component: "web",
      status: "met",
      covers: "activation with Enter and Space and focus reaching the button with Tab",
      evidence: [
        { id: "button-keyboard-activation", environments: ["chromium", "firefox", "webkit"],
          url: "https://example.gov/report/button#keyboard" },
        { id: "button-voiceover-activation", environments: ["safari-voiceover"] },
      ],
    },
    {
      criterion: "4.1.2",
      component: "web",
      status: "known-defect",
      covers: "the accessible name and role screen readers announce",
      issues: [{ id: "uswds#6011", summary: "Disabled state is not announced by NVDA.", kind: "core-bug",
        url: "https://github.com/uswds/uswds/issues/6011" }],
      notes: ["Its test is switched off until the fix lands"],
    },
    { criterion: "1.2.1", component: "web", status: "not-triggered" },
    { criterion: "2.4.2", component: "web", status: "page-level" },
    { criterion: "3.1.1", component: "web", status: "page-level" },
    { criterion: "1.4.3", component: "web", status: "partly-tested", covers: "text contrast of the default theme" },
    { criterion: "2.5.8", component: "web", status: "failing", failingShare: "all",
      evidence: [{ id: "button-target-size" }] },
  ],
});

const build = (findings = button(), options = {}) => buildAcr(findings, options);

const rows = (acr) => {
  const out = [];
  for (const [chapter, body] of Object.entries(acr.chapters)) {
    for (const criterion of body.criteria ?? []) {
      for (const component of criterion.components) {
        out.push({ chapter, num: criterion.num, name: component.name, ...component.adherence });
      }
    }
  }
  return out;
};
const row = (acr, num, name) => rows(acr).find((r) => r.num === num && (!name || r.name === name));

describe("buildAcr on a harness-shaped component", () => {
  const acr = build();

  it("validates against the OpenACR schema, catalog, and completeness rules", () => {
    assert.deepEqual(validateAcr(acr, { catalog }), { valid: true, problems: [] });
  });

  it("marks the title as a draft and carries product, author, date, and catalog", () => {
    assert.equal(acr.title, "USWDS Button Accessibility Conformance Report (draft)");
    assert.deepEqual(acr.product, { name: "USWDS Button", version: "3.13.0", description: "The USWDS button component." });
    assert.deepEqual(acr.author, { name: "USWDS accessibility team", email: "uswds@gsa.gov" });
    assert.equal(acr.report_date, "2026-09-30");
    assert.equal(acr.catalog, "2.5-edition-wcag-2.2-508-en");
  });

  it("maps each finding through the default policy", () => {
    assert.equal(row(acr, "2.1.1").level, "supports");
    assert.equal(row(acr, "4.1.2").level, "partially-supports");
    assert.equal(row(acr, "1.2.1").level, "not-applicable");
    assert.equal(row(acr, "2.4.2").level, "not-applicable");
    assert.equal(row(acr, "3.1.1").level, "not-applicable");
    assert.equal(row(acr, "1.4.3").level, "not-evaluated");
    assert.equal(row(acr, "2.5.8").level, "does-not-support");
  });

  it("emits every catalog criterion outside the hardware chapter, once, in catalog order", () => {
    for (const chapter of catalog.chapters) {
      if (chapter.id === "hardware") continue;
      assert.deepEqual(acr.chapters[chapter.id].criteria.map((c) => c.num), chapter.criteria.map((c) => c.id));
    }
    const expected = catalogCriteria.filter((c) => c.chapter !== "hardware").length;
    assert.equal(rows(acr).length, expected);
  });

  it("fills criteria without a finding as not-evaluated, needing human review", () => {
    const covered = new Set(button().findings.map((f) => f.criterion));
    const filled = rows(acr).filter((r) => !covered.has(r.num));
    assert.equal(filled.length, rows(acr).length - covered.size);
    assert.ok(filled.length > 100);
    for (const r of filled) {
      assert.equal(r.level, "not-evaluated", r.num);
      assert.match(r.notes, /Needs human review/, r.num);
    }
    assert.equal(row(acr, "1.1.1").notes, "Not evaluated: no finding covers this criterion for the Web component. Needs human review.");
    assert.equal(row(acr, "502.2.1").name, "none");
  });

  it("disables the hardware chapter with a note, as src/report/openacr.mjs does", () => {
    assert.deepEqual(acr.chapters.hardware, {
      notes: "USWDS Button is not a hardware product. Hardware criteria do not apply.",
      disabled: true,
    });
  });

  it("never supports a criterion without a passing finding", () => {
    const passing = new Set(["2.1.1"]);
    for (const r of rows(acr)) if (r.level === "supports") assert.ok(passing.has(r.num), r.num);
  });

  it("composes notes from the policy, covers, issues, notes, and evidence", () => {
    assert.equal(
      row(acr, "2.1.1").notes,
      "Every automated test for this criterion passed. The evidence covers activation with Enter and Space and " +
        "focus reaching the button with Tab. Evidence: button-keyboard-activation in chromium, firefox, webkit " +
        "(https://example.gov/report/button#keyboard); button-voiceover-activation in safari-voiceover.",
    );
    assert.equal(
      row(acr, "4.1.2").notes,
      "A known defect keeps this criterion from being met. The failure affects some of the functionality. " +
        "The evidence covers the accessible name and role screen readers announce. Known issues: uswds#6011 " +
        "(core-bug): Disabled state is not announced by NVDA https://github.com/uswds/uswds/issues/6011. " +
        "Its test is switched off until the fix lands.",
    );
    assert.match(row(acr, "2.5.8").notes, /affects all of the functionality\. Evidence: button-target-size\.$/);
    assert.equal(row(acr, "2.4.2").notes, DEFAULT_POLICY["page-level"].note);
  });

  it("states the draft's limits, provenance, and level counts in the report notes", () => {
    assert.match(acr.notes, /^DRAFT\. Generated by aloud/);
    assert.match(acr.notes, /from 7 finding\(s\) for the web component\(s\)/);
    assert.match(acr.notes, /commit 0123abc, run https:\/\/github\.com\/uswds\/uswds\/actions\/runs\/42, dated 2026-09-30/);
    assert.match(acr.notes, /Component rows by level: 1 supports, 1 partially-supports, 1 does-not-support, 3 not-applicable, \d+ not-evaluated\./);
    assert.match(acr.notes, /needs a human review/);
    assert.doesNotMatch(acr.notes, /placeholder contact/);
    assert.match(acr.evaluation_methods_used, /Tools: Playwright 1\.63\.0, aloud 0\.1\.0\./);
    // The tools are stated with the rest of the provenance in the notes too.
    assert.match(acr.notes, /dated 2026-09-30\. Tools: Playwright 1\.63\.0, aloud 0\.1\.0\./);
  });

  it("says when the evidence's commit had uncommitted changes", () => {
    const dirty = build({ ...button(), provenance: { ...button().provenance, workingTreeDirty: true } });
    assert.match(dirty.notes, /commit 0123abc plus uncommitted changes, run /);
    const clean = build({ ...button(), provenance: { ...button().provenance, workingTreeDirty: false } });
    assert.match(clean.notes, /commit 0123abc, run /);
    // null is "could not tell", which must not read as clean.
    const unknown = build({ ...button(), provenance: { ...button().provenance, workingTreeDirty: null } });
    assert.match(unknown.notes, /commit 0123abc \(working tree state unknown\), run /);
    assert.throws(() => build({ ...button(), provenance: { ...button().provenance, workingTreeDirty: "yes" } }),
      /provenance\.workingTreeDirty/);
  });

  it("round-trips through YAML unchanged", () => {
    assert.deepEqual(load(toYaml(acr)), acr);
  });

  it("is deterministic", () => {
    assert.deepEqual(build(), acr);
  });
});

describe("Section 508 chapter provisions", () => {
  const findings = {
    product: { name: "Example App" },
    components: ["software"],
    findings: [
      { criterion: "302.1", status: "partly-tested", covers: "screen reader speech captured on 12 screens" },
      { criterion: "302.3", component: "none", status: "met" },
      { criterion: "502.2.1", status: "untested" },
      { criterion: "502.3.1", status: "failing", evidence: [{ id: "object-info" }] },
      { criterion: "602.3", status: "not-triggered" },
      { criterion: "1.1.1", component: "software", status: "met" },
    ],
  };
  const acr = build(findings, { date: "2026-09-30" });

  it("validates against the OpenACR schema and catalog", () => {
    assert.deepEqual(validateAcr(acr), { valid: true, problems: [] });
  });

  it("reports provisions on the catalog's none component", () => {
    assert.deepEqual(
      ["302.1", "302.3", "502.2.1", "502.3.1", "602.3"].map((num) => [num, row(acr, num).name, row(acr, num).level]),
      [
        ["302.1", "none", "not-evaluated"],
        ["302.3", "none", "supports"],
        ["502.2.1", "none", "not-evaluated"],
        ["502.3.1", "none", "partially-supports"],
        ["602.3", "none", "not-applicable"],
      ],
    );
    assert.equal(row(acr, "1.1.1").name, "software");
  });

  it("fills provisions without a finding as not-evaluated", () => {
    assert.deepEqual(
      { ...row(acr, "504.2"), notes: row(acr, "504.2").notes },
      { chapter: "software", num: "504.2", name: "none", level: "not-evaluated",
        notes: "Not evaluated: no finding covers this criterion. Needs human review." },
    );
  });

  it("uses a placeholder author a Section 508 office must replace", () => {
    assert.deepEqual(acr.author, DRAFT_AUTHOR);
    assert.match(acr.notes, /replace the placeholder contact email/);
    assert.equal(acr.product.version, undefined);
  });

  it("refuses findings in a disabled chapter", () => {
    assert.throws(
      () => build({ ...findings, findings: [{ criterion: "402.2.1", status: "met" }] }, { date: "2026-09-30" }),
      /402\.2\.1 is in the hardware chapter, which this report disables/,
    );
  });

  it("emits the hardware chapter when the caller enables it", () => {
    const withHardware = build(
      { ...findings, findings: [{ criterion: "402.2.1", status: "not-triggered" }] },
      { date: "2026-09-30", disabledChapters: [] },
    );
    assert.equal(row(withHardware, "402.2.1").level, "not-applicable");
    assert.equal(row(withHardware, "402.2.2").level, "not-evaluated");
    assert.equal(validateAcr(withHardware).valid, true);
  });

  it("disables other chapters on request, and rejects unknown ones", () => {
    const withoutDocs = { ...findings, findings: findings.findings.filter((f) => f.criterion !== "602.3") };
    const docsOff = build(withoutDocs, { date: "2026-09-30", disabledChapters: ["hardware", "support_documentation_and_services"] });
    assert.equal(docsOff.chapters.support_documentation_and_services.disabled, true);
    assert.match(docsOff.chapters.support_documentation_and_services.notes, /does not apply to Example App/);
    assert.throws(() => build(findings, { date: "2026-09-30", disabledChapters: ["chapter-9"] }), /unknown chapter "chapter-9"/);
  });
});

describe("multiple components", () => {
  const acr = build({
    product: { name: "Example" },
    components: ["web", "software"],
    findings: [
      { criterion: "1.1.1", component: "web", status: "met" },
      { criterion: "1.1.1", component: "software", status: "failing" },
      { criterion: "2.4.2", component: "software", status: "not-triggered" },
    ],
  }, { date: "2026-09-30" });

  it("emits one row per declared component, in declared order", () => {
    const criterion = acr.chapters.success_criteria_level_a.criteria.find((c) => c.num === "1.1.1");
    assert.deepEqual(criterion.components.map((c) => [c.name, c.adherence.level]), [
      ["web", "supports"],
      ["software", "partially-supports"],
    ]);
  });

  it("fills each component without a finding separately", () => {
    assert.equal(row(acr, "2.4.2", "web").level, "not-evaluated");
    assert.match(row(acr, "2.4.2", "web").notes, /for the Web component/);
    assert.equal(row(acr, "2.4.2", "software").level, "not-applicable");
    assert.match(row(acr, "3.1.1", "software").notes, /for the Software component/);
  });

  it("still keeps Section 508 provisions to a single none row", () => {
    const criterion = acr.chapters.software.criteria.find((c) => c.num === "502.2.1");
    assert.deepEqual(criterion.components.map((c) => c.name), ["none"]);
  });

  it("validates", () => {
    assert.equal(validateAcr(acr).valid, true);
  });

  it("reports catalog problems instead of throwing", () => {
    const unknown = validateAcr({ ...acr, catalog: "2.9-edition" });
    assert.equal(unknown.valid, false);
    assert.match(unknown.problems[0], /^catalog: unknown catalog "2\.9-edition"/);
    const repeated = validateAcr({ ...acr, catalog: "2.4-edition-wcag-2.1-508-eu-en" });
    assert.equal(repeated.valid, false);
    assert.match(repeated.problems[0], /appears in more than one chapter/);
    // A supplied catalog must be the one the report names.
    const mismatch = validateAcr(acr, { catalog: loadCatalog({ id: "2.5-edition-wcag-2.1-508-en" }) });
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.problems[0], /does not match catalog id/);
  });

  it("never omits a criterion the catalog applies only to undeclared components", () => {
    const custom = structuredClone(catalog);
    custom.chapters[0].criteria[0].components = ["authoring-tool"];
    const built = build({ product: { name: "Example" }, components: ["web"],
      findings: [{ criterion: "2.1.1", component: "web", status: "met" }] }, { date: "2026-09-30", catalog: custom });
    assert.deepEqual(row(built, "1.1.1"), {
      chapter: "success_criteria_level_a", num: "1.1.1", name: "authoring-tool", level: "not-evaluated",
      notes: "Not evaluated: the catalog applies this criterion only to authoring-tool, which this report " +
        "does not declare. Needs human review.",
    });
    assert.equal(validateAcr(built, { catalog: custom }).valid, true);
  });
});

describe("policy overrides", () => {
  it("apply to the emitted levels and are stated in the report notes", () => {
    const acr = build(button(), { policy: { "page-level": "not-evaluated" } });
    assert.equal(row(acr, "2.4.2").level, "not-evaluated");
    assert.equal(row(acr, "1.2.1").level, "not-applicable");
    assert.match(acr.notes, /changed the default level policy: page-level -> not-evaluated\./);
  });

  it("can replace the policy note", () => {
    const acr = build(button(), { policy: { "page-level": { note: "The site team checks this on each page." } } });
    assert.equal(row(acr, "2.4.2").notes, "The site team checks this on each page.");
    assert.match(acr.notes, /changed the default level policy: page-level: note replaced\./);
    assert.match(acr.evaluation_methods_used, /with the caller's changes: page-level: note replaced\./);
  });

  it("describe the default policy in the methods only when it is unchanged", () => {
    const plain = build(button());
    assert.match(plain.evaluation_methods_used, /anything unproven stays not-evaluated\./);
    assert.doesNotMatch(plain.notes, /changed the default level policy/);
    const changed = build(button(), { policy: { "partly-tested": { level: "partially-supports", note: "Partly covered." } } });
    assert.doesNotMatch(changed.evaluation_methods_used, /anything unproven stays not-evaluated/);
    assert.match(changed.evaluation_methods_used,
      /with the caller's changes: partly-tested -> partially-supports \(note replaced\)\./);
    assert.match(changed.notes, /partly-tested -> partially-supports \(note replaced\)/);
  });

  it("can never turn an unproven finding into not-applicable", () => {
    assert.throws(() => build(button(), { policy: { untested: "not-applicable" } }), /may not map to "not-applicable"/);
  });

  it("can never turn a failure into a pass", () => {
    assert.throws(() => build(button(), { policy: { "known-defect": "supports" } }), /may not map to "supports"/);
  });
});

describe("note length cap", () => {
  it("leaves short notes alone", () => {
    assert.equal(capNote("short note", 200), "short note");
  });

  it("cuts on a word boundary and ends with the marker", () => {
    const text = `${"word ".repeat(100)}end`;
    const capped = capNote(text, 200);
    assert.ok(capped.length <= 200);
    assert.ok(capped.endsWith(` ${TRUNCATION_MARKER}`));
    assert.match(capped, /^(word )+\(truncated; see evidence\)$/);
  });

  it("caps long evidence lists in emitted notes", () => {
    const findings = button();
    findings.findings[0].evidence = Array.from({ length: 200 }, (_, i) => ({
      id: `keyboard-check-${i}`,
      url: `https://example.gov/report/button#check-${i}`,
    }));
    const acr = build(findings);
    const notes = row(acr, "2.1.1").notes;
    assert.ok(notes.length <= 1500);
    assert.ok(notes.endsWith(TRUNCATION_MARKER));
    assert.match(notes, /^Every automated test for this criterion passed\. The evidence covers/);
    const tight = build(findings, { maxNoteLength: 300 });
    assert.ok(row(tight, "2.1.1").notes.length <= 300);
    assert.throws(() => build(findings, { maxNoteLength: 50 }), /maxNoteLength must be an integer of at least 200/);
  });
});

describe("buildAcr input checks", () => {
  it("rejects invalid findings before building anything", () => {
    assert.throws(() => build({ ...button(), components: ["app"] }), FindingsError);
  });

  it("needs a report date", () => {
    const findings = button();
    delete findings.provenance.date;
    assert.throws(() => build(findings), /needs a report date/);
    assert.throws(() => build(findings, { date: "09/30/2026" }), /needs a report date/);
    // The right shape is not enough: the date must exist.
    for (const date of ["2026-02-31", "2026-13-45", "2025-02-29"]) {
      assert.throws(() => build(findings, { date }), /exists on the calendar/, date);
    }
    assert.equal(build(findings, { date: "2028-02-29" }).report_date, "2028-02-29");
    assert.equal(build(findings, { date: "2026-10-01" }).report_date, "2026-10-01");
  });

  it("builds against another catalog by id or by file", () => {
    const wcag21 = build({ ...button(), catalog: "2.5-edition-wcag-2.1-508-en", findings: button().findings.slice(0, 3) });
    assert.equal(wcag21.catalog, "2.5-edition-wcag-2.1-508-en");
    assert.equal(row(wcag21, "2.5.8"), undefined, "2.5.8 is not in WCAG 2.1");
    assert.equal(validateAcr(wcag21).valid, true);
    assert.throws(() => build(button(), { catalogPath: "/nonexistent/catalog.yaml" }), /catalog file not found/);

    // A catalog file states its base name as the catalog id.
    const small = { ...button(), findings: button().findings.slice(0, 3) };
    const fromFile = build(small, { catalogPath: catalogPath("2.5-edition-wcag-2.1-508-en") });
    assert.equal(fromFile.catalog, "2.5-edition-wcag-2.1-508-en");
    assert.equal(row(fromFile, "2.5.8"), undefined);
    assert.equal(validateAcr(fromFile).valid, true, "the report validates against the catalog it names");

    // A catalog object must be the catalog the findings name.
    const wcag21Catalog = loadCatalog({ id: "2.5-edition-wcag-2.1-508-en" });
    assert.throws(() => build(small, { catalog: wcag21Catalog }), /does not match catalog id "2\.5-edition-wcag-2\.2-508-en"/);
    assert.equal(build({ ...small, catalog: "2.5-edition-wcag-2.1-508-en" }, { catalog: wcag21Catalog }).catalog,
      "2.5-edition-wcag-2.1-508-en");
    assert.throws(() => build({ ...small, catalog: "2.5-edition-wcag-2.2-en" }, { catalog: loadCatalog() }),
      /does not match catalog id "2\.5-edition-wcag-2\.2-en"/);
    assert.throws(() => build(small, { catalog: wcag21Catalog, catalogPath: catalogPath() }), /not both/);
  });

  it("builds a WCAG-only catalog, which has no hardware chapter", () => {
    const acr = build({ ...button(), catalog: "2.5-edition-wcag-2.2-en" });
    assert.equal(acr.chapters.hardware, undefined);
    assert.equal(validateAcr(acr).valid, true);
  });
});

describe("producer notes and methods", () => {
  it("states report-level notes after the builder's own sentences", () => {
    const acr = build({ ...button(), notes: ["Tested in Chromium and WebKit", "Runs nightly."] });
    assert.match(acr.notes, /dated 2026-09-30\. Tools: Playwright 1\.63\.0, aloud 0\.1\.0\. Tested in Chromium and WebKit\. Runs nightly\. Component rows by level/);
  });

  it("opens the evaluation methods with the producer's account and keeps the policy sentence", () => {
    const acr = build({ ...button(), evaluationMethods: "Playwright drives each component story" });
    assert.match(acr.evaluation_methods_used, /^Playwright drives each component story\. aloud's level policy/);
    assert.match(acr.evaluation_methods_used, /Tools: Playwright/);
    // options.evaluationMethods still replaces the whole section.
    const replaced = build({ ...button(), evaluationMethods: "ignored" }, { evaluationMethods: "Only this." });
    assert.equal(replaced.evaluation_methods_used, "Only this.");
  });

  it("reject blank report notes and methods", () => {
    assert.throws(() => build({ ...button(), notes: [" "] }), /notes\[0\]/);
    assert.throws(() => build({ ...button(), evaluationMethods: "" }), /evaluationMethods/);
  });

  it("says a date-only provenance plainly", () => {
    const acr = build({ ...button(), provenance: { date: "2026-09-30" } });
    assert.match(acr.notes, /The evidence is dated 2026-09-30\./);
    assert.doesNotMatch(acr.notes, /comes from dated/);
  });

  it("ends a fragment that closes a bracket with a full stop", () => {
    const findings = button();
    findings.findings[0] = { criterion: "2.1.1", component: "web", status: "met", covers: "Tab order (desktop)",
      notes: ["Checked by hand (see the log.)"] };
    const notes = row(build(findings), "2.1.1").notes;
    assert.match(notes, /covers Tab order \(desktop\)\. Checked by hand \(see the log\.\)$/);
  });
});

describe("validateAcr", () => {
  const acr = build();

  it("reports an omitted criterion", () => {
    const broken = structuredClone(acr);
    broken.chapters.success_criteria_level_a.criteria.splice(0, 1);
    const result = validateAcr(broken, { catalog });
    assert.equal(result.valid, false);
    assert.match(result.problems.join("\n"), /success_criteria_level_a must list every catalog criterion in order \(missing 1\.1\.1\)/);
  });

  it("reports a row without notes, a missing chapter, and a bare disabled chapter", () => {
    const broken = structuredClone(acr);
    delete broken.chapters.success_criteria_level_a.criteria[0].components[0].adherence.notes;
    delete broken.chapters.software;
    delete broken.chapters.hardware.notes;
    const { problems } = validateAcr(broken, { catalog });
    assert.ok(problems.includes("criterion 1.1.1 (web) has no notes"));
    assert.ok(problems.includes("chapter software is missing"));
    assert.ok(problems.includes("disabled chapter hardware needs notes saying why"));
  });

  it("reports schema and catalog violations from @openacr/openacr", () => {
    const noEmail = structuredClone(acr);
    delete noEmail.author.email;
    assert.match(validateAcr(noEmail, { catalog }).problems[0], /^schema: Invalid: .*email/);
    const badTerm = structuredClone(acr);
    badTerm.chapters.success_criteria_level_a.criteria[0].components[0].adherence.level = "passes";
    assert.match(validateAcr(badTerm, { catalog }).problems[0], /catalog values: .*term 'passes'/);
  });
});
