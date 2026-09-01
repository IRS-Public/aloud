/**
 * Unit tests for the iOS half of the audit: the computed VoiceOver
 * utterance composer (src/ios/voiceover.mjs) and the idb-dump
 * normalizer + rules (src/ios/tree.mjs).
 * Device-free — fixtures stand in for `idb ui describe-all --json`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeTranscript, normalizeElements, runIosChecks } from "../src/ios/tree.mjs";
import { composeUtterance, isFocusable } from "../src/ios/voiceover.mjs";

const el = (over = {}) => ({
  AXLabel: "Pay now",
  AXValue: null,
  help: null,
  type: "Button",
  enabled: true,
  AXUniqueId: null,
  frame: { x: 0, y: 0, width: 200, height: 48 },
  ...over,
});

describe("composeUtterance", () => {
  const norm = (over = {}) => normalizeElements([el(over)])[0];

  it("orders label, value, trait, hint — matching Xcode 27 utterance style", () => {
    assert.equal(composeUtterance(norm()), "Pay now, button");
    assert.equal(
      composeUtterance(norm({ AXValue: "$50", help: "Double tap to pay", type: "Button" })),
      "Pay now, $50, button, Double tap to pay",
    );
  });

  it("marks disabled controls as dimmed", () => {
    assert.equal(composeUtterance(norm({ enabled: false })), "Pay now, button, dimmed");
  });

  it("does not repeat a value identical to the label", () => {
    assert.equal(composeUtterance(norm({ AXValue: "Pay now" })), "Pay now, button");
  });

  it("speaks plain text with no trait word", () => {
    assert.equal(
      composeUtterance(norm({ type: "StaticText", AXLabel: "Order status" })),
      "Order status",
    );
  });

  it("maps boolean values to switch words", () => {
    assert.equal(
      composeUtterance(norm({ type: "Switch", AXLabel: "Paperless", AXValue: true })),
      "Paperless, on, switch",
    );
    assert.equal(
      composeUtterance(norm({ type: "Switch", AXLabel: "Paperless", AXValue: false })),
      "Paperless, off, switch",
    );
  });
});

describe("normalizeElements", () => {
  it("parses the AXFrame string form", () => {
    const [n] = normalizeElements([el({ frame: undefined, AXFrame: "{{10, 20}, {100, 44}}" })]);
    assert.deepEqual(n.frame, { x: 10, y: 20, w: 100, h: 44 });
  });

  it("accepts a JSON string dump", () => {
    assert.equal(normalizeElements(JSON.stringify([el()])).length, 1);
  });

  it("treats 'null' strings as empty", () => {
    const [n] = normalizeElements([el({ AXLabel: "null" })]);
    assert.equal(n.label, "");
  });
});

describe("computeTranscript", () => {
  it("skips silent elements and keeps tree order", () => {
    const t = computeTranscript(
      normalizeElements([
        el({ AXLabel: "Order status", type: "StaticText" }),
        el({ AXLabel: null, type: "Other" }), // nothing to say
        el({ AXLabel: "Check order status", type: "Button" }),
      ]),
    );
    assert.deepEqual(t, ["Order status", "Check order status, button"]);
  });

  it("keeps unlabeled interactive elements — VoiceOver still stops on them", () => {
    const [n] = normalizeElements([el({ AXLabel: null })]);
    assert.equal(isFocusable(n), true);
    assert.deepEqual(computeTranscript([n]), ["button"]);
  });
});

describe("runIosChecks", () => {
  const check = (elements) => runIosChecks(normalizeElements(elements));

  it("passes a labeled, big-enough button", () => {
    assert.deepEqual(check([el()]), []);
  });

  it("flags an unlabeled interactive element", () => {
    assert.ok(
      check([el({ AXLabel: null })])
        .map((v) => v.ruleId)
        .includes("ios-interactive-unlabeled"),
    );
  });

  it("flags an unlabeled image", () => {
    assert.ok(
      check([el({ type: "Image", AXLabel: null })])
        .map((v) => v.ruleId)
        .includes("ios-image-unlabeled"),
    );
  });

  it("flags a sub-44pt target with pt math", () => {
    const v = check([el({ frame: { x: 0, y: 0, width: 100, height: 32 } })]);
    const hit = v.find((x) => x.ruleId === "ios-touch-target-small");
    assert.ok(hit);
    assert.ok(hit.detail.includes("100x32pt"));
  });

  it("warns, not errors, on duplicate announcements", () => {
    const v = check([el(), el({ frame: { x: 0, y: 100, width: 200, height: 48 } })]);
    const dupes = v.filter((x) => x.ruleId === "ios-duplicate-speakable");
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0].severity, "warn");
  });

  it("skips zero-sized and frameless elements", () => {
    assert.deepEqual(
      check([
        el({ AXLabel: null, frame: { x: 0, y: 0, width: 0, height: 0 } }),
        el({ AXLabel: null, frame: undefined, AXFrame: undefined }),
      ]),
      [],
    );
  });

  it("flags a toggle announcing a raw numeric value", () => {
    const v = check([el({ type: "Switch", AXLabel: "Paperless notices", AXValue: "1" })]);
    const hit = v.find((x) => x.ruleId === "ios-toggle-raw-value");
    assert.ok(hit);
    assert.ok(hit.detail.includes('"1"'));
    // real booleans normalize to on/off upstream and must NOT flag
    assert.equal(
      check([el({ type: "Switch", AXLabel: "Paperless notices", AXValue: true })]).filter(
        (x) => x.ruleId === "ios-toggle-raw-value",
      ).length,
      0,
    );
  });

  it("warns when a list row loses its interactive trait among interactive siblings", () => {
    const row = (y, over = {}) =>
      el({ frame: { x: 20, y, width: 350, height: 60 }, ...over });
    const v = check([
      row(0, { AXLabel: "Dana Whitfield" }),
      row(70, { AXLabel: "Miguel Santana", type: "StaticText" }),
      row(140, { AXLabel: "Priya Anand" }),
      row(210, { AXLabel: "Chidi Okafor" }),
    ]);
    const hits = v.filter((x) => x.ruleId === "ios-list-row-not-interactive");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].severity, "warn");
    assert.ok(hits[0].detail.includes("Miguel Santana"));
    // an all-static column (a definition list) must not flag
    const calm = check([
      row(0, { AXLabel: "A", type: "StaticText" }),
      row(70, { AXLabel: "B", type: "StaticText" }),
      row(140, { AXLabel: "C", type: "StaticText" }),
    ]);
    assert.equal(calm.filter((x) => x.ruleId === "ios-list-row-not-interactive").length, 0);
  });
});
