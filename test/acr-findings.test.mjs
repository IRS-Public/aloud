/**
 * Unit tests for the findings contract (src/acr/findings.mjs and
 * findings.schema.json): a valid document normalizes, and every kind of
 * bad input (unknown criteria, statuses, and components, duplicates,
 * malformed evidence, contradictory fields) throws with a message that
 * names the exact field.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CATALOG_ID, catalogPath, loadCatalog } from "../src/acr/catalog.mjs";
import { FINDINGS_SCHEMA, FindingsError, validateFindings } from "../src/acr/findings.mjs";
import { STATUSES } from "../src/acr/levels.mjs";

const base = () => ({
  product: { name: "USWDS Button", version: "3.13.0" },
  components: ["web"],
  findings: [{ criterion: "2.1.1", component: "web", status: "met", covers: "keyboard checks" }],
});

// Build a document, apply a change, and return the problems it raises.
const problemsFor = (mutate) => {
  const input = base();
  mutate(input);
  try {
    validateFindings(input);
  } catch (error) {
    assert.ok(error instanceof FindingsError, error.message);
    return error.problems;
  }
  assert.fail("expected the findings to be rejected");
};

const assertProblem = (mutate, pattern) => {
  const problems = problemsFor(mutate);
  assert.ok(problems.some((p) => pattern.test(p)), `no problem matches ${pattern}:\n${problems.join("\n")}`);
};

describe("valid findings", () => {
  it("normalize with the default catalog and stay unchanged otherwise", () => {
    const input = base();
    const out = validateFindings(input);
    assert.equal(out.catalog, DEFAULT_CATALOG_ID);
    assert.deepEqual(out.findings, input.findings);
    assert.equal(input.catalog, undefined, "the input is not modified");
    assert.ok(Object.isFrozen(out.findings[0]));
  });

  it("accept every optional field", () => {
    const out = validateFindings({
      schemaVersion: 1,
      product: { name: "Example", version: "1.0", description: "An example." },
      author: { name: "A11y team", email: "a11y@example.gov" },
      vendor: { name: "Example Agency" },
      provenance: {
        commit: "abc123",
        runUrl: "https://github.com/example/repo/actions/runs/1",
        date: "2026-09-30",
        tools: [{ name: "aloud", version: "0.1.0", url: "https://github.com/IRS-Public/aloud" }],
      },
      catalog: "2.5-edition-wcag-2.2-508-en",
      components: ["web", "software"],
      findings: [{
        criterion: "1.4.3",
        component: "software",
        status: "known-defect",
        failingShare: "all",
        covers: "text contrast of the default theme",
        evidence: [{ id: "contrast", url: "https://example.gov/e/1", environments: ["chromium", "webkit"] }],
        issues: [{ id: "ISSUE-1", summary: "Low contrast placeholder", kind: "core-bug", url: "https://example.gov/i/1" }],
        notes: ["Fix scheduled."],
      }],
    });
    assert.equal(out.findings[0].failingShare, "all");
  });

  it("give Section 508 chapter findings the catalog's none component", () => {
    const out = validateFindings({
      ...base(),
      findings: [
        { criterion: "502.2.1", status: "untested" },
        { criterion: "302.1", component: "none", status: "partly-tested" },
      ],
    });
    assert.deepEqual(out.findings.map((f) => f.component), ["none", "none"]);
  });

  it("allow one finding per declared component for the same criterion", () => {
    const out = validateFindings({
      ...base(),
      components: ["web", "software"],
      findings: [
        { criterion: "1.1.1", component: "web", status: "met", covers: "keyboard checks" },
        { criterion: "1.1.1", component: "software", status: "failing" },
      ],
    });
    assert.equal(out.findings.length, 2);
  });

  it("check against a caller-supplied catalog object", () => {
    const catalog = loadCatalog({ id: "2.5-edition-wcag-2.0-508-en" });
    // 2.5.8 is WCAG 2.2 only.
    assert.throws(
      () => validateFindings({
        ...base(),
        catalog: "2.5-edition-wcag-2.0-508-en",
        findings: [{ criterion: "2.5.8", component: "web", status: "met", covers: "keyboard checks" }],
      }, { catalog }),
      /"2\.5\.8" is not a criterion/,
    );
    const out = validateFindings({ ...base(), catalog: "2.5-edition-wcag-2.0-508-en" }, { catalog });
    assert.equal(out.catalog, "2.5-edition-wcag-2.0-508-en");
  });

  it("name a catalog file by its base name", () => {
    const out = validateFindings(base(), { catalogPath: catalogPath("2.5-edition-wcag-2.1-508-en") });
    assert.equal(out.catalog, "2.5-edition-wcag-2.1-508-en");
  });

  it("refuse a supplied catalog that is not the catalog the findings name", () => {
    const wcag21 = loadCatalog({ id: "2.5-edition-wcag-2.1-508-en" });
    // Without findings.catalog the default id would be stated, but this
    // catalog lacks the WCAG 2.2 criteria.
    assert.throws(() => validateFindings(base(), { catalog: wcag21 }),
      (error) => error instanceof FindingsError &&
        /catalog: the supplied catalog does not match catalog id "2\.5-edition-wcag-2\.2-508-en"/.test(error.message));
    assert.throws(
      () => validateFindings({ ...base(), catalog: "2.5-edition-wcag-2.2-en" }, {
        catalogPath: catalogPath("2.5-edition-wcag-2.2-508-en"),
      }),
      /does not match catalog id "2\.5-edition-wcag-2\.2-en"/,
    );
  });
});

describe("rejected findings", () => {
  it("reject input that is not a findings object", () => {
    assert.throws(() => validateFindings(null), /findings input: must be object/);
    assert.throws(() => validateFindings([]), /must be object/);
  });

  it("reject missing required fields", () => {
    const problems = problemsFor((f) => {
      delete f.product;
      delete f.components;
      f.findings = [{}];
    });
    assert.ok(problems.includes("product: is required"));
    assert.ok(problems.includes("components: is required"));
    assert.ok(problems.includes("findings[0].criterion: is required"));
    assert.ok(problems.includes("findings[0].status: is required"));
  });

  it("reject an empty findings list", () => {
    assertProblem((f) => { f.findings = []; }, /^findings: must list at least 1 item/);
  });

  it("reject unknown fields, so a typo is never ignored", () => {
    assertProblem((f) => { f.findings[0].failingshare = "all"; }, /^findings\[0\]\.failingshare: unknown field/);
    assertProblem((f) => { f.product.owner = "x"; }, /^product\.owner: unknown field/);
  });

  it("reject unknown statuses", () => {
    assertProblem((f) => { f.findings[0].status = "passed"; }, /findings\[0\]\.status: "passed" is not one of met, /);
    assertProblem((f) => { f.findings[0].status = "not-met"; }, /"not-met" is not one of/);
  });

  it("reject criteria the catalog does not list", () => {
    assertProblem((f) => { f.findings[0].criterion = "9.9.9"; },
      /findings\[0\]\.criterion: "9\.9\.9" is not a criterion in catalog 2\.5-edition-wcag-2\.2-508-en/);
    assertProblem((f) => { f.findings[0].criterion = "SC 2.1.1"; }, /"SC 2\.1\.1" is not a criterion/);
  });

  it("reject unknown and undeclared components", () => {
    assertProblem((f) => { f.components = ["webpage"]; }, /components\[0\]: "webpage" is not a product component/);
    assertProblem((f) => { f.components = ["web", "none"]; }, /components\[1\]: "none" is not a product component/);
    assertProblem((f) => { f.findings[0].component = "software"; },
      /findings\[0\]\.component: "software" is not a declared component \(declared: web\)/);
    assertProblem((f) => { f.findings[0].component = "app"; }, /"app" is not a catalog component/);
    assertProblem((f) => { delete f.findings[0].component; }, /findings\[0\]\.component: is required for criterion 2\.1\.1/);
    assertProblem((f) => { f.components = ["web", "web"]; }, /components: must not repeat items/);
  });

  it("reject a product component on a Section 508 chapter criterion", () => {
    assertProblem((f) => { f.findings[0] = { criterion: "502.2.1", component: "web", status: "met", covers: "keyboard checks" }; },
      /criterion 502\.2\.1 has no product components in the catalog; omit component/);
  });

  it("reject duplicate criterion and component pairs", () => {
    assertProblem((f) => { f.findings.push({ criterion: "2.1.1", component: "web", status: "failing" }); },
      /findings\[1\]: duplicate of findings\[0\] \(criterion 2\.1\.1, component web\)/);
    // An omitted component and "none" are the same component.
    assertProblem((f) => {
      f.findings = [{ criterion: "302.1", status: "untested" }, { criterion: "302.1", component: "none", status: "met", covers: "keyboard checks" }];
    }, /findings\[1\]: duplicate of findings\[0\] \(criterion 302\.1, component none\)/);
  });

  it("reject malformed evidence", () => {
    assertProblem((f) => { f.findings[0].evidence = []; }, /findings\[0\]\.evidence: must list at least 1 item/);
    assertProblem((f) => { f.findings[0].evidence = [{ url: "https://example.gov" }]; }, /evidence\[0\]\.id: is required/);
    assertProblem((f) => { f.findings[0].evidence = [{ id: "a", url: "results/a.html" }]; },
      /evidence\[0\]\.url: "results\/a\.html" is not an absolute http\(s\) URL/);
    assertProblem((f) => { f.findings[0].evidence = [{ id: " " }]; }, /evidence\[0\]\.id: " " is not a non-blank string/);
    assertProblem((f) => { f.findings[0].evidence = [{ id: "a", environments: "chromium" }]; },
      /evidence\[0\]\.environments: must be array/);
    assertProblem((f) => { f.findings[0].evidence = [{ id: "a" }, { id: "a" }]; }, /findings\[0\]\.evidence: repeated id\(s\) a/);
    assertProblem((f) => { f.findings[0].evidence = "button-activation"; }, /findings\[0\]\.evidence: must be array/);
  });

  it("reject malformed issues, notes, and provenance", () => {
    assertProblem((f) => { f.findings[0].issues = [{ id: "I-1" }]; }, /issues\[0\]\.summary: is required/);
    assertProblem((f) => { f.findings[0].notes = [""]; }, /notes\[0\]: must not be empty/);
    assertProblem((f) => { f.provenance = { date: "30 Sep 2026" }; }, /provenance\.date: "30 Sep 2026" is not a date as YYYY-MM-DD/);
    assertProblem((f) => { f.provenance = { date: "2026-09-31" }; }, /provenance\.date: "2026-09-31" is not a real calendar date/);
    assertProblem((f) => { f.author = { name: "A", email: "nobody" }; }, /author\.email: "nobody" is not an email address/);
  });

  it("reject fields that contradict the status", () => {
    assertProblem((f) => { f.findings[0].failingShare = "all"; },
      /findings\[0\]\.failingShare: applies only to failing and known-defect findings, not "met"/);
    assertProblem((f) => { f.findings[0].status = "failing"; f.findings[0].failingShare = "most"; },
      /failingShare: "most" is not one of some, all/);
    assertProblem((f) => { f.findings[0].status = "known-defect"; },
      /findings\[0\]\.issues: a known-defect finding must name the known issue/);
  });

  it("reject known issues on a passing or not-applicable finding", () => {
    const issues = [{ id: "GH-1", summary: "Keyboard trap in dialog" }];
    for (const status of ["met", "human-reviewed", "standard-interpretation", "not-triggered", "page-level"]) {
      assertProblem((f) => { f.findings[0].status = status; f.findings[0].issues = issues; },
        new RegExp(`findings\\[0\\]\\.issues: a "${status}" finding may not list known issues`));
    }
    // An unproven finding may note an issue; it stays not-evaluated.
    const out = validateFindings({ ...base(), findings: [{ ...base().findings[0], status: "partly-tested", issues }] });
    assert.equal(out.findings[0].issues.length, 1);
  });

  it("reject a passing finding that names nothing it rests on", () => {
    for (const status of ["met", "human-reviewed", "standard-interpretation"]) {
      assertProblem((f) => { f.findings[0] = { criterion: "1.4.3", component: "web", status }; },
        new RegExp(`findings\\[0\\]: a "${status}" finding must say what it rests on`));
    }
    // An interpretation must be cited in the notes; evidence alone is not it.
    assertProblem((f) => {
      f.findings[0] = { criterion: "4.1.1", component: "web", status: "standard-interpretation", evidence: [{ id: "markup" }] };
    }, /findings\[0\]\.notes: a standard-interpretation finding must cite the interpretation it rests on/);
    const interpreted = validateFindings({ ...base(), findings: [{
      criterion: "4.1.1", component: "web", status: "standard-interpretation",
      notes: ["WCAG 2.1 errata: 4.1.1 Parsing is always satisfied for HTML content."],
    }] });
    assert.equal(interpreted.findings[0].status, "standard-interpretation");
    // Any one of evidence, covers, or notes is enough.
    for (const grounds of [{ evidence: [{ id: "contrast" }] }, { covers: "text contrast" }, { notes: ["Checked by hand."] }]) {
      const out = validateFindings({ ...base(), findings: [{ criterion: "1.4.3", component: "web", status: "met", ...grounds }] });
      assert.equal(out.findings[0].status, "met");
    }
    // Statuses that support nothing need no grounds.
    validateFindings({ ...base(), findings: [{ criterion: "1.4.3", component: "web", status: "untested" }] });
  });

  it("reject an unknown catalog", () => {
    assertProblem((f) => { f.catalog = "2.9-edition"; }, /catalog: unknown catalog "2\.9-edition"/);
    // This bundled catalog lists 4.1.1 in two chapters, so it cannot be indexed.
    assertProblem((f) => { f.catalog = "2.4-edition-wcag-2.1-508-eu-en"; },
      /catalog: invalid OpenACR catalog: criterion 4\.1\.1 appears in more than one chapter/);
    assertProblem((f) => { f.catalog = "../../etc/passwd"; }, /catalog: "\.\.\/\.\.\/etc\/passwd" is not a catalog file name/);
  });

  it("list every problem at once", () => {
    const problems = problemsFor((f) => {
      f.findings.push({ criterion: "9.9.9", component: "web", status: "met", covers: "keyboard checks" });
      f.findings.push({ criterion: "1.1.1", component: "software", status: "met", covers: "keyboard checks" });
    });
    assert.equal(problems.length, 2);
  });
});

describe("findings schema", () => {
  it("lists exactly the policy's statuses", () => {
    assert.deepEqual(FINDINGS_SCHEMA.definitions.finding.properties.status.enum, [...STATUSES]);
  });
});
