# Technical roadmap

This plan prioritizes evidence we can validate. A working API spike is a
starting point; it does not establish complete audit coverage.

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

- Establish a verified traversal-completion signal. Neither repeated
  speech nor `noSpeech` establishes the end of a screen.
- Pair moving or changing content with coherent tree/screenshot evidence;
  the current walker rejects changed screens and retains raw diagnostics.
- Validate repeatably on supported GA toolchains and external apps.

## 3. TalkBack focus stepping

Tracking: [#24](https://github.com/IRS-Public/aloud/issues/24).

Develop a companion with a documented command/response protocol. Prove on
the pinned TalkBack build that commands advance TalkBack's own focus and
produce its speech. A tree walker that merely sets accessibility focus is
not sufficient evidence of the user's traversal order.

Acceptance fixtures must include nested containers, scrollable lists,
duplicate labels, disabled controls, and an explicit end condition. Keep
request IDs, screen IDs, and focus-step sequence numbers in capture records.
Fail incomplete traversal rather than presenting it as a full transcript.

## 4. Logging TTS engine

Tracking: [#25](https://github.com/IRS-Public/aloud/issues/25).

Use the same capture identity and sequence protocol as focus stepping.
Preserve speech requests, queue replacement/flush events, and completion or
interruption events. Compare logs against TalkBack output under repeated
rapid navigation, process restart, and output-buffer pressure.

Do not call a stream lossless until the test can account for every request.
A TTS request is evidence of what TalkBack asked to speak; it does not prove
the user heard the whole utterance. Restore the original engine and device
settings after both successful and failed runs.

## 5. Accessibility Test Framework and richer Android nodes

Tracking: [#26](https://github.com/IRS-Public/aloud/issues/26).

Capture node properties missing from `uiautomator`, including hints,
`stateDescription`, and `paneTitle`, through a supported richer API.
Integrate the framework's checks with stable rule IDs, source/version
provenance, and reproducible fixtures. Distinguish duplicate findings from
the existing tree checks.

Before new checks affect OpenACR, record which checks actually completed on
each screen and test missing/failed native coverage. Absence of a finding
must not be treated as evidence that an unexecuted check passed.
