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
date (it must be a real calendar date); `--version` overrides `app.version`.
`--catalog <file>` replaces the bundled catalog YAML. The draft still
states `2.5-edition-wcag-2.2-508-en`, so the replacement must list the same
chapters and criteria in the same order; only labels and components may
differ. A trimmed or reordered catalog is rejected rather than producing a
report that names one catalog and lists another's criteria.

The emitter turns the audit inputs into a findings document
(`src/acr/from-aloud.mjs`) and builds the draft with the shared builder in
`src/acr/`, the same one other evidence sources use (see
[below](#build-a-draft-from-findings)). `src/report/openacr.mjs`
keeps its exported functions for existing callers. These properties make
the output a draft you can trust, rather than a report you cannot:

- **Only automated evidence gets a conformance level.** Criteria the
  audit's error rules map to (1.1.1, 1.3.1, 2.5.8, 4.1.2) get `supports` only
  when applicable tree checks completed without mapped failures on every
  supplied screen, and every supplied platform has rules for the
  criterion. The Android and iOS app is one software component, so 1.3.1,
  which only Android rules check, stays `not-evaluated` whenever an iOS
  audit is supplied. Known failures produce
  `partially-supports`, with the failing screens and rule ids in the notes.
  Missing tree checks produce `not-evaluated` unless there is already a
  known failure. So does evidence older than the target-size split, whether
  a tree report or a baseline entry that lists `native-touch-target-small`
  or `ios-touch-target-small` as an error: it gated on 48dp/44pt, not on
  2.5.8's 24-unit minimum, so it leaves 2.5.8 `not-evaluated` on that
  screen until the tree pass is re-run. Notes state that automation covers
  part of the criterion only, and the 2.5.8 note names the targets
  automation skips. In findings terms, a clean criterion is `met`, a known
  failure is `failing` with `failingShare: "some"` (the audit sees only the
  screens it was given, so it never claims `does-not-support`), and missing
  or stale checks are `incomplete`. A failure the baseline accepts (see
  [accepted findings](how-it-works.md#accepted-findings)) is still a
  failure: a `product-bug` or `accepted-risk` reason leaves the criterion
  `failing` (`partially-supports`), and the reason is listed as one of the
  finding's `issues`, so the notes explain it ("Known issues: ..."). Screens
  that accept the same rule for the same reason share one issue. Only when
  every failure on a criterion is accepted as a `platform-gap` is the
  finding `platform-limitation` (`not-evaluated`, for a person to judge),
  with a note saying so. An accepted failure never reads as `supports`.
  Every other criterion is `not-evaluated`
  with a "needs human review" note. A few `not-evaluated` rows carry related evidence in
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
  an Android-only check and stays `not-evaluated` in any report with an
  iOS audit (a known Android failure still shows as `partially-supports`).
  Transcript-only runs cannot establish support for tree criteria.

Notes over 3000 characters are cut, and the cut is marked "(truncated; see
evidence)". The failing screens are listed last in a note, so only that
list is ever cut, never the coverage caveat. Accepted reasons come before
the coverage caveat, so when a draft has any, the cap grows by the length
of the longest list of them (`aloudMaxNoteLength` in
`src/acr/from-aloud.mjs`); they are never cut either.

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

## Build a draft from findings

`src/acr/` is a reusable OpenACR builder for any evidence source, such as
the USWDS accessibility harness or a manual review. The source writes a
findings document: one finding per criterion and component, saying what
its evidence shows. `aloud openacr` builds its drafts this way too.

From the command line:

```bash
npx aloud acr --findings findings.json [--out acr-draft.yaml] \
  [--policy policy.json] [--catalog catalog.yaml] [--date YYYY-MM-DD]
```

`--findings` is required. `--out` defaults to `acr-draft.yaml`. `--policy`
is a JSON object of per-status overrides, the same as the `policy` option
below. `--catalog` is a catalog YAML file, the same as `catalogPath`.
`--date` defaults to `provenance.date`, else today; either must be a real
calendar date. `aloud acr` reads no
aloud config. On a missing or malformed file, invalid findings, or an
unsafe policy, it prints every problem, writes nothing, and exits
non-zero.

As a library:

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
not a failure; a `known-defect` with no issue; and known issues on a
passing or not-applicable finding (`met`, `human-reviewed`,
`not-triggered`, `page-level`), since "supports" means met without known
defects. It lists every problem at once. Two optional top-level fields
describe the evidence as a whole: `notes` (a list of sentences added to the
report notes) and `evaluationMethods` (how the evidence was produced; it
opens the evaluation methods, followed by the level policy sentence). Components are the catalog's: `web`, `electronic-docs`,
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
may map to `supports`. A failure or an unproven status may never map to
`supports` or `not-applicable`. The report notes and the evaluation
methods list every override, whether it changes a level or only a note.

To build against a catalog of your own, pass `catalog` (an object) or
`catalogPath` (a YAML file). The report states the catalog id from
`findings.catalog`, else the file's base name, else the default. When that
id names a catalog shipped in `@openacr/openacr`, the supplied catalog
must have the same chapters and criteria, or the build throws; the report
can never name one catalog and list another's criteria.

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
that no criterion is missing. `validateAcr` returns `{ valid, problems }`
and reports an unknown or mismatched catalog as a problem rather than
throwing.

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
