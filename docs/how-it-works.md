# How aloud works

aloud walks the screens of a mobile app on a device or emulator. On each
screen it records what a screen reader speaks and runs Section 508 / WCAG
checks on the accessibility tree. It writes per-screen transcripts, an HTML
evidence page, and a draft OpenACR report. It was built for the IRS mobile
app project and both legs have passed real CI runs.

## The pipeline

```
aloud.config.json                 app ids, nav mode, paths (all optional
        |                         unless a leg needs them; CLI flags override)
        v
src/nav/                          navigation adapter: current-screen,
        |                         deeplinks, or bridge (see below)
        v
src/android/walk.mjs              Android walker, two passes:
        |-- --pass transcript     TalkBack ON. Logcat markers bracket each
        |                         screen. TalkBack's verbose speech log is
        |                         sliced into a per-screen spoken transcript
        |                         (src/android/transcript.mjs).
        |-- --pass tree           TalkBack OFF. `uiautomator dump` per screen
        |                         feeds the 508 rules (src/android/ui-tree.mjs)
        |                         plus an evidence screenshot.
src/ios/walk.mjs                  iOS walker, one pass: `idb` dumps the
        |                         accessibility tree per screen, aloud
        |                         computes the VoiceOver transcript
        |                         (src/ios/voiceover.mjs) and runs the iOS
        |                         rules (src/ios/tree.mjs).
        v
src/report/report.mjs             summary.json + index.html evidence page +
                                  ratchet gate against the baseline
src/provenance.mjs                where each evidence file came from (commit,
                                  machine, CI run, tools); see below
src/acr/                          draft OpenACR: audit results -> findings
                                  -> shared builder (see docs/openacr.md)
```

Android `--talkback focus` replaces the startup transcript pass with the
pinned companion's actual gesture actions, focus events, and speech requests.
It requires verified native boundaries and runs tree capture first, before
scrolling. See [the protocol](talkback-focus.md).

`aloud android` and `aloud ios` run the whole leg: install the build
(`--apk` / `--app`), walk, report, gate. `aloud report` re-aggregates an
existing report dir. `aloud baseline` accepts current counts, and records
why an error is accepted (`--accept`). `aloud openacr` emits the draft conformance report, and `aloud acr` builds one from
any findings document (see [docs/openacr.md](openacr.md)). Both run in the
`aloud` process through `src/cli/openacr.mjs`.

The scripts under `src/` can also be run directly with `node`. The walkers
(`src/android/walk.mjs`, `src/ios/walk.mjs`), `src/report/report.mjs`,
`src/report/baseline.mjs`, `src/demo/demo.mjs`, and
`src/web/run.mjs` parse flags as strictly as the `aloud` command: an unknown
flag, a flag missing its value, or a flag given twice stops the script instead
of being ignored. The low-level helpers (`src/android/talkback.mjs`,
`atf-capture.mjs`, `tts-capture.mjs`) still read their arguments loosely, so
check flag spelling when calling them by hand.

Reports land under the report root (`--out`, default `aloud-report`):
`aloud-report/android/` and `aloud-report/ios/`. Each dir holds per-screen
`*.tree.json` and `*.transcript.json` files, `shots/` screenshots,
`summary.json`, and `index.html`.

Every evidence file records where it came from under `provenance`
(`src/provenance.mjs`): the audited app's git commit and whether its
working tree had uncommitted changes (aloud's own output, the report dir
and the `.aloud-cache` download dir or `$ALOUD_CACHE`, does not count),
aloud's version and commit, the OS, architecture, and Node.js version,
the GitHub Actions run id, attempt, and URL when there is one, and tool
versions (the TalkBack build, the Accessibility Test Framework, the `adb`
the walker runs, Xcode). The shared fields use the USWDS accessibility
harness's `evidence.json` names (`commit`, `workingTreeDirty`,
`platform`, `architecture`, `osRelease`, `node`, `githubRunId`,
`githubRunAttempt`); aloud adds `githubRunUrl`, `aloud`, and `tools`.
Anything that cannot be read, such as a directory that is not a git
checkout, is `null`, never "clean". `summary.json` states the run's
provenance, and the evidence page shows it. A report dir must hold one
run: `aloud report` and `aloud baseline` refuse to combine files from
another commit, a dirty tree, another aloud, machine, or CI run, or
files written before provenance next to newer ones. Re-run into a fresh
report dir, or pass `--allow-mixed`; the summary then lists every source
and the files it covers. Report dirs written before provenance still
aggregate unchanged.

A missing accessibility capture fails the walk before it writes that screen's
tree report or screenshot. Android requires a complete XML hierarchy with
visible accessibility content from the configured app package; launcher,
system-dialog-only, and empty layout trees cannot pass the audit. iOS retries
empty or malformed dumps within its six-capture settling budget and fails if
the final dump still has no visible accessibility content. An unlabeled control
is valid evidence and is checked normally. Check the foreground app, screen
rendering, and accessibility setup when a capture fails.

## Navigation modes

aloud does not know your app. You tell it how to reach each screen with
`--nav` (or `nav.mode` in the config):

- **current-screen** (default). Zero setup. aloud audits whatever screen is
  open right now. One screen per run; `--screen-id` names the report key
  (default `current`). Open the target screen before running the audit;
  aloud preserves the running app and its current light/dark appearance.
  On Android, capture begins before TalkBack is enabled so the initial
  focus announcement is included in the transcript. If this run installs a
  build (`--apk`, `--app`, or a configured build path), aloud opens that
  build first and audits its opening screen. Omit build paths when auditing
  a screen you have navigated to manually.
- **deeplinks**. You provide a screens manifest (`--screens`, see
  `examples/screens-deeplinks.example.json`). Each screen has a `url` and aloud opens
  it with a deep link. Works on release builds.
- **bridge**. For apps with a dev navigation hook. The walker evaluates
  small expressions in the app's JS runtime through the dev server (the
  globals default to `__devNav`, `__devSignInAs`, `__devSignOut`). Screens
  can set a `route`, a `persona`, or a raw `eval`. This mode can walk
  signed-in screens and modal sheets.

A manifest groups screens into flows. `--flow a,b` walks a subset. Screens
can set `settleMs` (extra wait) and `dark: true` (dark mode).

Screen IDs must be non-empty strings containing only ASCII letters, digits,
underscores, and hyphens (for example, `account-orders` or `home_dark`). The
same format applies to `--screen-id` and `nav.screenId`. Dots, spaces, and
path separators are rejected. `_between` and names inherited from
`Object.prototype`, such as `constructor`, `toString`, and `__proto__`, are
reserved. IDs preserve their case and identify report files, transcript
markers, and baseline entries. They must be unique across selected flows
even when ignoring letter case: `Home` and `home` would overwrite the same
report on a filesystem that ignores case.

## The Android leg

Two passes, because they cannot share a device session: `uiautomator dump`
attaches UiAutomation, which evicts running accessibility services. The
transcript pass keeps TalkBack undisturbed; the tree pass does not need it.

The transcript is real TalkBack speech. `aloud talkback enable` puts
TalkBack in diagnosis mode so it logs every utterance, and the walker
brackets each screen with logcat markers. The capture and its limits are
described in [docs/talkback.md](talkback.md).

Run it:

```bash
npx aloud talkback get --build       # build TalkBack at the pin (once, cached)
npx aloud talkback install .aloud-cache/talkback.apk
npx aloud android --apk path/to/app-debug.apk
```

`--pass transcript|tree|both` runs one pass alone (default `both`). Use
`--pass transcript --no-gate` for capture-only evidence: a gate requires
completed tree checks for every screen in the report. A transcript-only or
partially checked report still renders, but cannot pass `aloud report --gate`.
Requires a `google_apis` (userdebug) emulator image; see
[docs/talkback.md](talkback.md) for why.

### Android rules

`uiautomator dump` exposes a high-confidence subset of the accessibility
tree. The rules live in `src/android/ui-tree.mjs`. Each rule's severity and
WCAG criteria come from the rule catalog, `src/rules/catalog.mjs`, which the
OpenACR draft also reads (primary criterion first):

| Rule id | WCAG | Severity |
| --- | --- | --- |
| `native-interactive-unlabeled` | 4.1.2 | error |
| `native-image-button-unlabeled` | 4.1.2, 1.1.1 | error |
| `native-edittext-unlabeled` | 4.1.2, 1.3.1 | error |
| `native-target-size-minimum` (under 24dp, spacing circle overlaps another target) | 2.5.8 | error |
| `native-touch-target-small` (48dp Android guideline) | none | warn (report-only) |
| `native-duplicate-speakable` | 4.1.2, 2.4.6 | warn (report-only) |

Errors count toward the gate; warns appear in the report only.

WCAG 2.5.8 needs a target to be at least 24x24 CSS px. aloud reads that as
24dp on Android and 24pt on iOS. It also applies the spacing exception: an
undersized target still passes if a 24-unit circle centred on it does not
overlap any other target, or another undersized target's circle. A circle
that only touches another target or circle at a single point does not
count as an overlap. aloud cannot judge the inline, user-agent-control,
essential and equivalent-control exceptions, so those still need a human.
It also skips some targets entirely: disabled ones, ones with no on-screen
area, switch-family controls on iOS, and, on Android, targets clipped at a
scroll edge or nested inside a labeled clickable ancestor of at least 24dp.
Review those by hand. The 48dp and 44pt platform guidelines stay in the
report as warnings.

Reports and baselines written before this split still load. A baseline
entry that accepted the old 48dp/44pt ids as errors drops those ids and
one error for each of them. Each dropped id accounted for at least one
error, so what remains is the most the other rules could have had, which
is also what the old entry already allowed them. An unchanged app that
passed before still passes. A new 24-unit violation still fails the gate. `aloud
baseline` keeps old entries for screens it did not re-run exactly as
written, and the OpenACR draft reads such an entry as leaving 2.5.8
unchecked on that screen. An old tree report that gated on the 48dp/44pt
rule cannot show whether 2.5.8 is met. So `aloud report` fails that screen,
`aloud baseline` refuses it, and the OpenACR draft leaves 2.5.8
`not-evaluated` until the tree pass is re-run. ATF reports carry the
native evidence, so both commands recompute them in the current
classification.

The dump format omits `stateDescription`, `roleDescription`, hints, and `paneTitle`.
Opt-in `--atf` uses the companion's `AccessibilityNodeInfo` snapshot for both
tree rules and six pinned Google Accessibility Test Framework checks. It
captures those missing properties, retains exact node identities, and verifies
the snapshot around the screenshot. ATF findings and skipped results appear
separately and do not change the tree gate. See [native Android checks](android-atf.md).

## The iOS leg

One pass. `src/ios/run.sh` boots a simulator if none is booted, installs
the app, and per screen dumps the accessibility tree with
`idb ui describe-all`. From each dump aloud computes the VoiceOver
utterance for each element (label, value, trait, hint, in VoiceOver's
order) and runs the iOS rules (`src/ios/tree.mjs`), with severity and
criteria from the same catalog:

| Rule id | WCAG | Severity |
| --- | --- | --- |
| `ios-interactive-unlabeled` | 4.1.2 | error |
| `ios-image-unlabeled` | 1.1.1, 4.1.2 | error |
| `ios-target-size-minimum` (under 24pt, spacing circle overlaps another target) | 2.5.8 | error |
| `ios-touch-target-small` (44pt Apple guideline) | none | warn (report-only) |
| `ios-toggle-raw-value` (non-switch control speaking "1"/"0") | 4.1.2 | warn (report-only) |
| `ios-list-row-not-interactive` (static row among interactive siblings) | 4.1.2 | warn (report-only) |
| `ios-duplicate-speakable` | 4.1.2, 2.4.6 | warn (report-only) |

Errors count toward the gate; warns appear in the report only. Switch-family
roles (`Switch`, `Toggle`, and `CheckBox`, which is how a UISwitch reaches
the mac-AX dump) speak numeric state as on/off and are exempt from
both target-size rules: Apple's own UISwitch is 51x31pt and Apple's audit
passes it. A switch still counts as a neighbour when aloud checks another
target's spacing.

Each dump is taken twice or more: the walker re-dumps every half second
until two consecutive dumps agree (up to six), because a dump can race the
accessibility tree's realization and drop traits from rows that are still
settling.

The default transcript is labeled `computed-voiceover`. With
`--voiceover real --no-gate`, Xcode 27's `XCUIVoiceOverService` supplies raw
speech instead. Every native capture has explicit partial coverage; step
limits and speech timeouts never establish completion. Changed screen
content is rejected before pairing speech with tree evidence. See
[docs/ios.md](ios.md) for requirements, artifacts, and remaining limits.

```bash
npx aloud ios --app path/to/YourApp.app
```

## The transcript is the point

The per-screen `*.transcript.json` files record what a screen-reader user
gets when each screen opens: navigation announcements, accessibility
announcements, initial focus. Browse them on the evidence page
(`index.html`). Static scanners cannot produce this evidence; a screen
reader can.

## The gate

The baseline file (default `aloud-baseline-android.json` /
`aloud-baseline-ios.json`, or `baseline.android` / `baseline.ios` in the
config) records per screen `{ errors, ruleIds }`, plus optional accepted
reasons (see [below](#accepted-findings)). The gate is a ratchet:

- A screen fails if its error count rises above the baseline.
- A rule id the baseline has never seen fails even under the count.
- A screen not in the baseline fails until you accept it.

`aloud baseline <report-dir>` is the only sanctioned way to change the
baseline. Without `--baseline`, a report dir named `ios` or ending in `-ios`
(for example `aloud-report/ios` or `shop-ios`) uses the iOS baseline, and any
other dir uses the Android one; `aloud report` picks its baseline the same
way. Run it to accept an initial baseline or after a fix lowers the
counts, and commit the result with the change that earned it. The gate
summary is computed once, in the walker, and embedded in each report as
`.gate`. The report and baseline tools validate that summary against the
error findings before using it. Invalid counts, duplicate or empty rule IDs,
and contradictory findings stop the command. Baseline updates validate all
existing entries and supplied tree reports before writing; an invalid input
leaves the baseline unchanged. Valid filtered runs still preserve untouched
screens. `--no-gate` on a leg skips the ratchet comparison, not validation of
the supplied tree evidence.

A screen this run did not cover is kept as written, with a note. When a
screen was renamed or removed, pass `--prune` to drop every screen the run
did not cover instead of editing the file by hand.

### Accepted findings

A baselined error can carry the reason it is allowed to stand:

```bash
aloud baseline aloud-report/android \
  --accept checkout:native-target-size-minimum --kind platform-gap \
  --summary "The system date picker draws 20dp arrows" \
  --issue https://tracker.example.com/APP-7
```

This writes an `accepted` list on the screen's entry:

```json
"checkout": {
  "errors": 2,
  "ruleIds": ["native-target-size-minimum"],
  "accepted": [{
    "ruleId": "native-target-size-minimum",
    "kind": "platform-gap",
    "summary": "The system date picker draws 20dp arrows",
    "issue": "https://tracker.example.com/APP-7"
  }]
}
```

- `kind` is `product-bug` (a defect in the app, not fixed yet),
  `platform-gap` (the OS, screen reader, or a system control causes it), or
  `accepted-risk` (a known defect the team chose to ship).
- `summary` is one sentence of at most 140 characters. `issue` is optional:
  an http(s) URL or a tracker id with no spaces.
- The rule id must be one the screen's entry gates, and a rule in
  `src/rules/catalog.mjs`. An invalid entry stops `aloud report --gate` and
  `aloud baseline` without writing anything, like any other invalid baseline.
  A report without `--gate` (including the report step of a leg run with
  `--no-gate`) warns instead and writes its evidence without accepted
  reasons.
- One `--accept` per run adds or replaces the reason for that rule id; the
  command still merges the report dir first.
- Re-baselining keeps each reason while its rule still fires on the screen,
  and drops it (with a note) once the finding is gone.
- `aloud baseline` warns about baselined rule ids with no reason. It is a
  warning, not a failure: baselines written before accepted reasons stay
  valid as they are.

A reason explains a failure; it does not excuse it. The ratchet is
unchanged, and the screen keeps its failing badge. The reasons for the
errors a run still finds appear in `summary.json` (per screen, `accepted`),
on the evidence page, and in the OpenACR draft's notes (see
[docs/openacr.md](openacr.md)).

## Draft OpenACR

`aloud openacr` converts the audit results into a draft machine-readable
conformance report in the GSA OpenACR format. It does so in two steps:
`src/acr/from-aloud.mjs` turns the audit results into a findings document,
one status per criterion and component, and the shared builder
(`src/acr/build.mjs`) turns findings into the draft through a conservative
level policy. `aloud acr` runs only the second step, on findings from any
source, so aloud's drafts and another tool's drafts follow the same rules:
every catalog row is listed, only passing evidence reaches `supports`, and
anything unproven is `not-evaluated`. What the draft claims, and what a
human must still do, is in [docs/openacr.md](openacr.md);
[docs/harness-integration.md](harness-integration.md) shows another tool's
report feeding the same builder.

## Running in CI

Optional. aloud is standalone-first. Templates and the hard-won runner
facts are in [docs/ci.md](ci.md) and [`examples/ci/`](../examples/ci/).

## Known limits, on purpose

- **The default Android transcript covers startup/navigation speech.** Full
  traversal is opt-in through `--talkback focus`; incomplete traversal fails
  and retains raw diagnostics.
- **Shell input injection does not drive TalkBack's accessibility focus.**
  Focus capture uses a restricted broadcast companion inside TalkBack's
  service and invokes its actual gesture controller.
- **Logcat speech capture can drop lines.** Baselines count tree errors and
  cannot detect missing speech. Focus mode records TalkBack's own TTS request
  callback and keeps duplicate speech. Opt-in `--tts logging` pairs durable
  request records with engine receipts and queue/completion events; its engine
  generates synthetic silence. See [logging TTS capture](logging-tts.md).
- **The computed iOS transcript is a model, not a recording.** Every report
  labels it as computed. See [docs/ios.md](ios.md) for the path to real
  VoiceOver speech.
