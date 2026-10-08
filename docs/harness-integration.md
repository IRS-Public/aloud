# USWDS accessibility harness integration

The [USWDS accessibility harness](https://github.com/uswds/accessibility-harness)
(a private repository at the time of writing, so the link and the harness
files this guide names need access to it) tests each USWDS component in browsers, with NVDA and VoiceOver, and in
Windows high contrast, then writes a requirements report. aloud turns that
report into one draft OpenACR per component, with the same engine, level
policy, and checks as its own audits (see [the draft OpenACR](openacr.md)).

```text
harness test runs -> requirements-report/report.json
                  -> adapter (below)  -> findings/<component>.json
                  -> aloud acr, at a pinned commit -> <component> draft OpenACR
```

The two projects also share screen-reader code. The harness checks out
aloud at a reviewed commit and imports `src/web/nvda.mjs`,
`src/web/dependencies.mjs`, `src/web/safari.mjs` and
`src/web/voiceover.mjs` by path: NVDA on Windows through the first two,
Safari and VoiceOver on macOS through the last two. aloud keeps those paths
and their exports stable (they are also exported as
`@irs-public/aloud/web/nvda`, `/web/dependencies` and `/web/voiceover`).
aloud's Safari + VoiceOver driver (see [web.md](web.md#voiceover-command-capture-safari))
is a port of the harness's own native driver, and carries its failure
context (`captureContext`), typed punctuation, pass-next-key and
host-refusal handling. The harness's screen reader job sets
`ALOUD_ALLOW_NATIVE_DESKTOP=1` for aloud's guard, behind its own, and keeps
on its side the sentinel focus each test starts from, a check that moves
VoiceOver's cursor off the web content area before each command, its focus
diagnostics, the command names in its failure messages and the NVDA path.

## What the adapter reads

`testing/support/requirements-report.mjs` in the harness writes
`report.json` with one entry per component. The adapter uses these fields
and ignores the rest:

| Field | Used for |
|---|---|
| `run.commit`, `run.workingTreeDirty` | `provenance.commit` and `provenance.workingTreeDirty` (omitted when the commit is `"unknown"`) |
| `run.finishedAt`, else `generatedAt` | `provenance.date`, and so the report date |
| `run.environments` | A report note: where the tests ran |
| `run.knownBugsEnabled` | Refuse the report when it is true (see [below](#run-it)) |
| `run.unhandledErrors` | Refuse the report when it is not 0 |
| `components[].component` | The product name (`USWDS <component>`) and output file name |
| `criteria[].criterion` | `finding.criterion` (WCAG ids such as `2.1.1`, exactly as the catalog names them) |
| `criteria[].profile` | Which rows go in the ACR; see [profiles](#profiles) |
| `criteria[].status` | `finding.status`; see [the status mapping](#status-mapping) |
| `criteria[].reason` | The first of `finding.notes`: a triage reason as written, the citation a `standard-interpretation` row carries, or a scope statement labeled "Scope of the checks, not a result" |
| `criteria[].coverage` | On a `shared` row, the reason's "Left to each site" clause becomes its own note |
| `criteria[].review` | A "Reviewed by" note on a `human-reviewed` row: the reviewer's GitHub user name, the date, and their judgment |
| `criteria[].checks[].id` | `finding.evidence[].id` |
| `criteria[].checks[].environments` | `finding.evidence[].environments`: where the check's tests ran, pass or fail |
| `criteria[].checks[].passedIn` | Where each failing check passed, in the "Failing checks" note, and [`failingShare`](#how-failingshare-is-derived) |
| `criteria[].checks[].status` | A "Failing checks" note for checks with status `failing`, and `failingShare` |
| `criteria[].checks[].missingIn`, `skippedIn` | A "Some tests did not run in" note |
| `criteria[].checks[].issues` | `finding.issues`, with each issue's kind and summary from the harness's known-issue registry |
| `criteria[].checks[].absentIn`, `absentFeatures` | A "Not applicable in" note: where a feature the check tests does not exist, with the registry's summary |

`name`, `summary`, `scope`, and `sourceUrl` are not copied: the harness
has already folded `scope` and `coverage` into the status
(`not-triggered`, `consumer-page`, `standard-interpretation`, and
`unreviewed` scopes; `partial` coverage makes `partly-tested` until a
person reviews the part it leaves out), and the catalog supplies each
criterion's name. A `shared` row's checks cover the component's part of a
criterion that also rests on content each site writes, such as its own
labels; the row is judged on its checks like a `full` one, and its reason
ends with what each site must still check.

For rows a check can fail, the harness's `reason` is the requirement's
scope, written as a claim ("Every control works from the keyboard"). Copied
as it is, an incomplete or failing row would state that claim as a fact,
so the adapter labels it: "Scope of the checks, not a result: ...". Triage
reasons (`not-triggered`, `consumer-responsibility`, and `unreviewed`
rows) say why no check applies, and are copied as written. A `shared`
row's closing "Left to each site: ..." clause is the site's part, not
part of the checks' scope, so it becomes the next note as written. A
`standard-interpretation` row's reason cites the standard's own published
interpretation, which satisfies the row without a test; it is copied as
written and is the finding's only note.

## Status mapping

The harness decides each criterion's status from its checks, worst first
(`failing`, then `known-issue`, `platform-gap`, `no-evidence`, `partial`,
and `not-run`), so a row shows its worst check only; checks further down
the order may also be unproven. The adapter maps each status to one
findings status. Any other status throws.

| Harness status | What the harness means | Findings status | Default level |
|---|---|---|---|
| `met` | Every check passed everywhere it is declared, and the checks cover the whole requirement (on a `shared` row, the component's part of it) | `met` | `supports` |
| `human-reviewed` | Every check passed, and a person recorded, in the component's `reviews.csv`, a judgment of what they cannot settle: whether the wording they keep is clear, or the part a `partial` row leaves out | `human-reviewed` | `supports` |
| `awaiting-review` | Every check passed, but they only keep wording as written, and nobody has recorded a review of it yet | `partly-tested` | `not-evaluated` |
| `partly-tested` | Every check passed, but the row's coverage is `partial`, and nobody has recorded a review of the part left out | `partly-tested` | `not-evaluated` |
| `not-met` | A check failed (a regression) | `failing` | `partially-supports`, or `does-not-support` when `failingShare` is `all` |
| `not-met-known-issue` | A check's test is switched off for a registered USWDS defect (`core-bug`) | `known-defect` | `partially-supports`, or `does-not-support` when `failingShare` is `all` |
| `platform-limitation` | A check's test is switched off for a browser or reader limitation (`platform-gap`), and no check failed or has a known defect; other checks may not have run | `platform-limitation` | `not-evaluated` |
| `incomplete` | Everything that ran passed, but some tests did not run | `incomplete` | `not-evaluated` |
| `untested` | The requirement applies and has no check yet | `untested` | `not-evaluated` |
| `unreviewed` | Nobody has checked yet whether the requirement applies | `unreviewed` | `not-evaluated` |
| `standard-interpretation` | The standard's own published interpretation says the criterion is always satisfied for this content; the row's reason cites it, and no check is counted | `standard-interpretation` | `supports` |
| `consumer-responsibility` | Page-level: the site team checks it on their own pages | `page-level` | `not-applicable` |
| `not-triggered` | Triaged: the component has no feature the requirement is about | `not-triggered` | `not-applicable` |

The default levels come from aloud's [level policy](openacr.md#the-default-policy),
which explains each one, and can be [overridden](openacr.md#overriding-the-policy)
with `aloud acr --policy` or the action's `policy` input.

A harness `human-reviewed` row rests on a review a named person
recorded, and the adapter copies it as a note:
`Reviewed by <reviewer> on <date>: <judgment>`. aloud's evaluation
methods then say which findings rest on a person's review. On a `partial`
row the review covers the part the checks leave out, which aloud's level
note, written for reviewed content kept as approved, does not say; the
scope note and the review note do. Older harness reports used
`human-reviewed` for approved wording alone, with no review, so the
adapter throws on a `human-reviewed` row that has none. A row whose
checks keep wording nobody has judged yet is `awaiting-review`, which
maps to `partly-tested` with a note that the wording awaits a person's
review.

A harness `platform-limitation` row may hide checks that never ran; its
"Some tests did not run in" note names them, and `not-evaluated` sends the
row to a person either way.

Some features do not exist in every environment: Safari has no
high-contrast mode, for example. The harness registers such a feature as
an `absent-feature` known issue and skips its tests there. That skip is
not evidence and not a gap, since the environment cannot owe the result,
so the check counts only where the feature exists and the row can be
`met`. The check lists the environments in `absentIn` and the issues in
`absentFeatures`, not in `issues`, so the adapter writes a note,
`Not applicable in <environments>: <summary>`, with the registry's
summary, and puts nothing in `finding.issues`.

The harness's own catalog records WCAG 2.0 and 2.1's 4.1.1 Parsing as
satisfied for HTML by the W3C's errata (WCAG 2.2 removed it), so each
component's 4.1.1 row has the scope `standard-interpretation` and no
checks; its markup checks are the harness's own `HTML-VALID` project row,
which stays in its report. The adapter maps the status to
[`standard-interpretation`](openacr.md#the-status-vocabulary) with the
row's reason as the citation (the harness's own adapter adds the errata's
source), and the draft reads `supports` with a note that the level rests
on the standard's interpretation, not on a test.

### Profiles

Rows with profile `section508`, `additional-wcag21`, or
`additional-wcag22` are WCAG criteria the OpenACR catalog lists, so they
become findings. Rows with profile `project` (USWDS's own requirements,
such as `APG-RADIO`) have no catalog criterion and stay in the harness
report. Any other profile throws, so a new profile cannot silently drop
rows.

## How failingShare is derived

A failing finding (`failing` or `known-defect`) needs a `failingShare`:
does the failure affect some of the functionality (`partially-supports`)
or all of it (`does-not-support`)? The harness does not say, so the
adapter derives it from the criterion's checks.

Each check has its own status (`passing`, `partial`, `not-run`,
`no-evidence`, `platform-gap`, `known-issue`, or `failing`) and a
`passedIn` list of the environments where at least one of its tests
passed. The adapter uses `"all"` only when **every check for the
criterion failed or is switched off for a known defect (`failing` or
`known-issue`), and none passed in any environment**; otherwise `"some"`:

| Checks | `failingShare` | Level |
|---|---|---|
| `DP-K01` passed everywhere, `DP-K03` failed in Firefox but passed in Chrome | `some` | `partially-supports` |
| `DP-K05` failed in every browser, no other check | `all` | `does-not-support` |
| `DP-S03` switched off everywhere for a known defect, no other check | `all` | `does-not-support` |
| `CB-S05` switched off everywhere for a known defect, `CB-N03` never ran (`no-evidence`) | `some` | `partially-supports` |
| `CB-V12` switched off in one browser for a known defect, passed in another | `some` | `partially-supports` |

A passing check or environment shows that part of the functionality
works, so the failure cannot be said to affect all of it. A check that
never ran shows nothing either way, so it cannot make a failure total.
OpenACR's `does-not-support` means most of the functionality fails, and
the adapter cannot see how much of a criterion one check covers: a
single failing check that guards one control's state still gives
`"all"`. Treat every `does-not-support` row as a claim to confirm; a
reviewer softens it when the failing checks cover a small part of the
criterion.

## The adapter

This is [`examples/harness-to-findings.example.mjs`](../examples/harness-to-findings.example.mjs),
the reference: a test runs it against a report fixture that uses every
status, and checks that this page shows it exactly. The harness keeps its
own copy, with the same status mapping and notes, at
`testing/support/acr-findings.mjs`. That copy takes the product and tool
names from the harness configuration and imports the harness's known-issue
registry, so it takes two arguments; it reads the product version from
`ACCESSIBILITY_PRODUCT_VERSION`, and its evaluation methods name only the
kinds of test the run has evidence from. aloud never changes the harness.

```js
#!/usr/bin/env node
// Turn the USWDS accessibility harness's requirements-report/report.json into
// one aloud findings document per component (docs/harness-integration.md).
//
//   node harness-to-findings.mjs requirements-report/report.json findings/ \
//     [testing/support/known-issues.mjs]
//
// The optional third argument is the harness's known-issue registry; with it,
// each issue carries the registry's kind and plain-language summary. Set
// USWDS_VERSION to state the product version. Writes <out-dir>/<component>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Harness criterion status -> findings status. Anything else throws.
export const STATUS_MAP = Object.freeze({
  met: "met",
  // A named person recorded, in the component's reviews.csv, a judgment of
  // what the checks cannot settle; the note names them and what they found.
  "human-reviewed": "human-reviewed",
  // The checks keep wording nobody has judged yet, so a person decides.
  "awaiting-review": "partly-tested",
  "partly-tested": "partly-tested",
  "not-met": "failing",
  "not-met-known-issue": "known-defect",
  "platform-limitation": "platform-limitation",
  incomplete: "incomplete",
  untested: "untested",
  unreviewed: "unreviewed",
  "consumer-responsibility": "page-level",
  "not-triggered": "not-triggered",
  // The standard's own interpretation satisfies the row; the harness's reason
  // cites it, and no check is counted.
  "standard-interpretation": "standard-interpretation",
});

// WCAG rows are in the OpenACR catalog. "project" rows (USWDS's own
// requirements, such as APG-RADIO) are not, so they stay in the harness report.
function inCatalog({ criterion, profile }) {
  if (["section508", "additional-wcag21", "additional-wcag22"].includes(profile)) return true;
  if (profile === "project") return false;
  throw new Error(`${criterion}: unknown harness profile "${profile}"`);
}

// A failure affects all of the functionality only when every check for the
// criterion failed or is switched off for a known defect, and none passed in
// any environment. A check that never ran shows nothing either way, so it
// keeps the share at "some".
const failingShare = (checks) =>
  checks.every((check) => ["failing", "known-issue"].includes(check.status) && check.passedIn.length === 0)
    ? "all"
    : "some";

// Where a failing check passed, so the reader can tell where it failed.
const passedWhere = ({ passedIn }) => (passedIn.length ? `passed only in ${passedIn.join(", ")}` : "passed nowhere");

// The row's reason is a scope statement written as a claim ("Every control
// works from the keyboard"), or for rows no check can fail, a triage reason.
// A scope statement is labeled so the ACR never states it as a result.
const TRIAGED = new Set(["not-triggered", "consumer-responsibility", "unreviewed"]);
const reasonNote = (row) => (TRIAGED.has(row.status) ? row.reason : `Scope of the checks, not a result: ${row.reason}`);

// A "shared" row's reason ends with what each site writes and checks itself,
// which is the site's part, not a scope the checks cover: its own note.
const SITE_CONTENT = "Left to each site: ";
const reasonNotes = (row) => {
  const at = row.coverage === "shared" ? row.reason.indexOf(SITE_CONTENT) : -1;
  if (at < 0) return [reasonNote(row)];
  return [reasonNote({ ...row, reason: row.reason.slice(0, at).trim() }), row.reason.slice(at).trim()];
};

function toFinding(row, issuesByName) {
  const status = STATUS_MAP[row.status];
  if (!status) throw new Error(`${row.criterion}: unknown harness status "${row.status}"`);
  if (status === "standard-interpretation") {
    if (!row.reason) throw new Error(`${row.criterion}: a standard-interpretation row needs a reason that cites the interpretation`);
    return { criterion: row.criterion, component: "web", status, notes: [row.reason] };
  }
  const finding = { criterion: row.criterion, component: "web", status };
  if (status === "failing" || status === "known-defect") finding.failingShare = failingShare(row.checks);
  const names = [...new Set(row.checks.flatMap((check) => check.issues))];
  if (names.length) {
    finding.issues = names.map((id) => {
      const known = issuesByName.get(id);
      const summary = known?.summary ?? `Known issue ${id}; see the harness requirements report.`;
      return known?.kind ? { id, kind: known.kind, summary } : { id, summary };
    });
  }
  // Older harness reports used "human-reviewed" for approved wording alone.
  if (row.status === "human-reviewed" && !row.review) {
    throw new Error(`${row.criterion}: a human-reviewed row needs the review it rests on`);
  }
  const notes = row.reason ? reasonNotes(row) : [];
  if (row.status === "awaiting-review") {
    notes.push("The tests keep the wording as written; whether it is clear awaits a person's review");
  }
  if (row.status === "human-reviewed") {
    notes.push(`Reviewed by ${row.review.reviewer} on ${row.review.date}: ${row.review.judgment}`);
  }
  const failing = row.checks.filter((check) => check.status === "failing");
  if (failing.length) {
    notes.push(`Failing checks: ${failing.map((check) => `${check.id} (${passedWhere(check)})`).join(", ")}`);
  }
  const missing = [...new Set(row.checks.flatMap((check) => [...check.missingIn, ...check.skippedIn]))];
  if (missing.length) notes.push(`Some tests did not run in: ${missing.join(", ")}`);
  // A feature an environment does not have, such as high contrast in Safari,
  // leaves its tests nothing to verify there; those results are not evidence.
  for (const id of new Set(row.checks.flatMap((check) => check.absentFeatures ?? []))) {
    const where = new Set(row.checks.filter((check) => check.absentFeatures?.includes(id)).flatMap((check) => check.absentIn));
    notes.push(`Not applicable in ${[...where].join(", ")}: ${issuesByName.get(id)?.summary ?? id}`);
  }
  if (notes.length) finding.notes = notes;
  // Each check is evidence; environments lists where its tests ran.
  if (row.checks.length) {
    finding.evidence = row.checks.map((check) =>
      check.environments.length ? { id: check.id, environments: check.environments } : { id: check.id });
  }
  return finding;
}

// report: the parsed report.json. Returns [{ component, findings }].
export function harnessToFindings(report, { knownIssues = [], runUrl, version } = {}) {
  if (!Array.isArray(report?.components) || !report.run) throw new Error("not a harness report.json");
  if (report.run.unhandledErrors) throw new Error("the harness run had unhandled errors; fix the run first");
  // With known bugs switched on (RUN_KNOWN_BUGS=1), known defects and platform
  // limitations show up as plain failures with no issue named.
  if (report.run.knownBugsEnabled) throw new Error("the harness run switched known bugs on; draft from a regular run");
  const issuesByName = new Map(knownIssues.map((issue) => [issue.name, issue]));
  const { commit, workingTreeDirty, finishedAt, environments } = report.run;
  const provenance = {
    ...(commit && commit !== "unknown" ? { commit, workingTreeDirty } : {}),
    ...(runUrl ? { runUrl } : {}),
    date: (finishedAt ?? report.generatedAt).slice(0, 10),
    tools: [{ name: "USWDS accessibility harness" }],
  };
  const notes = [`Tested in: ${environments.length ? environments.join(", ") : "no environment"}`];
  return report.components.map(({ component, criteria }) => ({
    component,
    findings: {
      schemaVersion: 1,
      product: { name: `USWDS ${component}`, ...(version ? { version } : {}) },
      provenance,
      components: ["web"],
      findings: criteria.filter(inCatalog).map((row) => toFinding(row, issuesByName)),
      notes,
      evaluationMethods:
        "The USWDS accessibility harness ran automated browser, screen reader, and high contrast " +
        "tests on the component's example pages; each finding is one row of its requirements report.",
    },
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [reportFile, outDir, registry] = process.argv.slice(2);
  if (!reportFile || !outDir) throw new Error("usage: harness-to-findings.mjs <report.json> <out-dir> [known-issues.mjs]");
  const knownIssues = registry ? (await import(pathToFileURL(resolve(registry)).href)).knownIssues : [];
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = process.env;
  const runUrl = server && repo && run ? `${server}/${repo}/actions/runs/${run}` : undefined;
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  mkdirSync(outDir, { recursive: true });
  const version = process.env.USWDS_VERSION || undefined;
  for (const { component, findings } of harnessToFindings(report, { knownIssues, runUrl, version })) {
    writeFileSync(join(outDir, `${component}.json`), `${JSON.stringify(findings, null, 2)}\n`);
  }
}
```

### Run it

In the harness, after its test runs:

```bash
node testing/support/requirements-report.mjs evidence/*/*/evidence.json --out requirements-report
node testing/support/acr-findings.mjs requirements-report/report.json findings
node <aloud checkout>/bin/aloud.mjs acr --findings findings/button.json --out acr/button.yaml
```

The harness's report job passes the `evidence.json` of every job in one
workflow run; with no evidence files, the report reads a local run's
`test-results/all/evidence.json`. The example takes the same two
arguments and the harness's known-issue registry
(`testing/support/known-issues.mjs`) as an optional third. Without the
registry, each issue's summary points to the requirements report instead,
and a "Not applicable in" note gives the issue's id instead of its summary.

The report must come from one clean, full run: the harness already refuses
to merge evidence from different commits, and the adapter refuses a run
with unhandled errors. It also refuses a run with known bugs switched on
(`RUN_KNOWN_BUGS=1`, the workflow's `run_known_bugs` input): there, the
tests for known defects and platform limitations run and fail as plain
failures with no issue named, so a platform gap would read as a product
defect.

## GitHub Actions

The harness drafts in the `report` job of its
`.github/workflows/accessibility.yml`, which runs when dispatched by hand,
after the job writes and uploads the requirements report. The job checks
out aloud at `ALOUD_COMMIT`, the commit the screen reader jobs check out,
so one pin covers the drivers and the drafts. Every run with known bugs
switched off converts the report and runs `aloud acr` once per component,
with `--step-summary` collecting each draft's level counts; a report that
no longer converts, or findings aloud rejects, fails the job. Only a run
of every component and every test keeps the drafts: the `openacr-drafts`
artifact holds one draft per component and the findings it was built
from, for 90 days, and the job summary links it above the level counts. A
run narrowed to some components or tests keeps nothing, since the other
components' rows have no evidence from it. A run with known bugs switched
on is never drafted.

These are the report job's steps (`ALOUD_REPOSITORY` and `ALOUD_COMMIT`
are workflow-level settings):

```yaml
      - name: Check out pinned Aloud
        if: env.RUN_KNOWN_BUGS != '1'
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          repository: ${{ env.ALOUD_REPOSITORY }}
          ref: ${{ env.ALOUD_COMMIT }}
          path: .native-tools/aloud
          persist-credentials: false
      - name: Draft an OpenACR for each component
        if: env.RUN_KNOWN_BUGS != '1'
        run: |
          npm ci --prefix .native-tools/aloud --ignore-scripts --no-audit --no-fund
          node testing/support/acr-findings.mjs requirements-report/report.json findings
          mkdir -p openacr
          for findings in findings/*.json; do
            component=$(basename "$findings" .json)
            node .native-tools/aloud/bin/aloud.mjs acr --findings "$findings" \
              --out "openacr/uswds-$component-acr-draft.yaml" \
              --step-summary "$RUNNER_TEMP/acr-summary.md" > /dev/null
          done
          cp -r findings openacr/findings
      - id: drafts
        if: env.RUN_KNOWN_BUGS != '1' && inputs.components == '' && inputs.test_pattern == ''
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: openacr-drafts
          path: openacr/
          if-no-files-found: error
          overwrite: true
          retention-days: 90
```

## What a harness draft does not cover

The harness tests components on example pages, so its drafts leave
several things to people, and say so:

- Criteria the harness does not report (the WCAG AAA criteria and the
  Section 508 chapter provisions such as 302, 502, and 602) are
  `not-evaluated` with "no finding covers this criterion".
- Page-level criteria are `not-applicable` for a component. A site built
  with USWDS must test them on its own pages; in a site's ACR, override
  `page-level` to `not-evaluated`.
- Emulated phones are not physical devices, and `not-triggered` rows rest
  on a person's triage, not a test.

Finish each draft with the [checklist](openacr.md#how-to-finish-it-into-a-real-acr).
