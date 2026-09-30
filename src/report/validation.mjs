import { validateScreenId } from "../screen-id.mjs";
import { RECLASSIFIED, RULES, splitReclassified } from "../rules/catalog.mjs";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isRuleId = (value) => typeof value === "string" && value.trim().length > 0;

// Validate persisted summaries without changing the walker's accepted values.
export function validateGate(gate, field) {
  if (!isRecord(gate)) throw new Error(`${field} must be an object`);
  if (!Number.isSafeInteger(gate.errors) || gate.errors < 0) {
    throw new Error(`${field}.errors must be a non-negative safe integer`);
  }
  if (!Array.isArray(gate.ruleIds) || !gate.ruleIds.every(isRuleId) ||
      new Set(gate.ruleIds).size !== gate.ruleIds.length) {
    throw new Error(`${field}.ruleIds must be an array of unique non-empty strings`);
  }
  if ((gate.errors === 0) !== (gate.ruleIds.length === 0) || gate.ruleIds.length > gate.errors) {
    throw new Error(`${field}.ruleIds must agree with the error count`);
  }
  return gate;
}

// Validate a baseline as written, then return it in the current rule
// classification. Baselines written before a reclassification (see
// RECLASSIFIED in src/rules/catalog.mjs) list ids that are now report-only
// warnings. Those ids leave the entry, taking at least one error each with
// them, so the ratchet keeps holding every other rule and a screen that now
// trips the successor rule fails as a new rule id. `migrated` lists the
// screens that changed, for a note to the user; the input is not modified.
export function readBaseline(baseline, field = "baseline") {
  if (!isRecord(baseline)) throw new Error(`${field} must be an object keyed by screen id`);
  const current = {};
  const migrated = [];
  for (const [screen, gate] of Object.entries(baseline)) {
    validateScreenId(screen, `${field} screen id`);
    validateGate(gate, `${field} screen "${screen}"`);
    const { errors, ruleIds, retired } = splitReclassified(gate);
    current[screen] = { ...gate, errors, ruleIds };
    if (retired.length) migrated.push({ screen, retired });
  }
  return { baseline: current, migrated };
}

// The migrated baseline alone, for callers that need no note.
export function validateBaseline(baseline, field = "baseline") {
  return readBaseline(baseline, field).baseline;
}

// One line naming the screens readBaseline migrated, or "" when none were.
export function migrationNote(migrated, field = "baseline", advice = "Run `aloud baseline` to rewrite the file.") {
  if (!migrated.length) return "";
  const ids = [...new Set(migrated.flatMap(({ retired }) => retired))];
  return `note: ${field} lists ${ids.join(", ")} as gating error(s) on ${migrated.length} screen(s) ` +
    `(${migrated.map(({ screen }) => screen).join(", ")}); ` +
    `${ids.map((id) => RECLASSIFIED[id].change).join("; ")}. ` +
    `Those entries now allow one fewer error per retired id. ${advice}`;
}

export function validateTreeReport(report, field = "tree report") {
  if (!isRecord(report)) throw new Error(`${field} must be an object`);
  validateScreenId(report.screen, `${field}.screen`);
  const context = `${report.screen}: ${field}`;
  const gate = validateGate(report.gate, `${report.screen}: no completed tree checks with invalid ${field}.gate`);
  if (!Array.isArray(report.violations)) throw new Error(`${context}.violations must be an array`);
  const errors = [];
  for (const [index, violation] of report.violations.entries()) {
    if (!isRecord(violation) || !isRuleId(violation.ruleId) ||
        !["error", "warn"].includes(violation.severity)) {
      throw new Error(`${context}.violations[${index}] needs a non-empty ruleId and severity error or warn`);
    }
    if (violation.severity === "error") errors.push(violation);
  }
  const ruleIds = new Set(errors.map((violation) => violation.ruleId));
  if (gate.errors !== errors.length || gate.ruleIds.length !== ruleIds.size ||
      !gate.ruleIds.every((rule) => ruleIds.has(rule))) {
    throw new Error(`${context}.gate does not match the error findings in violations`);
  }
  return report;
}

// A tree report written before a reclassification carries the retired ids
// as errors. Its findings cannot say whether the successor rule would fire
// (a 30dp target failed the old 48dp rule and meets 2.5.8; a 20dp one
// fails both), so the report is read in the current classification with
// the affected criteria marked unchecked: the findings become the warnings
// the catalog now says they are, the gate drops them, and callers refuse
// to gate or baseline the screen and leave those criteria unevaluated.
// Reports with no retired error findings come back unchanged. Call after
// validateTreeReport.
export function migrateTreeReport(report) {
  const stale = report.violations.filter((v) =>
    v.severity === "error" && Object.hasOwn(RECLASSIFIED, v.ruleId));
  if (stale.length === 0) return { report, uncheckedCriteria: [], retired: [] };
  const violations = report.violations.map((v) => {
    if (!stale.includes(v)) return v;
    const { wcag, criteria, ...rest } = v;
    const rule = RULES[v.ruleId];
    return {
      ...rest,
      ...(rule.criteria.length ? { wcag: rule.criteria[0] } : {}),
      ...(criteria !== undefined ? { criteria: [...rule.criteria] } : {}),
      severity: rule.severity,
    };
  });
  const retired = [...new Set(stale.map((v) => v.ruleId))];
  const errors = violations.filter((v) => v.severity === "error");
  const gate = { errors: errors.length, ruleIds: report.gate.ruleIds.filter((id) => !retired.includes(id)) };
  const uncheckedCriteria = [...new Set(retired.flatMap((id) => RECLASSIFIED[id].was.criteria))];
  return { report: { ...report, violations, gate }, uncheckedCriteria, retired };
}

// Findings as the rules produced them before the reclassifications: the
// successor rules did not exist, and the reclassified ids carried their
// old severity and criteria. Used to check an old Android ATF tree report
// against findings recomputed from its raw native evidence; the recomputed
// findings, in the current classification, then replace it. Details and
// element text are unchanged by the reclassification, so they must match.
export function beforeReclassification(violations) {
  const successors = new Set(Object.values(RECLASSIFIED).map((entry) => entry.successor));
  return violations
    .filter((v) => !successors.has(v.ruleId))
    .map((v) => {
      if (!Object.hasOwn(RECLASSIFIED, v.ruleId)) return v;
      const { was } = RECLASSIFIED[v.ruleId];
      return { ...v, wcag: was.criteria[0], criteria: [...was.criteria], severity: was.severity };
    });
}
