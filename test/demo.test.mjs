/**
 * Tests for `aloud demo`: the bundled sample capture replayed through the
 * real pipeline. Two layers:
 *   1. the fixtures through the real rule engine and transcript
 *      segmentation (pins the documented sample contract), and
 *   2. the demo CLI end to end (report artifacts + honesty notice).
 * Audio assertions run only when the host has a TTS voice; without one the
 * demo prints its skip line and the audio checks are skipped.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { dedupeConsecutive, segmentTranscript } from "../src/android/transcript.mjs";
import { parseUiDump, runChecks } from "../src/android/ui-tree.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "src", "demo", "fixtures");

const DEMO_NOTICE =
  "Demo data. This is a replay of a captured audit of the bundled sample screen, not your app.";
const EXPECTED_RULE_IDS = ["native-interactive-unlabeled"];
const EXPECTED_WARN_IDS = ["native-touch-target-small"];
const EXPECTED_UTTERANCES = [
  "Order status, heading",
  "Your order shipped on Tuesday, August 25th.",
  "Track package, button",
  "Unlabeled, button",
  "Cancel order, button",
];

describe("demo fixtures through the real pipeline", () => {
  it("fires exactly the documented error and warning on the sample tree", () => {
    const xml = readFileSync(join(FIXTURES, "order-status.uidump.xml"), "utf8");
    const violations = runChecks(parseUiDump(xml), {
      densityDpi: 420,
      appPackage: "com.example.shop",
    });
    const byRule = (severity) =>
      violations.filter((v) => v.severity === severity).map((v) => v.ruleId).sort();
    assert.deepEqual(byRule("error"), EXPECTED_RULE_IDS);
    assert.deepEqual(byRule("warn"), EXPECTED_WARN_IDS);
    assert.equal(violations.length, 2);
    const unlabeled = violations.find((v) => v.ruleId === "native-interactive-unlabeled");
    assert.ok(unlabeled.element.includes("share_order"));
    const small = violations.find((v) => v.ruleId === "native-touch-target-small");
    assert.ok(small.element.includes("cancel_order"));
    // 32dp meets WCAG 2.5.8's 24dp minimum but misses Android's 48dp guideline.
    assert.ok(small.detail.includes("32x32dp"));
    assert.deepEqual(small.criteria, []);
    assert.ok(!violations.some((v) => v.ruleId === "native-target-size-minimum"));
  });

  it("segments the bundled logcat into the documented five utterances", () => {
    const log = readFileSync(join(FIXTURES, "order-status.logcat.txt"), "utf8");
    const screens = segmentTranscript(log);
    assert.deepEqual(dedupeConsecutive(screens["order-status"] ?? []), EXPECTED_UTTERANCES);
    // speech after the end marker stays out of the screen's transcript
    assert.ok(screens["_between"].includes("Home, tab"));
  });
});

describe("aloud demo end to end", () => {
  it("writes a real report from the bundled capture and says it is demo data", () => {
    const out = mkdtempSync(join(tmpdir(), "aloud-demo-"));
    try {
      const res = spawnSync(
        process.execPath,
        [join(ROOT, "bin", "aloud.mjs"), "demo", "--out", out],
        { encoding: "utf8" },
      );
      assert.equal(res.status, 0, res.stderr);
      assert.ok(res.stdout.includes(DEMO_NOTICE));

      const tree = JSON.parse(readFileSync(join(out, "order-status.tree.json"), "utf8"));
      assert.deepEqual(tree.gate, { errors: 1, ruleIds: EXPECTED_RULE_IDS });

      const transcript = JSON.parse(
        readFileSync(join(out, "order-status.transcript.json"), "utf8"),
      );
      assert.equal(transcript.source, "talkback");
      assert.deepEqual(transcript.transcript, EXPECTED_UTTERANCES);

      const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
      assert.equal(summary.screens["order-status"].errors, 1);
      assert.equal(summary.screens["order-status"].warns, 1);
      assert.equal(summary.screens["order-status"].utterances, 5);

      assert.ok(existsSync(join(out, "shots", "order-status.png")));
      const html = readFileSync(join(out, "index.html"), "utf8");
      assert.ok(html.includes(DEMO_NOTICE));
      assert.ok(html.includes("native-interactive-unlabeled"));
      assert.ok(html.includes("native-touch-target-small"));

      if (res.stdout.includes("No TTS voice found")) return; // host has no TTS; audio skipped
      const manifest = JSON.parse(
        readFileSync(join(out, "speech-audio", "manifest.json"), "utf8"),
      );
      assert.equal(manifest["order-status"].length, 5);
      manifest["order-status"].forEach((entry, i) => {
        assert.equal(entry.i, i);
        assert.equal(entry.file, `speech-audio/order-status-${i}.wav`);
        assert.equal(entry.text, EXPECTED_UTTERANCES[i]);
        assert.ok(existsSync(join(out, entry.file)));
      });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
