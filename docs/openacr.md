# The draft OpenACR

Experimental web reports use `aloud openacr --report-web aloud-report/web`.
The emitter verifies raw captures and keeps every web component
`not-evaluated`. Web findings and scripted interactions are report-only;
they do not change native software conformance levels. See [web scope](web.md).

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
24dp/24pt target-size rules map to criterion 2.5.8, which exists only there.
The 48dp/44pt platform guidelines are warnings with no criterion.

Inputs default to the baseline files named in the config. For a fresh
run's results instead, pass `--report <dir>` and/or `--report-ios <dir>`
(they read the run's `summary.json`). `--date YYYY-MM-DD` pins the report
date; `--version` overrides `app.version`.

The emitter is `src/report/openacr.mjs`. Three properties make the output
a draft you can trust, rather than a report you cannot:

- **Only automated evidence gets a conformance level.** Criteria the
  audit's error rules map to (1.1.1, 1.3.1, 2.5.8, 4.1.2) get `supports` only
  when applicable tree checks completed without mapped failures on every
  supplied screen for those platforms. Known failures produce
  `partially-supports`, with the failing screens and rule ids in the notes.
  Missing tree checks produce `not-evaluated` unless there is already a
  known failure. So does evidence older than the target-size split, whether
  a tree report or a baseline entry that lists `native-touch-target-small`
  or `ios-touch-target-small` as an error: it gated on 48dp/44pt, not on
  2.5.8's 24-unit minimum, so it leaves 2.5.8 `not-evaluated` on that
  screen until the tree pass is re-run. Notes state that automation covers
  part of the criterion only, and the 2.5.8 note names the targets
  automation skips. Every other criterion is `not-evaluated` with a "needs human
  review" note. A few `not-evaluated` rows carry related evidence in
  their notes (for example, the transcript coverage on 302.1, or the
  duplicate-label warnings on 2.4.6), still marked as needing human review.
- **One mapping, shared with the rules.** Each rule's severity and criteria
  live in the rule catalog, `src/rules/catalog.mjs`, with a plain statement
  of what the automation checks per criterion. The Android and iOS rule
  engines and this emitter all read it, so a finding and the draft cannot
  disagree about what a rule counts toward. A test checks that every
  emitted rule is catalogued and every criterion exists in the OpenACR
  catalog.
- **Invalid evidence throws.** Empty audits, malformed screen data,
  inconsistent error counts and rule ids, unknown rules, report-only
  warnings filed as baseline errors, and rules filed under the wrong
  platform stop generation. A missing optional baseline
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
distinguish TalkBack speech, computed iOS utterances, and real VoiceOver
capture with explicit partial coverage. Empty transcripts are identified.
Real speech requires capture identity, toolchain, and coverage metadata;
incomplete or contradictory metadata is rejected. Partial speech does not
expand conformance coverage or establish focus order. Baselines contain no transcript counts, so their transcript
coverage is reported as unavailable. Use fresh report directories when you
need that evidence in the draft.

The author block defaults to "Automated draft" with a placeholder email
(set `openacr.author` in the config).

## Build a draft from findings (library)

`src/acr/` is a reusable OpenACR builder for any evidence source, such as
the USWDS accessibility harness or a manual review. The source writes a
findings document: one finding per criterion and component, saying what
its evidence shows. `aloud openacr` does not use it yet; the emitter above
is unchanged.

```js
import { writeFileSync } from "node:fs";
import { buildAcr, toYaml } from "@irs-public/aloud/src/acr/index.mjs";

const acr = buildAcr({
  product: { name: "USWDS Button", version: "3.13.0" },
  provenance: { commit: "0123abc", date: "2026-09-30" },
  components: ["web"],
  findings: [
    { criterion: "2.1.1", component: "web", status: "met",
      covers: "activation with Enter and Space",
      evidence: [{ id: "button-keyboard", environments: ["chromium", "webkit"] }] },
    { criterion: "4.1.2", component: "web", status: "known-defect",
      issues: [{ id: "uswds#6011", summary: "Disabled state is not announced" }] },
    { criterion: "502.2.1", status: "untested" },
  ],
});
writeFileSync("acr-draft.yaml", toYaml(acr));
```

The contract is `src/acr/findings.schema.json`. `validateFindings` checks
the shape, then checks every criterion and component against the catalog
(`catalog`, default `2.5-edition-wcag-2.2-508-en`). It rejects unknown
criteria, statuses, components, and fields; duplicate criterion and
component pairs; malformed evidence; `failingShare` on a status that is
not a failure; and a `known-defect` with no issue. It lists every problem
at once. Components are the catalog's: `web`, `electronic-docs`,
`software`, `authoring-tool`. Section 508 chapter provisions (302.1,
502.2.1, 602.3, ...) have no product component in the catalog, so their
findings omit `component` (or use `none`).

Each status maps to a level through the policy in `src/acr/levels.mjs`:

| Status | Level | Meaning |
|---|---|---|
| `met` | `supports` | Every automated test passed. |
| `human-reviewed` | `supports` | A person reviewed it; the note says so. |
| `failing`, `known-defect` | `partially-supports`, or `does-not-support` with `failingShare: "all"` | A test failed, or a known defect blocks it. |
| `partly-tested`, `platform-limitation`, `incomplete`, `untested`, `unreviewed` | `not-evaluated` | The evidence proves nothing yet. |
| `not-triggered` | `not-applicable` | Triaged: the component has no such feature. |
| `page-level` | `not-applicable` | The site team is responsible on their own pages. |

Pass `policy` to override a status, for example
`buildAcr(findings, { policy: { "page-level": "not-evaluated" } })`.
Overrides may choose only OpenACR levels. Only `met` and `human-reviewed`
may map to `supports`. A failure may never map to `supports` or
`not-applicable`. The report notes list any override.

The builder emits every catalog criterion for every declared component.
A criterion with no finding is `not-evaluated` with a "needs human review"
note. The hardware chapter is disabled with a note, as in `aloud
openacr`; `disabledChapters` changes that. Notes combine the policy's
meaning, `covers`, issues, the finding's notes, and evidence ids and
links. A note over `maxNoteLength` (default 1500) is cut at a word and
ends with "(truncated; see evidence)". The title ends in "(draft)". The
report date comes from `options.date` or `provenance.date`; one is
required. Without an author email, the draft uses a placeholder and says
it must be replaced. `buildAcr` checks its own output with `validateAcr`,
which runs the `@openacr/openacr` schema and catalog validators and checks
that no criterion is missing.

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
