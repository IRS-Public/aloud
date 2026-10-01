// Read one persisted *.tree.json in the current rule classification.
// `aloud report` and `aloud baseline` both call this, so the two commands
// judge the same evidence the same way.
//
// An Android ATF report carries its raw AccessibilityNodeInfo snapshot, so
// its findings are recomputed from that evidence with the current rules
// and must match what the report persisted (as the rules ran when it was
// written). Any other report written before a rule reclassification is
// migrated instead (see migrateTreeReport), with the criteria its old
// findings cannot speak to listed in `uncheckedCriteria`.

import { isDeepStrictEqual } from "node:util";
import { atfSummary, atfFindings, atfTreeNodes, validateAtfEvidence } from "../android/atf-evidence.mjs";
import { runChecks as androidTreeChecks } from "../android/ui-tree.mjs";
import { RECLASSIFIED } from "../rules/catalog.mjs";
import { beforeReclassification, migrateTreeReport, validateTreeReport } from "./validation.mjs";

export function readTreeReport(raw, file, { isIos }) {
  const r = validateTreeReport(raw, file);
  if (r.androidAtf === undefined && r.treeSource !== "accessibility-node-info") {
    const migrated = migrateTreeReport(r);
    return migrated.uncheckedCriteria.length
      ? { ...migrated.report, uncheckedCriteria: migrated.uncheckedCriteria }
      : migrated.report;
  }
  if (isIos || r.treeSource !== "accessibility-node-info" || r.androidAtf?.screen !== r.screen) {
    throw new Error(`invalid Android ATF source in ${file}`);
  }
  const native = validateAtfEvidence(r.androidAtf);
  const violations = androidTreeChecks(atfTreeNodes(native), { densityDpi: native.densityDpi, appPackage: native.target });
  const gate = gateOf(violations);
  // Tree reports written before findings carried `criteria` lack that key
  // on every finding. Compare those without it (the catalog derives it
  // from the rule id). A report that has `criteria` on some findings but
  // not others is compared as-is and fails.
  // Reports written before the touch-target reclassification list the
  // reclassified ids as errors and lack the successor rules; compare those
  // against the findings as the rules made them then. Either way the
  // recomputed findings and gate replace the persisted ones: the raw
  // native evidence is enough to run the current rules.
  const legacy = r.violations.every((v) => !Object.hasOwn(v, "criteria"));
  const predatesReclassification = r.violations.some((v) =>
    v.severity === "error" && Object.hasOwn(RECLASSIFIED, v.ruleId));
  const then = predatesReclassification ? beforeReclassification(violations) : violations;
  const expected = legacy ? then.map(({ criteria, ...v }) => v) : then;
  if (!isDeepStrictEqual(expected, r.violations) || !isDeepStrictEqual(gateOf(then), r.gate)) {
    throw new Error(`Android ATF tree findings differ from native evidence in ${file}`);
  }
  return {
    ...r,
    violations,
    gate,
    atfSummary: atfSummary(r.androidAtf),
    atfFindings: atfFindings(native, violations),
    atfNodes: native.nodes,
  };
}

function gateOf(violations) {
  const errors = violations.filter((v) => v.severity === "error");
  return { errors: errors.length, ruleIds: [...new Set(errors.map((v) => v.ruleId))].sort() };
}
