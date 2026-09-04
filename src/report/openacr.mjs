#!/usr/bin/env node
// Convert the aloud audit results into a draft OpenACR report
// (https://github.com/GSA/openacr). The draft fills in only what the
// automated audit can prove — everything else is "not-evaluated" with a
// note that a human review is required. A 508 office finishes the report.
//
//   aloud openacr --out acr-draft.yaml
//
// Inputs default to the baselines named in the resolved config
// (env ALOUD_CONFIG); point --report / --report-ios at a fresh run's
// report dir (report.mjs writes summary.json there):
//
//   --android <file>      Android baseline
//   --ios <file>          iOS baseline
//   --report <dir>        read <dir>/summary.json instead of --android
//   --report-ios <dir>    read <dir>/summary.json instead of --ios
//   --date <YYYY-MM-DD>   report date (defaults to the report's generated
//                         date, else today; tests pass it for determinism)
//   --version <v>         product version (config app.version otherwise)
//   --catalog <file>      OpenACR catalog YAML override
//   --out <file>          output path (default acr-draft.yaml in cwd)
//
// No import.meta here — the unit tests (node:test) import this module
// directly, and the exported API must stay usable without a module URL.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { dump, load } from "js-yaml";

// The catalog names the edition the draft is built against. WCAG 2.2 is
// required: the touch-target rules map to 2.5.8, which exists only there.
export const CATALOG_ID = "2.5-edition-wcag-2.2-508-en";

// ── audit rule → WCAG evidence ──
// Every rule id the audit can emit (src/android/ui-tree.mjs /
// src/ios/tree.mjs), with the platform it runs on. Warn-only rules never
// appear in baseline ruleIds (the walkers gate errors only) but are
// described in notes.
export const RULES = {
  "native-interactive-unlabeled": {
    platform: "Android",
    what: "interactive element with no speakable text",
  },
  "native-image-button-unlabeled": {
    platform: "Android",
    what: "image control without a content description",
  },
  "native-edittext-unlabeled": {
    platform: "Android",
    what: "text field with no label, hint, or content description",
  },
  "native-touch-target-small": {
    platform: "Android",
    what: "touch target under 48x48dp",
  },
  "ios-interactive-unlabeled": {
    platform: "iOS",
    what: "interactive element with no label or value",
  },
  "ios-image-unlabeled": {
    platform: "iOS",
    what: "image element without an accessibility label",
  },
  "ios-touch-target-small": {
    platform: "iOS",
    what: "touch target under 44x44pt",
  },
};

// Criteria the audit gives partial evidence for. "covers" states, in the
// adherence notes, exactly what the automation checks — never more.
export const AUTOMATED_CRITERIA = {
  "1.1.1": {
    rules: ["native-image-button-unlabeled", "ios-image-unlabeled"],
    covers: "image controls and image elements must carry a text label",
  },
  "1.3.1": {
    rules: ["native-edittext-unlabeled"],
    covers: "text fields must expose a label a screen reader can announce (Android check only)",
  },
  "2.5.8": {
    rules: ["native-touch-target-small", "ios-touch-target-small"],
    covers:
      "touch targets must meet the platform minimum (48x48dp on Android, 44x44pt on iOS; both exceed the 24 CSS px minimum of this criterion)",
  },
  "4.1.2": {
    rules: [
      "native-interactive-unlabeled",
      "native-image-button-unlabeled",
      "native-edittext-unlabeled",
      "ios-interactive-unlabeled",
      "ios-image-unlabeled",
    ],
    covers: "interactive elements, image controls, and text fields must expose an accessible name",
    extra:
      "Three report-only warnings add related evidence: elements that announce identical labels (native-duplicate-speakable, ios-duplicate-speakable), " +
      "iOS controls announcing a raw \"1\"/\"0\" where a switch state should speak on/off (ios-toggle-raw-value), " +
      "and iOS list rows with no interactive trait among interactive siblings (ios-list-row-not-interactive); warnings do not gate.",
  },
};

// Criteria the audit cannot decide but has related evidence for. The
// 302.1 note names the transcript coverage, so it is built per run in
// buildAcr from the actual screen counts.
const SPECIAL_NOTES = {
  "2.5.5":
    "Not evaluated; needs human review. Related evidence: the automated target-size rules hold the platform bars (48x48dp Android, 44x44pt iOS), which meet the 44 CSS px measure of this AAA criterion on every audited screen.",
  "2.4.6":
    "Not evaluated; needs human review. Related evidence: the audit flags interactive elements that announce identical labels (native-duplicate-speakable, ios-duplicate-speakable) as warnings; warnings do not gate.",
};

// Coverage strings such as "12 Android screens and 12 iOS screens" are
// always computed from the audits actually read, never hardcoded, so
// partial runs stay honest.
function transcriptCoverage(audits) {
  return audits
    .map(({ platform, screens }) => `${Object.keys(screens).length} ${platform} screens`)
    .join(" and ");
}

const NOT_EVALUATED_NOTE = "Not covered by the automated audit. Needs human review.";

// ── inputs ──
// Baselines are a flat map { screenId: { errors, ruleIds } };
// report.mjs's summary.json wraps the same shape as
// { generated, screens: {...} }. Normalize both.
export function normalizeAudit(data) {
  if (data && typeof data === "object" && data.screens) {
    return { screens: data.screens, generated: data.generated ?? null };
  }
  return { screens: data ?? {}, generated: null };
}

// For one criterion, list the screens whose baseline error rule ids
// intersect the criterion's rules, per platform.
export function findFailures(criterionRules, audits) {
  const failures = [];
  for (const { platform, screens } of audits) {
    for (const [id, s] of Object.entries(screens)) {
      const hit = (s.ruleIds ?? []).filter((r) => criterionRules.includes(r));
      if (hit.length) failures.push({ platform, screen: id, ruleIds: hit });
    }
  }
  return failures;
}

function adherenceForAutomated(num, audits) {
  const auto = AUTOMATED_CRITERIA[num];
  const failures = findFailures(auto.rules, audits);
  const checked = audits
    .map(({ platform, screens }) => `${Object.keys(screens).length} ${platform} screens`)
    .join(" and ");
  const coverage =
    `Automated checks cover part of this criterion only: ${auto.covers}. ` +
    (auto.extra ? `${auto.extra} ` : "") +
    `A human review must complete the rest. See https://github.com/IRS-Public/aloud/blob/main/docs/how-it-works.md.`;
  if (failures.length === 0) {
    return {
      level: "supports",
      notes: `The automated native audit found no violations on ${checked}. ${coverage}`,
    };
  }
  const detail = failures
    .map((f) => `${f.platform} ${f.screen}: ${f.ruleIds.join(", ")}`)
    .join("; ")
    .slice(0, 1500);
  return {
    level: "partially-supports",
    notes: `The automated native audit found violations on ${failures.length} of ${checked}: ${detail}. ${coverage}`,
  };
}

// ── report ──
export function buildAcr({
  catalog,
  android,
  ios,
  date,
  productVersion,
  appName,
  appDescription,
  authorName,
  authorEmail,
}) {
  if (!appName) {
    throw new Error("buildAcr needs an app name (config app.name)");
  }
  const audits = [];
  if (android) audits.push({ platform: "Android", screens: android.screens });
  if (ios) audits.push({ platform: "iOS", screens: ios.screens });

  // Refuse rule ids the emitter does not know. Without this, a new audit
  // rule with baseline errors would be invisible to every mapped criterion
  // and the report would claim "supports" while the audit is failing.
  for (const { platform, screens } of audits) {
    for (const [id, s] of Object.entries(screens)) {
      for (const r of s.ruleIds ?? []) {
        if (!RULES[r]) {
          throw new Error(
            `unknown audit rule id "${r}" (${platform} ${id}): add it to RULES and ` +
              "map it in AUTOMATED_CRITERIA in src/report/openacr.mjs",
          );
        }
      }
    }
  }

  const note302 =
    "Not evaluated; needs human review. Related evidence: the audit records what a " +
    "screen-reader user hears on every screen — TalkBack speech-log transcripts on " +
    `Android and computed VoiceOver transcripts on iOS (${transcriptCoverage(audits)}). ` +
    "See https://github.com/IRS-Public/aloud/blob/main/docs/how-it-works.md.";

  const chapters = {};
  for (const chapter of catalog.chapters) {
    if (chapter.id === "hardware") {
      chapters[chapter.id] = {
        notes: `${appName} is a software application. Hardware criteria do not apply.`,
        disabled: true,
      };
      continue;
    }
    const criteria = chapter.criteria.map((c) => {
      const component = c.components.includes("software") ? "software" : c.components[0];
      let adherence;
      if (AUTOMATED_CRITERIA[c.id]) {
        adherence = adherenceForAutomated(c.id, audits);
      } else if (c.id === "302.1") {
        adherence = { level: "not-evaluated", notes: note302 };
      } else if (SPECIAL_NOTES[c.id]) {
        adherence = { level: "not-evaluated", notes: SPECIAL_NOTES[c.id] };
      } else {
        adherence = { level: "not-evaluated", notes: NOT_EVALUATED_NOTE };
      }
      return { num: c.id, components: [{ name: component, adherence }] };
    });
    chapters[chapter.id] = { criteria };
  }

  const screenCounts = audits
    .map(({ platform, screens }) => `${Object.keys(screens).length} on ${platform}`)
    .join(", ");

  return {
    title: `${appName} Accessibility Conformance Report (draft)`,
    product: {
      name: appName,
      version: productVersion,
      description: appDescription || `${appName} mobile app for iOS and Android.`,
    },
    author: {
      name: authorName || "Automated draft — aloud openacr",
      email: authorEmail || "todo@example.com",
    },
    report_date: date,
    notes:
      "DRAFT. This report is generated from the automated 508 audit " +
      "(https://github.com/IRS-Public/aloud/blob/main/docs/how-it-works.md). It records only what " +
      "automation can prove: " +
      "tree checks for labels and touch-target size, run on every audited screen " +
      `(${screenCounts}). The audit also captures what a screen-reader user hears ` +
      "on each of those screens: TalkBack speech-log transcripts on Android and " +
      "computed VoiceOver transcripts on iOS. Every criterion marked " +
      "'not-evaluated' needs a human review. A Section 508 office must complete " +
      "those rows and replace the author contact before publication.",
    evaluation_methods_used:
      "Automated accessibility-tree checks on a device or simulator for every " +
      "screen in the screens manifest (uiautomator dumps on Android, idb " +
      "accessibility dumps on iOS), with screen-reader transcripts captured per " +
      "screen (TalkBack on Android; computed VoiceOver on iOS). Rules and WCAG " +
      "mapping: src/android/ui-tree.mjs and src/ios/tree.mjs. " +
      "No human evaluation yet.",
    catalog: CATALOG_ID,
    chapters,
  };
}

export function toYaml(acr) {
  return dump(acr, { lineWidth: 100 });
}

// ── CLI ──
function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };

  const cfg = process.env.ALOUD_CONFIG
    ? JSON.parse(readFileSync(process.env.ALOUD_CONFIG, "utf8"))
    : null;

  const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

  // One audit per platform: an explicit flag or report dir must exist;
  // a config-default baseline is used only when the file is present.
  const loadAudit = (reportDir, flagPath, cfgPath) => {
    if (reportDir) return normalizeAudit(readJson(join(reportDir, "summary.json")));
    if (flagPath) return normalizeAudit(readJson(flagPath));
    if (cfgPath) {
      try {
        return normalizeAudit(readJson(cfgPath));
      } catch {
        return null;
      }
    }
    return null;
  };

  const android = loadAudit(opt("report", null), opt("android", null), cfg?.baseline?.android);
  const ios = loadAudit(opt("report-ios", null), opt("ios", null), cfg?.baseline?.ios);
  if (!android && !ios) {
    console.error(
      "no audit input: pass --android/--ios baseline files or --report/--report-ios dirs, " +
        "or set baseline paths in aloud.config.json",
    );
    process.exit(1);
  }

  const generated = android?.generated ?? ios?.generated;
  const date = opt(
    "date",
    generated ? generated.slice(0, 10) : new Date().toISOString().slice(0, 10),
  );

  // Resolve the catalog inside aloud's own install, not the target repo.
  const requireFromHere = createRequire(process.argv[1]);
  const defaultCatalog = join(
    dirname(requireFromHere.resolve("@openacr/openacr/package.json")),
    "catalog",
    `${CATALOG_ID}.yaml`,
  );
  const catalog = load(readFileSync(opt("catalog", defaultCatalog), "utf8"));

  const appName = cfg?.app?.name;
  const productVersion = opt("version", cfg?.app?.version);
  if (!appName || !productVersion) {
    console.error("openacr needs app.name and app.version (config) or --version");
    process.exit(1);
  }

  const out = opt("out", cfg?.openacr?.out ?? "acr-draft.yaml");
  const acr = buildAcr({
    catalog,
    android,
    ios,
    date,
    productVersion,
    appName,
    appDescription: cfg?.openacr?.description,
    authorName: cfg?.openacr?.author?.name,
    authorEmail: cfg?.openacr?.author?.email,
  });
  writeFileSync(out, toYaml(acr));
  console.log(`draft OpenACR → ${out} (report_date ${date})`);
}

if (process.argv[1] && process.argv[1].endsWith("openacr.mjs")) main();
