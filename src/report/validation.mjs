import { validateScreenId } from "../screen-id.mjs";

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

export function validateBaseline(baseline, field = "baseline") {
  if (!isRecord(baseline)) throw new Error(`${field} must be an object keyed by screen id`);
  for (const [screen, gate] of Object.entries(baseline)) {
    validateScreenId(screen, `${field} screen id`);
    validateGate(gate, `${field} screen "${screen}"`);
  }
  return baseline;
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
