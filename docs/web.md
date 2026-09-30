# Experimental web audits

`aloud web` captures named states in Chromium, runs axe-core, and writes an
HTML evidence page. Opt-in NVDA capture adds command output and interaction
assertions on a dedicated Windows desktop. Opt-in VoiceOver capture drives
Safari on a disposable GitHub-hosted macOS runner; it has not yet passed a
hosted acceptance run. This milestone is **report-only**:
there is no browser baseline or regression gate yet. Every web component in
the OpenACR draft remains `not-evaluated`.

## Install and run

Browser packages are optional peers. Installing Aloud for mobile does not
install browser packages or download browsers. Repository development installs
include the packages so contributors can run the fixtures.

```sh
npm install --save-dev playwright@1.63.0 @axe-core/playwright@4.13.0
npx playwright install chromium
npx aloud web --url http://127.0.0.1:3000
```

Open `aloud-report/web/index.html`. `--headed` shows the browser. The default
uses headless Chromium with no screen reader; it produces structural evidence
and explicitly says that no speech was captured. It never computes speech.
The CLI records the browser, OS, tool versions, locale, viewport, and mode.
Version pins are checked at startup; upgrades require rerunning the fixtures.

Use `examples/aloud.web.config.example.json` and
`examples/screens-web.example.json` to audit multiple states:

```sh
npx aloud web --config examples/aloud.web.config.example.json --flow account
```

Configure a base `web.url` and a `web.screens` manifest path. Config paths
resolve relative to the config file; CLI paths resolve from the current
directory. Flows and screen IDs use the same format as mobile manifests.
`--screen-id` names a single-URL capture, defaulting to `current`.

Each screen specifies a URL, optional visible `ready` selector, and up to
100 steps. Navigation requires a successful HTTP response. The final URL must
match the screen URL, or its explicit `expectedUrl`. An unexpected login or
error redirect fails capture. No site crawling or link following is inferred.

```json
{
  "id": "form-error",
  "url": "/account",
  "ready": "#email",
  "steps": [
    { "action": "click", "selector": "#email" },
    { "action": "press", "key": "Tab", "expect": { "focused": "#submit" } },
    { "action": "press", "key": "Enter", "expect": { "focused": "#email" } },
    { "action": "wait", "selector": "#error:text-is('Enter an email address')" }
  ]
}
```

`click`, `fill` (with `value`), and `wait` (visible selector) are browser setup
actions. `press` uses Playwright keyboard input in structural mode and NVDA
keyboard commands in NVDA mode. `expect.focused` observes DOM keyboard focus,
including open shadow roots; it does not assert the screen reader's browse
cursor identity. Arbitrary JS evaluation is not a manifest action.

For authenticated test accounts, pass `--storage-state path/to/auth.json`
or set `web.storageState` to a Playwright storage-state file. Its contents are
not copied into artifacts. Keep that file out of source control. Page content,
URLs, axe HTML snippets, screenshots, and manifest step values are preserved
verbatim in evidence; use test data and authenticate through storage state
instead of embedding credentials in `fill` steps.

## NVDA command capture

NVDA is an experimental adapter with recorded Windows fixture acceptance below.
Its validation applies to the recorded environment and scripted scenarios. Use
a dedicated Windows test desktop. Aloud refuses to start if NVDA is already
running, so Guidepup cannot replace an everyday screen-reader session. Setup modifies the
test machine and installs Guidepup's supported NVDA assets:

```sh
npm install --save-dev @guidepup/guidepup@0.34.0
npx --yes @guidepup/setup@0.25.3 setup
npx --yes @guidepup/setup@0.25.3 install
npx aloud web --url http://127.0.0.1:3000 --screen-reader nvda
```

NVDA always uses headed Chromium. After browser navigation Aloud checks that
the page owns keyboard focus and records `Control+Home` as its initial command.
It does not claim that this proves the beginning of a complete traversal.
Use `press`, or `nvda` with `command` set to `next`, `previous`, `nextHeading`,
`nextLandmark`, `nextLink`, or `act`, for captured interactions:

```json
{ "action": "press", "key": "Enter", "expect": { "speechIncludes": "Enter an email address" } }
```

`speechIncludes` is a case-sensitive substring assertion against an individual
returned command-log entry. It is allowed only on captured commands. Plain
Playwright setup actions do not capture speech. Failed expectations fail the
run and retain the raw steps; movement is never retried.

Guidepup 0.34.0 captures around its commands, joins speech fragments, and
normalizes whitespace upstream. Aloud preserves that output, including empty
entries, repeated text, and long strings. It is labeled `nvda-guidepup`, not
raw NVDA speech or recorded audio. Capture windows can miss delayed live
announcements, and silence is not proof of successful delivery or traversal.
The adapter does not independently verify browse-cursor identity or OS-wide
notification provenance. These limits keep the integration report-only.

The runner stops its reader and closes its browser on ordinary success or
failure. Cleanup failure prevents a completed report. A forced kill, hung
native command, or machine failure can require recovery of the disposable
desktop. Firefox, JAWS, and mobile browsers are not part of this milestone.

## VoiceOver command capture (Safari)

`--screen-reader voiceover` (or `web.screenReader: "voiceover"`) runs the
same scenarios in Safari with macOS VoiceOver, through Guidepup 0.34.0. It is
ported from the USWDS accessibility harness's native driver and is
**unvalidated**: the [web VoiceOver workflow](../.github/workflows/web-voiceover.yml)
exists, but no hosted run has been reviewed yet.

Starting VoiceOver changes the machine's accessibility settings, so Aloud
refuses to run it on a developer's Mac. It requires macOS and all of
`GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`, and
`ALOUD_ALLOW_NATIVE_DESKTOP=1`, and checks them before touching any output.
These variables prevent accidents; they are not a security boundary. It also
refuses to start when VoiceOver is already running, and at cleanup it stops
only the VoiceOver processes it started (matched by process id and start
time). The runner needs Guidepup's setup, Safari's "Allow JavaScript from
Apple Events", and full keyboard access:

```sh
npx --yes @guidepup/setup@0.25.3 setup --ci
npx --yes @guidepup/setup@0.25.3 install
defaults write com.apple.Safari AllowJavaScriptFromAppleEvents -bool true
defaults write NSGlobalDomain AppleKeyboardUIMode -int 2
ALOUD_ALLOW_NATIVE_DESKTOP=1 npx aloud web --url http://127.0.0.1:3000 --screen-reader voiceover
```

Safari WebDriver blocks native keys, so Aloud does not use Playwright here.
It opens its own Safari window and observes it through Apple Events. That
changes what the evidence can say:

- `click`, `fill`, and `wait` run as page JavaScript. Their events are not
  trusted input, and selectors are plain CSS (no Playwright selector
  extensions, no piercing of shadow roots).
- `press` goes to Safari through VoiceOver. Safari's tab-to-links preference
  is ignored on hosted runners, so `Tab` and `Shift+Tab` are sent as
  `Option+Tab` and `Option+Shift+Tab`; each step records the key actually
  sent as `sentKey`.
- `voiceover` steps send a VoiceOver cursor command: `next`, `previous`,
  `nextHeading`, `nextLandmark`, `nextLink`, `act`, `interact`, or
  `stopInteracting`. `speechIncludes` works on these and on `press` steps.
- Before each command, Aloud waits until VoiceOver's last phrase has been
  unchanged for one second (at most five), so earlier speech does not land
  in the command's log. After navigation it records what VoiceOver said as
  the page loaded; no command is sent, unlike NVDA's `Control+Home`.
- Apple Events cannot see HTTP status, so a direct request from Node checks
  the URL first, and Safari's navigation timing is checked too when Safari
  reports a status.
- The structural snapshot is a DOM outline computed in the page
  (`safari-dom-outline`): roles, simple names, and common states. It is not
  Safari's accessibility tree.
- axe-core runs from the same pinned build that `@axe-core/playwright` uses,
  injected into the page. Frames are not injected.
- Safari's language comes from the system; a `web.locale` that differs fails
  the run. The window is sized so the page area matches `web.viewport`.
- The screenshot is `screencapture` of the window's screen rectangle and
  needs Screen Recording permission on the runner.
- Playwright storage state cannot be loaded, so `storageState` is refused.

Speech is labelled `voiceover-guidepup`, with the same limits as NVDA's
command logs: formatted by Guidepup, not audio, and silent windows prove
nothing. A timed-out command is never retried, and no further reader is
started in that process.

## Evidence and re-aggregation

The run writes `web-run.json`, per-state `*.web.json`, screenshots, a summary,
and a self-contained HTML page. `web-run.json` records the run's provenance
(commit, dirty state, machine, CI run, and the Playwright, axe-core,
Chromium or Safari, and NVDA or VoiceOver versions; see [how-it-works](how-it-works.md)), even for
a failed run, and the summary and HTML page state it. Before each final checkpoint it records a
Playwright ARIA snapshot; after axe and screenshot capture it checks that the
URL and ARIA snapshot still match. This detects exposed structural changes,
not every visual or layout change. Axe may examine content outside the
captured viewport. Frames and shadow content retain axe's own applicability
results; neither the snapshot nor successful execution proves all content
was examined.

The run inventory is written before capture. Failed runs preserve raw data
but produce no successful summary. Existing output is moved to a uniquely
named `web.previous-*` directory before another run. Review or remove these
archives when they are no longer needed.

```sh
npx aloud report --dir aloud-report/web
npx aloud openacr --report-web aloud-report/web
```

OpenACR also needs `app.name` and `app.version` in the config. It can combine
web evidence with `--report` (Android) and `--report-ios` inputs, keeping web
and software components separate. Every web criterion remains unevaluated.
Re-aggregation and OpenACR verify the run inventory, capture identities,
assertion results, raw axe structure, and artifact hashes. Missing, failed,
changed, or interrupted evidence cannot be promoted through a summary file.
`aloud report --gate` and `aloud baseline` reject web evidence.

## Validation and promotion

```sh
npm test
npx playwright install chromium
npm run test:web
```

The real Chromium suite exercises validation errors, dialog focus return,
live content, axe findings, empty pages, redirects, HTTP failures, failed
assertions, evidence regeneration, and conservative OpenACR output. The
separate unit suite exercises malformed artifacts and command-log handling.

Run `npm run test:web:voiceover` only through the **Experimental web
VoiceOver evidence** workflow (manual dispatch). It repeats the NVDA fixture
scenarios in Safari, plus VoiceOver cursor commands, and retains raw
artifacts. The unit suite `test/web-voiceover.test.mjs` covers the driver
and its wiring with fakes; it never starts Safari or VoiceOver.

Run `npm run test:web:nvda` on the prepared Windows desktop, or dispatch the
**Experimental web evidence** workflow with the NVDA input enabled. It repeats
form, dialog, live-region, duplicate-label, and long-output cases and retains
raw artifacts. Dispatched workflows also run the live TodoMVC React application
through task creation, completion, and keyboard filtering, twice per mode.
Run that external suite locally with `npm run test:web:external`, or set
`ALOUD_WEB_READER=nvda` on a prepared Windows desktop. Each checkpoint creates
its own task because this deployment resets its in-memory state on navigation.
The app is independently hosted and mutable; it is not a pinned golden baseline.
Browser gates need their own reviewed coverage policy, environment-specific
baselines, and negative fixtures before activation.

On 2026-09-20, all 288 device-free tests passed after integration with the latest
report-evidence validation on `main`. The Chromium CLI suite also passed using
Node 26.3.1, Darwin 25.5.0, Chromium 153.0.8010.12, Playwright 1.63.0, and axe-core
4.13.0. A clean packaged install was checked on 2026-09-18: mobile commands load
without the optional browser dependencies.

[Windows acceptance run 35528690779](https://github.com/IRS-Public/aloud/actions/runs/35528690779)
completed both fixture passes with Chromium 153.0.8010.12, Windows 10.0.26100,
Guidepup 0.34.0, and Guidepup's NVDA bundle `0.2.1-2026.2`. Both runs recorded
successful cleanup, verified artifact receipts, and passed every focus and
speech assertion. Review of the retained logs confirmed three distinct
`Repeat, button` entries and the entire long accessible name, including its
final verification phrase. The form error, returned dialog focus, and live
status announcement were captured in both runs.
Regenerating a report and OpenACR from the downloaded Windows artifacts also
passed: the OpenACR schema and catalog validators accepted the output, and all
87 web components remained `not-evaluated`.

[Combined acceptance run 35528852547](https://github.com/IRS-Public/aloud/actions/runs/35528852547)
passed the Windows fixtures again and the live
[TodoMVC React app](https://todomvc.com/examples/react/dist/) twice in each mode:
headless Chromium on Linux and headed Chromium with NVDA on Windows. Each
external run captured all three named states with verified receipts and
successful cleanup. NVDA returned the toggle-all label, `checked` after task
completion, and `Completed, link` during keyboard filtering. The suite retains
the app's actual axe findings (`heading-order`, `label`, and `region`); these
are findings in the target app, not failures of evidence capture.

The same external suite passed twice locally in structural mode. This validates
scripted interactions on a public sample application; authenticated apps,
frames, shadow content, and broader production application coverage remain
unvalidated. Neither the fixture nor external passes establish full traversal
or audible delivery. Raw CI captures, screenshots, and reports are retained in
the linked runs' artifacts for 14 days.
