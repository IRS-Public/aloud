# The iOS leg

Two speech sources are available:

- **Computed VoiceOver transcripts** are the default for `aloud ios`.
  Proven, in CI, on real runs.
- **Real VoiceOver capture** through Xcode 27's `XCUIVoiceOverService` is
  opt-in with `--voiceover real --no-gate`. Captures are explicitly partial;
  complete traversal has not been established.

## Computed VoiceOver (default)

`aloud ios --app path/to/YourApp.app` boots a simulator if none is booted,
installs the app, walks the screens, and per screen dumps the
accessibility tree with `idb ui describe-all --json`. From each element
(label, value, trait, hint) it composes the utterance in the order
VoiceOver composes speech (`src/ios/voiceover.mjs`) and runs the iOS rules
(`src/ios/tree.mjs`), including the 44x44pt touch-target rule (the Apple
platform bar; WCAG 2.5.8 asks less, aloud holds the platform bar).

Honesty rule: every computed transcript carries
`source: "computed-voiceover"` and the evidence page labels it
"Computed VoiceOver". It is a model of what VoiceOver would
say, not a recording.

### idb, pinned

The tree dumps come from Facebook's `idb`. aloud's CI template installs
the `idb-companion` binary from the pinned v1.1.8 release tarball, not
from Homebrew:

```
https://github.com/facebook/idb/releases/download/v1.1.8/idb-companion.universal.tar.gz
```

Why: the Homebrew formula, when its bottle misses the current runner
image, falls back to a source build that demands a full Xcode 26
toolchain. That breaks every time the runner image updates. The v1.1.8
binary is what brew shipped anyway. The Python client is `pip install
fb-idb==1.1.7`, on Python 3.11. Python 3.14 fails before capture because
the client calls `asyncio.get_event_loop()` without creating an event loop.
Use a Python 3.11 virtual environment and run `idb list-targets` before building
a target app.

A dump can also race the tree's realization: on the IRS app, a walk-time
dump showed two of six list rows without their button trait while a
later dump showed all six with it. `src/ios/walk.mjs` therefore re-dumps
every half second until two consecutive dumps agree (up to six), and says
so in the log when a screen never settles.

One preflight the runner scripts do for you: idb tree reads come back
empty unless the simulator's app-accessibility flag is on. `src/ios/run.sh`
writes `com.apple.Accessibility ApplicationAccessibilityEnabled` before
the walk.

## Apple accessibility audit (opt-in)

`aloud ios --apple-audit` runs Apple's `performAccessibilityAudit(for: .all)`
on every selected screen, after the existing tree dump and screenshot.
It works independently of the selected speech source and can be combined
with either computed or real VoiceOver capture.

Requirements:

- Xcode 15+ with its first-launch setup and license completed, and an iOS
  17+ Simulator runtime. Select that Xcode through `DEVELOPER_DIR` or your
  usual Xcode developer-directory setting.
- `xcodegen` (`brew install xcodegen`).
- The normal iOS prerequisites above, including `idb` and the target app.

Enable it with the flag or add `"ios": { "appleAudit": true }` at the top
level of `aloud.config.json`. The default is off.

The walker builds the XCTest harness once per run and executes it for each
screen. The harness activates the already-running target without calling
`launch()`. It refuses an unavailable target and never falls back to its
own host app. Each completion record is tied to a unique request ID, the
screen ID, and the target bundle ID. A failed test, timeout, missing record,
or invalid record stops the run before passing screen artifacts are written.

Apple may temporarily change settings such as Dynamic Type during an
audit. The screenshot is taken first so it matches the tree evidence.
The test runner briefly takes foreground focus between captures. The walker
compares normalized accessibility content and geometry before and after the
native audit and rejects changed screens. Live content that changes during
an audit can also trigger this check; use a stable app state for this mode.

The evidence report includes a separate **Apple accessibility audit**
section. Apple findings are report-only while the integration is calibrated:
they do not change the tree-error baseline or add OpenACR conformance
coverage. Screens with native findings are labeled **Review**. Capture
failures still fail the command even with `--no-gate`.

Artifacts under `<report-root>/ios/apple-audit/`:

- `<screen>.json`: raw typed findings, descriptions, optional element
  labels/frames, and capture identity.
- `<screen>.log` and `<screen>.xcresult`: XCTest diagnostics and attachments.
- `generate.log`, `build.log`, `harness/`, and `build/`: harness build files.

The device-free tests exercise parsing, invocation, failure handling, and
walker integration. `node test/ios-apple-audit-smoke.mjs` builds and audits
an intentionally flawed simulator fixture, then verifies that an unavailable
target is rejected. The `Apple audit smoke` workflow runs that test for
changes to the native harness. A successful simulator run is required before
describing this integration as validated on a particular toolchain.

## Real VoiceOver (opt-in, partial capture)

```bash
aloud ios --voiceover real --voiceover-max-steps 20 --no-gate
# Combine speech capture and Apple findings:
aloud ios --voiceover real --apple-audit --no-gate
```

Equivalent top-level config:

```json
{
  "ios": {
    "voiceOver": "real",
    "voiceOverMaxSteps": 20
  }
}
```

Requirements: Xcode 27+, an iOS 27+ Simulator runtime, `xcodegen`, and the
normal iOS prerequisites (including `idb`). Select Xcode through
`DEVELOPER_DIR` or your developer-directory setting. Unsupported toolchains
fail; the command never silently substitutes computed speech.

The harness activates the already-running target. It never launches it or
falls back to its own host. Dismiss system dialogs before capture: a
foreground app can still be covered by a system alert. The harness checks
for those alerts and verifies foreground state throughout capture.

### What the evidence proves

Apple's [XCUIVoiceOverService](https://developer.apple.com/documentation/xcuiautomation/xcuivoiceoverservice)
returns speech from `currentSpeech()` and subsequent `moveForward()` calls.
The [Output](https://developer.apple.com/documentation/xcuiautomation/xcuivoiceoverservice/output)
contains an utterance but has no documented focus identifier or
traversal-complete flag. Identical labels can belong to different controls.
Repeated speech is never used as a completion signal and is never removed.
The initial output can be a service announcement such as “VoiceOver on,”
leaving the first focused element's speech absent. The modal fixture showed
this on Xcode 27: subsequent calls returned the dismiss button and modal
value, but the heading was not returned. No computed heading is inserted.

Startup can also produce `noSpeech` before any announcement. The harness
retries `currentSpeech()` up to three times; these reads do not move focus.
Each timeout is retained in the current step's `readErrors`. If none returns
speech, the current step remains `null` with its error, and forward
traversal still runs. Reports and OpenACR notes identify that initial gap.

Every capture starts at **current focus**, with at most the configured
number of forward moves (1–100; default 20). Coverage is always partial:

- `step-limit`: all requested forward calls returned; this does not prove
  the last element was reached.
- `speech-timeout`: a forward action returned Apple's `noSpeech` error.
  The failed step and error are retained. The harness stops rather than
  retrying an action that could silently skip an element. An initial read
  timeout alone is retained as a gap and does not stop forward traversal.
- `time-limit`: the 120-second capture budget elapsed between API calls.
  An in-flight native call can exceed that budget; a 300-second process
  timeout then fails the capture and retains diagnostics.

`--no-gate` permits partial evidence. With gating enabled, partial real
speech fails even when the tree baseline passes. Tool failures, invalid
records, system alerts, and changed screens fail even with `--no-gate`.
The original VoiceOver enabled state is restored on normal and throwing
paths; a process crash or forced termination can prevent native cleanup.
Check the simulator state after such a failure before reusing it.

The walker compares normalized accessibility content and geometry before
and after the native capture. If activation resets the app, focus movement
scrolls it, or live content changes, it refuses to pair speech with the old
tree/screenshot. Raw speech and XCTest diagnostics remain available. Use a
stable viewport for integrated per-screen reports. The standalone native
smoke additionally captures scrolling and dynamic content to exercise these
limits without claiming complete traversal.

### Artifacts and reports

Under `<report-root>/ios/voiceover/`:

- `<screen>.json`: unchanged utterances and step order, request/screen/app
  identities, runtime, Xcode version, simulator UDID, service restoration,
  and explicit stopping reason.
- `<screen>.log` and `<screen>.xcresult`: native diagnostics and attachments.
- `toolchain.log`, `generate.log`, `build.log`, `harness/`, and `build/`:
  build evidence and generated harness.

Per-screen transcripts carry `source: "voiceover"` and the full capture
record. `summary.json` includes `transcriptSource` and VoiceOver coverage
and provenance. The HTML labels real speech as **VoiceOver said** and
**Partial traversal**; a clean tree receives a **Review** screen badge.
OpenACR notes distinguish real from computed speech per screen. Partial
speech adds no conformance coverage, and focus-order criteria remain
unevaluated.

### Speech comparisons

Saved speech is never normalized. The exported
`normalizeVoiceOverForComparison(utterances, policy)` helper defaults to
`exact`. The opt-in `unicode-nfc-v1` policy only reconciles canonically
equivalent Unicode (for example, two encodings of é). Both preserve
punctuation, numeric values, whitespace, case, order, and repeated lines.

Real “Order status Heading” and computed “Order status, heading” therefore
remain different. Inferring trait boundaries from unstructured speech can
mistake a label for a trait; no blanket punctuation or case stripping is
applied. Current baselines store only tree-error counts and rule IDs, so
there is no transcript baseline to migrate. Any future speech comparison
must select a versioned policy explicitly.

### Native validation and remaining work

`node test/ios-voiceover-smoke.mjs` builds a separate SwiftUI fixture,
navigates away from its launch screen, and captures repeated labels,
modal content, scrollable rows, and changing values. It also verifies an
unavailable target fails. The `VoiceOver smoke` workflow uses GitHub's
[`xcode-27` runner](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md).
Native captures retain the actual toolchain version; a preview runner does
not establish GA support automatically.

Applications linked against the iOS 27 SDK must adopt the UIScene lifecycle.
The SwiftUI fixture does. For older app architectures, build the target
with a pre-27 SDK until it adopts scenes. For React Native development
builds, prewarm the JavaScript bundle before launching or navigating.

Promotion to the default remains pending a verified traversal-completion
signal and repeatable validation on supported GA toolchains and external
apps. See [the technical roadmap](roadmap.md).
