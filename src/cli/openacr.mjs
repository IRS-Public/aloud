// The two OpenACR commands. bin/aloud.mjs parses and checks the flags,
// then calls one of these; each reads its inputs, builds a validated draft
// with the shared engine (src/acr), writes the YAML, and returns what it
// wrote. Any problem throws with a plain message, which bin prints before
// exiting non-zero. Nothing here exits the process.
//
//   aloud openacr   aloud's own audit results -> draft OpenACR
//     --android <file>      Android baseline
//     --ios <file>          iOS baseline
//     --report <dir>        read <dir>/summary.json instead of --android
//     --report-ios <dir>    read <dir>/summary.json instead of --ios
//     --report-web <dir>    report-only web evidence (raw captures are verified)
//     --date <YYYY-MM-DD>   report date (defaults to the report's generated
//                           date, else today)
//     --version <v>         product version (config app.version otherwise)
//     --catalog <file>      replacement for the bundled 2.5-edition-wcag-2.2-508-en
//                           catalog YAML; it must have the same chapters and
//                           criteria (only labels and components may differ)
//     --out <file>          output path (config openacr.out, default acr-draft.yaml)
//     --allow-mixed         combine inputs whose provenance names different code
//                           (refused otherwise; see src/provenance.mjs)
//   Inputs default to the baselines named in the config.
//
//   aloud acr       any findings document -> draft OpenACR
//     --findings <file>     findings JSON (src/acr/findings.schema.json); required
//     --out <file>          output path (default acr-draft.yaml)
//     --policy <file>       JSON object of per-status level overrides
//     --catalog <file>      OpenACR catalog YAML instead of the bundled one the
//                           findings name (see resolveCatalog in src/acr/catalog.mjs)
//     --date <YYYY-MM-DD>   report date (defaults to provenance.date, else today)
//     --step-summary <file> append a Markdown count of the levels to <file>
//                           (the GitHub Action passes $GITHUB_STEP_SUMMARY)

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAcr, toYaml } from "../acr/build.mjs";
import { loadCatalog } from "../acr/catalog.mjs";
import { isCalendarDate } from "../acr/findings.mjs";
import { summaryMarkdown } from "../acr/summary.mjs";
import { buildAloudAcr, normalizeAudit } from "../acr/from-aloud.mjs";
import { readWebReport, webSummary } from "../web/evidence.mjs";

const today = () => new Date().toISOString().slice(0, 10);

// --date must be a date that exists, so an impossible one fails here, in
// the flag's own terms, before anything is read.
function checkDateFlag(date) {
  if (date !== undefined && !isCalendarDate(date)) {
    throw new Error(`--date must be a real calendar date as YYYY-MM-DD; got ${JSON.stringify(date)}`);
  }
}

// Read and parse a JSON file, naming the file and what it is for in any
// error. Errors keep their code, so a caller can tell a missing file apart.
function readJson(file, what) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const message = error.code === "ENOENT" ? `${what} not found: ${file}` : `cannot read ${what} ${file}: ${error.message}`;
    throw Object.assign(new Error(message), { code: error.code });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} ${file} is not valid JSON: ${error.message}`);
  }
}

// One audit per platform: an explicit flag or report dir must exist; a
// config-default baseline is used only when the file is present. A
// malformed file is an error either way.
function loadAudit(reportDir, flagPath, configPath) {
  if (reportDir) return normalizeAudit(readJson(join(reportDir, "summary.json"), "report summary"));
  if (flagPath) return normalizeAudit(readJson(flagPath, "baseline"));
  if (!configPath) return null;
  try {
    return normalizeAudit(readJson(configPath, "baseline"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// `aloud openacr`. values are the parsed flags; cfg is the resolved config
// (src/config.mjs loadConfig). Returns { out, date }.
export function openacr(values, cfg) {
  checkDateFlag(values.date);
  const android = loadAudit(values.report, values.android, cfg?.baseline?.android);
  const ios = loadAudit(values["report-ios"], values.ios, cfg?.baseline?.ios);
  const web = values["report-web"] ? webSummary(readWebReport(values["report-web"])) : null;
  if (!android && !ios && !web) {
    throw new Error(
      "no audit input: pass --android/--ios baseline files or --report/--report-ios/--report-web dirs, " +
        "or set baseline paths in aloud.config.json",
    );
  }

  const generated = android?.generated ?? ios?.generated ?? web?.generated;
  const date = values.date ?? (generated ? generated.slice(0, 10) : today());
  const appName = cfg?.app?.name;
  const productVersion = values.version ?? cfg?.app?.version;
  if (!appName || !productVersion) {
    throw new Error("openacr needs app.name and app.version (config) or --version");
  }

  const acr = buildAloudAcr({
    ...(values.catalog ? { catalog: loadCatalog({ path: values.catalog }) } : {}),
    android,
    ios,
    web,
    date,
    productVersion,
    appName,
    appDescription: cfg?.openacr?.description,
    authorName: cfg?.openacr?.author?.name,
    authorEmail: cfg?.openacr?.author?.email,
    allowMixed: values["allow-mixed"] === true,
  });
  const out = values.out ?? cfg?.openacr?.out ?? "acr-draft.yaml";
  writeFileSync(out, toYaml(acr));
  return { out, date: acr.report_date };
}

// `aloud acr`. values are the parsed flags. Returns { out, date }.
export function acr(values) {
  if (!values.findings) throw new Error("--findings <file.json> is required");
  checkDateFlag(values.date);
  const findings = readJson(values.findings, "findings file");
  const policy = values.policy ? readJson(values.policy, "policy file") : undefined;
  // The findings' own date wins over the wall clock; --date wins over both.
  const hasOwnDate = typeof findings?.provenance?.date === "string";
  const date = values.date ?? (hasOwnDate ? undefined : today());

  const draft = buildAcr(findings, {
    ...(date ? { date } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(values.catalog ? { catalogPath: values.catalog } : {}),
  });
  const out = values.out ?? "acr-draft.yaml";
  writeFileSync(out, toYaml(draft));
  // The summary is appended, never overwritten: a job summary file
  // collects every step's output.
  if (values["step-summary"]) appendFileSync(values["step-summary"], summaryMarkdown(draft, { file: out }));
  return { out, date: draft.report_date };
}
