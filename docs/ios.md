# The iOS leg

Two states of the world live in this repo:

- **Computed VoiceOver transcripts** are what `aloud ios` produces today.
  Proven, in CI, on real runs.
- **Real VoiceOver capture** through Xcode 27's `XCUIVoiceOverService` is
  experimental. The harness lives in `src/ios/voiceover-native/` and has
  captured real speech in CI, but it is not wired into the audit yet.

## Computed VoiceOver (today)

`aloud ios --app path/to/YourApp.app` boots a simulator if none is booted,
installs the app, walks the screens, and per screen dumps the
accessibility tree with `idb ui describe-all --json`. From each element
(label, value, trait, hint) it composes the utterance in the order
VoiceOver composes speech (`src/ios/voiceover.mjs`) and runs the iOS rules
(`src/ios/tree.mjs`), including the 44x44pt touch-target rule (the Apple
platform bar; WCAG 2.5.8 asks less, aloud holds the platform bar).

Honesty rule: every transcript from this leg carries
`source: "computed-voiceover"` and the evidence page labels it
"VoiceOver transcript (computed)". It is a model of what VoiceOver would
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
fb-idb`, on Python 3.11 (its grpclib/protobuf pins are unproven on newer
Pythons).

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
It works independently of VoiceOver capture: transcripts remain labeled
`computed-voiceover`.

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

## Real VoiceOver (experimental)

Xcode 27 adds `XCUIVoiceOverService`: a UI test can enable VoiceOver in
the Simulator, step element by element, and read back each utterance.
`src/ios/voiceover-native/` is a working harness for it:

- `project.yml` is an xcodegen spec. The generated `.xcodeproj` is not
  committed; run `xcodegen generate` in that directory.
- `UITests/VoiceOverTests.swift` launches the target app by bundle id
  (env `TEST_RUNNER_TARGET_BUNDLE_ID`), enables VoiceOver, walks forward
  up to 20 elements, and writes every utterance to stdout markers, an
  XCTest attachment, and the file named by
  `TEST_RUNNER_VOICEOVER_OUT_FILE`.
- `HostApp/` exists only because a UI-testing bundle needs a host target.
  It also carries a few labeled controls as a last-resort read target.

The harness proved real capture works. It also proved four constraints.
Any production swap from computed to real speech must handle all four:

1. **The real utterance format differs from the computed one.** Real
   VoiceOver spoke "Order status Heading": capitalized trait word, no
   comma. The computed transcript says "Order status, heading". A
   comparison policy is needed before asserting equivalence. Preserve raw
   speech and avoid blanket punctuation stripping, which can hide meaningful
   differences in numbers or labels. Existing ratchet baselines contain tree
   error counts and rule IDs, so they do not compare transcript text.
2. **The iOS 27 SDK launch trap.** An app linked against the iOS 27 SDK
   crashes at launch (`EXC_BREAKPOINT` in
   `__UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`)
   until the app adopts the UIScene lifecycle. Until yours does, build
   the app against a pre-27 SDK and install that build on the Xcode 27
   simulator. The harness only needs the app installed; it does not build
   it.
3. **`moveForward()` can throw** `Error Code=3 "No speech available"`
   mid-walk. The spike stops on it, but Apple's API describes it as a speech
   timeout. It is not proof that traversal completed. Production capture
   needs bounded retries and an explicit incomplete result when completion
   cannot be established.
4. **Prewarm the JS bundle before the test drives VoiceOver.** For a dev
   React Native build, the first bundle compile can take minutes and the
   app dies if launched during it. Fetch the app's entry bundle from the
   dev server until it returns 200 before any launch.

## Roadmap

The Apple audit integration can be validated now, independently of Xcode
27. Real VoiceOver remains experimental until the harness can prove target
identity and complete traversal on a supported toolchain. The spike's
fallback app and 20-step limit are not acceptable production evidence.
See [the technical roadmap](roadmap.md) for completion criteria.
