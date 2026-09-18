# Technical roadmap

This plan prioritizes evidence we can validate. A working API spike is a
starting point; it does not establish complete audit coverage.

The [external-app validation record](real-app-validation.md) tracks pinned
Wikipedia builds, capture results, toolchain constraints, and remaining coverage.
It distinguishes successful evidence collection from app accessibility findings.

## 1. Apple accessibility audit

Tracking: [#21](https://github.com/IRS-Public/aloud/issues/21).

The first implementation is `aloud ios --apple-audit`:

- Capture native findings on every navigated screen alongside tree checks.
- Keep target identity and capture-completion checks mandatory.
- Include raw JSON and XCTest artifacts in the evidence report.
- Leave findings report-only until severity and coverage are calibrated.

Release criteria: the simulator smoke workflow passes, then at least one
external app is exercised in current-screen, deep-link, and bridge modes.
Verify that background/foreground transitions do not change the requested
screen. Only introduce gating or WCAG mappings with corresponding fixtures
and explicit per-screen native-check coverage.

## 2. Real VoiceOver

Tracking: [#23](https://github.com/IRS-Public/aloud/issues/23).

The Xcode 27 harness is integrated as opt-in partial capture through
`--voiceover real --no-gate`. It preserves raw speech and identities,
retains limits/timeouts explicitly, and rejects unavailable targets and
system dialogs. Complete traversal is still unproven: Apple's `Output`
contains no documented focus identity or end flag.

Implemented: strict capture identities, no fallback or target relaunch,
raw `source: "voiceover"` evidence, toolchain versions, service-state
restoration, explicit stopping reasons, report/OpenACR provenance, and
conservative comparison policies. Tree-count baselines need no transcript
migration because they contain no transcript text. The simulator workflow
exercises repeated labels, dynamic content, scrolling, and modals.

Still required before promotion to the default:

- Verify complete utterance text on supported runtimes; the external-app run
  observed long API strings ending at 64 characters, which Aloud preserves
  exactly. See the [validation record](real-app-validation.md).
- Establish a verified traversal-completion signal. Neither repeated
  speech nor `noSpeech` establishes the end of a screen.
- Pair moving or changing content with coherent tree/screenshot evidence;
  the current walker rejects changed screens and retains raw diagnostics.
- Expand repeatable validation to released OS runtimes and more external apps.
  The first external captures use released Xcode 27 with simulator `24A434`;
  the toolchain and OS runtime have separate build identities.

## 3. TalkBack focus stepping

Tracking: [#24](https://github.com/IRS-Public/aloud/issues/24).

The opt-in `--talkback focus` implementation uses a shell-restricted companion
inside the pinned source build. It invokes TalkBack's gesture controller,
records actual focus and speech requests, and requires backward and forward
native boundaries. Incomplete traversal fails with raw diagnostics retained.
See [the protocol and limitations](talkback-focus.md).

The native fixture covers nested containers, scrolling, duplicate labels,
disabled controls, dialogs, target changes, permission denial, and restoration.
Broader app and WebView compatibility remains an adoption-validation task;
traversal evidence alone does not establish correct focus order or conformance.

## 4. Logging TTS engine

Tracking: [#25](https://github.com/IRS-Public/aloud/issues/25).

The opt-in `--talkback focus --tts logging` mode pairs a durable request ledger
with independent engine receipts and Android completion/interruption callbacks.
It keeps queued-but-flushed requests explicit, preserves incomplete evidence
after process death, and restores the original engine and related settings.
See [logging TTS capture](logging-tts.md).

The native suite checks repeated IDs, 400 rapid requests with logcat overflow,
queue replacement and stop, and engine/client restart recovery. The recording
engine generates synthetic silence, not spoken words. Verified request
accounting does not prove audible delivery or correct focus order.

## 5. Accessibility Test Framework and richer Android nodes

Tracking: [#26](https://github.com/IRS-Public/aloud/issues/26).

The opt-in `--atf` implementation captures native hints, `stateDescription`,
`paneTitle`, and the AndroidX role-description extra. Six pinned ATF 4.1.1
checks run against the same snapshot used by the existing tree rules.
Reports preserve check execution, `NOT_RUN` applicability results, stable
rule IDs, exact element identity, and potential overlap with tree findings.
Raw snapshots and hashed receipts are retained and revalidated on aggregation.
See [setup and scope](android-atf.md).

The controlled fixture demonstrates each selected check failing and then
clearing after correction, plus read-only content, changing screens, process
loss, permission denial, and cleanup. These checks remain report-only and add
no OpenACR conformance claims. Broader app/framework validation and additional
checks require their own fixtures before expanding the supported suite.

## 6. Web app evidence

The experimental `aloud web` leg captures named Chromium page states with
axe-core findings, structural ARIA snapshots, screenshots, and scripted
keyboard/focus assertions. Browser packages are optional peers. Run identities,
expected states, artifact receipts, explicit speech sources, and cleanup
status survive re-aggregation. Web results are report-only, and web OpenACR
components remain `not-evaluated`.

The NVDA adapter captures Guidepup's formatted command output on a dedicated
Windows desktop. It never substitutes structural text for speech and never
claims full traversal. Its native acceptance workflow is opt-in; a real Windows
run and an external app validation record remain required before promotion.
See [web setup and limits](web.md).

Next acceptance steps:

- Run the repeated Windows form-error, modal-return, live-region, duplicate-label,
  and long-output fixtures. Retain the exact browser, NVDA, and Guidepup identities.
- Validate authenticated and changing page states on an external web app, including
  frames and shadow content, and record unsupported cases without loosening checks.
- Define separate scan, assertion, and capture-completeness policies before browser
  gating. Baselines must identify the browser/reader/OS/locale/viewport and rule suite.
- Validate additional browser and screen-reader combinations independently. A
  Playwright WebKit run must not be labeled as Safari coverage.
