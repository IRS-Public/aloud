// Build a draft OpenACR (https://github.com/GSA/openacr) from a findings
// document (src/acr/findings.mjs). Every criterion the catalog lists is
// emitted, for every declared component it applies to. A criterion with a
// finding gets the level the policy (src/acr/levels.mjs) gives its status;
// one without a finding is "not-evaluated" with a note that it needs human
// review. Nothing is omitted and nothing is supported without evidence.
//
//   import { buildAcr, toYaml } from "@irs-public/aloud/src/acr/index.mjs";
//   writeFileSync("acr-draft.yaml", toYaml(buildAcr(findings, { date: "2026-09-30" })));
//
// Library only: no file writes and no side effects on import.

import { createRequire } from "node:module";
import { dump } from "js-yaml";
import { checkCatalogId, hasNoComponents, indexCatalog, loadCatalog } from "./catalog.mjs";
import { checkFindings } from "./findings.mjs";
import { ADHERENCE_LEVELS, DEFAULT_POLICY, STATUSES, adherenceFor, isFailingStatus, resolvePolicy } from "./levels.mjs";

// The validators ship as CJS with no type declarations.
const require = createRequire(import.meta.url);
const { validateOpenACR } = require("@openacr/openacr/dist/validateOpenACR.js");
const { validateOpenACRCatalogValues } = require("@openacr/openacr/dist/validateOpenACRCatalogValues.js");

// OpenACR requires an author email. Without one, the draft names itself
// and a placeholder a Section 508 office must replace before publication.
export const DRAFT_AUTHOR = Object.freeze({ name: "Automated draft — aloud", email: "todo@example.com" });

// Long notes are cut at a word boundary and end with this marker, so a
// reader always knows there is more in the evidence.
export const TRUNCATION_MARKER = "(truncated; see evidence)";
export const DEFAULT_MAX_NOTE_LENGTH = 1500;
const MIN_NOTE_LENGTH = 200;

const DOCS_URL = "https://github.com/IRS-Public/aloud/blob/main/docs/openacr.md";

// End a fragment with a full stop unless it already ends a sentence.
const sentence = (text) => {
  const trimmed = text.trim();
  return /[.!?)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

// Cap a note at max characters. The cut lands on a word boundary and the
// marker says so; it is never a silent slice.
export function capNote(text, max = DEFAULT_MAX_NOTE_LENGTH) {
  if (text.length <= max) return text;
  const room = max - TRUNCATION_MARKER.length - 1;
  const cut = text.lastIndexOf(" ", room);
  const kept = text.slice(0, cut > 0 ? cut : room).replace(/[\s,;:]+$/, "");
  return `${kept} ${TRUNCATION_MARKER}`;
}

function evidenceNote(evidence) {
  const items = evidence.map((item) => {
    const where = item.environments ? ` in ${item.environments.join(", ")}` : "";
    const link = item.url ? ` (${item.url})` : "";
    return `${item.id}${where}${link}`;
  });
  return `Evidence: ${items.join("; ")}.`;
}

function issuesNote(issues) {
  const items = issues.map((issue) => {
    const kind = issue.kind ? ` (${issue.kind})` : "";
    const link = issue.url ? ` ${issue.url}` : "";
    return `${issue.id}${kind}: ${issue.summary.trim().replace(/\.$/, "")}${link}`;
  });
  return `Known issues: ${items.join("; ")}.`;
}

// The adherence notes for one finding, most important first so a cap
// trims the long evidence list rather than the verdict: what the status
// means, how much fails, what the checks cover, the issues, the finding's
// own notes, then the evidence.
function findingNotes(finding, policyNote, maxNoteLength) {
  const parts = [policyNote];
  if (isFailingStatus(finding.status)) {
    parts.push(finding.failingShare === "all"
      ? "The failure affects all of the functionality."
      : "The failure affects some of the functionality.");
  }
  if (finding.covers) parts.push(sentence(`The evidence covers ${finding.covers}`));
  if (finding.issues) parts.push(issuesNote(finding.issues));
  for (const note of finding.notes ?? []) parts.push(sentence(note));
  if (finding.evidence) parts.push(evidenceNote(finding.evidence));
  return capNote(parts.join(" "), maxNoteLength);
}

function notEvaluated(notes) {
  return { level: "not-evaluated", notes };
}

// The component rows for one catalog criterion.
function criterionComponents(entry, declared, byComponent, index, options) {
  const fromFinding = (name) => {
    const finding = byComponent?.get(name);
    if (!finding) return null;
    const { level, note } = adherenceFor(finding.status, {
      policy: options.policy,
      failingShare: finding.failingShare,
    });
    return { name, adherence: { level, notes: findingNotes(finding, note, options.maxNoteLength) } };
  };

  // Section 508 chapter criteria have no product component: one row, "none".
  if (hasNoComponents(entry)) {
    return [fromFinding("none") ?? {
      name: "none",
      adherence: notEvaluated("Not evaluated: no finding covers this criterion. Needs human review."),
    }];
  }

  const applicable = declared.filter((name) => entry.components.includes(name));
  if (applicable.length === 0) {
    // Never omit a criterion. The catalog applies it only to components
    // this report does not declare; say so and leave it for review.
    const name = entry.components[0];
    return [{
      name,
      adherence: notEvaluated(
        `Not evaluated: the catalog applies this criterion only to ${entry.components.join(", ")}, ` +
          "which this report does not declare. Needs human review.",
      ),
    }];
  }
  return applicable.map((name) => fromFinding(name) ?? {
    name,
    adherence: notEvaluated(
      `Not evaluated: no finding covers this criterion for the ${index.componentLabels.get(name)} component. ` +
        "Needs human review.",
    ),
  });
}

function disabledChapterNote(chapterId, productName) {
  return chapterId === "hardware"
    ? `${productName} is not a hardware product. Hardware criteria do not apply.`
    : `This chapter does not apply to ${productName} and is not covered by this report.`;
}

// Resolve which catalog chapters are disabled. By default only the
// hardware chapter is, matching src/report/openacr.mjs; a catalog without
// one disables nothing.
function resolveDisabledChapters(disabledChapters, index) {
  if (disabledChapters === undefined) return index.chapters.has("hardware") ? ["hardware"] : [];
  if (!Array.isArray(disabledChapters)) throw new Error("disabledChapters must be an array of chapter ids");
  for (const id of disabledChapters) {
    if (!index.chapters.has(id)) {
      throw new Error(`unknown chapter "${id}" in disabledChapters (catalog chapters: ${[...index.chapters.keys()].join(", ")})`);
    }
  }
  return disabledChapters;
}

// Level counts over every emitted component row, for the report notes.
function levelSummary(chapters) {
  const counts = new Map();
  for (const chapter of Object.values(chapters)) {
    for (const criterion of chapter.criteria ?? []) {
      for (const { adherence } of criterion.components) {
        counts.set(adherence.level, (counts.get(adherence.level) ?? 0) + 1);
      }
    }
  }
  return ADHERENCE_LEVELS.filter((level) => counts.has(level))
    .map((level) => `${counts.get(level)} ${level}`)
    .join(", ");
}

// How the caller's policy differs from the default: one entry per status
// whose level or note changed, such as "page-level -> not-evaluated" or
// "met: note replaced".
function policyChanges(policy) {
  const changes = [];
  for (const status of STATUSES) {
    const { level, note } = policy[status];
    const levelChanged = JSON.stringify(level) !== JSON.stringify(DEFAULT_POLICY[status].level);
    const noteChanged = note !== DEFAULT_POLICY[status].note;
    if (!levelChanged && !noteChanged) continue;
    const shown = typeof level === "string" ? level : `some: ${level.some}, all: ${level.all}`;
    if (levelChanged && noteChanged) changes.push(`${status} -> ${shown} (note replaced)`);
    else if (levelChanged) changes.push(`${status} -> ${shown}`);
    else changes.push(`${status}: note replaced`);
  }
  return changes;
}

function provenanceNote(provenance) {
  if (!provenance) return "";
  const parts = [];
  if (provenance.commit) parts.push(`commit ${provenance.commit}`);
  if (provenance.runUrl) parts.push(`run ${provenance.runUrl}`);
  if (provenance.date) parts.push(`dated ${provenance.date}`);
  return parts.length ? ` The evidence comes from ${parts.join(", ")}.` : "";
}

function toolsNote(tools) {
  if (!tools) return "";
  const names = tools.map((tool) => [tool.name, tool.version].filter(Boolean).join(" "));
  return ` Tools: ${names.join(", ")}.`;
}

const contact = (person) => ({
  name: person?.name ?? DRAFT_AUTHOR.name,
  email: person?.email ?? DRAFT_AUTHOR.email,
});

// Build the draft OpenACR object. findings is a findings document; it is
// validated here, so invalid input throws before anything is built.
//
// options:
//   date              report date, YYYY-MM-DD (else provenance.date; one is required)
//   policy            per-status overrides for the level policy (see resolvePolicy)
//   catalog           a catalog object, instead of the bundled one findings.catalog names
//   catalogPath       a catalog YAML file, instead of the bundled one findings.catalog names
//                     (either must match the id the report states: findings.catalog,
//                     else the file's base name, else the default)
//   disabledChapters  chapter ids emitted as disabled (default: ["hardware"])
//   maxNoteLength     cap on each adherence note (default 1500)
//   evaluationMethods replaces the default evaluation_methods_used text
export function buildAcr(findings, options = {}) {
  const { findings: input, catalog: resolvedCatalog } = checkFindings(findings, {
    catalog: options.catalog,
    catalogPath: options.catalogPath,
  });
  const index = indexCatalog(resolvedCatalog);
  const policy = resolvePolicy(options.policy);

  const date = options.date ?? input.provenance?.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("buildAcr needs a report date as YYYY-MM-DD (options.date or provenance.date)");
  }
  const maxNoteLength = options.maxNoteLength ?? DEFAULT_MAX_NOTE_LENGTH;
  if (!Number.isSafeInteger(maxNoteLength) || maxNoteLength < MIN_NOTE_LENGTH) {
    throw new Error(`maxNoteLength must be an integer of at least ${MIN_NOTE_LENGTH}`);
  }
  // Every level the policy can emit must be a term the catalog defines.
  for (const status of STATUSES) {
    const levels = typeof policy[status].level === "string" ? [policy[status].level] : Object.values(policy[status].level);
    for (const level of [...levels, "not-evaluated"]) {
      if (!index.terms.includes(level)) throw new Error(`catalog ${input.catalog} has no term "${level}"`);
    }
  }

  const disabled = resolveDisabledChapters(options.disabledChapters, index);
  const byCriterion = new Map();
  for (const finding of input.findings) {
    const chapter = index.criteria.get(finding.criterion).chapter;
    if (disabled.includes(chapter)) {
      throw new Error(`finding for ${finding.criterion} is in the ${chapter} chapter, which this report disables`);
    }
    if (!byCriterion.has(finding.criterion)) byCriterion.set(finding.criterion, new Map());
    byCriterion.get(finding.criterion).set(finding.component, finding);
  }

  const chapters = {};
  for (const chapter of resolvedCatalog.chapters) {
    if (disabled.includes(chapter.id)) {
      chapters[chapter.id] = { notes: disabledChapterNote(chapter.id, input.product.name), disabled: true };
      continue;
    }
    chapters[chapter.id] = {
      criteria: (chapter.criteria ?? []).map((criterion) => ({
        num: criterion.id,
        components: criterionComponents(
          index.criteria.get(criterion.id),
          input.components,
          byCriterion.get(criterion.id),
          index,
          { policy, maxNoteLength },
        ),
      })),
    };
  }

  const changes = policyChanges(policy);
  const placeholderContact = !input.author?.email || (input.vendor && !input.vendor.email);
  const notes =
    `DRAFT. Generated by aloud (${DOCS_URL}) from ${input.findings.length} finding(s) for the ` +
    `${input.components.join(", ")} component(s). It records only what the evidence shows.` +
    provenanceNote(input.provenance) +
    ` Component rows by level: ${levelSummary(chapters)}.` +
    (changes.length ? ` The caller changed the default level policy: ${changes.join("; ")}.` : "") +
    " Every criterion marked 'not-evaluated' needs a human review. A Section 508 office must " +
    `complete those rows${placeholderContact ? " and replace the placeholder contact email" : ""} before publication.`;
  // The policy sentence describes the default policy only when the caller
  // kept it; otherwise it names the changes, so the methods section never
  // claims a mapping the rows do not follow.
  const policySentence = changes.length
    ? "aloud's level policy (src/acr/levels.mjs) maps each finding's status to a conformance level, " +
      `with the caller's changes: ${changes.join("; ")}. Even so, only passing evidence can support ` +
      "a criterion, and no failure or unproven finding can read as supported or not applicable."
    : "aloud's level policy (src/acr/levels.mjs) maps each finding's status to a conformance level: " +
      "only passing evidence supports a criterion, failures partially support or do not support it, " +
      "and anything unproven stays not-evaluated.";
  const evaluationMethods = options.evaluationMethods ??
    "Automated tests and recorded reviews produced one finding per criterion and component. " +
      policySentence +
      toolsNote(input.provenance?.tools) +
      " Findings marked human-reviewed rest on a person's review; there is no other human evaluation yet.";

  const product = { name: input.product.name };
  if (input.product.version) product.version = input.product.version;
  if (input.product.description) product.description = input.product.description;

  const acr = {
    title: `${input.product.name} Accessibility Conformance Report (draft)`,
    product,
    author: contact(input.author),
    ...(input.vendor ? { vendor: contact(input.vendor) } : {}),
    report_date: date,
    notes,
    evaluation_methods_used: evaluationMethods,
    catalog: input.catalog,
    chapters,
  };

  // The builder checks its own output, so a bug here can never emit an
  // invalid or incomplete report.
  const { valid, problems } = validateAcr(acr, { catalog: resolvedCatalog });
  if (!valid) throw new Error(`generated OpenACR is invalid: ${problems.join("; ")}`);
  return acr;
}

// Check an OpenACR object against the OpenACR schema and catalog that ship
// in @openacr/openacr, and against the draft's own completeness rules:
// every enabled catalog chapter lists every criterion, in catalog order,
// and every component row has a level and non-empty notes. Returns
// { valid, problems } and never throws for a bad report: an unknown or
// invalid catalog is a problem too. options.catalog defaults to the
// catalog the report names; when given, it must be that catalog (same
// chapters and criteria, when the report names a bundled catalog).
export function validateAcr(acr, { catalog } = {}) {
  const problems = [];
  const schema = validateOpenACR(acr, "openacr-0.1.0.json");
  if (!schema.result) problems.push(`schema: ${schema.message}`);
  if (problems.length) return { valid: false, problems };

  let resolved;
  try {
    if (catalog) {
      checkCatalogId(catalog, acr.catalog);
      resolved = catalog;
    } else {
      resolved = loadCatalog({ id: acr.catalog });
    }
    indexCatalog(resolved);
  } catch (error) {
    return { valid: false, problems: [`catalog: ${error.message}`] };
  }
  const values = validateOpenACRCatalogValues(acr, resolved);
  if (!values.result) problems.push(`catalog values: ${values.message}`);

  for (const chapter of resolved.chapters) {
    const emitted = acr.chapters?.[chapter.id];
    if (!emitted) {
      problems.push(`chapter ${chapter.id} is missing`);
      continue;
    }
    if (emitted.disabled) {
      if (!emitted.notes?.trim()) problems.push(`disabled chapter ${chapter.id} needs notes saying why`);
      continue;
    }
    const expected = (chapter.criteria ?? []).map((c) => c.id);
    const actual = (emitted.criteria ?? []).map((c) => c.num);
    if (expected.join("\n") !== actual.join("\n")) {
      const missing = expected.filter((id) => !actual.includes(id));
      problems.push(
        `chapter ${chapter.id} must list every catalog criterion in order` +
          (missing.length ? ` (missing ${missing.join(", ")})` : ""),
      );
    }
    for (const criterion of emitted.criteria ?? []) {
      if (!criterion.components?.length) problems.push(`criterion ${criterion.num} has no component rows`);
      for (const component of criterion.components ?? []) {
        if (!component.adherence?.level) problems.push(`criterion ${criterion.num} (${component.name}) has no level`);
        if (!component.adherence?.notes?.trim()) problems.push(`criterion ${criterion.num} (${component.name}) has no notes`);
      }
    }
  }
  return { valid: problems.length === 0, problems };
}

export function toYaml(acr) {
  return dump(acr, { lineWidth: 100 });
}
