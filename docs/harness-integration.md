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
                  -> aloud acr / the aloud GitHub Action -> <component> draft OpenACR
```

The two projects also share screen-reader code. The harness checks out
aloud at a reviewed commit and imports `src/web/nvda.mjs` and
`src/web/dependencies.mjs` by path to drive NVDA on Windows; aloud keeps
those paths and their exports stable (they are also exported as
`@irs-public/aloud/web/nvda` and `/web/dependencies`). aloud's Safari +
VoiceOver driver (`src/web/voiceover.mjs`, see [web.md](web.md#voiceover-command-capture-safari))
is a port of the harness's own native driver, and carries its failure
context (`captureContext`), typed punctuation, pass-next-key and
host-refusal handling, so the harness can drive VoiceOver through it in
place of its own copy.

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
| `criteria[].reason` | The first of `finding.notes`: a triage reason as written, or a scope statement labeled "Scope of the checks, not a result" |
| `criteria[].checks[].id` | `finding.evidence[].id` |
| `criteria[].checks[].environments` | `finding.evidence[].environments`: where the check's tests ran, pass or fail |
| `criteria[].checks[].passedIn` | Where each failing check passed, in the "Failing checks" note, and [`failingShare`](#how-failingshare-is-derived) |
| `criteria[].checks[].status` | A "Failing checks" note for checks with status `failing`, and `failingShare` |
| `criteria[].checks[].missingIn`, `skippedIn` | A "Some tests did not run in" note |
| `criteria[].checks[].issues` | `finding.issues`, with each issue's kind and summary from the harness's known-issue registry |

`name`, `summary`, `scope`, `coverage`, and `sourceUrl` are not copied:
the harness has already folded `scope` and `coverage` into the status
(`not-triggered`, `consumer-page`, and `unreviewed` scopes; `partial`
coverage makes `partly-tested`), and the catalog supplies each
criterion's name.

For rows a check can fail, the harness's `reason` is the requirement's
scope, written as a claim ("Every control works from the keyboard"). Copied
as it is, an incomplete or failing row would state that claim as a fact,
so the adapter labels it: "Scope of the checks, not a result: ...". Triage
reasons (`not-triggered`, `consumer-responsibility`, and `unreviewed`
rows) say why no check applies, and are copied as written.

## Status mapping

The harness decides each criterion's status from its checks, worst first
(`failing`, then `known-issue`, `platform-gap`, `no-evidence`, `partial`,
and `not-run`), so a row shows its worst check only; checks further down
the order may also be unproven. The adapter maps each status to one
findings status. Any other status throws.

| Harness status | What the harness means | Findings status | Default level |
|---|---|---|---|
| `met` | Every check passed everywhere it is declared, and the checks cover the whole requirement | `met` | `supports` |
| `human-reviewed` | Every check passed, and they only guard wording a person approved | `partly-tested` | `not-evaluated` |
| `partly-tested` | Every check passed, but the row's coverage is `partial` | `partly-tested` | `not-evaluated` |
| `not-met` | A check failed (a regression) | `failing` | `partially-supports`, or `does-not-support` when `failingShare` is `all` |
| `not-met-known-issue` | A check's test is switched off for a registered USWDS defect (`core-bug`) | `known-defect` | `partially-supports`, or `does-not-support` when `failingShare` is `all` |
| `platform-limitation` | A check's test is switched off for a browser or reader limitation (`platform-gap`), and no check failed or has a known defect; other checks may not have run | `platform-limitation` | `not-evaluated` |
| `incomplete` | Everything that ran passed, but some tests did not run | `incomplete` | `not-evaluated` |
| `untested` | The requirement applies and has no check yet | `untested` | `not-evaluated` |
| `unreviewed` | Nobody has checked yet whether the requirement applies | `unreviewed` | `not-evaluated` |
| `consumer-responsibility` | Page-level: the site team checks it on their own pages | `page-level` | `not-applicable` |
| `not-triggered` | Triaged: the component has no feature the requirement is about | `not-triggered` | `not-applicable` |

The default levels come from aloud's [level policy](openacr.md#the-default-policy),
which explains each one, and can be [overridden](openacr.md#overriding-the-policy)
with the action's `policy` input.

The harness's `human-reviewed` is narrower than aloud's: its tests keep
wording a person approved, and the harness says whether the wording is
clear is not tested and counts the status as a gap in its own Section 508
verdict. Nobody recorded a judgment that the whole criterion is met, which
is what aloud's `human-reviewed` (and its `supports` level) means. So the
adapter maps it to `partly-tested`, with a note that only the approved
wording is kept, and a person decides the level. A harness `platform-limitation`
row, likewise, may hide checks that never ran; its "Some tests did not run
in" note names them, and `not-evaluated` sends the row to a person either
way.

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

This is [`examples/harness-to-findings.example.mjs`](../examples/harness-to-findings.example.mjs);
a test runs it against a report fixture that uses every status, and
checks that this page shows it exactly. To use it, copy it into the
harness (for example as `testing/support/acr-findings.mjs`); aloud never
changes the harness.

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
  // The harness's "human-reviewed" means the tests keep wording a person
  // approved; nobody judged the whole criterion met, so a person reviews it.
  "human-reviewed": "partly-tested",
  "partly-tested": "partly-tested",
  "not-met": "failing",
  "not-met-known-issue": "known-defect",
  "platform-limitation": "platform-limitation",
  incomplete: "incomplete",
  untested: "untested",
  unreviewed: "unreviewed",
  "consumer-responsibility": "page-level",
  "not-triggered": "not-triggered",
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

function toFinding(row, issuesByName) {
  const status = STATUS_MAP[row.status];
  if (!status) throw new Error(`${row.criterion}: unknown harness status "${row.status}"`);
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
  const notes = row.reason ? [reasonNote(row)] : [];
  if (row.status === "human-reviewed") {
    notes.push("The tests keep wording a person approved; whether it is clear, and the rest of the criterion, is not tested");
  }
  const failing = row.checks.filter((check) => check.status === "failing");
  if (failing.length) {
    notes.push(`Failing checks: ${failing.map((check) => `${check.id} (${passedWhere(check)})`).join(", ")}`);
  }
  const missing = [...new Set(row.checks.flatMap((check) => [...check.missingIn, ...check.skippedIn]))];
  if (missing.length) notes.push(`Some tests did not run in: ${missing.join(", ")}`);
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

Run it after the requirements report, passing the harness's known-issue
registry so each issue carries its plain-language summary:

```bash
node testing/support/requirements-report.mjs --out requirements-report
node testing/support/acr-findings.mjs requirements-report/report.json findings \
  testing/support/known-issues.mjs
npx aloud acr --findings findings/button.json --out acr/button.yaml
```

(`npx aloud` needs aloud installed; from a checkout, run
`node <aloud checkout>/bin/aloud.mjs acr` instead.)

The report must come from one clean, full run: the harness already refuses
to merge evidence from different commits, and the adapter refuses a run
with unhandled errors. It also refuses a run with known bugs switched on
(`RUN_KNOWN_BUGS=1`, the workflow's `run_known_bugs` input): there, the
tests for known defects and platform limitations run and fail as plain
failures with no issue named, so a platform gap would read as a product
defect. Without the registry, each issue's summary points to
the requirements report instead.

## GitHub Actions

These jobs go in the harness workflow that builds the requirements
report (`.github/workflows/accessibility.yml`), after its `report` job,
which uploads the `requirements-report` artifact. One job writes the findings; a
matrix builds one draft per component with the [aloud action](ci.md#draft-an-openacr-with-the-github-action),
which adds each draft's level counts to the job summary; and on a
published release, a last job attaches every draft to the release.

The drafting jobs run only on pushes to `main` and on releases. On a pull
request, the harness runs VoiceOver, NVDA, and high contrast only for the
components that changed, and a manual run can limit the components or
switch known bugs on, so a draft from those runs would rest on partial
evidence. Every action is pinned to a full commit SHA, as the harness
already does; the SHAs below are the ones the harness workflow uses, so
update them together.

```yaml
on:
  release:
    types: [published]   # in addition to the workflow's existing triggers

jobs:
  # ...the existing jobs, including report...

  acr-findings:
    needs: report
    # Full runs only: pull requests test some components in some lanes.
    if: github.event_name == 'push' || github.event_name == 'release'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      components: ${{ steps.findings.outputs.components }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: 24
      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0
        with:
          name: requirements-report
          path: requirements-report/
      - id: findings
        run: |
          node testing/support/acr-findings.mjs requirements-report/report.json findings \
            testing/support/known-issues.mjs
          echo "components=$(ls findings | sed 's/\.json$//' | jq -R . | jq -cs .)" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: findings
          path: findings/

  acr:
    needs: acr-findings
    runs-on: ubuntu-latest
    permissions:
      contents: read
    strategy:
      fail-fast: false
      matrix:
        component: ${{ fromJSON(needs.acr-findings.outputs.components) }}
    steps:
      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0
        with:
          name: findings
          path: findings/
      - id: acr
        uses: IRS-Public/aloud@<full commit sha>
        with:
          findings: findings/${{ matrix.component }}.json
          out: acr/uswds-${{ matrix.component }}-acr-draft.yaml
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: draft-acr-${{ matrix.component }}
          path: ${{ steps.acr.outputs.acr }}

  attach-acrs:
    if: github.event_name == 'release'
    needs: acr
    runs-on: ubuntu-latest
    permissions:
      contents: write   # to upload release assets
    steps:
      - uses: actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0
        with:
          pattern: draft-acr-*
          merge-multiple: true
          path: acr/
      - env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.event.release.tag_name }}
        run: gh release upload "$TAG" acr/*.yaml --clobber --repo "$GITHUB_REPOSITORY"
```

Invalid findings fail that component's leg with every problem listed, and
no draft is uploaded for it; `fail-fast: false` lets the other components
finish, and the release job runs only when every leg succeeded. With about
fifty components the matrix starts fifty short jobs; to use one job
instead, loop over `findings/*.json` with `node <aloud checkout>/bin/aloud.mjs acr`
from the aloud checkout the harness already pins for its screen-reader
tests.

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
