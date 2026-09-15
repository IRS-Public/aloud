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
contains no documented focus identity or end flag. Before promotion to the
default:

- Remove fallback-to-host behavior and validate the intended app throughout
  capture. Preserve the already-navigated screen.
- Distinguish a speech timeout, a traversal limit, and successful completion.
  The current 20-step cap and `noSpeech` exception do not prove completion.
- Test repeated labels, dynamic content, scroll boundaries, and modal views.
- Store raw speech with `source: "voiceover"`, explicit completion metadata,
  and the toolchain version. Never substitute computed output silently.
- Define comparison normalization with fixtures; preserve meaningful
  punctuation, values, order, and repeated utterances. Tree-count baselines
  need no transcript migration because they contain no transcript text.
- Make real capture opt-in first. Promote it only after repeatable device
  or simulator runs on the supported toolchain demonstrate the above.

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
