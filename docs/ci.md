# Running aloud in CI

CI is optional. aloud is standalone-first: point it at a build on your
machine and read the report. Put it in CI when you want the audit and the
ratchet gate to run without you.

Two adopter templates live in [`examples/ci/`](../examples/ci/):

- [`android-audit.yml`](../examples/ci/android-audit.yml): headless
  emulator with KVM, TalkBack built once and cached, both audit passes,
  evidence page uploaded as an artifact.
- [`ios-audit.yml`](../examples/ci/ios-audit.yml): macOS runner,
  simulator, `idb` from a pinned tarball, computed VoiceOver audit,
  evidence page uploaded.

Copy one into your app repo under `.github/workflows/`, fill in the
marked "replace with your app's build" blocks, and commit an
`aloud.config.json`. Both templates use GitHub-owned actions only, so they
work on orgs with a strict action allowlist.

The rest of this page is the list of runner facts the templates encode.
Each one cost a broken run to learn. Keep them if you edit the templates.

## Schedule triggers only fire from the default branch

A `schedule:` cron in a workflow that exists only on a feature branch
never runs. GitHub reads the cron from the default branch. While you
develop the workflow, trigger it with `workflow_dispatch`; the nightly
starts working when the file lands on the default branch.

## Cap Gradle memory in ~/.gradle/gradle.properties

`~/.gradle/gradle.properties` outranks every project
`gradle.properties`. That is the point: TalkBack's own
`gradle.properties` demands `-Xmx8G`, and a standard Linux runner has 7GB
of RAM. Without the cap, the TalkBack build JVM plus your app build's
leftover Gradle daemon plus a Kotlin compile daemon stack up and the OOM
killer takes the runner down mid-job. The template writes:

```
org.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=512m
org.gradle.daemon=false
org.gradle.parallel=true
org.gradle.workers.max=2
kotlin.daemon.jvmargs=-Xmx1536m
```

No daemons may outlive a build step. This caps both your app build and
the TalkBack source build with one file.

## Save caches even on failure

A plain `actions/cache` step saves in a post-job hook. If a later step
OOMs the runner, that hook never runs, and the next attempt starts cold
again. The templates split `actions/cache/restore` and
`actions/cache/save`, and save immediately after the expensive step:

- The TalkBack APK cache (keyed on the pinned commit) is saved right
  after the source build. The cold build takes about 50 minutes; with the
  cache, reruns skip it entirely.
- The Gradle cache is saved right after the app build.

Front-load the risky expensive step (the TalkBack build) before the app
build, so its cache is banked as early as possible.

## Pin ANDROID_AVD_HOME

Newer `cmdline-tools` `avdmanager` writes AVDs under `ANDROID_USER_HOME`
(an XDG config dir on the runner). The emulator does not look there; it
searches `$ANDROID_AVD_HOME`, `$ANDROID_SDK_HOME/avd`, and
`$HOME/.android/avd`. The result is an `avdmanager` that exits 0 followed
by `Unknown AVD name`. `src/android/boot-emulator-ci.sh` exports
`ANDROID_AVD_HOME="$HOME/.android/avd"` before creating the AVD, and then
verifies the emulator can list it.

The same script also bounds the boot wait. A bare `adb wait-for-device`
blocks forever if the emulator process dies at launch; the script polls
`sys.boot_completed`, fails loudly with the emulator log, and gives up
after 10 minutes.

## Add platform-tools to GITHUB_PATH

Each workflow step gets a fresh shell. Exporting PATH inside the
emulator-boot step does not help the audit step that calls bare `adb`.
After booting, append the SDK's platform-tools to `GITHUB_PATH` so every
later step keeps `adb`:

```bash
echo "$ANDROID_HOME/platform-tools" >> "$GITHUB_PATH"
```

## Other facts the templates encode

- **Free disk first.** The TalkBack build (with NDK r21), the emulator
  image, and your app build do not fit next to the runner's preinstalled
  toolchains. The template deletes the big unused ones, and uninstalls
  the NDK again right after the TalkBack build.
- **KVM needs a udev rule.** Ubuntu runners have `/dev/kvm`, but not
  world-usable by default. Without it the emulator falls back to software
  emulation and the boot can eat the job budget.
- **google_apis image, not Play Store.** `aloud talkback enable` writes
  TalkBack's prefs with `adb root`, which Play-Store images refuse. See
  [docs/talkback.md](talkback.md).
- **ARM-only TalkBack libs.** On the x86_64 emulator, install the
  emitted `talkback-nolib.apk` fallback when the main APK fails with
  `NO_MATCHING_ABIS`. See [docs/talkback.md](talkback.md).
- **idb from the pinned tarball.** The brew formula breaks on runner
  image updates. See [docs/ios.md](ios.md).
- **Keep the gate advisory at first.** Both templates run
  `npx aloud report --dir ... --gate` with `continue-on-error: true`.
  While the baselines burn in, you want the evidence without red builds.
  Once transcripts and counts are stable, drop `continue-on-error` and
  let the ratchet gate fail the job.
- **macOS minutes are expensive.** They bill about 10x Linux minutes.
  Run the iOS leg nightly and on manual dispatch, not per PR.
