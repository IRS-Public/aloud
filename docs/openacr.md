# The draft OpenACR

[OpenACR](https://github.com/GSA/openacr) is the GSA's machine-readable
format for an Accessibility Conformance Report (ACR): the document a vendor
or agency publishes to state how a product conforms to Section 508 and
WCAG. A traditional ACR (often called a VPAT) is a Word or PDF file. An
OpenACR is YAML with a schema and a criteria catalog, so tools can validate
it, diff it, and render it.

aloud builds draft OpenACRs with one engine, `src/acr/`. Any evidence
source describes what it found in a **findings document**, one finding per
criterion and component; the engine checks it, applies a conservative
**level policy**, and writes a draft that lists every criterion in the
catalog. Two commands use it:

- `aloud acr --findings findings.json` builds a draft from any findings
  document: the [USWDS accessibility harness](harness-integration.md), a
  manual review, or your own tool. The [GitHub Action](ci.md#draft-an-openacr-with-the-github-action)
  runs the same command.
- `aloud openacr` builds a draft from aloud's own Android, iOS, and web
  audits. It turns them into findings first (`src/acr/from-aloud.mjs`); see
  [aloud's own audits](#aloud-openacr-alouds-own-audits).

Either way the result is a **draft**: a starting point for a Section 508
office, never a conformance claim. The [checklist](#how-to-finish-it-into-a-real-acr)
at the end says what a person must do before publishing it.

## Build a draft from findings

```bash
npx aloud acr --findings examples/findings.example.json --out acr-draft.yaml
```

That builds a draft from the [example findings](../examples/findings.example.json),
shown in full [below](#a-full-example). The flags:

```bash
npx aloud acr --findings findings.json [--out acr-draft.yaml] \
  [--policy policy.json] [--catalog catalog.yaml] [--date YYYY-MM-DD] \
  [--step-summary summary.md]
```

| Flag | Default | Meaning |
|---|---|---|
| `--findings` | required | The findings JSON |
| `--out` | `acr-draft.yaml` | Where to write the draft |
| `--policy` | the default policy | JSON object of per-status overrides ([overriding the policy](#overriding-the-policy)) |
| `--catalog` | the bundled catalog the findings name | OpenACR catalog YAML ([catalogs](#catalogs)) |
| `--date` | `provenance.date`, else today | Report date; must be a real calendar date |
| `--step-summary` | none | Append a Markdown table of rows per conformance level to this file, such as `$GITHUB_STEP_SUMMARY` |

`aloud acr` reads no aloud config. On a missing or malformed file, invalid
findings, an unsafe policy, or a `--step-summary` file that cannot be
written, it prints every problem, writes nothing, and exits non-zero. The
step summary says every row needs human review, supports rows included,
since a supports level can rest on automated checks alone.

As a library:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { buildAcr, toYaml } from "@irs-public/aloud";

const findings = JSON.parse(readFileSync("findings.json", "utf8"));
const acr = buildAcr(findings, { date: "2026-09-30" });
writeFileSync("acr-draft.yaml", toYaml(acr));
```

`buildAcr(findings, options)` validates the findings, builds the draft,
checks its own output, and returns the OpenACR object. Its options:

| Option | Default | Meaning |
|---|---|---|
| `date` | `provenance.date` | Report date as YYYY-MM-DD; one of the two is required |
| `policy` | `DEFAULT_POLICY` | Per-status overrides, as for `--policy` |
| `catalog` | none | A catalog object instead of the bundled catalog |
| `catalogPath` | none | A catalog YAML file instead of the bundled catalog |
| `disabledChapters` | `["hardware"]` | Chapter ids emitted as disabled, with a note |
| `maxNoteLength` | 1500 | Cap on each adherence note (at least 200) |
| `evaluationMethods` | built from the findings | Replaces the whole evaluation methods text |

`validateFindings(findings)` checks a document without building anything;
`validateAcr(acr)` checks any OpenACR object and returns
`{ valid, problems }`; `levelCounts(acr)` and `summaryMarkdown(acr)` give
the counts `--step-summary` writes.

## The findings contract

The contract is the JSON Schema `src/acr/findings.schema.json` (also
exported as `@irs-public/aloud/findings.schema.json`). A document
describes one product: what it is, where the evidence came from, which
catalog components it has, and one finding per criterion and component.

### Top-level fields

| Field | Required | Meaning |
|---|---|---|
| `schemaVersion` | no | The contract version. Only `1` exists. |
| `product` | yes | `{ name, version?, description? }`. Becomes the report's product block and title. |
| `author` | no | `{ name, email? }`: who is accountable for the report. Without an email the draft uses a placeholder and says it must be replaced. |
| `vendor` | no | `{ name, email? }`: who makes the product. Same placeholder rule. |
| `provenance` | no | Where the evidence came from; see below. Stated in the report notes. |
| `catalog` | no | A catalog id from `@openacr/openacr/catalog`. Default `2.5-edition-wcag-2.2-508-en`. |
| `components` | yes | The catalog components the product has, such as `["web"]` or `["software"]`. At least one; no repeats. |
| `findings` | yes | At least one finding; see below. |
| `notes` | no | Sentences about the evidence as a whole, such as which environments ran. Added to the report notes. |
| `evaluationMethods` | no | How the evidence was produced, in plain words. Opens the evaluation methods; the policy sentence follows it. |

`provenance` fields, all optional:

| Field | Meaning |
|---|---|
| `commit` | The commit of the code the evidence describes. |
| `workingTreeDirty` | `true` when that commit had uncommitted changes, `false` when it had none, `null` when the producer tried and could not tell. The notes say "plus uncommitted changes" or "working tree state unknown"; `null` never reads as clean. |
| `runUrl` | The CI run that produced the evidence (an http(s) URL). |
| `date` | When the evidence was produced (YYYY-MM-DD, a real date). The report date defaults to it. |
| `tools` | `[{ name, version?, url? }]`: the tools that produced the evidence. Listed in the notes and the evaluation methods. |

The catalog's components are `web`, `electronic-docs`, `software`, and
`authoring-tool`. A web component library or web site is `web`; a native
mobile app is `software`, as in aloud's own drafts.

### Finding fields

| Field | Required | Meaning |
|---|---|---|
| `criterion` | yes | The criterion id exactly as the catalog names it: `2.1.1`, `2.5.8`, `302.1`, `502.2.1`. |
| `component` | for WCAG criteria | One of the declared `components`. Section 508 chapter provisions (302.x, 5xx, 6xx) have no product component in the catalog: omit it or write `none`. |
| `status` | yes | What the evidence shows; see [the status vocabulary](#the-status-vocabulary). |
| `failingShare` | no | `"some"` (default) or `"all"`: how much of the functionality a `failing` or `known-defect` finding affects. |
| `covers` | no | What the evidence checks, in plain words, never more than it proves. The note reads "The evidence covers ...". |
| `evidence` | no | `[{ id, url?, environments? }]`: the checks, tests, or artifacts behind the finding. `environments` names where each ran, such as `["chromium", "webkit"]`. |
| `issues` | for `known-defect` | `[{ id, summary, kind?, url? }]`: known defects or limitations that affect the criterion. `kind` is free text, such as `product-bug` or `platform-gap`. |
| `notes` | no | Further sentences for the row's notes, such as a scope statement or which tests did not run. |

### What the contract rejects

`validateFindings` (and so `buildAcr`, `aloud acr`, and the action) checks
the shape with the schema, then checks the document against the catalog.
It rejects, listing every problem at once:

- unknown fields, statuses, criteria, or components, and blank strings;
- a component the catalog does not apply to the criterion, or one the
  document does not declare;
- two findings for the same criterion and component;
- `failingShare` on a status that is not a failure;
- a `known-defect` finding with no `issues`;
- `issues` on a passing or out-of-scope finding (`met`, `human-reviewed`,
  `not-triggered`, `page-level`), since the catalog defines "supports" as
  met without known defects; use `known-defect` or `failing` instead;
- repeated evidence or issue ids within a finding;
- an impossible date, such as `2026-02-31`.

A typo can never quietly drop a finding from the report.

### A full example

This is [`examples/findings.example.json`](../examples/findings.example.json).
It uses every field and every status, and a test builds a valid draft from
it, so it always matches the contract.

```json
{
  "schemaVersion": 1,
  "product": {
    "name": "Example Date Picker",
    "version": "3.13.0",
    "description": "A date input with a calendar dialog, from an example design system."
  },
  "author": { "name": "Example Accessibility Team", "email": "a11y@example.gov" },
  "vendor": { "name": "Example Agency", "email": "508@example.gov" },
  "provenance": {
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "workingTreeDirty": false,
    "runUrl": "https://github.com/example/design-system/actions/runs/123456789",
    "date": "2026-09-30",
    "tools": [
      { "name": "example accessibility harness", "version": "1.4.0" },
      { "name": "Playwright", "version": "1.63.0", "url": "https://playwright.dev" }
    ]
  },
  "catalog": "2.5-edition-wcag-2.2-508-en",
  "components": ["web"],
  "findings": [
    {
      "criterion": "1.1.1",
      "component": "web",
      "status": "met",
      "covers": "accessible names on the icon-only calendar toggle and the month and year buttons",
      "evidence": [
        { "id": "DP-K02", "environments": ["chromium", "firefox", "webkit"] },
        { "id": "DP-K04", "environments": ["chromium", "firefox", "webkit"] }
      ]
    },
    {
      "criterion": "3.3.2",
      "component": "web",
      "status": "human-reviewed",
      "covers": "the label and format hint text a person approved",
      "evidence": [{ "id": "DP-C01", "environments": ["unit"] }]
    },
    {
      "criterion": "2.1.1",
      "component": "web",
      "status": "failing",
      "failingShare": "some",
      "evidence": [
        { "id": "DP-K01", "environments": ["chromium", "firefox"] },
        { "id": "DP-K03" }
      ],
      "notes": ["Failing checks: DP-K03"]
    },
    {
      "criterion": "4.1.2",
      "component": "web",
      "status": "known-defect",
      "failingShare": "all",
      "issues": [
        {
          "id": "DP-EXPANDED-STATE",
          "kind": "core-bug",
          "summary": "The calendar toggle does not say whether the calendar is open.",
          "url": "https://github.com/example/design-system/issues/42"
        }
      ],
      "evidence": [{ "id": "DP-S03" }]
    },
    {
      "criterion": "1.4.10",
      "component": "web",
      "status": "partly-tested",
      "covers": "the field and calendar at 320 CSS pixels wide",
      "notes": ["No check covers the calendar at 400% zoom in a short window yet."],
      "evidence": [{ "id": "DP-R01", "environments": ["chromium-zoom"] }]
    },
    {
      "criterion": "1.4.11",
      "component": "web",
      "status": "platform-limitation",
      "issues": [
        {
          "id": "WEBKIT-FORCED-COLORS",
          "kind": "platform-gap",
          "summary": "Safari has no high-contrast mode, so high-contrast checks run only in Chrome and Firefox."
        }
      ],
      "evidence": [{ "id": "DP-FC01", "environments": ["chromium", "firefox"] }]
    },
    {
      "criterion": "1.3.1",
      "component": "web",
      "status": "incomplete",
      "notes": ["Some tests did not run in: macos-voiceover"],
      "evidence": [{ "id": "DP-S01", "environments": ["chromium", "firefox", "webkit", "windows-nvda"] }]
    },
    { "criterion": "2.4.11", "component": "web", "status": "untested" },
    {
      "criterion": "2.2.1",
      "component": "web",
      "status": "unreviewed",
      "notes": ["Nobody has checked yet whether the calendar has a time limit."]
    },
    {
      "criterion": "1.2.2",
      "component": "web",
      "status": "not-triggered",
      "notes": ["The date picker has no video."]
    },
    {
      "criterion": "2.4.2",
      "component": "web",
      "status": "page-level",
      "notes": ["A component has no page title of its own."]
    },
    {
      "criterion": "502.3.1",
      "status": "untested",
      "notes": ["Section 508 chapter provisions take no component."]
    }
  ],
  "notes": [
    "Tested in Chrome, Firefox, Safari, Chrome with NVDA on Windows, and Safari with VoiceOver on a Mac"
  ],
  "evaluationMethods": "An automated accessibility harness ran browser, screen reader, and high contrast tests against the component's example pages; each finding is one requirement row of its report."
}
```

The 4.1.2 row of the draft built from it reads:

```yaml
- num: 4.1.2
  components:
    - name: web
      adherence:
        level: does-not-support
        notes: >-
          A known defect keeps this criterion from being met. The failure affects all of the
          functionality. Known issues: DP-EXPANDED-STATE (core-bug): The calendar toggle does
          not say whether the calendar is open
          https://github.com/example/design-system/issues/42. Evidence: DP-S03.
```

Its report notes count 2 `supports`, 1 `partially-supports`, 1
`does-not-support`, 2 `not-applicable`, and 121 `not-evaluated` rows: the
twelve findings, plus every criterion no finding covers.

## The status vocabulary

A finding's status says what the evidence shows, not what the report
should claim; the [policy](#the-default-policy) decides that. Every status
belongs to one of four kinds, and the kind limits which levels the status
may ever reach:

| Kind | Statuses | What it proves |
|---|---|---|
| passing | `met`, `human-reviewed` | The criterion is met. |
| failing | `failing`, `known-defect` | A defect keeps the criterion from being met. `failingShare` applies. |
| unproven | `partly-tested`, `platform-limitation`, `incomplete`, `untested`, `unreviewed` | The criterion applies, but the evidence does not settle it yet. |
| out-of-scope | `not-triggered`, `page-level` | The criterion is outside this component. |

What each status means:

- `met`: every automated test for the criterion passed, and the tests
  cover the whole criterion.
- `human-reviewed`: a person reviewed the criterion and judged it met;
  automated tests only keep the reviewed content as approved.
- `failing`: an automated test for the criterion failed.
- `known-defect`: a known, recorded defect keeps the criterion from being
  met (its test may be switched off until the fix lands).
- `partly-tested`: the tests passed but cover only part of the criterion.
- `platform-limitation`: a browser or screen reader limitation kept the
  criterion from being verified in some environment; everything that ran
  passed.
- `incomplete`: some of the criterion's tests did not run.
- `untested`: the criterion applies and nothing establishes it yet.
  aloud's own warning-only and report-only rows use it too, with their
  related evidence in the notes.
- `unreviewed`: the criterion applies only if the component has some
  feature (video, a time limit), and nobody has checked whether it does.
- `not-triggered`: someone checked and the component has no feature the
  criterion is about.
- `page-level`: the criterion is about a whole page or site (page title,
  language, consistent navigation), not a single component.

## The default policy

`DEFAULT_POLICY` in `src/acr/levels.mjs` maps each status to an OpenACR
adherence level and a note that opens the row's notes:

| Status | Kind | Default level | Why |
|---|---|---|---|
| `met` | passing | `supports` | Every test passed and they cover the criterion. |
| `human-reviewed` | passing | `supports` | A person judged it met; see below. |
| `failing` | failing | `partially-supports`; `does-not-support` with `failingShare: "all"` | OpenACR's own definitions: some functionality fails, or most of it does. |
| `known-defect` | failing | `partially-supports`; `does-not-support` with `failingShare: "all"` | A known defect is still a defect; the issue is named in the notes. |
| `partly-tested` | unproven | `not-evaluated` | The untested part could fail, so passing tests cannot support the whole criterion. |
| `platform-limitation` | unproven | `not-evaluated` | See below. |
| `incomplete` | unproven | `not-evaluated` | Tests that did not run prove nothing. |
| `untested` | unproven | `not-evaluated` | Nothing established it. |
| `unreviewed` | unproven | `not-evaluated` | Nobody knows yet whether it applies. |
| `not-triggered` | out-of-scope | `not-applicable` | Someone triaged it: the component has no such feature. The note says it was triaged, not tested. |
| `page-level` | out-of-scope | `not-applicable` | See below. |

A criterion with no finding at all is `not-evaluated` with a note that no
finding covers it and it needs human review.

Three mappings deserve their reasons:

- **`page-level` -> `not-applicable`.** A component's ACR describes the
  component. A page title, a declared language, or consistent navigation
  across pages belongs to the site that uses the component, and no
  component can meet or fail it alone. `not-applicable` is the closest
  OpenACR term for "not this product's to meet", and the note names who
  is responsible: "the site team is responsible for it on their own
  pages". It is not a claim about any site. **If your ACR describes a
  whole site or app rather than a component, page-level criteria are
  yours to meet**: override `page-level` to `not-evaluated` (or
  report those criteria with another status) so they get tested.
- **`human-reviewed` -> `supports`.** Some criteria rest on judgment: is
  this label clear, is this instruction enough? No test can repeat that
  judgment; a person makes it, and the automated tests keep the reviewed
  wording from changing unnoticed. An ACR level is itself a judgment, and
  a person's recorded review is the evidence an ACR expects for it. The
  note says plainly that the judgment is a person's, and the evaluation
  methods say the draft's only human evaluation is those reviews. If your
  508 office requires its own reviewer, override it to `not-evaluated`.
- **`platform-limitation` -> `not-evaluated`.** The checks that could run
  passed, but a browser or screen reader limitation (Safari has no
  high-contrast mode, say) kept the criterion from being verified
  somewhere. That is not a product defect, so `partially-supports` would
  overstate the problem; but it is not proven, so `supports` would
  overstate the evidence. `not-evaluated` sends it to a person, who can
  test the gap by hand or decide the limitation is outside the product.
  A stricter caller may map it to `partially-supports`.

`failingShare` defaults to `"some"`: a producer that sees only the pages,
screens, or environments it was given cannot show a failure affects all
of the product. Set `"all"` when the evidence shows the whole
functionality fails. aloud's own audits always use `"some"`; the
[harness adapter](harness-integration.md#how-failingshare-is-derived) uses
`"all"` only when no check for the criterion passed anywhere.

### Overriding the policy

Pass `policy` to `buildAcr`, or a JSON file to `--policy` (or the action's
`policy` input). Each key is a status; each value is a level, or
`{ level?, note? }`. A failing status's level may be one level for both
shares or `{ some?, all? }`:

```json
{
  "page-level": "not-evaluated",
  "human-reviewed": {
    "level": "not-evaluated",
    "note": "A person reviewed this; our 508 office has not confirmed it yet."
  },
  "failing": { "level": { "some": "does-not-support" } }
}
```

Overrides are checked against the status's kind. No override can make a
failure or unproven evidence read as a pass, or as "does not apply":

| Kind | Levels an override may choose |
|---|---|
| passing | any level |
| failing | `partially-supports`, `does-not-support`, `not-evaluated` |
| unproven | `partially-supports`, `does-not-support`, `not-evaluated` |
| out-of-scope | `not-applicable`, `not-evaluated` |

An unknown status, an unknown key, a level OpenACR does not define, or a
forbidden level throws and nothing is written. The report notes and the
evaluation methods list every override, whether it changes a level or
only a note, so a reader always knows the draft departs from the default.

## Never a silent pass

These hold for every draft, whatever the evidence source or policy:

- **Every criterion is listed.** Every catalog criterion appears for every
  declared component it applies to, in catalog order. A criterion the
  catalog applies only to undeclared components still gets a
  `not-evaluated` row saying so. Nothing is omitted.
- **Every row has a level and a note.** The note opens with what the
  status means, then how much fails, what the evidence covers, the known
  issues, the finding's notes, and the evidence ids. A note over the cap
  is cut at a word and ends with "(truncated; see evidence)"; the verdict
  comes first, so only the evidence list is ever cut.
- **Only passing evidence supports a criterion**, and no failure or
  unproven finding can read as supported or not applicable, whatever the
  policy says. `adherenceFor` re-checks every level, so even a hand-built
  policy object cannot skip the rules.
- **Unknown input throws.** An unknown status, criterion, component, field,
  catalog, chapter, or policy key stops the build with every problem
  listed.
- **The draft checks itself.** `buildAcr` runs `validateAcr` on its output:
  the `@openacr/openacr` schema and catalog validators, plus aloud's
  completeness rules. A bug in the builder throws rather than emitting an
  invalid or incomplete report.
- **It says it is a draft.** The title ends in "(draft)", the report notes
  open with "DRAFT", count the rows at each level, and say every
  `not-evaluated` row needs human review before publication.

## What the draft contains

- **Title and product** from `product`; the title ends in "(draft)".
- **Author and vendor** from the findings, or "Automated draft — aloud"
  with the placeholder email `todo@example.com`, which the notes say must
  be replaced.
- **Report date** from `--date`/`options.date`, else `provenance.date`.
- **Report notes**: the draft marker, the finding count and components,
  provenance (commit and working tree state, run, date, tools), the
  findings' `notes`, the row count at each level, any policy overrides,
  and what a Section 508 office must still do.
- **Evaluation methods**: the findings' `evaluationMethods` (or a generic
  sentence), the policy sentence, the tools, and a statement that
  `human-reviewed` findings are the only human evaluation so far.
- **Chapters**: every catalog chapter. The hardware chapter is disabled
  with a note ("... is not a hardware product"); `disabledChapters`
  changes which are disabled, and a finding in a disabled chapter throws.

### Catalogs

The default catalog is `2.5-edition-wcag-2.2-508-en`, the WCAG 2.2 /
Revised Section 508 edition. WCAG 2.2 is required because aloud's 24dp and
24pt target-size rules map to 2.5.8, which exists only there. The report
states the catalog id from `findings.catalog`, else the base name of the
file passed as `catalogPath`/`--catalog`, else the default. When that id
names a catalog shipped in `@openacr/openacr`, the supplied catalog must
have the same chapters and criteria (its labels and components may
differ), or the build throws; a report can never name one catalog and list
another's criteria.

### Package entry points

The package's `exports` map names these entries:

| Import | Module |
|---|---|
| `@irs-public/aloud` | The OpenACR engine (`src/index.mjs`, re-exporting `src/acr/index.mjs`) |
| `@irs-public/aloud/acr` | The same engine, by name |
| `@irs-public/aloud/findings.schema.json` | The findings JSON Schema |
| `@irs-public/aloud/rules` | The tree rule catalog (`src/rules/catalog.mjs`) |
| `@irs-public/aloud/web/nvda` | The experimental NVDA driver |
| `@irs-public/aloud/web/voiceover` | The experimental Safari + VoiceOver driver |
| `@irs-public/aloud/web/dependencies` | Pinned web peer loading |
| `@irs-public/aloud/src/...`, `/bin/...`, `/examples/*.json` | Any shipped file, as before 0.2.0 |

The engine exports `buildAcr`, `validateAcr`, `toYaml`, `capNote`,
`validateFindings`, `FindingsError`, `FINDINGS_SCHEMA`, `DEFAULT_POLICY`,
`resolvePolicy`, `adherenceFor`, `STATUSES`, `STATUS_KINDS`,
`ADHERENCE_LEVELS`, `FAILING_SHARES`, `isFailingStatus`, `levelCounts`,
`summaryMarkdown`, and the catalog helpers. Importing a web driver starts
nothing; the optional peers (Playwright, Guidepup, axe-core) load only
when a driver runs.

## aloud openacr: aloud's own audits

```bash
npx aloud openacr
```

This writes `acr-draft.yaml` (or `openacr.out` from the config, or
`--out`). Inputs default to the baseline files named in the config. For a
fresh run's results instead, pass `--report <dir>` and/or
`--report-ios <dir>` (they read the run's `summary.json`), and
`--report-web <dir>` for web evidence. `--date YYYY-MM-DD` pins the report
date (it must be a real calendar date); `--version` overrides
`app.version`. `--catalog <file>` replaces the bundled catalog YAML; the
draft still states `2.5-edition-wcag-2.2-508-en`, so the replacement must
list the same chapters and criteria in the same order. A trimmed or
reordered catalog is rejected.

`src/acr/from-aloud.mjs` turns the audits into findings; native evidence
is the `software` component and web evidence the `web` component.
`src/report/openacr.mjs` keeps its exported functions for existing
callers. What the findings say:

- **Only automated evidence gets a conformance level.** Criteria the
  audit's error rules map to (1.1.1, 1.3.1, 2.5.8, 4.1.2) are `met`
  (`supports`) only when applicable tree checks completed without mapped
  failures on every supplied screen, and every supplied platform has rules
  for the criterion. The Android and iOS app is one software component, so
  1.3.1, which only Android rules check, stays `not-evaluated` whenever an
  iOS audit is supplied. Notes state that automation covers part of the
  criterion only, and the 2.5.8 note names the targets automation skips.
- **Failures are partial.** A mapped failure is `failing` with
  `failingShare: "some"` (`partially-supports`), with the failing screens
  and rule ids in the notes: the audit sees only the screens it was given,
  so it never claims `does-not-support`.
- **Missing or stale checks are `incomplete`** (`not-evaluated`) unless
  there is already a known failure. So is evidence older than the
  target-size split, whether a tree report or a baseline entry that lists
  `native-touch-target-small` or `ios-touch-target-small` as an error: it
  gated on 48dp/44pt, not on 2.5.8's 24-unit minimum, so it leaves 2.5.8
  `not-evaluated` on that screen until the tree pass is re-run. The
  48dp/44pt platform guidelines are warnings with no criterion.
- **Accepted failures stay failures.** A failure the baseline accepts (see
  [accepted findings](how-it-works.md#accepted-findings)) keeps the
  criterion `failing` whatever its kind (`product-bug`, `platform-gap`, or
  `accepted-risk`), because the checks ran and found the violation. The
  reason is one of the finding's `issues`, so the notes explain it
  ("Known issues: ..."). Screens that accept the same rule for the same
  reason share one issue.
- **Everything else is `untested`** with a "needs human review" note. A
  few such rows carry related evidence in their notes (the transcript
  coverage on 302.1, the duplicate-label warnings on 2.4.6).
- **Web evidence is report-only.** Every web row is `untested`
  (`not-evaluated`); web findings and scripted interactions never change
  the native software levels. See [web scope](web.md).

The rule catalog, `src/rules/catalog.mjs`, holds each rule's severity and
criteria with a plain statement of what the automation checks. The Android
and iOS rule engines and this emitter all read it, so a finding and the
draft cannot disagree about what a rule counts toward; a test checks that
every emitted rule is catalogued and every criterion exists in the OpenACR
catalog.

Invalid evidence throws: empty audits, malformed screen data, inconsistent
error counts and rule ids, unknown rules, report-only warnings filed as
baseline errors, and rules filed under the wrong platform stop generation.
A missing optional baseline file is allowed; an unreadable or malformed
existing baseline is an error. Checked-screen counts include only
completed tree checks on platforms that implement the criterion's rules,
and transcript-only runs cannot establish support for tree criteria.

Notes in these drafts are capped at 3000 characters, not 1500. The failing
screens are listed last in a note, so only that list is ever cut, never
the coverage caveat. Accepted reasons come before the coverage caveat, so
when a draft has any, the cap grows by the length of the longest list of
them (`aloudMaxNoteLength` in `src/acr/from-aloud.mjs`); they are never
cut either.

Transcript coverage comes from the summary's utterance counts. Notes
distinguish TalkBack speech, computed iOS utterances, and real VoiceOver
capture with explicit partial coverage. Real speech requires capture
identity, toolchain, and coverage metadata; incomplete or contradictory
metadata is rejected. Partial speech does not expand conformance coverage
or establish focus order. Baselines contain no transcript counts, so their
transcript coverage is reported as unavailable; use fresh report
directories when you need that evidence in the draft.

**Provenance.** A report summary's provenance becomes the findings'
`provenance`: the aloud, Node.js, and tool versions, and the commit (with
its working tree state) and CI run when every input recorded provenance
and they all agree. The report notes state that once for the whole draft,
and each platform's note adds its machine (and its own commit or run when
there is no shared one). Inputs from different code (another app commit,
uncommitted changes on one side only, or another aloud) are refused,
because a draft describes one version of the product, and the error says
which of those differs; so is a summary written with `--allow-mixed`. Pass
`--allow-mixed` to combine them anyway, and the notes say the draft does
not describe a single version. Machines and CI runs may differ.
Baselines, and summaries written before provenance, record none; they are
accepted and the notes say so, and the draft then names no commit for the
whole product.

The author block defaults to "Automated draft — aloud" with a placeholder
email (set `openacr.author` in the config).

## How to finish it into a real ACR

The draft is the starting point for a human review, not a publishable
report. Work through this list, whichever command built it:

1. **Review every `not-evaluated` row.** Test the criterion with the
   methods your 508 office uses (the DHS Trusted Tester process names
   VoiceOver and TalkBack as the mobile test instruments; aloud's
   transcripts, evidence pages, and harness reports are useful input, not
   a verdict). Set the level (`supports`, `partially-supports`,
   `does-not-support`, or `not-applicable`) and write notes that state the
   evidence.
2. **Confirm every `supports` row.** Automated evidence proves what its
   notes say and nothing more. A person must confirm the rest of each
   criterion before its level can stand, and must accept or redo each
   `human-reviewed` judgment.
3. **Check the `not-applicable` rows.** `not-triggered` rows rest on a
   triage, not a test; re-check them if the product changed. `page-level`
   rows are right only for a component: for a site or app, test them.
4. **Review the failures.** Confirm each `partially-supports` and
   `does-not-support` row, decide whether "some" or "all" of the
   functionality is affected, and link each known issue to its tracking
   item.
5. **Complete the sections the automation cannot**: the Section 508
   chapters (302 functional performance criteria, 502 and 503 software,
   602 and 603 documentation and support), the AAA criteria if you report
   them, and whether any disabled chapter really does not apply.
6. **Replace the contacts.** Set the author (and vendor) to the
   accountable person or office and replace any `todo@example.com`, and
   set the product description and version.
7. **Validate.** The `@openacr/openacr` package validates the YAML against
   the schema and the catalog; `validateAcr` from aloud does the same and
   also checks that no criterion is missing. Keep the file valid as you
   edit.
8. **Remove the DRAFT markers** in the title and the report notes, and
   rewrite the evaluation methods, only when every row reflects a
   completed evaluation.

Re-running `aloud openacr` or `aloud acr` regenerates the draft from
current evidence. Keep human-review content in your published copy, not in
the generated file, or merge the two deliberately; a diff of two drafts
shows exactly which rows the new evidence changed.
