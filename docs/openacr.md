# The draft OpenACR

## What OpenACR is

[OpenACR](https://github.com/GSA/openacr) is the GSA's machine-readable
format for an Accessibility Conformance Report (ACR): the document a
vendor or agency publishes to state how a product conforms to Section 508
and WCAG. A traditional ACR (often called a VPAT) is a Word or PDF file.
An OpenACR is YAML with a schema and a criteria catalog, so tools can
validate it, diff it, and render it.

## What aloud emits

```bash
npx aloud openacr
```

This writes `acr-draft.yaml` (or `openacr.out` from the config, or
`--out`). The report is built against the WCAG 2.2 / Revised 508 edition
catalog (`2.5-edition-wcag-2.2-508-en`). WCAG 2.2 is required because the
touch-target rules map to criterion 2.5.8, which exists only there.

Inputs default to the baseline files named in the config. For a fresh
run's results instead, pass `--report <dir>` and/or `--report-ios <dir>`
(they read the run's `summary.json`). `--date YYYY-MM-DD` pins the report
date; `--version` overrides `app.version`.

The emitter is `src/report/openacr.mjs`. Three properties make the output
a draft you can trust, rather than a report you cannot:

- **Only automated evidence gets a conformance level.** Criteria the
  audit rules map to (1.1.1, 1.3.1, 2.5.8, 4.1.2) get `supports` only
  when applicable tree checks completed without mapped failures on every
  supplied screen for those platforms. Known failures produce
  `partially-supports`, with the failing screens and rule ids in the notes.
  Missing tree checks produce `not-evaluated` unless there is already a
  known failure. Notes state that automation covers part of the criterion
  only. Every other criterion is `not-evaluated` with a "needs human
  review" note. A few `not-evaluated` rows carry related evidence in
  their notes (for example, the transcript coverage on 302.1), still
  marked as needing human review.
- **Invalid evidence throws.** Empty audits, malformed screen data,
  inconsistent error counts and rule ids, unknown rules, and rules filed
  under the wrong platform stop generation. A missing optional baseline
  file is allowed; an unreadable or malformed existing baseline is an
  error.
- **Nothing is a silent pass.** Every adherence entry has a level and a
  note. Checked-screen counts include only completed tree checks on
  platforms that implement the criterion's rules. For example, 1.3.1 has
  an Android-only check and stays `not-evaluated` in an iOS-only report.
  Transcript-only runs cannot establish support for tree criteria.

A filtered run describes only the screens supplied to the emitter. Within
that input, a mix of completed and missing tree checks cannot produce a
clean verdict. Notes identify incomplete coverage even when another screen
has a known failure.

Transcript coverage comes from the summary's utterance counts. Notes
distinguish TalkBack speech from computed iOS utterances and identify empty
transcripts. Baselines contain no transcript counts, so their transcript
coverage is reported as unavailable. Use fresh report directories when you
need that evidence in the draft.

The author block defaults to "Automated draft" with a placeholder email
(set `openacr.author` in the config).

## How to finish it into a real ACR

The draft is the starting point for a human review, not a publishable
report. To finish it:

1. **Review every `not-evaluated` row.** Test the criterion with the
   methods your 508 office uses (the DHS Trusted Tester process for
   mobile uses VoiceOver and TalkBack as the test instruments; the aloud
   transcripts and evidence page are useful input, not a verdict). Set
   the level (`supports`, `partially-supports`, `does-not-support`, or
   `not-applicable`) and write notes that state the evidence.
2. **Confirm the automated rows.** The audit proves what its notes say it
   proves and nothing more. A human must confirm the rest of each mapped
   criterion before its level can stand without the "partial coverage"
   caveat.
3. **Replace the author contact** with the accountable person or office,
   and set the product description.
4. **Validate.** The `@openacr/openacr` package validates the YAML
   against the schema and the catalog. Keep the file valid as you edit.
5. **Remove the DRAFT markers** in the title and the report notes only
   when all rows reflect a completed evaluation.

Re-running `aloud openacr` regenerates the draft from current audit
results. Keep human-review content in your published copy, not in the
generated file, or merge the two deliberately.
