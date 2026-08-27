#!/usr/bin/env node
// aloud demo — replay the bundled sample capture through the real pipeline.
//
//   node src/demo/demo.mjs [--out <dir>]     (via: aloud demo)
//
// No device, no setup. The fixtures in ./fixtures are a uiautomator dump
// and a TalkBack logcat capture of one sample screen ("order-status" in the
// fictional Example Shop app), in the exact formats the Android leg
// produces. This script runs them through the REAL rule engine
// (src/android/ui-tree.mjs), the REAL transcript segmentation
// (src/android/transcript.mjs), and the REAL report generator
// (src/report/report.mjs). Nothing about the findings is canned: if the
// rules change, the demo's findings change.
//
// Honesty contract: every surface must say this is bundled sample data,
// and the sample must keep producing exactly the findings the README
// documents. The EXPECTED_* constants below pin that contract; on drift
// the demo refuses to write a report rather than publish output that no
// longer matches its own documentation.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeConsecutive, segmentTranscript } from "../android/transcript.mjs";
import { parseUiDump, runChecks } from "../android/ui-tree.mjs";
import { reconstructSpeech } from "./speak.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

// The sample capture's identity. densityDpi matches the device the sample
// screen was laid out for (Pixel-7-class, 420dpi: 48dp = 126px).
const SCREEN_ID = "order-status";
const SCREEN_TITLE = "Order status";
const APP_NAME = "Example Shop";
const APP_PACKAGE = "com.example.shop";
const DENSITY_DPI = 420;

export const DEMO_NOTICE =
  "Demo data. This is a replay of a captured audit of the bundled sample screen, not your app.";
export const AUDIO_NOTICE =
  "Audio is reconstructed: synthesized from the captured transcript, not a recording of the device.";

// The documented sample contract (the README quotes these verbatim).
const EXPECTED_RULE_IDS = ["native-interactive-unlabeled", "native-touch-target-small"];
const EXPECTED_UTTERANCES = [
  "Order status, heading",
  "Your order shipped on Tuesday, August 25th.",
  "Track package, button",
  "Unlabeled, button",
  "Cancel order, button",
];

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const OUT = resolve(opt("out", "aloud-demo-report"));

console.log(`aloud demo: replaying the bundled sample capture (app "${APP_NAME}")`);
console.log(DEMO_NOTICE);

mkdirSync(join(OUT, "shots"), { recursive: true });

// ── tree pass: real rules over the bundled uiautomator dump ──
const xml = readFileSync(join(FIXTURES, `${SCREEN_ID}.uidump.xml`), "utf8");
const violations = runChecks(parseUiDump(xml), {
  densityDpi: DENSITY_DPI,
  appPackage: APP_PACKAGE,
});
const errors = violations.filter((v) => v.severity === "error");
const ruleIds = [...new Set(errors.map((v) => v.ruleId))].sort();

// ── transcript pass: real segmentation over the bundled logcat capture ──
const logcat = readFileSync(join(FIXTURES, `${SCREEN_ID}.logcat.txt`), "utf8");
const transcript = dedupeConsecutive(segmentTranscript(logcat)[SCREEN_ID] ?? []);

// ── contract check: the fixtures must still produce the documented output ──
if (
  JSON.stringify(ruleIds) !== JSON.stringify(EXPECTED_RULE_IDS) ||
  errors.length !== EXPECTED_RULE_IDS.length ||
  JSON.stringify(transcript) !== JSON.stringify(EXPECTED_UTTERANCES)
) {
  fail(
    `aloud demo: the bundled sample no longer produces its documented findings.\n` +
      `  expected rules: ${EXPECTED_RULE_IDS.join(", ")}\n` +
      `  got rules:      ${ruleIds.join(", ") || "(none)"} (${errors.length} error(s))\n` +
      `  got ${transcript.length} utterance(s), expected ${EXPECTED_UTTERANCES.length}\n` +
      `Refusing to write a demo report that does not match the docs. ` +
      `Update the fixtures and the README together.`,
  );
}

// ── write the per-screen artifacts in the walker's exact shapes ──
writeFileSync(
  join(OUT, `${SCREEN_ID}.tree.json`),
  JSON.stringify(
    {
      screen: SCREEN_ID,
      title: `${SCREEN_TITLE} (${APP_NAME} sample)`,
      violations,
      gate: { errors: errors.length, ruleIds },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(OUT, `${SCREEN_ID}.transcript.json`),
  JSON.stringify({ screen: SCREEN_ID, source: "talkback", transcript }, null, 2),
);
copyFileSync(join(FIXTURES, `${SCREEN_ID}.png`), join(OUT, "shots", `${SCREEN_ID}.png`));

console.log(
  `  screen ${SCREEN_ID}: ${transcript.length} utterances, ` +
    `${errors.length} error(s), ${violations.length - errors.length} warn(s)`,
);
for (const v of errors) console.log(`    ${v.ruleId} (WCAG ${v.wcag}): ${v.detail}`);

// ── reconstructed speech audio ──
// Synthesized before the report renders: the report generator picks up
// <report-dir>/speech-audio/manifest.json and adds the audio controls.
const audio = reconstructSpeech({ [SCREEN_ID]: transcript }, OUT);
if (audio) {
  console.log(`  speech audio: ${audio.files} WAV clip(s) via ${audio.tts} + manifest.json`);
  console.log(AUDIO_NOTICE);
}

// ── real report generator (untouched src/report/report.mjs) ──
const env = { ...process.env };
delete env.ALOUD_CONFIG; // the demo is self-contained; ignore any real config
const report = spawnSync(process.execPath, [join(HERE, "..", "report", "report.mjs"), "--dir", OUT], {
  stdio: "inherit",
  env,
});
if (report.status !== 0) fail("aloud demo: report generation failed");

// The report generator is shared with real audits and must not carry demo
// strings; stamp the demo notice into the generated page here instead.
const indexPath = join(OUT, "index.html");
const html = readFileSync(indexPath, "utf8");
const banner = `<p style="border:1px solid #8a5a00;background:#fff7e6;color:#5c3d00;border-radius:6px;padding:8px 12px;font-weight:600">${DEMO_NOTICE}</p>`;
writeFileSync(
  indexPath,
  /<body[^>]*>/i.test(html)
    ? html.replace(/<body[^>]*>/i, (m) => `${m}\n${banner}`)
    : `${banner}\n${html}`,
);

console.log(`\nreport: ${indexPath}`);
console.log(DEMO_NOTICE);
