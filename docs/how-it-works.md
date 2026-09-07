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
src/report/openacr.mjs            draft OpenACR (see docs/openacr.md)
```

`aloud android` and `aloud ios` run the whole leg: install the build
(`--apk` / `--app`), walk, report, gate. `aloud report` re-aggregates an
existing report dir. `aloud baseline` accepts current counts. `aloud
openacr` emits the draft conformance report.

Reports land under the report root (`--out`, default `aloud-report`):
`aloud-report/android/` and `aloud-report/ios/`. Each dir holds per-screen
`*.tree.json` and `*.transcript.json` files, `shots/` screenshots,
`summary.json`, and `index.html`.

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
tree. The rules live in `src/android/ui-tree.mjs`:

| Rule id | WCAG | Severity |
| --- | --- | --- |
| `native-interactive-unlabeled` | 4.1.2 | error |
| `native-image-button-unlabeled` | 4.1.2 | error |
| `native-edittext-unlabeled` | 4.1.2 | error |
| `native-touch-target-small` (48dp platform bar) | 2.5.8 | error |
| `native-duplicate-speakable` | 4.1.2 | warn (report-only) |

Errors count toward the gate; warns appear in the report only. The dump
format omits `stateDescription`, `roleDescription`, hints, and `paneTitle`.
Those need an AccessibilityNodeInfo harness (Google's Accessibility Test
Framework), which is on the roadmap.

## The iOS leg

One pass. `src/ios/run.sh` boots a simulator if none is booted, installs
the app, and per screen dumps the accessibility tree with
`idb ui describe-all`. From each dump aloud computes the VoiceOver
utterance for each element (label, value, trait, hint, in VoiceOver's
order) and runs the iOS rules (`src/ios/tree.mjs`):

| Rule id | WCAG | Severity |
| --- | --- | --- |
| `ios-interactive-unlabeled` | 4.1.2 | error |
| `ios-image-unlabeled` | 4.1.2 | error |
| `ios-touch-target-small` (44pt Apple bar) | 2.5.8 | error |
| `ios-toggle-raw-value` (non-switch control speaking "1"/"0") | 4.1.2 | warn (report-only) |
| `ios-list-row-not-interactive` (static row among interactive siblings) | 4.1.2 | warn (report-only) |
| `ios-duplicate-speakable` | 4.1.2 | warn (report-only) |

Errors count toward the gate; warns appear in the report only. Switch-family
roles (`Switch`, `Toggle`, and `CheckBox`, which is how a UISwitch reaches
the mac-AX dump) speak numeric state as on/off and are exempt from the
44pt rule: Apple's own UISwitch is 51x31pt and Apple's audit passes it.

Each dump is taken twice or more: the walker re-dumps every half second
until two consecutive dumps agree (up to six), because a dump can race the
accessibility tree's realization and drop traits from rows that are still
settling.

The transcript is labeled `computed-voiceover` in every report. It is never
passed off as real speech. Real VoiceOver capture through Xcode 27's
`XCUIVoiceOverService` is experimental; the harness and its proven
constraints are in [docs/ios.md](ios.md).

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
config) records per screen `{ errors, ruleIds }`. The gate is a ratchet:

- A screen fails if its error count rises above the baseline.
- A rule id the baseline has never seen fails even under the count.
- A screen not in the baseline fails until you accept it.

`aloud baseline <report-dir>` is the only sanctioned way to change the
baseline. Run it to accept an initial baseline or after a fix lowers the
counts, and commit the result with the change that earned it. The gate
summary is computed once, in the walker, and embedded in each report as
`.gate`; the baseline tool never re-derives it, so the gate and the
baseline cannot drift. `--no-gate` on a leg skips the gate for that run.

## Draft OpenACR

`aloud openacr` converts the audit results into a draft machine-readable
conformance report in the GSA OpenACR format. What the draft claims, and
what a human must still do, is in [docs/openacr.md](openacr.md).

## Running in CI

Optional. aloud is standalone-first. Templates and the hard-won runner
facts are in [docs/ci.md](ci.md) and [`examples/ci/`](../examples/ci/).

## Known limits, on purpose

- **Announcement transcripts, not traversal transcripts.** Without focus
  stepping, TalkBack speaks window, title, and focus events per screen.
  That is rich enough to catch regressions, but it is not a full
  element-by-element read. Focus stepping is on the roadmap.
- **`adb shell input` can never drive TalkBack.** Its events inject below
  the accessibility layer (verified in AOSP `InputDispatcher`). Focus
  stepping will use a broadcast-intent companion service, not synthetic
  gestures.
- **Logcat speech capture can drop a line now and then.** The
  consecutive-duplicate dedupe plus the ratchet baselines absorb this. A
  logging TTS engine for lossless capture is on the roadmap.
- **The computed iOS transcript is a model, not a recording.** Every report
  labels it as computed. See [docs/ios.md](ios.md) for the path to real
  VoiceOver speech.
