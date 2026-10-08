# Changelog

All notable changes to `@irs-public/aloud`. Versions follow
[semantic versioning](https://semver.org/); while the version is 0.x, a
minor release may change output. Changes that can alter an existing
adopter's results are listed under "Behavior changes".

## 0.2.0 (unreleased)

aloud becomes a shared Section 508 evidence -> OpenACR engine: its own
native audits and other tools (such as the USWDS accessibility harness)
build drafts through one findings contract and one level policy.

### Behavior changes

- **A silent VoiceOver capture waits for late speech.** When a command's
  capture holds only the phrase its settle left, Guidepup's repeat of a
  capture that heard nothing, `voiceOverCommand` polls VoiceOver's last
  phrase for up to three seconds more and, once a new phrase arrives, until
  a quiet second, and returns the late speech alone. Such a command takes up
  to three seconds longer; a command whose capture has its own speech is
  unchanged. New exports `LATE_SPEECH_MS`, `isSilentCapture` and
  `awaitLateSpeech`.
- **WCAG 2.5.8 target size is checked at its 24-unit minimum.** New error
  rules `native-target-size-minimum` (24dp) and `ios-target-size-minimum`
  (24pt) carry 2.5.8 and apply the spacing exception.
  `native-touch-target-small` (48dp) and `ios-touch-target-small` (44pt)
  keep their ids but become report-only warnings with no criterion,
  labeled "Platform guideline". Old baselines still validate: each entry
  that lists a retired id drops it and one error per retired id, with a
  note (for example 5 errors across `native-interactive-unlabeled` and
  `native-touch-target-small` becomes 4 errors for
  `native-interactive-unlabeled`). That is what the old entry already
  allowed the remaining rules, so an unchanged app keeps passing. A new
  24-unit violation fails as a new rule id. Old tree reports that gated on a
  retired id leave 2.5.8 unchecked, so the gate fails that screen until it
  is re-run. The demo now fails on 1 error with 1 warning.
- **OpenACR draft wording changed.** Drafts are built by the shared
  builder: adherence notes open with the level policy's sentence;
  uncovered criteria say "Not evaluated: no finding covers this criterion
  for the Software component. Needs human review."; the failing-screen list
  comes last, and a note over 3000 characters ends with "(truncated; see
  evidence)" instead of being cut silently at 1500; the hardware chapter
  note reads "<app> is not a hardware product. Hardware criteria do not
  apply."; the default untested note says no automated test establishes
  whether the criterion is met. Notes also state provenance and any
  accepted baseline reasons.
- **Native drafts no longer claim "supports".** A criterion aloud's
  error rules map to (1.1.1, 1.3.1, 2.5.8, 4.1.2) with clean, complete
  tree checks is `partly-tested` (`not-evaluated`) instead of `met`
  (`supports`): the rules check part of each criterion only, so a person
  must review the rest. A criterion only one platform's rules check
  (1.3.1, Android-only) is `incomplete` for the single software component
  when an iOS audit is also supplied. Failures still read as
  `partially-supports`.
- **Rule mapping.** `native-image-button-unlabeled` and
  `native-edittext-unlabeled` declare the 1.1.1 and 1.3.1 criteria they
  already drove; the duplicate-label warnings declare 2.4.6. Findings gain
  a `criteria` array beside `wcag`. Rule ids are unchanged.
- **Strict flags in the internal scripts.** The walkers, report, baseline,
  web capture, and demo scripts stop on an unknown, value-less, or
  repeated flag instead of ignoring it.
- **iOS report dirs are named "ios" or "*-ios".** Run directly,
  `src/report/report.mjs` and `src/report/baseline.mjs` used to count any
  path ending in "ios" as iOS; they now share the `aloud` CLI's rule, so
  "radios" or "myios" is Android. When they would take the baseline from
  `ALOUD_CONFIG` for a dir whose name ends in a separate word "ios" in any
  case ("out/app_ios", "app.ios", "build/iOS"), they stop and ask for
  `--baseline <file>` rather than gate iOS evidence against the Android
  baseline. Rename such a dir (for example to "app-ios") or pass
  `--baseline`. The `aloud` CLI always passes `--baseline` and is
  unaffected.
- **`node src/report/openacr.mjs` no longer runs a command.** Use
  `aloud openacr`. The module exports the same names, but two changed
  contents: `RULES` and `AUTOMATED_CRITERIA` are now frozen views of the
  rule catalog, so adding or changing a key throws in strict mode.
  `RULES` lists the error rules only, so `native-touch-target-small` and
  `ios-touch-target-small` are gone (reading `.what` on them throws) and
  `native-target-size-minimum` and `ios-target-size-minimum` are new; each
  entry gains `severity` and `criteria` beside `platform` and `what`.
  In `AUTOMATED_CRITERIA`, 2.5.8 now lists the two target-size-minimum
  rules and checks the 24-unit minimum, every `covers` text is reworded,
  and 4.1.2 gains an `extra` field naming related report-only warnings.
- **`aloud openacr --catalog`** must keep the bundled catalog's chapters
  and criteria, since the draft names that catalog.
- **Mixed evidence is refused.** Reports, baselines, and drafts refuse to
  combine evidence from different commits unless `--allow-mixed` is passed.
- **Impossible dates are rejected** (`--date 2026-02-31`).
- **Package exports.** `package.json` now has an `exports` map (see
  Packaging). Every file path under `src/` and `bin/`, and
  `examples/*.json`, still resolves; other files in the package can no
  longer be imported by path.

### Added

- **`standard-interpretation` finding status.** A passing status for a
  criterion the standard's own published interpretation says is always
  satisfied for the content: WCAG 2.0 and 2.1's 4.1.1 Parsing on HTML,
  per the W3C errata. It maps to `supports` with a note that says the
  level rests on the interpretation, not a test; the finding must cite the
  interpretation in its `notes`, and like every passing status it may list
  no known issues (a markup defect that breaks a relationship, a name, or
  a state belongs to 1.3.1 or 4.1.2).
- **Shared OpenACR engine** (`src/acr/`): a findings contract
  (`src/acr/findings.schema.json`, `validateFindings`), a status
  vocabulary and conservative level policy (`src/acr/levels.mjs`; only
  passing evidence reaches "supports", and no override can make a failure
  or unproven evidence read as a pass, and a passing finding must name the
  evidence, covers text, or notes it rests on), and `buildAcr`/`validateAcr`, which
  emit every catalog criterion for every component and check the result
  against the `@openacr/openacr` schema and catalog.
- **`aloud acr --findings <file.json>`** builds a draft from any findings
  document, with `--out`, `--policy`, `--catalog`, `--date`, and
  `--step-summary <file>` (append a Markdown count of conformance levels).
  `aloud openacr` now builds its drafts through the same engine. Both
  commands create missing `--out` parent directories once the draft is
  valid.
- **GitHub Action** (`action.yml`, "aloud acr"): runs `aloud acr` in any
  repository with Node 24, outputs the draft's path, and adds the level
  count to the job summary. See docs/ci.md.
- **One rule catalog** (`src/rules/catalog.mjs`) for every tree rule's
  platform, severity, WCAG criteria, and "covers" text. The rule engines
  and the draft read it, and a traceability test keeps them in step.
- **Accepted baseline reasons**: baseline entries may record why an error
  is accepted (`product-bug`, `platform-gap`, `accepted-risk`), with
  `aloud baseline --accept <screen>:<ruleId> --kind --summary [--issue]`.
  `--prune` drops screens a run did not cover. Reasons appear in the
  evidence page and as issues in the draft.
- **Provenance** on every evidence file: app commit and dirty state,
  aloud version and commit, machine, Node.js, CI run, and tool versions,
  stated in reports and drafts.
- **Experimental Safari + VoiceOver web driver**
  (`aloud web --screen-reader voiceover`, `src/web/voiceover.mjs`,
  `src/web/safari.mjs`), parallel to the NVDA driver. It runs only on a
  disposable GitHub-hosted macOS runner that opts in, and has not yet
  passed a hosted run. `dependencies.mjs` gains `axeCoreSource`. The driver
  carries the USWDS harness's failure context (`captureContext`: the
  command, the speech its settle discarded, the cursor item), types a lone
  punctuation character through the reader, can tell VoiceOver to pass the
  next key to Safari (`voiceOverPassNextKey`), lets a settle run an action
  inside its capture, and stops startup at once on a machine that refuses
  Apple events (`hostRefusal`).
- One shared report-platform helper and shared rule-engine helpers, so
  every entry point agrees on android, ios, or web.
- **Documentation for the findings engine.** [docs/openacr.md](docs/openacr.md)
  covers the findings contract field by field, the status vocabulary, the
  default policy and its rationale, overrides, the never-a-silent-pass
  guarantees, and a checklist for finishing a draft.
  [docs/harness-integration.md](docs/harness-integration.md) maps the USWDS
  accessibility harness's report onto findings, with a tested adapter
  (`examples/harness-to-findings.example.mjs`) and a release workflow.
  `examples/findings.example.json` uses every field and status; tests keep
  the examples, the docs' tables, and every relative link in step.

### Packaging

- Version 0.2.0.
- `exports`: `@irs-public/aloud` (the OpenACR engine, `src/index.mjs`),
  `/acr`, `/findings.schema.json`, `/rules`, `/web/nvda`,
  `/web/voiceover`, `/web/dependencies`, `/package.json`, and the
  pre-0.2.0 `src/*`, `bin/*`, and `examples/*.json` paths.
  `src/web/nvda.mjs` and `src/web/dependencies.mjs` keep their paths and
  exports.
- `files` adds `action.yml` and `CHANGELOG.md`, and names the findings
  schema.

## 0.1.0

The first version: TalkBack and VoiceOver mobile audits, tree rules with a
ratchet baseline, the evidence page, experimental Chromium and NVDA web
evidence, and a draft OpenACR.
