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
import { load } from "js-yaml";
import { cliArgs } from "../cli-args.mjs";
import { readWebReport, webSummary } from "../web/evidence.mjs";
import { toYaml as acrToYaml } from "../acr/build.mjs";
import {
  AUTOMATED_CRITERIA,
  CATALOG_ID,
  RULES,
  buildAloudAcr,
  findFailures,
  normalizeAudit,
} from "../acr/from-aloud.mjs";

// The draft is built by the shared OpenACR engine (src/acr): the audit
// inputs become a findings document (src/acr/from-aloud.mjs), and the
// builder (src/acr/build.mjs) turns it into a validated OpenACR. This
// module keeps the names adopters and tests already import.
export { AUTOMATED_CRITERIA, CATALOG_ID, RULES, findFailures, normalizeAudit };

// Build the draft OpenACR object from aloud's audit inputs:
//   { catalog?, android?, ios?, web?, date, productVersion, appName,
//     appDescription?, authorName?, authorEmail? }
// catalog is an OpenACR catalog object (default: the bundled CATALOG_ID
// catalog); it must match CATALOG_ID's chapters and criteria. Throws on
// missing or malformed evidence, and never returns an invalid report.
export function buildAcr(inputs) {
  return buildAloudAcr(inputs);
}

export function toYaml(acr) {
  return acrToYaml(acr);
}

// ── CLI ──
function main() {
  const { opt } = cliArgs("openacr.mjs", {
    android: { type: "string" },
    ios: { type: "string" },
    report: { type: "string" },
    "report-ios": { type: "string" },
    "report-web": { type: "string" },
    date: { type: "string" },
    catalog: { type: "string" },
    version: { type: "string" },
    out: { type: "string" },
  });

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
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }
    return null;
  };

  const android = loadAudit(opt("report", null), opt("android", null), cfg?.baseline?.android);
  const ios = loadAudit(opt("report-ios", null), opt("ios", null), cfg?.baseline?.ios);
  const web = opt("report-web", null) ? webSummary(readWebReport(opt("report-web", null))) : null;
  if (!android && !ios && !web) {
    console.error(
      "no audit input: pass --android/--ios baseline files or --report/--report-ios/--report-web dirs, " +
        "or set baseline paths in aloud.config.json",
    );
    process.exit(1);
  }

  const generated = android?.generated ?? ios?.generated ?? web?.generated;
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
    web,
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
