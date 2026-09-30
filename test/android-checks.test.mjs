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

  it("warns on a sub-48dp touch target against the Material guideline", () => {
    // 100px @420dpi = 38dp: under Material's 48dp, over WCAG 2.5.8's 24dp.
    const v = check(node({ ...base, text: "x", bounds: "[0,0][100,100]" }));
    const hit = v.find((x) => x.ruleId === "native-touch-target-small");
    assert.ok(hit);
    assert.ok(hit.detail.includes("38x38dp"));
    assert.equal(hit.severity, "warn");
    assert.deepEqual(hit.criteria, []);
    assert.equal(Object.hasOwn(hit, "wcag"), false, "a guideline warning has no primary criterion");
    assert.ok(!v.some((x) => x.ruleId === "native-target-size-minimum"));
  });

  it("flags an unlabeled image button", () => {
    const v = check(node({ ...base, class: "android.widget.ImageButton" }));
    const hit = v.find((x) => x.ruleId === "native-image-button-unlabeled");
    assert.ok(hit);
    assert.equal(hit.wcag, "4.1.2");
    assert.deepEqual(hit.criteria, ["4.1.2", "1.1.1"]);
  });

  it("flags an unlabeled empty EditText", () => {
    const v = check(node({ ...base, class: "android.widget.EditText", clickable: "false" }));
    const hit = v.find((x) => x.ruleId === "native-edittext-unlabeled");
    assert.ok(hit);
    assert.deepEqual(hit.criteria, ["4.1.2", "1.3.1"]);
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

describe("WCAG 2.5.8 target size (Android)", () => {
  // At 160dpi one pixel is one dp, which keeps the geometry readable.
  const checkAt = (densityDpi, xml) =>
    runChecks(parseUiDump(wrap(xml)), { densityDpi, appPackage: "com.example.app" });
  const minimum = (v) => v.filter((x) => x.ruleId === "native-target-size-minimum");
  const box = ([x1, y1, x2, y2]) => `[${x1},${y1}][${x2},${y2}]`;
  const target = (bounds, over = {}) => node({ ...base, text: "Go", bounds: box(bounds), ...over });
  // A labeled, full-size button whose left edge touches x.
  const neighbourAt = (x, size) => target([x, 0, x + 1000, size], { text: "Neighbour" });

  it("holds the boundary at exactly 24dp (23.9 fails, 24 and 24.1 pass)", () => {
    // 1600dpi is ten pixels per dp, so tenths of a dp are whole pixels.
    for (const [px, fails] of [[239, true], [240, false], [241, false]]) {
      const v = checkAt(1600, target([0, 0, px, px]) + neighbourAt(px, px));
      assert.equal(minimum(v).length, fails ? 1 : 0, `${px / 10}dp`);
    }
    const [hit] = minimum(checkAt(1600, target([0, 0, 239, 239]) + neighbourAt(239, 239)));
    assert.equal(hit.severity, "error");
    assert.equal(hit.wcag, "2.5.8");
    assert.deepEqual(hit.criteria, ["2.5.8"]);
    assert.match(hit.detail, /touch target 23\.9x23\.9dp \(minimum 24x24dp\)/);
  });

  it("judges one dimension alone: a wide target that is 23.9dp tall fails", () => {
    const v = checkAt(1600, target([0, 0, 2000, 239]) + target([0, 239, 2000, 739], { text: "Below" }));
    assert.equal(minimum(v).length, 1);
  });

  it("converts pixels to dp at each density the way Android lays views out", () => {
    // Android sizes a 24dp view at round(24 x density) pixels; one pixel
    // less is a real deficit at every density.
    for (const [dpi, px] of [[120, 18], [160, 24], [213, 32], [320, 48], [420, 63], [480, 72], [640, 96]]) {
      assert.equal(minimum(checkAt(dpi, target([0, 0, px, px]) + neighbourAt(px, px))).length, 0, `${px}px at ${dpi}dpi`);
      assert.equal(minimum(checkAt(dpi, target([0, 0, px - 1, px - 1]) + neighbourAt(px - 1, px))).length, 1,
        `${px - 1}px at ${dpi}dpi`);
    }
  });

  it("applies the spacing exception to an undersized target with room around it", () => {
    // A lone 20dp target: its 24dp circle touches nothing.
    assert.deepEqual(minimum(checkAt(160, target([100, 100, 120, 120]))), []);
    // A full-size neighbour whose edge is exactly 12dp from the centre only
    // touches the circle, which the exception allows.
    assert.deepEqual(minimum(checkAt(160, target([0, 0, 20, 20]) + neighbourAt(22, 48))), []);
  });

  it("fails an undersized target whose circle overlaps another target", () => {
    // Centre at x=10; the neighbour starts 11dp away.
    const [hit] = minimum(checkAt(160, target([0, 0, 20, 20]) + neighbourAt(21, 48)));
    assert.ok(hit);
    assert.match(hit.detail, /20x20dp .*spacing circle overlaps Button/);
  });

  it("fails two undersized targets whose circles overlap, and passes them 24dp apart", () => {
    // Centres 23dp apart: neither circle reaches the other box (13dp away),
    // but the circles overlap each other.
    const close = minimum(checkAt(160, target([0, 0, 20, 20]) + target([23, 0, 43, 20], { text: "Next" })));
    assert.equal(close.length, 2);
    assert.match(close[0].detail, /overlaps the spacing circle of Button/);
    // Centres exactly 24dp apart: the circles only touch.
    const apart = minimum(checkAt(160, target([0, 0, 20, 20]) + target([24, 0, 44, 20], { text: "Next" })));
    assert.deepEqual(apart, []);
  });

  it("ignores disabled neighbours, which accept no pointer input", () => {
    const v = checkAt(160, target([0, 0, 20, 20]) + neighbourAt(21, 48).replace('enabled="true"', 'enabled="false"'));
    assert.deepEqual(minimum(v), []);
  });

  it("treats a target's own clickable descendants as part of it, not neighbours", () => {
    const v = checkAt(160, node({ ...base, text: "", "content-desc": "Close", bounds: box([0, 0, 20, 20]) },
      target([4, 4, 16, 16], { text: "x" })));
    // The parent passes: its child is part of its own hit area. The child
    // is judged too, and the undersized parent around it is another target
    // its circle overlaps (a parent of 24dp or more would exempt it).
    const hits = minimum(v);
    assert.equal(hits.length, 1);
    assert.match(hits[0].element, /@\[4,4 12x12px\]/);
    assert.match(hits[0].detail, /overlaps Button @\[0,0 20x20px\]/);
  });

  it("keeps the exemptions: large labeled ancestor, scroll clipping, and non-positive bounds", () => {
    // A 30dp labeled clickable row is the real target for its 20dp switch:
    // fine for 2.5.8, still under the 48dp guideline.
    const row = node({ ...base, text: "", "content-desc": "Paperless", bounds: box([0, 0, 300, 30]) },
      target([5, 5, 25, 25], { class: "android.widget.Switch", checkable: "true", text: "" }));
    const inRow = checkAt(160, row + neighbourAt(300, 30));
    assert.deepEqual(minimum(inRow), []);
    assert.ok(inRow.some((x) => x.ruleId === "native-touch-target-small" && x.element.includes("Switch")));
    // A row cut to 10dp by the scroll viewport's edge is not judged.
    const clipped = `<node package="com.example.app" class="android.widget.ScrollView" scrollable="true" bounds="[0,0][400,400]">` +
      target([0, 390, 400, 400]) + target([0, 380, 400, 390], { text: "Above" }) + `</node>`;
    assert.ok(!minimum(checkAt(160, clipped)).some((x) => x.element.includes("@[0,390")));
    // Zero-sized ghosts are not judged, and are not neighbours either.
    assert.deepEqual(minimum(checkAt(160, target([0, 0, 0, 0]) + target([100, 0, 120, 20]))), []);
  });

  it("refuses to judge sizes without a real screen density", () => {
    for (const densityDpi of [undefined, 0, -1, Number.NaN, "420"]) {
      assert.throws(() => checkAt(densityDpi, target([0, 0, 20, 20])), /densityDpi must be a positive number/);
    }
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
