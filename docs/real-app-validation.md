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
  Verify the requested screen survives harness activation and foreground
  transitions. Preserve actual speech and explicitly partial coverage.
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

The available iOS runner selects Xcode 27 Release Candidate, build `27A266a`.
`xcodebuild -version` alone does not identify the release channel, so the harness
also records the selected developer directory. This is RC validation, not GA
validation. The pinned app needs a one-line `isolated deinit` compatibility patch
for its settings controller on this SDK. The patch is committed alongside the
harness; the evidence includes the complete tracked source diff and app version.
An empty `OpenSourceDebug.xcconfig` supplies upstream's generated simulator
configuration without a signing identity.

## Results

Validation is in progress. Final results will link the CI artifacts and distinguish
captured screens, rejected captures, and remaining coverage.
