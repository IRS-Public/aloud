<img src="docs/assets/social-preview.png" alt="aloud. The first 508 audit that actually listens. A speech waveform over the text: TalkBack, VoiceOver, OpenACR, CC0." width="100%">

# aloud

**The first 508 audit that actually listens.**

[![ci](https://github.com/IRS-Public/aloud/actions/workflows/ci.yml/badge.svg)](https://github.com/IRS-Public/aloud/actions/workflows/ci.yml)
[![license: CC0-1.0](https://img.shields.io/badge/license-CC0--1.0-blue.svg)](LICENSE)
[![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

aloud collects accessibility evidence for mobile and web apps: screen-reader
transcripts, accessibility checks, screenshots, HTML reports, and draft
OpenACR documents. Each platform labels how speech was captured or computed;
web checks run without a screen reader by default.

- **Android**: real TalkBack, built from Google's source at a pinned commit.
  The transcript is what TalkBack spoke, captured from its speech log.
- **iOS**: computed VoiceOver transcripts by default. Opt-in real speech
  through Xcode 27's `XCUIVoiceOverService` uses
  `--voiceover real --no-gate` and labels traversal as partial.
- **Web (experimental)**: Chromium page checks, screenshots, and structural
  snapshots, with an opt-in NVDA command-capture adapter for Windows. Web
  evidence is report-only. [Setup and validation status](docs/web.md).

Both mobile audit legs have passed real CI runs on the IRS mobile app project
it was built for. Browser validation covers Chromium fixtures and the public
TodoMVC React app, including repeated NVDA runs on Windows.

## Why

508 audit tools today do not listen. Static scanners check the
accessibility tree and stop there. But the DHS Trusted Tester methodology
for mobile names its test instruments plainly: VoiceOver and TalkBack. A
conformant audit uses the screen reader itself. aloud automates exactly
that. It runs the instrument, records the speech, and turns the evidence
into a report.

One more reason the name fits: "audit" comes from the Latin *audire*, to
hear. The first audits were hearings. This one is too.

## Try it in 60 seconds

No emulator, no simulator, no setup. The demo replays a captured audit of a
bundled sample screen through the real pipeline:

```bash
git clone https://github.com/IRS-Public/aloud && cd aloud && npm install
npx aloud demo
```

Here is the demo screen's captured TalkBack transcript:

```text
Order status, heading
Your order shipped on Tuesday, August 25th.
Track package, button
Unlabeled, button
Cancel order, button
```

Line four is the audit. A static scanner logs "missing contentDescription"
in a table. aloud shows you the moment a blind user reaches a share button
and hears the word "Unlabeled". The demo report fails that screen on two
real findings: the unlabeled control, and a cancel button smaller than the
touch-target minimum. If your machine has a text-to-speech voice, the
report also reconstructs the transcript as playable audio, labeled as a
reconstruction.

## Quickstart

aloud is a standalone CLI. Point it at a mobile app build or a running web
app. You do not need CI or changes to your app. For a URL, jump to
[Web apps](#web-apps-experimental).

For mobile audits, install it as in the demo above, then write a small config
(see `examples/aloud.config.example.json`). Save it as `aloud.config.json` in
your project root.

```json
{
  "app": {
    "name": "Example App",
    "version": "1.0.0",
    "android": { "package": "com.example.app", "apk": "build/app-debug.apk" },
    "ios": { "bundleId": "com.example.app", "app": "build/Example.app" }
  }
}
```

### Android

You need a running emulator with a `google_apis` (userdebug) image, and a
TalkBack APK (Google ships no prebuilt one, so aloud builds it from source
at a pinned commit and caches it):

```bash
npx aloud talkback get --build
npx aloud talkback install .aloud-cache/talkback.apk
npx aloud android --apk path/to/app-debug.apk
open aloud-report/android/index.html
```

On an x86_64 emulator, install `.aloud-cache/talkback-nolib.apk` instead.
The pinned TalkBack build ships ARM native libs only.

The first run exits with a failure: findings gate against a baseline, and
no screen is in one yet. Accept the current counts:

```bash
npx aloud baseline aloud-report/android
```

The gate is a ratchet: from that baseline, per-screen error counts can only
go down, and a rule id the baseline has never seen fails. Pass `--no-gate`
to skip the gate instead.

### iOS

You need macOS, a booted simulator, and `idb` (accessibility tree dumps):

```bash
npx aloud ios --app path/to/YourApp.app
open aloud-report/ios/index.html
```

Same first-run rule as Android: accept the baseline with
`npx aloud baseline aloud-report/ios`, or pass `--no-gate`.

To also collect Apple's per-screen accessibility audit, install `xcodegen`
and use a configured Xcode 15+ with an iOS 17+ simulator:

```bash
brew install xcodegen
npx aloud ios --apple-audit --no-gate
```

This opt-in integration adds contrast, hit-region, text-clipping, and other
Apple findings to the evidence page. Findings are **report-only** while the
integration is calibrated; they do not change the tree-check gate or
OpenACR conformance levels. A failed or incomplete native capture stops the
run. See [docs/ios.md](docs/ios.md#apple-accessibility-audit-opt-in).

### Web apps (experimental)

Start your web app, then capture its URL with Chromium. The default mode
needs no emulator, simulator, or screen reader. Browser dependencies are
optional for mobile-only installs.

```bash
npm install --save-dev playwright@1.63.0 @axe-core/playwright@4.13.0
npx playwright install chromium
npx aloud web --url http://127.0.0.1:3000
open aloud-report/web/index.html
```

The default captures page structure, axe findings, and screenshots without
generating speech. Use the [web config](examples/aloud.web.config.example.json)
and [scenario manifest](examples/screens-web.example.json) to capture named
page states and assert keyboard focus.

On a dedicated Windows desktop, `--screen-reader nvda` adds Guidepup-formatted
NVDA command output and speech assertions. Follow the
[NVDA setup instructions](docs/web.md#nvda-command-capture) first. Chromium
fixtures and the external TodoMVC scenarios have passed repeated runs,
including NVDA on Windows; [recorded results and limits](docs/web.md#validation-and-promotion)
describe the tested scope.

Web evidence is **report-only**: browser baselines and regression gates are
disabled, and every web OpenACR component remains `not-evaluated`.

### Draft OpenACR

Run this after the baseline step: with no flags, `openacr` reads the
baselines you accepted above.

```bash
npx aloud openacr
```

To draft from a fresh run without a baseline, pass the report dirs:
`npx aloud openacr --report aloud-report/android --report-ios aloud-report/ios`.

For web evidence, configure `app.name` and `app.version`, then run
`npx aloud openacr --report-web aloud-report/web`. This can be combined with
the mobile report inputs; web criteria remain unevaluated.

This emits `acr-draft.yaml`, a machine-readable accessibility conformance
report in the GSA [OpenACR](https://github.com/GSA/openacr) format. It is a
draft on purpose: only criteria the automated rules cover get a conformance
level, and every note says so. See [docs/openacr.md](docs/openacr.md).

For mobile apps, aloud audits whatever screen is currently open
(`--nav current-screen`, the default). Give it a screens manifest
(`examples/screens-deeplinks.example.json`) to walk your whole app by deep
links, or use bridge mode (`examples/screens-bridge.example.json`) for apps
with a dev navigation hook. See
[docs/how-it-works.md](docs/how-it-works.md).

## Run it in CI (optional)

aloud runs fine on GitHub-hosted runners. Copy the templates in
[`examples/ci/`](examples/ci/):

- [`examples/ci/android-audit.yml`](examples/ci/android-audit.yml): boots a
  headless emulator with KVM, builds TalkBack once and caches it, runs the
  audit, uploads the evidence page.
- [`examples/ci/ios-audit.yml`](examples/ci/ios-audit.yml): boots a
  simulator on a macOS runner, installs `idb` from a pinned tarball, runs
  the audit, uploads the evidence page.

Both templates use only GitHub-owned actions. See [docs/ci.md](docs/ci.md).

The repository's [browser acceptance workflow](.github/workflows/web.yml)
runs Chromium fixtures on relevant pull requests. Manual dispatch adds the
external web-app scenarios and can enable Windows NVDA validation.

## How it works

**Android** runs two passes per screen. Pass one: TalkBack is on, and
logcat markers bracket each screen so TalkBack's verbose speech log can be
sliced into a per-screen spoken transcript. Pass two: TalkBack is off, and
`uiautomator dump` feeds the 508 rule checks plus an evidence screenshot.
Two passes because `uiautomator` evicts running accessibility services, so
the tree pass would kill TalkBack mid-speech.

Opt-in `aloud android --atf --pass tree --no-gate` captures richer native nodes
through the companion and runs six pinned Google Accessibility Test Framework
checks on the same snapshot. Native findings are report-only; skipped checks
remain explicit. See [setup and coverage](docs/android-atf.md).

**iOS** runs one pass. `idb` dumps the accessibility tree per screen. aloud
computes the VoiceOver utterance for each element (label, value, trait,
hint) and runs the iOS rule checks. The transcript is labeled
`computed-voiceover`. Opt-in `--voiceover real --no-gate` records actual
speech with `source: "voiceover"`, raw capture evidence, and explicit partial
coverage. Partial speech cannot pass the gate. Requirements and screen-state
limits are documented in [docs/ios.md](docs/ios.md).

**Web** captures configured Chromium page states with Playwright, runs axe-core,
and retains ARIA snapshots, screenshots, and keyboard/focus assertions. Opt-in
NVDA adds captured command output. Run inventories and artifact hashes are
verified when reports are regenerated. Scripted scenario completion does not
establish full traversal or conformance; see [web coverage](docs/web.md).

Mobile tree-check findings gate against a per-screen baseline you accept with
`aloud baseline`. It is a ratchet: counts only go down, and a rule id the
baseline has never seen fails even under the count.

Full pipeline, rule tables, and known limits:
[docs/how-it-works.md](docs/how-it-works.md).

## Bugs it has actually found

aloud's transcripts were read against a real IRS-app feature branch after
the tree checks had passed every screen. Three findings surfaced. Chasing
each to root cause improved the tool more than the app, which is the
honest shape of dogfooding:

- **"Paperless notices, 1."** Preference toggles appeared to announce a raw
  numeric state. Root cause: a UISwitch dumps `AXValue "1"` through the
  mac-AX bridge, but real VoiceOver speaks "on". The *transcript* was
  wrong, not the app. Fixed: switch-family numeric state now normalizes to
  on/off, and RN's Switch (which surfaces as `CheckBox`) is recognized as
  a switch. A new `ios-toggle-raw-value` warning covers the genuinely
  broken shape, a non-switch control wearing numeric state, and stays out
  of text fields and sliders, where a "1" is content.
- **Roster rows intermittently losing their button trait.** In walk-time
  dumps, two of six visually identical client rows read as static text; in
  settled dumps all six carry the trait. The app's code was right. The
  dump can race the accessibility tree's realization. Fixed at the cause:
  the walker now re-dumps until two consecutive dumps agree. The new
  `ios-list-row-not-interactive` warning still flags a static row sitting
  in a column of interactive siblings, so a real lost trait gets human
  review instead of a silent pass.
- **A switch flagged for being 51x31pt.** Adding CheckBox to the
  interactive set tripped the 44pt target rule on Apple's own UISwitch
  geometry. Apple's audit passes it; aloud now exempts switch-family
  roles from the platform-minimum rule.

The meta-lesson is the tool's thesis restated: the dump is not the speech.
Every one of these was invisible to a static tree check and surfaced only
by reading what VoiceOver would say.

## Status and roadmap

Working today, proven in CI:

- Android TalkBack transcripts and tree checks, two-pass.
- iOS computed VoiceOver transcripts and tree checks.
- Experimental Chromium checks and keyboard/focus scenarios, with opt-in NVDA
  command capture validated on Windows and the external TodoMVC React app.
- Mobile ratchet gate, HTML evidence pages, and draft OpenACR emitter.

Roadmap, in implementation order:

1. **Per-screen Apple accessibility audits.** The opt-in `--apple-audit`
   integration is available for validation on iOS 17+. Keep native findings
   report-only until real-app fixtures establish useful severity and
   coverage. This work does not depend on the VoiceOver beta API.
2. **Real VoiceOver on iOS.** Opt-in per-screen capture preserves raw speech,
   target identity, and explicit partial coverage. A verified completion
   signal, complete utterance text, and broader released-runtime validation
   remain required before it becomes the default. Today's baselines store tree
   errors, so no transcript migration is needed. [Tracking #23](https://github.com/IRS-Public/aloud/issues/23).
3. **TalkBack focus stepping.** Opt-in `--talkback focus` drives the pinned
   TalkBack gesture pipeline and captures focus and speech requests, including
   scrolling and duplicate labels. Native backward/forward boundaries are
   required; incomplete traversal fails. [Setup and limits](docs/talkback-focus.md).
4. **A logging TTS engine.** Opt-in `--talkback focus --tts logging` verifies
   durable requests against engine receipts and queue/completion events.
   The test engine emits synthetic silence; request accounting does not
   prove audible delivery. [Setup and evidence](docs/logging-tts.md).
5. **Deeper Android checks.** Opt-in `--atf` captures native hints, state
   descriptions, pane titles, and role-description extras, and runs six ATF
   4.1.1 checks. Reports preserve exact element identities, skipped results,
   and overlap with tree findings. New results remain report-only.
   [Setup and coverage](docs/android-atf.md).
6. **Web app evidence.** Experimental `aloud web` uses pinned Chromium and
   axe-core, with a separate NVDA command-capture adapter. Repeated Windows
   fixtures validate scripted command capture; browser gates still require
   their own coverage policy. [Scope and validation](docs/web.md).

Acceptance criteria and dependencies: [technical roadmap](docs/roadmap.md).
External app results and limits: [Wikipedia mobile validation](docs/real-app-validation.md)
and [TodoMVC browser validation](docs/web.md#validation-and-promotion).

## Prior art, and the word "first"

Static scanners (axe, Accessibility Scanner, Xcode's audit) inspect markup
or the accessibility tree. They are useful, and aloud runs tree checks too.
But they do not run a screen reader, so they cannot tell you what a blind
user hears. Projects like ARIA-AT drive real screen readers to test
interoperability on the web, not to audit an app. Commercial screen-reader
automation exists in beta. As far as we know, no open tool before aloud
combined all four: crawl an app's screens, drive the real screen readers,
assert on the captured speech, and emit 508/OpenACR reporting. If we are
wrong, open an issue; we would genuinely like to know.

|  | aloud | Static scanners (axe, Accessibility Scanner) | Xcode audit | ARIA-AT | Commercial beta tools |
| --- | --- | --- | --- | --- | --- |
| Runs the real screen reader | Yes* | No | No | Yes | Yes |
| Captures the spoken output | Yes* | No | No | Yes | Yes |
| Walks every screen of a mobile app | Yes | No | Only screens your UI tests visit | No, web only | Varies |
| Section 508 / OpenACR reporting | Yes | No | No | No | No |
| Open source | Yes, CC0 | Core only | No | Yes | No |

\* Real TalkBack on Android today. On iOS the default transcript is computed and
labeled as computed; opt-in real VoiceOver captures are partial on Xcode 27
GA, with the experimental harness already in this repo. Web defaults to
structural checks; opt-in NVDA preserves Guidepup-formatted command output
and remains report-only.

## License

This project is dedicated to the public domain under
[CC0 1.0 Universal](LICENSE). It was developed as a work of the United
States federal government, following the precedent of IRS Direct File. You
may copy, modify, and use it, for any purpose, without permission or
attribution.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
