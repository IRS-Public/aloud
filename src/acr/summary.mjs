// A short, human-readable count of the conformance levels in a draft
// OpenACR, for a CI job summary ($GITHUB_STEP_SUMMARY) or a terminal. It
// counts component rows (one per criterion per component) in the enabled
// chapters, so the total matches the rows a reviewer has to look at.
//
// Pure functions: no file access. A level the OpenACR vocabulary does not
// define throws rather than being dropped from the count.

import { ADHERENCE_LEVELS } from "./levels.mjs";

// Count the component rows at each adherence level, in ADHERENCE_LEVELS
// order. Disabled chapters (the hardware chapter, by default) are skipped
// and counted separately, since they carry no rows.
export function levelCounts(acr) {
  if (!acr || typeof acr !== "object" || !acr.chapters || typeof acr.chapters !== "object") {
    throw new Error("levelCounts needs an OpenACR object with chapters");
  }
  const levels = Object.fromEntries(ADHERENCE_LEVELS.map((level) => [level, 0]));
  let rows = 0;
  let disabledChapters = 0;
  for (const [id, chapter] of Object.entries(acr.chapters)) {
    if (chapter?.disabled) {
      disabledChapters += 1;
      continue;
    }
    for (const criterion of chapter?.criteria ?? []) {
      for (const component of criterion.components ?? []) {
        const level = component.adherence?.level;
        if (!Object.hasOwn(levels, level)) {
          throw new Error(`criterion ${criterion.num} in chapter ${id} has unknown level ${JSON.stringify(level)}`);
        }
        levels[level] += 1;
        rows += 1;
      }
    }
  }
  return { levels, rows, disabledChapters };
}

// A Markdown section: a heading naming the product, the level table, and
// one sentence saying the draft needs review. file is the path shown for
// the YAML, when given.
export function summaryMarkdown(acr, { file } = {}) {
  const { levels, rows, disabledChapters } = levelCounts(acr);
  const product = [acr.product?.name, acr.product?.version].filter(Boolean).join(" ");
  const lines = [
    `### Draft OpenACR${product ? `: ${product}` : ""}`,
    "",
  ];
  if (file) lines.push(`Written to \`${file}\` (report date ${acr.report_date ?? "unknown"}).`, "");
  lines.push("| Conformance level | Rows |", "|---|---:|");
  for (const level of ADHERENCE_LEVELS) lines.push(`| ${level} | ${levels[level]} |`);
  lines.push(`| **Total** | **${rows}** |`, "");
  const disabled = disabledChapters === 1 ? "1 chapter is" : `${disabledChapters} chapters are`;
  lines.push(
    `This is a draft for human review, not a conformance claim: every not-evaluated row still needs testing` +
      (disabledChapters ? `, and ${disabled} disabled.` : "."),
    "",
  );
  return lines.join("\n");
}
