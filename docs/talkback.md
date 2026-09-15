# The TalkBack toolchain

The Android transcript is real TalkBack speech, captured from TalkBack's
own log. That only works if the TalkBack build on the device logs its
utterances in a shape aloud can parse. So aloud pins the build.

For full traversal, opt into [TalkBack focus stepping](talkback-focus.md).
The default capture still records startup/navigation speech only.

## The pin

Google ships no prebuilt TalkBack APKs (the GitHub releases are
source-only). `aloud talkback get --build` clones
[google/talkback](https://github.com/google/talkback) and builds it at a
pinned commit:

```
229212fdf5842191d0a93fc95d9ca1423b346866   (TalkBack 16.2)
```

The pin lives in `src/android/get-talkback.sh` (`TALKBACK_COMMIT`, and the
env var overrides it). The build needs JDK 17, a system gradle >= 8.13 on
PATH, and NDK 21.4.7075529. CI caches the resulting APK keyed on the
commit, so the build runs about once per pin (see
[docs/ci.md](ci.md)).

`aloud talkback get --foss` instead downloads the signed
[talkback-foss](https://github.com/talkback-foss-team/talkback-foss) build.
It is fine for local spikes and needs no toolchain, but it is a much older
TalkBack.

## Why the pin matters

The transcript extractors in `src/android/transcript.mjs` were verified by
reading the TalkBack source at the pinned commit. At that commit,
`SpeechControllerImpl` logs each utterance at VERBOSE under the logcat tag
`talkback: SpeechControllerImpl`, in this shape:

```
Speaking fragment text="...", utteranceId=talkback_N, TtsSpan=..., locale=...
```

That log line is not a stable API. Google changes it between versions.
That is why `UTTERANCE_EXTRACTORS` holds three shapes, tried in order:

1. TalkBack 16.x (the pinned CI build): quoted `text="..."` with a
   `TtsSpan` field.
2. TalkBack ~14.x: `Speaking fragment text "..." with spans ...`. This is
   the shape the talkback-foss "latest" build (14.2) emits, observed live
   on an emulator.
3. Intermediate versions: quoted `text="..."` without the `TtsSpan` field.

**The rule: if you bump the pin, re-verify the extractors.** Read
`SpeechControllerImpl` at the new commit, confirm the log line shape, add
or adjust an extractor if it changed, and run the unit tests
(`test/android-checks.test.mjs` covers the extractors on fixture logs). A
silent shape change does not error; it produces empty transcripts.

## How aloud configures TalkBack

`aloud talkback enable` (implemented in `src/android/talkback.mjs`) was
also verified against the pinned source:

- TalkBack's prefs live in device-protected storage
  (`/data/user_de/0/<pkg>/shared_prefs/`). A running service never
  re-reads the file, so aloud force-stops TalkBack, writes the prefs, then
  enables the service, in that order.
- `pref_diagnosis_mode=true` forces VERBOSE speech logging regardless of
  the log-level pref, and survives version-migration resets. aloud sets
  both anyway.
- The first-run tutorial and onboarding flags are pre-answered, so no
  overlay covers the walk.
- The prefs write needs `adb root`. That works on `google_apis`
  (userdebug) emulator images only. Play-Store images refuse root and are
  not supported.
- TalkBack drops utterances before logging them if no text-to-speech
  engine ever initializes ("TTS is not ready" in logcat). `enable`
  health-checks that a TTS engine is installed.

## ARM-only native libs, and talkback-nolib.apk

The pinned source build ships native libs (used for braille support) for
`armeabi-v7a` and `arm64-v8a` only. On an x86_64 emulator, installing that
APK can fail with `INSTALL_FAILED_NO_MATCHING_ABIS`.

So `--build` also emits `talkback-nolib.apk` next to `talkback.apk` in the
cache dir: the same APK with `lib/` stripped, zipaligned, and re-signed
with the debug key. Braille display support dies; screen reading and
speech logging do not need it. On an x86_64 emulator, install the
fallback:

```bash
npx aloud talkback install .aloud-cache/talkback.apk \
  || npx aloud talkback install .aloud-cache/talkback-nolib.apk
```

The cache dir is `$ALOUD_CACHE` if set, else `.aloud-cache` under the
current directory.
