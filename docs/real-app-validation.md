# Real-app validation

The first external-app validation target is Wikipedia's public Android and iOS
apps. Build identities are pinned in `test/real-app/wikipedia.json`. Use fresh,
disposable emulators/simulators without an account. Preserve raw artifacts and
record failures separately from completed captures; accessibility findings in
the app are not failures of the capture tool.

## Validation scope

- Android: native ATF, TalkBack focus traversal, and logging TTS through the CLI.
  Exercise native controls and article content, current-screen and deep-link
  navigation, repeated runs, and restoration of accessibility/TTS state.
- iOS: native Apple audit and real VoiceOver on an independently built app.
  Verify repeated onboarding captures, navigation to the exploration page,
  and rejection of Saved audits whose navigation geometry changes. Confirm
  its deep link explicitly during setup. Verify that successful current-screen
  captures survive harness activation and foreground transitions. Preserve actual speech and explicitly partial coverage.
- Record toolchain versions, app build identities, screen identities, and raw
  evidence. A passing controlled fixture does not substitute for these runs.

Wikipedia's native apps do not provide Aloud's React Native development bridge.
Bridge validation still requires a separate external app exposing that protocol;
it must not be marked passed by using Wikipedia deep links instead.

## VoiceOver completion remains unresolved

Apple's documentation was checked on 2026-09-17. The documented
[`XCUIVoiceOverService.Output`](https://developer.apple.com/documentation/xcuiautomation/xcuivoiceoverservice/output)
still exposes only `utterance`. It does not provide a focused-element identity
or an end-of-traversal flag. A repeated utterance, timeout, or successful capture
on an external app cannot establish complete traversal. Keep real VoiceOver
opt-in and partial until a separately verified completion signal exists.

On the observed iOS 27 runtime `24A434`, long returned utterances ended at 64
characters, including a mid-word ending in the page-control hint. Aloud passes
`Output.utterance` through unchanged; it does not reconstruct missing text from
the tree. This observation needs verification on newer runtimes and does not
establish a universal API length limit. A captured API response does not prove
the complete spoken text was returned.

## Preparation and observed limits

Android runs verify the downloaded APK's SHA-256, clear the disposable app's
storage, complete onboarding, and open/close the article overflow menu. That
last step completes Wikipedia's first-use toolbar hint through its public UI.
Without preparation, the hint opened a different window during article traversal;
Aloud retained the speech and correctly rejected the capture as `target-changed`.
Preparation does not weaken that guard or retry a failed capture into a pass.

The long “Hello, World!” article exceeds the 500-node ATF limit. A separate
speech-only probe also reached the 200-step TalkBack limit. Both are incomplete
captures, not passing audits. The automated suite retains the ATF rejection and
checks that report regeneration cannot promote it. The short Abacheri article
is a separate WebView case; live Wikipedia content is not a fixed golden baseline.

CI selects Xcode by build identity: `27A266a`, which [Apple’s release list](https://developer.apple.com/news/releases/)
identifies as the September 14, 2026 Xcode 27 release (checked September 17).
The installation directory still says `Xcode_27_Release_Candidate.app`; the
runner label has also selected beta 6 on earlier jobs. A directory name or
runner label alone cannot establish release status. The harness retains the
version, directory hint, and release reference separately.

The validated simulator runtime is iOS 27 build `24A434`, which differs from
Apple’s September 14 iOS release (`24A437`). This validates the released Xcode
build on the recorded simulator, not every released OS runtime. The pinned app needs a one-line `isolated deinit` compatibility patch
for its settings controller on this SDK. The patch is committed alongside the
harness; the evidence includes the complete tracked source diff and app version.
An empty `OpenSourceDebug.xcconfig` supplies upstream's generated simulator
configuration. The simulator build uses ad-hoc signing to preserve the app's
required app-group entitlements; no developer certificate is used. An earlier
unsigned build crashed while initializing the shared data store, and Aloud
correctly rejected the unavailable target. The suite retains crash diagnostics
and checks the launched process before starting capture.

On the initial iOS onboarding screen, Apple's audit completes but changes the
Skip button's frame: its width changes from 57 to about 54.67 points. Repeated
diagnostic captures reproduced this exact change while the other normalized
elements stayed equal. Aloud rejects the pairing and retains the raw native
audit and both trees. The suite verifies that specific rejection, then makes
a separate capture of the post-audit state without relaunching the app. The
original rejected capture remains incomplete. The screen-consistency guard
remains exact. The initial case also accepts a coherent capture if a newer
runtime no longer causes the resize; it always validates the normal completed
report before recording that outcome.

On Saved, the native audit completes but changes the navigation bar height
from 144 to 224 points; the next audit changes it back to 144. Other normalized
elements stay equal. Both pairings remain unsupported. The suite verifies the
specific geometry changes, completed native audit identities, and rejection
when reports are regenerated. It does not loosen geometry matching or turn
these captures into passing screen reports.

Unattended iOS `deeplinks` mode encountered SpringBoard’s “Open in Wikipedia?”
confirmation. Apple rejected the obscured target (`Invalid target app`); the
failed capture retained the dialog tree and produced no passing report. That
dialog also blocked later app launches in the same diagnostic run. The suite
runs VoiceOver first and explicitly confirms the URL during setup before using
`current-screen` for Saved. Unattended CLI deep-link navigation remains
unresolved on this app; no automatic dialog dismissal was added to Aloud.

## Results

Local Android validation on 2026-09-17 used Wikipedia `50608-r-2026-09-15`,
Android 14/API 34 (`sdk_gphone64_arm64`, build `UE1A.230829.050/12077443`), and
Node 26.3.1. The final run produced:

| Case | Native nodes | Transcript lines | Result |
| --- | ---: | ---: | --- |
| Onboarding, first capture | 13 | 7 | Both TalkBack boundaries and TTS accounting verified |
| Onboarding, repeat | 13 | 7 | Same coverage; state restored |
| Data & Privacy | 12 | 13 | Native navigation preserved; state restored |
| Abacheri deep link | 90 | 88 | Six ATF checks completed; both TalkBack boundaries verified |
| Hello, World! deep link | — | — | Incomplete ATF capture rejected at the node limit |

The article ledger contains 90 requests including setup/rewind speech: 89
completed and one stopped. The report labels the stopped request explicitly.
The article has tree and ATF findings; successful capture does not mean the app
passes accessibility checks. All cases restored accessibility/TTS settings and
TalkBack preferences. An earlier local attempt timed out in adb during article
traversal and remains failed evidence; the table describes a separate fresh run.

The [Android native regression suites](https://github.com/IRS-Public/aloud/actions/runs/35270741991)
passed for focus traversal, ATF capture, logging TTS, and queue/process recovery.
All 245 device-free tests passed.

[Wikipedia Android CI](https://github.com/IRS-Public/aloud/actions/runs/35270742053/job/105369111478)
also passed on Android 14 x86_64 with Node 24.20.0. The three native captures
matched the local node/utterance counts; the article produced 90 nodes and 88
transcript lines, including one stopped request. All state-restoration and
incomplete-report rejection checks passed. Download `wikipedia-android-evidence`
from that run for raw artifacts.

Released-Xcode runs retained these iOS outcomes on the pinned Wikipedia build:

| Case | Result |
| --- | --- |
| VoiceOver onboarding, first and repeat | 11 API utterances each; matching tree; VoiceOver state restored; explicitly partial at the 10-step budget |
| Initial onboarding Apple audit | Native audit completed; Skip resize rejected; no passing report |
| Separate post-audit onboarding capture | Coherent capture with one report-only native issue |
| Exploration page after tapping Next | Coherent capture with one report-only native issue |
| Saved after confirming its deep link | Native audit completed; navigation-bar expansion rejected |
| Saved repeat from the changed state | Native audit completed; navigation-bar contraction rejected |

The [full external-app suite passed](https://github.com/IRS-Public/aloud/actions/runs/35270742053)
on implementation commit `417a8a3`. All seven iOS cases verified their expected
outcomes: four coherent captures (two explicitly partial VoiceOver captures and
two Apple audit reports), plus three specific rejected pairings. Download
`wikipedia-ios-evidence` from the run for raw speech, audit records, before/after
trees, screenshots, and provenance. Earlier failed diagnostic runs remain
failed evidence; they were not converted into successful reports.

A successful suite verifies capture and rejection behavior. It does not mean
Wikipedia passes accessibility checks, nor that every tested screen produced
a coherent report. Known unsupported cases stay explicitly incomplete.

## Fixes found by the external app

- TalkBack diagnosis mode forced a visible logging overlay even with the
  overlay preference disabled. Native capture now turns diagnosis mode off;
  startup/logcat capture retains the logging configuration it requires.
- TalkBack interrupted its own WebView boundary announcement when moving to
  the native toolbar. The request and stop callback were fully accounted for,
  but focus validation previously required every request to finish synthesis.
  Validation now accepts accounted stops and labels them in the report.
  Dispatch/synthesis errors, missing callbacks, incomplete journals, and
  contradictory command or process identities still fail.
- iOS pairing failures previously retained native audit/speech output but not
  the trees used to reject the pairing. Raw idb reads now remain under
  `ios/capture-trees/`, labeled by screen, phase, and attempt. A changed tree
  still fails; these files are diagnostics, not replacement capture evidence.

## Reproduce

Run the **External app validation** workflow for both platforms. It retains
app/build provenance, per-case CLI logs, raw native evidence, reports, and
failure diagnostics for 14 days. Download artifacts before they expire if
you need to retain a validation record.

For Android, start a disposable rooted Android 14 emulator and install the
pinned TalkBack companion and recording TTS engine using the normal setup
instructions. Download the exact APK named in `test/real-app/wikipedia.json`,
then run:

```sh
ALOUD_WIKIPEDIA_APK=/absolute/path/wikipedia.apk node test/real-app/android.mjs
```

The script verifies the APK hash before installation and clears Wikipedia's
data. It checks restoration of accessibility settings, TTS settings, and
TalkBack preferences after each capture. It does not restore the app's data.

For iOS, follow `.github/workflows/real-app.yml` to build the pinned source
with the recorded compatibility patch, Python 3.11, idb, and Xcode 27. Set
`ALOUD_WIKIPEDIA_APP` to the simulator app bundle and
`ALOUD_WIKIPEDIA_SOURCE` to its source checkout, then run
`node test/real-app/ios.mjs`. The script records the actual selected toolchain and checks the known released
build identity independently of the installation directory’s name.

Both scripts accept `ALOUD_REAL_APP_OUT` for a separate evidence directory.
The CLI uses `--no-gate`: native app findings are retained for review, while
capture failures still fail validation.
