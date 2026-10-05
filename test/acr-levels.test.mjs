/**
 * Unit tests for the finding status vocabulary and the status -> OpenACR
 * level policy (src/acr/levels.mjs): every default mapping, the failing
 * share, and the override rules that keep a failure or unproven evidence
 * from ever reading as a pass.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ADHERENCE_LEVELS,
  DEFAULT_POLICY,
  STATUSES,
  adherenceFor,
  resolvePolicy,
} from "../src/acr/levels.mjs";

describe("default policy", () => {
  // The whole mapping, one row per status, so a change to it is deliberate.
  const expected = {
    met: "supports",
    "human-reviewed": "supports",
    "standard-interpretation": "supports",
    "partly-tested": "not-evaluated",
    "platform-limitation": "not-evaluated",
    incomplete: "not-evaluated",
    untested: "not-evaluated",
    unreviewed: "not-evaluated",
    "not-triggered": "not-applicable",
    "page-level": "not-applicable",
  };

  it("covers every status and nothing else", () => {
    assert.deepEqual(Object.keys(DEFAULT_POLICY).sort(), [...STATUSES].sort());
  });

  for (const [status, level] of Object.entries(expected)) {
    it(`maps ${status} to ${level}`, () => {
      assert.equal(adherenceFor(status).level, level);
    });
  }

  for (const status of ["failing", "known-defect"]) {
    it(`maps ${status} to partially-supports unless it affects all functionality`, () => {
      assert.equal(adherenceFor(status).level, "partially-supports");
      assert.equal(adherenceFor(status, { failingShare: "some" }).level, "partially-supports");
      assert.equal(adherenceFor(status, { failingShare: "all" }).level, "does-not-support");
    });
  }

  it("explains every status in a plain-English note", () => {
    for (const status of STATUSES) assert.ok(adherenceFor(status).note.length > 30, status);
    assert.match(adherenceFor("human-reviewed").note, /person reviewed/);
    assert.match(adherenceFor("standard-interpretation").note, /published interpretation .* no test applies/);
    assert.match(adherenceFor("page-level").note, /site team is responsible/);
  });

  it("uses only OpenACR levels", () => {
    for (const status of STATUSES) {
      for (const failingShare of status === "failing" || status === "known-defect" ? ["some", "all"] : [undefined]) {
        assert.ok(ADHERENCE_LEVELS.includes(adherenceFor(status, { failingShare }).level));
      }
    }
  });

  it("is frozen", () => {
    assert.throws(() => { DEFAULT_POLICY.met.level = "not-evaluated"; }, TypeError);
    assert.throws(() => { DEFAULT_POLICY.failing.level.all = "supports"; }, TypeError);
  });
});

describe("adherenceFor", () => {
  it("throws on an unknown status", () => {
    assert.throws(() => adherenceFor("passed"), /unknown finding status "passed"/);
    assert.throws(() => adherenceFor(undefined), /unknown finding status/);
  });

  it("accepts failingShare only on failing statuses, and only some or all", () => {
    assert.throws(() => adherenceFor("met", { failingShare: "all" }), /only to failing statuses/);
    assert.throws(() => adherenceFor("failing", { failingShare: "most" }), /invalid failingShare/);
  });

  it("refuses a hand-built policy that maps a failure to supports", () => {
    const policy = { ...DEFAULT_POLICY, failing: { level: { some: "supports", all: "supports" }, note: "x" } };
    assert.throws(() => adherenceFor("failing", { policy }), /may not map to "supports"/);
  });
});

describe("resolvePolicy overrides", () => {
  it("returns the default mapping with no overrides", () => {
    assert.deepEqual(resolvePolicy(), DEFAULT_POLICY);
  });

  it("overrides one status by level, keeping its note", () => {
    const policy = resolvePolicy({ "page-level": "not-evaluated" });
    assert.deepEqual(adherenceFor("page-level", { policy }), {
      level: "not-evaluated",
      note: DEFAULT_POLICY["page-level"].note,
    });
    assert.equal(adherenceFor("not-triggered", { policy }).level, "not-applicable");
  });

  it("overrides a note and a level together", () => {
    const policy = resolvePolicy({ untested: { level: "does-not-support", note: "Treated as failing until tested." } });
    assert.deepEqual(adherenceFor("untested", { policy }), {
      level: "does-not-support",
      note: "Treated as failing until tested.",
    });
  });

  it("overrides a failing status by share or for both shares", () => {
    const one = resolvePolicy({ failing: { level: { some: "does-not-support" } } });
    assert.equal(adherenceFor("failing", { policy: one }).level, "does-not-support");
    assert.equal(adherenceFor("failing", { policy: one, failingShare: "all" }).level, "does-not-support");
    const both = resolvePolicy({ "known-defect": "not-evaluated" });
    assert.equal(adherenceFor("known-defect", { policy: both, failingShare: "all" }).level, "not-evaluated");
  });

  it("never maps a failing status to supports", () => {
    for (const status of ["failing", "known-defect"]) {
      assert.throws(() => resolvePolicy({ [status]: "supports" }), /failing status may not map to "supports"/);
      assert.throws(() => resolvePolicy({ [status]: { level: { all: "supports" } } }), /failingShare "all"/);
      assert.throws(() => resolvePolicy({ [status]: "not-applicable" }), /may not map to "not-applicable"/);
    }
  });

  it("never maps an unproven status to not-applicable", () => {
    // Nobody showed the criterion is irrelevant, so it may not read as N/A.
    for (const status of ["partly-tested", "platform-limitation", "incomplete", "untested", "unreviewed"]) {
      assert.throws(() => resolvePolicy({ [status]: "not-applicable" }),
        /unproven status may not map to "not-applicable"/, status);
    }
  });

  it("never maps unproven or out-of-scope statuses to supports", () => {
    for (const status of ["partly-tested", "platform-limitation", "incomplete", "untested", "unreviewed",
      "not-triggered", "page-level"]) {
      assert.throws(() => resolvePolicy({ [status]: "supports" }), /may not map to "supports"/, status);
    }
  });

  it("lets passing statuses report something more conservative", () => {
    const policy = resolvePolicy({ "human-reviewed": "not-evaluated" });
    assert.equal(adherenceFor("human-reviewed", { policy }).level, "not-evaluated");
  });

  it("rejects unknown statuses, unknown levels, and malformed entries", () => {
    assert.throws(() => resolvePolicy({ passed: "supports" }), /unknown finding status "passed"/);
    assert.throws(() => resolvePolicy({ met: "yes" }), /"yes" is not an OpenACR level/);
    assert.throws(() => resolvePolicy({ met: { level: "supports", why: "x" } }), /unknown key "why"/);
    assert.throws(() => resolvePolicy({ met: { note: "" } }), /note must be a non-empty string/);
    assert.throws(() => resolvePolicy({ met: 3 }), /expected a level/);
    assert.throws(() => resolvePolicy({ failing: { level: { most: "does-not-support" } } }), /unknown failing share/);
    assert.throws(() => resolvePolicy([]), /expected an object/);
  });

  it("does not change the default policy", () => {
    resolvePolicy({ "page-level": "not-evaluated" });
    assert.equal(DEFAULT_POLICY["page-level"].level, "not-applicable");
  });
});
