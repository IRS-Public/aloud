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

  it("createFindings keeps the finding shape and default error severity", () => {
    const { violations, add } = createFindings((el) => `Button ${el.id}`);
    add("rule-a", "4.1.2", { id: 1 }, "first");
    add("rule-b", "2.5.8", { id: 2 }, "second", "warn");
    assert.deepEqual(violations, [
      { ruleId: "rule-a", wcag: "4.1.2", severity: "error", element: "Button 1", detail: "first" },
      { ruleId: "rule-b", wcag: "2.5.8", severity: "warn", element: "Button 2", detail: "second" },
    ]);
  });

  it("createFindings appends platform fields after the common ones", () => {
    const { violations, add } = createFindings(() => "View", (el) => ({ nativeId: el.id }));
    add("rule-a", "4.1.2", { id: 7 }, "detail");
    assert.deepEqual(Object.keys(violations[0]), ["ruleId", "wcag", "severity", "element", "detail", "nativeId"]);
    assert.equal(violations[0].nativeId, 7);
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
