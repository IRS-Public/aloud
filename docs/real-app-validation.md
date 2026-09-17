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

## Results

Validation is in progress. This document will distinguish executed results from
remaining coverage, including the actual Xcode build used for iOS evidence.
