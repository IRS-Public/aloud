/**
 * Unit tests for the Android audit's pure logic: the uiautomator-dump
 * parser + rule engine (src/android/ui-tree.mjs) and the TalkBack
 * logcat transcript segmentation (src/android/transcript.mjs).
 * Device-free — fixtures stand in for the emulator.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseUiDump, runChecks } from "../src/android/ui-tree.mjs";
import {
  dedupeConsecutive,
  extractUtterance,
  segmentTranscript,
} from "../src/android/transcript.mjs";

// 420dpi (Pixel 7): 48dp = 126px. Bounds below are chosen against that.
const DENSITY = 420;
const node = (attrs, children = "") =>
  children
    ? `<node ${Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ")}>${children}</node>`
    : `<node ${Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ")} />`;

const base = {
  package: "com.example.app",
  class: "android.widget.Button",
  text: "",
  "content-desc": "",
  clickable: "true",
  focusable: "true",
  enabled: "true",
  bounds: "[0,0][300,300]",
};

const wrap = (inner) => `<?xml version='1.0'?><hierarchy rotation="0">${inner}</hierarchy>`;

describe("parseUiDump", () => {
  it("parses nested and self-closing nodes with bounds and entities", () => {
    const xml = wrap(
      node(
        { ...base, "content-desc": "Pay &amp; go", bounds: "[10,20][310,320]" },
        node({ ...base, class: "android.widget.TextView", clickable: "false", text: "inner" }),
      ),
    );
    const nodes = parseUiDump(xml);
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0]["content-desc"], "Pay & go");
    assert.deepEqual(nodes[0].bounds, { x1: 10, y1: 20, x2: 310, y2: 320, w: 300, h: 300 });
    assert.equal(nodes[0].children.length, 1);
    assert.equal(nodes[1].parent, nodes[0]);
  });
});

describe("runChecks", () => {
  const check = (xml) =>
    runChecks(parseUiDump(wrap(xml)), { densityDpi: DENSITY, appPackage: "com.example.app" });

  it("passes a labeled, big-enough button", () => {
    assert.deepEqual(check(node({ ...base, text: "Pay now" })), []);
  });

  it("flags an interactive element with no speakable text in its subtree", () => {
    const v = check(node(base));
    assert.ok(v.map((x) => x.ruleId).includes("native-interactive-unlabeled"));
  });

  it("lets a child's text label its clickable parent (TalkBack grouping)", () => {
    const v = check(
      node(
        base,
        node({ ...base, class: "android.widget.TextView", clickable: "false", text: "Pay" }),
      ),
    );
    assert.ok(!v.map((x) => x.ruleId).includes("native-interactive-unlabeled"));
  });

  it("flags a sub-48dp touch target with dp math", () => {
    // 100px @420dpi = 38dp
    const v = check(node({ ...base, text: "x", bounds: "[0,0][100,100]" }));
    const hit = v.find((x) => x.ruleId === "native-touch-target-small");
    assert.ok(hit);
    assert.ok(hit.detail.includes("38x38dp"));
  });

  it("flags an unlabeled image button", () => {
    const v = check(node({ ...base, class: "android.widget.ImageButton" }));
    assert.ok(v.map((x) => x.ruleId).includes("native-image-button-unlabeled"));
  });

  it("flags an unlabeled empty EditText", () => {
    const v = check(node({ ...base, class: "android.widget.EditText", clickable: "false" }));
    assert.ok(v.map((x) => x.ruleId).includes("native-edittext-unlabeled"));
  });

  it("warns (not errors) on duplicate speakable labels", () => {
    const v = check(
      node({ ...base, text: "View details", bounds: "[0,0][300,300]" }) +
        node({ ...base, text: "View details", bounds: "[0,400][300,700]" }),
    );
    const dupes = v.filter((x) => x.ruleId === "native-duplicate-speakable");
    assert.ok(dupes.length > 0);
    assert.ok(dupes.every((x) => x.severity === "warn"));
  });

  it("skips unfocusable clickable layers (a11y-hidden sheet scrims)", () => {
    const v = check(node({ ...base, focusable: "false", bounds: "[0,0][1080,2400]" }));
    assert.ok(!v.map((x) => x.ruleId).includes("native-interactive-unlabeled"));
  });

  it("ignores system-UI nodes outside the app package", () => {
    assert.deepEqual(check(node({ ...base, package: "com.android.systemui" })), []);
  });

  it("skips elements clipped at a scrollable ancestor's bottom edge", () => {
    // 100px-tall visible slice of a row cut by the scroll viewport at y=2208
    const xml =
      `<node package="com.example.app" class="android.widget.ScrollView" scrollable="true" bounds="[0,200][1080,2208]">` +
      node({ ...base, text: "Send feedback", bounds: "[0,2108][1080,2208]" }) +
      `</node>`;
    const v = check(xml);
    assert.ok(!v.map((x) => x.ruleId).includes("native-touch-target-small"));
  });

  it("treats 47.6dp (125px at 420dpi) as meeting the 48dp bar", () => {
    const v = check(node({ ...base, text: "Pay", bounds: "[0,0][428,125]" }));
    assert.ok(!v.map((x) => x.ruleId).includes("native-touch-target-small"));
  });

  it("skips display-only controls inside a labeled 48dp clickable row", () => {
    const row = node(
      { ...base, class: "android.view.ViewGroup", text: "", "content-desc": "Paperless" },
      node({
        ...base,
        class: "android.widget.Switch",
        checkable: "true",
        bounds: "[200,20][322,91]",
      }),
    );
    const v = check(row);
    assert.ok(!v.map((x) => x.ruleId).includes("native-touch-target-small"));
    assert.ok(!v.map((x) => x.ruleId).includes("native-interactive-unlabeled"));
  });

  it("skips zero-sized layout ghosts in the target-size rule", () => {
    const v = check(node({ ...base, text: "x", bounds: "[0,0][0,0]" }));
    assert.ok(!v.map((x) => x.ruleId).includes("native-touch-target-small"));
  });
});

describe("transcript", () => {
  // Line shape verified against google/talkback SpeechControllerImpl (16.2):
  // tag "talkback: SpeechControllerImpl", threadtime format.
  const tb = (text, n) =>
    `08-15 10:00:00.500  4711  4711 V talkback: SpeechControllerImpl: Speaking fragment text="${text}", utteranceId=talkback_${n}, TtsSpan=null, locale=null, event=null`;
  const log = [
    `08-15 10:00:00.000 I/A11Y_AUDIT( 100): screen-start:guest-home`,
    tb("Order status, heading", 1),
    tb("Order status, heading", 2),
    tb("Email address, edit box", 3),
    `08-15 10:00:01.100  4711  4711 V talkback: SpeechControllerImpl: Speaking fragment text=null, utteranceId=talkback_4, TtsSpan=null, locale=null, event=null`,
    `08-15 10:00:01.200 D/OtherTag( 300): unrelated noise text="ignore me"`,
    `08-15 10:00:02.000 I/A11Y_AUDIT( 100): screen-end:guest-home`,
    tb("Home, tab", 5),
  ].join("\n");

  it("extracts utterances, surviving embedded quotes and commas", () => {
    assert.equal(extractUtterance(tb("Pay now, button", 9)), "Pay now, button");
    assert.equal(extractUtterance(tb('Say "hello", button', 9)), 'Say "hello", button');
    // pre-TtsSpan format (older TalkBack)
    assert.equal(
      extractUtterance(`Speaking fragment text="Pay now, button", utteranceId=talkback_9`),
      "Pay now, button",
    );
    // TalkBack 14.x shape, observed live on the emulator (talkback-foss)
    assert.equal(
      extractUtterance(
        `08-15 14:46:03.174  6360  6360 V talkback: SpeechControllerImpl: Speaking fragment text "Settings" with spans null for event type:EVENT_TYPE_ACCESSIBILITY subtype:TYPE_WINDOW_STATE`,
      ),
      "Settings",
    );
    // text=null is a non-spoken item, not an utterance
    assert.equal(
      extractUtterance(
        `Speaking fragment text=null, utteranceId=talkback_9, TtsSpan=null, locale=null, event=null`,
      ),
      null,
    );
    assert.equal(extractUtterance(`no speech here`), null);
    assert.equal(extractUtterance(tb("TalkBack on", 1)), null);
  });

  it("segments utterances by screen markers", () => {
    const screens = segmentTranscript(log);
    assert.deepEqual(screens["guest-home"], [
      "Order status, heading",
      "Order status, heading",
      "Email address, edit box",
    ]);
    // speech after screen-end lands in _between, not the screen
    assert.ok(screens["_between"].includes("Home, tab"));
  });

  it("collapses consecutive duplicates only", () => {
    assert.deepEqual(dedupeConsecutive(["a", "a", "b", "a"]), ["a", "b", "a"]);
  });
});
