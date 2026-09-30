// The shared Section 508 evidence -> OpenACR engine. Any evidence source
// writes a findings document (findings.mjs); buildAcr turns it into a
// draft OpenACR using the status -> level policy (levels.mjs).
//
//   import { buildAcr, toYaml, validateFindings } from "@irs-public/aloud/src/acr/index.mjs";
//
// Library only: importing it reads the findings schema and nothing else.

export {
  DRAFT_AUTHOR,
  DEFAULT_MAX_NOTE_LENGTH,
  TRUNCATION_MARKER,
  buildAcr,
  capNote,
  toYaml,
  validateAcr,
} from "./build.mjs";
export { DEFAULT_CATALOG_ID, catalogPath, indexCatalog, loadCatalog } from "./catalog.mjs";
export { FINDINGS_SCHEMA, FindingsError, validateFindings } from "./findings.mjs";
export {
  ADHERENCE_LEVELS,
  DEFAULT_POLICY,
  FAILING_SHARES,
  STATUSES,
  STATUS_KINDS,
  adherenceFor,
  isFailingStatus,
  resolvePolicy,
} from "./levels.mjs";
