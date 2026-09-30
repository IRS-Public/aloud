import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFindings, hasArea, repeatedAnnouncements } from "../src/rules/shared.mjs";

describe("shared rule helpers", () => {
  it("hasArea accepts only boxes with positive width and height", () => {
    assert.equal(hasArea({ w: 1, h: 1 }), true);
    for (const box of [null, undefined, { w: 0, h: 10 }, { w: 10, h: -5 }, {}]) {
      assert.equal(hasArea(box), false, JSON.stringify(box));
    }
  });

  it("createFindings takes severity and criteria from the rule catalog", () => {
    const { violations, add } = createFindings("Android", (el) => `Button ${el.id}`);
    add("native-edittext-unlabeled", { id: 1 }, "first");
    add("native-duplicate-speakable", { id: 2 }, "second");
    assert.deepEqual(violations, [
      {
        ruleId: "native-edittext-unlabeled",
        wcag: "4.1.2",
        criteria: ["4.1.2", "1.3.1"],
        severity: "error",
        element: "Button 1",
        detail: "first",
      },
      {
        ruleId: "native-duplicate-speakable",
        wcag: "4.1.2",
        criteria: ["4.1.2", "2.4.6"],
        severity: "warn",
        element: "Button 2",
        detail: "second",
      },
    ]);
  });

  it("createFindings appends platform fields after the common ones", () => {
    const { violations, add } = createFindings("Android", () => "View", (el) => ({ nativeId: el.id }));
    add("native-interactive-unlabeled", { id: 7 }, "detail");
    assert.deepEqual(Object.keys(violations[0]), [
      "ruleId", "wcag", "criteria", "severity", "element", "detail", "nativeId",
    ]);
    assert.equal(violations[0].nativeId, 7);
  });

  it("createFindings refuses rule ids outside the catalog or from another platform", () => {
    const android = createFindings("Android", () => "View");
    assert.throws(() => android.add("native-new-rule", {}, "detail"), /unknown rule id "native-new-rule"/);
    assert.throws(() => android.add("ios-image-unlabeled", {}, "detail"), /runs on iOS, not Android/);
    assert.equal(android.violations.length, 0);
    assert.throws(() => createFindings("web", () => "View"), /unknown platform/);
  });

  it("createFindings hands out criteria copies, never the frozen catalog array", () => {
    const { violations, add } = createFindings("iOS", () => "Image");
    add("ios-image-unlabeled", {}, "detail");
    violations[0].criteria.push("9.9.9");
    const again = createFindings("iOS", () => "Image");
    again.add("ios-image-unlabeled", {}, "detail");
    assert.deepEqual(again.violations[0].criteria, ["1.1.1", "4.1.2"]);
  });

  it("repeatedAnnouncements reports each repeat in order with the first speaker", () => {
    const els = ["Go", "", "Pay", "Go", "Go", "Pay"].map((label, id) => ({ id, label }));
    const repeats = repeatedAnnouncements(els, (el) => el.label);
    assert.deepEqual(repeats.map((r) => [r.element.id, r.announcement, r.first.id, r.occurrence]), [
      [3, "Go", 0, 1],
      [4, "Go", 0, 2],
      [5, "Pay", 2, 1],
    ]);
  });

  it("repeatedAnnouncements never treats silence as a duplicate", () => {
    assert.deepEqual(repeatedAnnouncements([{}, {}], () => ""), []);
  });
});
