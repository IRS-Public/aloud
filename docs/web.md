# Experimental web audits

`aloud web` captures named states in Chromium, runs axe-core, and writes an
HTML evidence page. Opt-in NVDA capture adds command output and interaction
assertions on a dedicated Windows desktop. This milestone is **report-only**:
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

NVDA is an experimental adapter awaiting a recorded Windows acceptance run.
Passing structural tests does not establish NVDA support. Use a dedicated
Windows test desktop. Aloud refuses to start if NVDA is already running, so
Guidepup cannot replace an everyday screen-reader session. Setup modifies the
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
desktop. macOS VoiceOver, Safari, Firefox, JAWS, and mobile browsers are not
part of this milestone.

## Evidence and re-aggregation

The run writes `web-run.json`, per-state `*.web.json`, screenshots, a summary,
and a self-contained HTML page. Before each final checkpoint it records a
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

Run `npm run test:web:nvda` on the prepared Windows desktop, or dispatch the
**Experimental web evidence** workflow with the NVDA input enabled. It repeats
form, dialog, live-region, duplicate-label, and long-output cases and retains
raw artifacts. A successful Windows fixture run and a separately documented
external web-app run are required before advertising validated NVDA coverage.
Browser gates need their own reviewed coverage policy, environment-specific
baselines, and negative fixtures before activation.

Local validation on 2026-09-18 passed the 253 device-free tests and the real
Chromium suite using Node 26.3.1, Darwin 25.5.0, Chromium 153.0.8010.12,
Playwright 1.63.0, and axe-core 4.13.0. The packaged CLI was also installed into
a clean temporary project: its mobile commands load without the optional
browser dependencies. These results do not validate the NVDA adapter or an
external production web app.
