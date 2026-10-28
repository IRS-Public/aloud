# Android interaction evidence

Focus traversal answers what TalkBack requests when it reaches a control.
An interaction scenario also records what happens after the user activates it.
Use it to investigate a radio choice whose amount or checked state is missing
from an announcement, or whose state is wrong after moving focus away and back.

This is an explicit diagnostic command. Ordinary `aloud android` audits never
activate controls. Use a disposable emulator and synthetic data: an `activate`
step invokes the real focused control and can change application state.

## Run a scenario

Prepare the pinned [TalkBack companion](talkback-focus.md) and navigate the test
app to the intended window. The command uses an already enabled companion; it
does not install packages, change accessibility settings, launch or navigate the
app, or dismiss blocking dialogs. Its handshake verifies the target window.

```bash
aloud android-interaction \
  --package org.irs_public.aloud.fixture \
  --scenario examples/android-radio-interaction.json \
  --out aloud-report/radio-interaction
```

The example expects the native acceptance fixture's `radio-en` screen, with three
radio choices followed by a disabled choice. On Android 14, its native radio
state description is “selected” or “not selected”, while the checked value
is a separate boolean. Adapt the fixed sequence and exact speech assertions to
the app, screen-reader configuration and language under test. A different focus order
should fail the assertions, not silently choose another control.

Steps use TalkBack's own `first`, `next`, `previous` and `activate` gesture
actions. Each command executes once. Activation is never retried and is bound
to the previously observed focused node. An app process, service session,
window or unexpected focus change stops the sequence.

`expect` can require `checkable`, `checked`, `stateDescription` and case-insensitive literal
`speechIncludes` / `speechExcludes` strings. Pair a positive checked-state
phrase with exclusion of its opposites (the example excludes “not selected”
and “unselected”); “selected” alone also occurs inside both opposite phrases.
Speech checks use the utterances for that action,
not a concatenated whole-screen transcript. Use independent assertions for
the initial amount, activation announcement and refocus announcement; speech
from an earlier action cannot satisfy a later check.

## Interpret the evidence

Each command retains the focused node before and after the action, including
its native checkable/checked/selected values and state description. Bounded
native click and content-change events preserve their source identity and
timing. Raw broadcasts, command records and diagnostics remain available when
a command or assertion fails.

Observation completion and assertion success are separate. A settled, silent
activation can be a complete observation with a failed speech assertion. A
click or unrelated content-change event alone does not prove the selected
state or the expected announcement. Missing or inconsistent evidence never
becomes a passing assertion.

The default source is TalkBack's speech-request listener. `--tts logging`
additionally requires an already configured [logging TTS engine](logging-tts.md)
and validates its independent receipts and queue accounting. Record the tested APK hash/version alongside the capture;
repository provenance alone does not identify an installed APK. The engine emits
synthetic silence. Neither mode records the sound a person hears. The result
is diagnostic evidence, not a WCAG or Section 508 conformance verdict, and it
is not fed into the ordinary audit ratchet or OpenACR automatically.

## Vendor-device retests

The companion is built from pinned Google OSS TalkBack source. It does not
instrument the TalkBack version installed on a Samsung phone. Rooted emulator
setup and the silent logging engine also differ from a physical device's
configuration. Do not replace a tester's everyday screen reader to claim a
vendor reproduction.

For a physical-device retest, retain app version/build, Android/One UI version,
TalkBack version, language, TTS engine/voice and verbosity settings. Record the
exact utterance on first focus, after each selection, and after focus leaves
and returns. Keep English and Spanish outcomes separate. An emulator capture
can narrow the defect to exposed state, native events or TalkBack speech
requests; that evidence does not substitute for the affected device result.

## Validation

The synthetic native fixture and `test/android-interaction-smoke.mjs` exercise
activation, repeated selection and refocus with English and Spanish amount
labels. Unit tests exercise malformed or stale evidence and failed assertions.
Native execution is a separate CI check; unit fixtures alone are not a native
speech pass. The acceptance workflow retains the raw evidence from each run.
