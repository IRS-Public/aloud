// The findings contract: the input src/acr/build.mjs turns into a draft
// OpenACR. Any evidence source (aloud's native audits, the USWDS
// accessibility harness, a manual review) writes one finding per criterion
// and component, saying what its evidence shows:
//
//   {
//     product: { name, version?, description? },
//     author?: { name, email? }, vendor?: { name, email? },
//     provenance?: { commit?, workingTreeDirty?, runUrl?, date?, tools?: [{ name, version?, url? }] },
//     catalog?: "2.5-edition-wcag-2.2-508-en",
//     components: ["web"],
//     findings: [{
//       criterion: "2.1.1", component: "web", status: "met",
//       covers?, evidence?: [{ id, url?, environments? }],
//       issues?: [{ id, summary, kind?, url? }], notes?: [...],
//       failingShare?: "some" | "all",
//     }],
//     notes?: ["report-level notes, such as what was tested where"],
//     evaluationMethods?: "how the evidence was produced",
//   }
//
// findings.schema.json checks the shape; validateFindings below also checks
// every criterion and component against the chosen catalog. Anything
// unknown, duplicated, or contradictory throws with every problem listed,
// so a typo can never quietly drop a finding from the report.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hasNoComponents, indexCatalog, resolveCatalog } from "./catalog.mjs";
import { STATUS_KINDS, isFailingStatus } from "./levels.mjs";

export const FINDINGS_SCHEMA = JSON.parse(
  readFileSync(new URL("./findings.schema.json", import.meta.url), "utf8"),
);

// ajv comes with @openacr/openacr (its validators use it). Resolve it from
// there rather than declaring a second copy.
const requireFromOpenAcr = createRequire(createRequire(import.meta.url).resolve("@openacr/openacr/package.json"));
const Ajv = requireFromOpenAcr("ajv");

let compiled;
function schemaValidator() {
  compiled ??= new Ajv({ allErrors: true, strict: true, verbose: true }).compile(FINDINGS_SCHEMA);
  return compiled;
}

// True when text is a YYYY-MM-DD date that exists on the calendar, so
// 2026-02-31 or 2026-13-45 never reaches a report. Round-tripping through
// Date catches days past the end of a month, which Date would otherwise
// roll into the next one.
export function isCalendarDate(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

// Thrown for any contract violation. problems lists each one on its own,
// as "<path>: <what is wrong>".
export class FindingsError extends Error {
  constructor(problems) {
    const shown = problems.slice(0, 25).map((p) => `  - ${p}`);
    if (problems.length > shown.length) shown.push(`  - ...and ${problems.length - shown.length} more`);
    super(`invalid findings:\n${shown.join("\n")}`);
    this.name = "FindingsError";
    this.problems = problems;
  }
}

// "/findings/0/evidence/1" -> "findings[0].evidence[1]"
function readablePath(instancePath, extra) {
  const parts = instancePath.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (extra !== undefined) parts.push(extra);
  let out = "";
  for (const part of parts) out += /^\d+$/.test(part) ? `[${part}]` : out ? `.${part}` : part;
  return out || "findings input";
}

// One plain message per ajv error.
function describeSchemaError(error) {
  const { keyword, params, instancePath, parentSchema } = error;
  switch (keyword) {
    case "required":
      return `${readablePath(instancePath, params.missingProperty)}: is required`;
    case "additionalProperties":
      return `${readablePath(instancePath, params.additionalProperty)}: unknown field`;
    case "enum":
      return `${readablePath(instancePath)}: ${JSON.stringify(error.data)} is not one of ${params.allowedValues.join(", ")}`;
    case "pattern":
      return `${readablePath(instancePath)}: ${JSON.stringify(error.data)} is not ${parentSchema.description ?? "valid"}`;
    case "minLength":
      return `${readablePath(instancePath)}: must not be empty`;
    case "minItems":
      return `${readablePath(instancePath)}: must list at least ${params.limit} item(s)`;
    case "uniqueItems":
      return `${readablePath(instancePath)}: must not repeat items (items ${params.j} and ${params.i} are the same)`;
    default:
      return `${readablePath(instancePath)}: ${error.message}`;
  }
}

// Shape errors only, each reported once.
function schemaProblems(input) {
  const validate = schemaValidator();
  if (validate(input)) return [];
  return [...new Set(validate.errors.map(describeSchemaError))];
}

// Checks the schema cannot express: real dates, catalog membership,
// duplicates, and fields that contradict the status.
function catalogProblems(input, index, catalogId) {
  const problems = [];
  // The schema checks the date's shape; this checks the date exists.
  if (input.provenance?.date !== undefined && !isCalendarDate(input.provenance.date)) {
    problems.push(`provenance.date: ${JSON.stringify(input.provenance.date)} is not a real calendar date`);
  }
  input.components.forEach((component, i) => {
    if (!index.components.includes(component)) {
      problems.push(
        `components[${i}]: "${component}" is not a product component in catalog ${catalogId} ` +
          `(${index.components.join(", ")})`,
      );
    }
  });
  const seen = new Map();
  input.findings.forEach((finding, i) => {
    const at = `findings[${i}]`;
    const entry = index.criteria.get(finding.criterion);
    if (!entry) {
      problems.push(`${at}.criterion: "${finding.criterion}" is not a criterion in catalog ${catalogId}`);
      return;
    }
    const component = resolveComponent(finding, entry, input.components, index, at, problems);
    if (component) {
      const key = `${finding.criterion}\u0000${component}`;
      if (seen.has(key)) {
        problems.push(
          `${at}: duplicate of findings[${seen.get(key)}] (criterion ${finding.criterion}, component ${component}); ` +
            "give each criterion and component one finding",
        );
      } else {
        seen.set(key, i);
      }
    }
    if (finding.failingShare !== undefined && !isFailingStatus(finding.status)) {
      problems.push(`${at}.failingShare: applies only to failing and known-defect findings, not "${finding.status}"`);
    }
    if (finding.status === "known-defect" && !finding.issues) {
      problems.push(`${at}.issues: a known-defect finding must name the known issue`);
    }
    // A known issue contradicts a pass or a "does not apply": the catalog
    // defines "supports" as met without known defects.
    const kind = STATUS_KINDS[finding.status];
    if (finding.issues && (kind === "passing" || kind === "out-of-scope")) {
      problems.push(
        `${at}.issues: a "${finding.status}" finding may not list known issues; ` +
          'use "known-defect" (or "failing") when an issue affects the criterion',
      );
    }
    // A pass must say what it rests on. Without evidence, covers text, or
    // a note, a typo'd or hand-written status would become "supports" with
    // nothing behind it.
    if (kind === "passing" && !finding.evidence?.length && !finding.covers && !finding.notes?.length) {
      problems.push(
        `${at}: a "${finding.status}" finding must say what it rests on: ` +
          "give evidence, covers, or notes",
      );
    }
    for (const field of ["evidence", "issues"]) {
      const ids = (finding[field] ?? []).map((item) => item.id);
      const repeated = ids.filter((id, j) => ids.indexOf(id) !== j);
      if (repeated.length) problems.push(`${at}.${field}: repeated id(s) ${[...new Set(repeated)].join(", ")}`);
    }
  });
  return problems;
}

// Resolve which component a finding reports on, or record why it cannot.
// A criterion with product components needs one of the declared components
// the catalog allows for it. A criterion whose only catalog component is
// "none" (the Section 508 chapters) takes no component: the finding may
// omit it or say "none".
function resolveComponent(finding, entry, declared, index, at, problems) {
  if (hasNoComponents(entry)) {
    if (finding.component === undefined || finding.component === "none") return "none";
    problems.push(
      `${at}.component: criterion ${entry.id} has no product components in the catalog; ` +
        `omit component (or use "none") instead of "${finding.component}"`,
    );
    return null;
  }
  if (finding.component === undefined) {
    problems.push(`${at}.component: is required for criterion ${entry.id} (one of ${declared.join(", ")})`);
    return null;
  }
  if (!declared.includes(finding.component)) {
    const known = index.components.includes(finding.component) ? "is not a declared component" : "is not a catalog component";
    problems.push(`${at}.component: "${finding.component}" ${known} (declared: ${declared.join(", ")})`);
    return null;
  }
  if (!entry.components.includes(finding.component)) {
    problems.push(
      `${at}.component: the catalog does not apply criterion ${entry.id} to "${finding.component}" ` +
        `(only ${entry.components.join(", ")})`,
    );
    return null;
  }
  return finding.component;
}

// Validate a findings document against the contract and its catalog.
// Returns a normalized, frozen copy: catalog set to the id of the catalog
// actually used and each Section 508 chapter finding's component set to
// "none". Throws FindingsError listing every problem.
//
// options.catalog: a catalog object to check against instead of the
// bundled one findings.catalog names.
// options.catalogPath: a catalog YAML file to check against instead.
// Either must match the id the report will state (findings.catalog, else
// the file's base name, else the default); see resolveCatalog.
export function validateFindings(input, options = {}) {
  return checkFindings(input, options).findings;
}

// validateFindings, also returning the resolved catalog object, for the
// builder: { findings, catalog }.
export function checkFindings(input, { catalog, catalogPath } = {}) {
  const shape = schemaProblems(input);
  if (shape.length) throw new FindingsError(shape);
  let resolved;
  let index;
  try {
    resolved = resolveCatalog({ id: input.catalog, path: catalogPath, catalog });
    index = indexCatalog(resolved.catalog);
  } catch (error) {
    throw new FindingsError([`catalog: ${error.message}`]);
  }
  const problems = catalogProblems(input, index, resolved.id);
  if (problems.length) throw new FindingsError(problems);

  const normalized = structuredClone(input);
  normalized.catalog = resolved.id;
  for (const finding of normalized.findings) {
    if (hasNoComponents(index.criteria.get(finding.criterion))) finding.component = "none";
  }
  return { findings: deepFreeze(normalized), catalog: resolved.catalog };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

