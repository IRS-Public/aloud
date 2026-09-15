# TalkBack focus traversal

`aloud android --talkback focus` opts into the pinned TalkBack gesture pipeline.
Build the test companion first (JDK 17, Gradle 8.14.3, Android SDK 36):

```bash
aloud talkback get --build --companion --no-native
aloud talkback install .aloud-cache/talkback.apk
aloud android --talkback focus --no-gate
```

`--no-native` is an emulator build: it omits braille libraries and disables
braille-display initialization. Omit it when building with the pinned NDK on
a supported host. Use a separate APK cache for companion builds; a stock or
FOSS APK has no command receiver. Never use this test build as your everyday
screen reader. It is built from TalkBack commit
`229212fdf5842191d0a93fc95d9ca1423b346866` plus the small, checked patch in
`src/android/talkback-companion/`.

## What completion means

The controller first invokes First item on screen to clear a prior screen’s
boundary state, then moves backward using TalkBack's **Previous item** action until
TalkBack reports its native boundary. It then invokes **First item on screen**
to record the first focus and its speech, and advances with **Next item** until
the forward boundary. These are the actions in the pinned
[GestureController](https://github.com/google/talkback/blob/229212fdf5842191d0a93fc95d9ca1423b346866/talkback/src/main/java/com/google/android/accessibility/talkback/gesture/GestureController.java).
The companion observes the exact `REACH_EDGE` branches in
[FocusProcessorForLogicalNavigation](https://github.com/google/talkback/blob/229212fdf5842191d0a93fc95d9ca1423b346866/talkback/src/main/java/com/google/android/accessibility/talkback/focusmanagement/FocusProcessorForLogicalNavigation.java).
It never chooses a target node itself or substitutes injected shell gestures.

A completed capture proves traversal between those boundaries in the selected
active window. It does **not** prove that the order is correct, that the app
exposes all its content, or that every speech request was audibly delivered.
No new WCAG criterion is marked as evaluated.

Scrolling is driven by TalkBack's asynchronous navigation. A failed scroll,
wrap, missing focus/speech evidence, window change, process change, missing
companion, or timeout makes the run fail. Repeated text, repeated focus, and
an actor returning `false` are never end signals. Dynamic content, WebViews,
links within a node, and other cases without a verifiable boundary may fail;
no computed transcript is substituted.

`--talkback-max-steps N` limits each backward/forward phase (1–200; default
100). Each native command has an 8-second deadline and waits for speech to
finish plus 600 ms of quiet. A deadline is an incomplete result. The
controller retains every returned broadcast, parsed command, and diagnostic
log even when it refuses to produce a passing transcript.

## Evidence and device state

`<out>/android/talkback-focus/` contains per-screen JSON, command JSONL,
broadcast responses, and logcat diagnostics. Transcript JSON includes the
validated raw command records. Duplicate labels and repeated speech remain
separate; node tokens come from Android node equality within this request,
never from text matching. Tokens are not persistent IDs or baseline keys.

Speech is observed through TalkBack's `FailoverTtsListener` callback immediately
before an utterance request. Each record retains its native utterance ID and
text, including hints. This is speech-request evidence, not a recording or a
claim of lossless audible output. The separate logging-TTS milestone will
provide independent engine-side evidence and queue/completion accounting.

When both passes run, tree checks and the screenshot are taken at the requested
viewport **before** focus traversal scrolls it. The focused node records show
the later traversal positions. The runner restores the original accessibility
service list, enabled flag, and TalkBack preference XML on success and failure,
including SIGINT/SIGTERM. A forced process kill or disconnected device can
prevent cleanup; the retained state snapshot identifies the recovery data.
Other accessibility services remain in the enabled list while TalkBack runs.

## Protocol v1

Only a source build patched with `--companion` registers the dynamic receiver.
It requires the platform `android.permission.DUMP` permission, held by adb
shell/root and privileged platform callers. Ordinary apps cannot invoke it;
the acceptance fixture verifies this denial. The endpoint is debug-only and
is registered only while TalkBack's service is alive.

Send an ordered, package-targeted broadcast:

```text
adb shell am broadcast -a org.irs_public.aloud.TALKBACK_COMMAND \
  -p com.android.talkback --es op hello --es requestId <uuid> \
  --es screen <screen-id> --es target <package> --ei sequence 0
```

Subsequent operations are `reset` (First item, before the backward sweep),
`previous`, `first` (First item, starting the recorded forward sweep), and `next`, with consecutive
sequence numbers and `--es session <hello-session>`. Every response echoes
request ID, screen, target, sequence, action, service session/PID, window ID,
Android runtime, and TalkBack commit. Code `200` carries base64 UTF-8 JSON;
`400` rejects malformed input, and `409` rejects concurrent or stale requests.
A service restart generates a new session and invalidates the capture.

Responses contain `before`, `after`, `focusEvents`, `speech`, `signals`,
`elapsedMs`, and `status`. `ready`, `focused`, and `edge` require matching
focus identity; failure statuses include `wrap`, `scroll-failed`,
`target-changed`, `window-changed`, `service-stopped`, `step-timeout`, and
`speech-limit`. Speech entries contain `utteranceId` and `text`; their array
position preserves order within a step. The identity tuple
`requestId / screen / sequence / utteranceId` is the join point for future
engine-side records. The final capture explicitly states
`coverage.complete`, `coverage.reason`, `coverage.start`, and `maxSteps`.

## Validation

The native smoke suite uses Android Views with nested containers, two identical
labels, a disabled button, 30 scrollable rows, and a dialog. It also exercises
truncation, app/process changes, permission denial, and state restoration.
The workflow retains raw evidence for investigation. JavaScript tests reject
truncated records, missing focus or speech, stale sessions, guessed boundaries,
and mismatched transcripts before report generation.
