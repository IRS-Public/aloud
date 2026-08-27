/**
 * Unit tests for the evidence page renderer (src/report/html.mjs). The page
 * is what adopters hand to their 508 coordinator, so the tests pin the
 * things that must not regress: failing screens first, honest computed
 * VoiceOver labeling, the reconstructed-audio disclosure above the first
 * audio control, escaping, graceful degradation, and zero external requests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUDIO_NOTE, displayOrder, renderReportHtml } from "../src/report/html.mjs";

const base = () => ({
  failing: {
    screen: "failing",
    title: "Refund form",
    source: "talkback",
    transcript: ['Refund form, heading', "Submit, button"],
    violations: [
      {
        ruleId: "android-unlabeled",
        wcag: "4.1.2",
        severity: "error",
        detail: "clickable element with no text",
        element: "<node class=Button>",
      },
      {
        ruleId: "android-small-target",
        wcag: "2.5.8",
        severity: "warn",
        detail: "target under 24dp",
        element: "<node class=ImageView>",
      },
    ],
    gate: { errors: 1, ruleIds: ["android-unlabeled"] },
  },
  passing: {
    screen: "passing",
    title: "Home",
    source: "talkback",
    transcript: ["Home, heading"],
    violations: [],
    gate: { errors: 0, ruleIds: [] },
  },
});

const render = (screens, extra = {}) =>
  renderReportHtml({
    screens,
    ids: Object.keys(screens).sort(),
    generated: "2026-08-27T00:00:00.000Z",
    shots: new Set(),
    audioManifest: null,
    ...extra,
  });

describe("evidence page renderer", () => {
  it("sorts failing screens first", () => {
    const screens = base();
    assert.deepEqual(displayOrder(["failing", "passing"], screens), ["failing", "passing"]);
    const html = render(screens);
    assert.ok(html.indexOf('id="screen-failing"') < html.indexOf('id="screen-passing"'));
  });

  it("escapes user-controlled text", () => {
    const screens = base();
    screens.failing.transcript = ['<script>alert("x")</script>'];
    screens.failing.title = 'A "quoted" <title>';
    const html = render(screens);
    assert.ok(!html.includes('<script>alert'));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("A &quot;quoted&quot; &lt;title&gt;"));
  });

  it("labels computed VoiceOver honestly", () => {
    const screens = base();
    screens.failing.source = "computed-voiceover";
    const html = render(screens);
    assert.ok(html.includes("Computed VoiceOver"));
    assert.ok(html.includes("computed, not recorded"));
    assert.ok(html.includes("iOS · Computed VoiceOver"));
  });

  it("renders nothing audio-related without a manifest", () => {
    const html = render(base());
    assert.ok(!html.includes(AUDIO_NOTE));
    assert.ok(!html.includes('class="play"'));
    assert.ok(!html.includes("<script>"));
  });

  it("puts the reconstructed-audio note directly above the first control", () => {
    const screens = base();
    const html = render(screens, {
      audioManifest: {
        passing: [{ i: 0, file: "speech-audio/passing-0.wav", text: "Home, heading" }],
      },
    });
    const note = html.indexOf(AUDIO_NOTE);
    const button = html.indexOf('class="play"');
    assert.ok(note >= 0, "note rendered");
    assert.ok(button >= 0, "button rendered");
    assert.ok(note < button, "note precedes the first audio control");
    assert.equal(html.indexOf(AUDIO_NOTE, note + 1), -1, "note appears once");
    assert.ok(html.includes("speech-audio/passing-0.wav"));
    assert.ok(html.includes("<script>"));
  });

  it("ignores manifest entries whose index is out of range", () => {
    const screens = base();
    const html = render(screens, {
      audioManifest: { passing: [{ i: 9, file: "speech-audio/nope.wav" }] },
    });
    assert.ok(!html.includes('class="play"'));
    assert.ok(!html.includes(AUDIO_NOTE));
  });

  it("degrades when fields are missing", () => {
    const screens = {
      bare: { screen: "bare", transcript: [], source: "talkback" },
    };
    const html = render(screens);
    assert.ok(html.includes("No speech captured in this run."));
    assert.ok(html.includes("No tree check in this run."));
    assert.ok(!html.includes("<img"), "no screenshot, no img tag");
    assert.ok(html.includes("bare"), "falls back to the id as the title");
  });

  it("makes zero external requests", () => {
    const screens = base();
    screens.failing.source = "computed-voiceover";
    const html = render(screens, {
      shots: new Set(["failing"]),
      audioManifest: { passing: [{ i: 0, file: "speech-audio/p.wav" }] },
    });
    assert.ok(!/https?:\/\//.test(html), "no external URLs");
    assert.ok(!/<link/.test(html), "no external stylesheets");
    assert.ok(!/src="(?!shots\/|speech-audio\/)/.test(html), "only local relative srcs");
  });

  it("counts pass and fail in the header", () => {
    const html = render(base());
    assert.ok(html.includes("<dt>Pass</dt><dd class=\"is-pass\">1</dd>"));
    assert.ok(html.includes("<dt>Fail</dt><dd class=\"is-fail\">1</dd>"));
  });
});
