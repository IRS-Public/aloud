// The draft OpenACR API that predates the shared engine, kept for existing
// callers. aloud's audit inputs become a findings document
// (src/acr/from-aloud.mjs), and the shared builder (src/acr/build.mjs)
// turns it into a validated OpenACR (https://github.com/GSA/openacr). The
// draft fills in only what the automated audit can prove; everything else
// is "not-evaluated" with a note that a human review is required.
//
// The `aloud openacr` command lives in src/cli/openacr.mjs.

import { toYaml as acrToYaml } from "../acr/build.mjs";
import {
  AUTOMATED_CRITERIA,
  CATALOG_ID,
  RULES,
  buildAloudAcr,
  findFailures,
  normalizeAudit,
} from "../acr/from-aloud.mjs";

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
