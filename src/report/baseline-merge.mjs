// The merge behind `aloud baseline`, as a pure function so it can be tested
// without a report dir. src/report/baseline.mjs reads the files, calls
// mergeBaseline, prints its notes, and writes the result.
//
// The rules:
//   - A screen this run covers gets the run's gate. Accepted reasons for
//     rule ids that still fire carry over; reasons for ids that no longer
//     fire are dropped (the finding is gone) and reported.
//   - A screen this run does not cover is written back exactly as it was,
//     including an entry from before a rule reclassification: that entry is
//     the only record that a criterion was never checked there at the
//     current rule (see readBaseline in validation.mjs).
//   - With prune, screens this run does not cover are removed instead.
//   - With accept, one accepted reason is added or replaced after the merge.
//     Its rule id must be one the screen's entry gates in the current rule
//     classification.
// The merged baseline is validated before it is returned, so a bad merge
// throws instead of being written.

import { keepAccepted, unexplainedRuleIds, validateAcceptedEntry, withAccepted } from "./accepted.mjs";
import { readBaseline } from "./validation.mjs";

// existing   the baseline file as parsed ({} when there is none)
// gates      { screenId: { errors, ruleIds } } from this run's validated reports
// options    { prune?: boolean, accept?: { screen, entry } | null, field?: string }
//
// Returns {
//   baseline    the merged baseline, screens sorted by id
//   updated     screen ids this run wrote
//   kept        screen ids kept as written (not in this run)
//   pruned      screen ids removed by prune
//   dropped     [{ screen, ruleId }] accepted reasons whose rule no longer fires
//   migrated    readBaseline's migration list for the kept screens
//   unexplained [{ screen, ruleIds }] baselined ids with no accepted reason
// }
export function mergeBaseline(existing, gates, { prune = false, accept = null, field = "baseline" } = {}) {
  const { migrated } = readBaseline(existing, field);
  const updated = Object.keys(gates).sort();
  if (updated.length === 0) throw new Error("No gate reports found — nothing written.");

  const merged = { ...existing };
  const dropped = [];
  for (const screen of updated) {
    const { errors, ruleIds } = gates[screen];
    const { kept, dropped: stale } = keepAccepted(existing[screen]?.accepted, ruleIds);
    dropped.push(...stale.map(({ ruleId }) => ({ screen, ruleId })));
    merged[screen] = { errors, ruleIds, ...(kept.length ? { accepted: kept } : {}) };
  }

  const others = Object.keys(merged).filter((screen) => !updated.includes(screen)).sort();
  const pruned = prune ? others : [];
  for (const screen of pruned) delete merged[screen];
  const kept = prune ? [] : others;

  if (accept) applyAccept(merged, accept, field);

  const baseline = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  // Validate what is about to be written, and read it in the current
  // classification for the unexplained-id warning.
  const current = readBaseline(baseline, field).baseline;
  return {
    baseline,
    updated,
    kept,
    pruned,
    dropped,
    migrated: migrated.filter(({ screen }) => kept.includes(screen)),
    unexplained: unexplainedRuleIds(current),
  };
}

// Add or replace one accepted reason on the merged baseline, in place.
function applyAccept(merged, { screen, entry }, field) {
  const target = merged[screen];
  if (!target) {
    throw new Error(`--accept names screen "${screen}", which is not in ${field} or this run`);
  }
  // Checked against the current classification: a reclassified id is no
  // longer a gating error, so there is nothing to accept.
  const current = readBaseline({ [screen]: target }, field).baseline[screen];
  if (!current.ruleIds.includes(entry.ruleId)) {
    const gating = current.ruleIds.length ? current.ruleIds.join(", ") : "none";
    throw new Error(
      `--accept names rule id "${entry.ruleId}", which screen "${screen}" does not gate ` +
        `(its baselined rule ids: ${gating})`,
    );
  }
  validateAcceptedEntry(entry, current.ruleIds, `accepted reason (${screen}:${entry.ruleId})`);
  merged[screen] = { ...target, accepted: withAccepted(target.accepted, entry) };
}
