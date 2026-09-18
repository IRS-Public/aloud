# Logging TTS capture

Engine-side evidence for roadmap [#25](https://github.com/IRS-Public/aloud/issues/25).

## Run

Use the Android 14 userdebug emulator and the same JDK 17, Gradle 8.14.3,
and Android SDK 36 setup as the focus companion. Rebuild the companion to
include the TTS request hooks:

```bash
aloud talkback get --build --companion --no-native
aloud talkback install .aloud-cache/talkback.apk
aloud tts build
aloud tts install .aloud-cache/logging-tts.apk
aloud android --talkback focus --tts logging --no-gate
```

Configuration: `android.tts` is `system` (default) or `logging`; logging requires
`android.talkBack: "focus"`. The recording engine advertises an English voice
and retains the exact requested Unicode text. It is a test engine for isolated
emulators, not an everyday screen reader.

The opt-in recording engine writes text to private, durable JSONL files before
synthesis. It produces **synthetic silence**, not spoken words. Engine synthesis
completion and Android playback completion are separate events; neither means
that a user heard the text. The normal system-engine mode keeps its existing
speech-request provenance.

## Two records are necessary

Android can flush queued speech before `TextToSpeechService.onSynthesizeText`
receives it. The pinned TalkBack companion therefore records each TTS call
before dispatch, including text, queue mode, original utterance ID, and the
focus capture's request/screen/step/session identity. Each dispatch gets a
unique wire ID, including when original utterance IDs repeat. Callbacks map
back to the original ID before TalkBack handles them.

The engine independently records the received text, dispatch identity, caller
UID, synthesis result, generated silence bytes, and synthesis interruptions.
The client records the API result and start/done/stop/error callbacks. Empty
flush calls and explicit stop calls remain separate queue controls.

## Durability and accounting

Each process writes a new session file with a header, consecutive event
numbers, and a final newline for each event. Every append is flushed to disk
before it returns. Files are private to the producer; adb root exports them
from the userdebug emulator. No public log-reading endpoint is exposed.
Journals are bounded at 32 MiB per process/client file, with at most 10,000
dispatches per client session. Exceeding a bound fails capture explicitly.

Accounting requires complete JSONL records, matching identities and text,
unique dispatches, dispatch results, and terminal callbacks. A completed
speech request also needs an engine receipt and completed synthesis. A
stopped request may have been flushed before reaching synthesis; its callback
must establish that outcome. Missing records, failed writes, process changes,
ambiguous identities, and unfinished requests remain explicit incomplete
evidence. They cannot become a passing capture when reports are regenerated.
A focus step may legitimately replace its own speech, for example when exiting
an Android WebView: TalkBack queues a boundary announcement and immediately
flushes it with the next control's label. Accept a fully accounted `stop` callback
within the same focus step, retain the requested text, and label it **stopped
before completion** in the report. Dispatch failures, synthesis errors, missing
terminal callbacks, and lifecycles extending beyond the step still fail capture.
Summary counts distinguish completed and stopped requests. Existing failed
capture envelopes remain incomplete; this does not promote old failed runs.

Raw journals are exported under `<out>/android/tts-logging/<client-session>/`.
The transcript artifact embeds the journals needed to revalidate accounting;
the HTML report links to both independent streams. Failed and interrupted
runs retain available device journals even when a terminal event is missing.

The runner restores the original TTS engine and related secure settings,
accessibility services, and TalkBack preferences after success, failure,
SIGINT, or SIGTERM. As with focus capture, a disconnected device or forced
process kill can prevent cleanup; retain the recovery snapshot.

## Validation

- Full TalkBack traversal with independent engine receipts for every captured
  utterance, including repeated text and hints.
- Rapid requests, repeated original IDs, queue replacement and stop, and output
  exceeding a deliberately constrained logcat buffer.
- Engine and client process death: preserved records and explicit incomplete
  accounting, followed by a new session that succeeds.
- Original engine, settings, and preferences restored after successful, failed,
  and interrupted runs; persisted-report tampering rejected.

The release claim is verified request accounting for tested captures, not a
universal claim of lossless audio delivery.
