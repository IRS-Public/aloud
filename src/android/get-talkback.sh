#!/bin/bash
# Produce <cache>/talkback.apk for the aloud audit rig. The cache dir is
# $ALOUD_CACHE if set, else .aloud-cache under the current directory.
#
#   aloud talkback get --foss    # download talkback-foss
#   aloud talkback get --build   # build google/talkback @ pin
#
# Google publishes NO prebuilt TalkBack APKs (github releases are source-only,
# verified Aug 2026), so:
# - --foss grabs the signed talkback-foss build (TalkBack 14.2, de-GMSed) —
#   fine for local spikes, stale for CI.
# - --build clones google/talkback at TALKBACK_COMMIT and runs its build
#   (AGP 8.11.1 → needs gradle ≥8.13 on PATH, JDK 17, NDK 21.4.7075529).
#   CI caches the result keyed on the commit, so this runs ~once per pin.
#
# The pin matters: the transcript extractors in src/android/transcript.mjs
# are verified against this exact TalkBack source. If you bump the pin,
# re-verify the extractors (see docs/talkback.md).
#
# The pinned source builds only armeabi-v7a/arm64-v8a native libs (braille).
# On an x86_64 emulator that can make `adb install` fail with
# NO_MATCHING_ABIS, so --build also emits talkback-nolib.apk — same APK with
# lib/ stripped and debug-resigned. Braille display support dies; screen
# reading and speech logging don't need it.
set -euo pipefail

CACHE="${ALOUD_CACHE:-.aloud-cache}"
mkdir -p "$CACHE"
COMPANION=0; NO_NATIVE=0
for flag in "$@"; do
  case "$flag" in
    --companion) COMPANION=1 ;;
    --no-native) NO_NATIVE=1 ;;
    --build|--foss) ;;
    *) echo "unknown flag: $flag"; exit 1 ;;
  esac
done
if [ "$NO_NATIVE" -eq 1 ] && [ "$COMPANION" -ne 1 ]; then
  echo "--no-native requires --companion (emulator-only build)"; exit 1
fi
if [ "$COMPANION" -eq 1 ] && [ "${1:-}" != "--build" ]; then
  echo "--companion requires --build"; exit 1
fi

TALKBACK_COMMIT="${TALKBACK_COMMIT:-229212fdf5842191d0a93fc95d9ca1423b346866}"

case "${1:---foss}" in
  --foss)
    URL=$(curl -fsSL https://api.github.com/repos/talkback-foss-team/talkback-foss/releases/latest \
      | grep -o 'https://[^"]*phone-release[^"]*\.apk' | head -1)
    [ -n "$URL" ] || { echo "could not resolve talkback-foss APK url"; exit 1; }
    echo "downloading $URL"
    curl -fSL -o "$CACHE/talkback.apk" "$URL"
    ;;
  --build)
    SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?set ANDROID_HOME}}"
    yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null || true
    "$SDK/cmdline-tools/latest/bin/sdkmanager" "platforms;android-36" > /dev/null
    if [ "$NO_NATIVE" -eq 0 ]; then "$SDK/cmdline-tools/latest/bin/sdkmanager" "ndk;21.4.7075529" > /dev/null; fi
    rm -rf "$CACHE/talkback-src"
    git clone https://github.com/google/talkback.git "$CACHE/talkback-src"
    git -C "$CACHE/talkback-src" checkout "$TALKBACK_COMMIT"
    if [ "$COMPANION" -eq 1 ]; then
      [ "$TALKBACK_COMMIT" = "229212fdf5842191d0a93fc95d9ca1423b346866" ] || { echo "companion requires its verified TalkBack pin"; exit 1; }
      PATCH_ARGS=(); [ "$NO_NATIVE" -eq 0 ] || PATCH_ARGS=(--no-native)
      node "$(dirname "$0")/talkback-companion/patch.mjs" "$CACHE/talkback-src" ${PATCH_ARGS[@]+"${PATCH_ARGS[@]}"}
    fi
    # build.sh wants ANDROID_SDK and a system gradle; it runs assembleDebug
    if [ "$COMPANION" -eq 1 ]; then
      printf 'sdk.dir=%s\n' "$SDK" > "$CACHE/talkback-src/local.properties"
      ( cd "$CACHE/talkback-src" && gradle assemblePhoneDebug )
    else
      ( cd "$CACHE/talkback-src" && ANDROID_SDK="$SDK" bash build.sh )
    fi
    APK=$(find "$CACHE/talkback-src/build/outputs/apk" -name "*phone-debug*.apk" | head -1)
    [ -n "$APK" ] || { echo "build produced no phone-debug apk"; exit 1; }
    cp "$APK" "$CACHE/talkback.apk"
    node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({talkbackCommit:process.argv[2],companion:process.argv[3]==="1",nativeLibraries:process.argv[4]==="0"},null,2))' "$CACHE/build.json" "$TALKBACK_COMMIT" "$COMPANION" "$NO_NATIVE"

    # lib-stripped fallback for x86_64 emulators (see header)
    # newest installed build-tools, installing 35.0.0 only if none exist
    BT=$(ls -d "$SDK/build-tools"/*/ 2>/dev/null | sort -V | tail -1)
    if [ -z "$BT" ]; then
      "$SDK/cmdline-tools/latest/bin/sdkmanager" "build-tools;35.0.0" > /dev/null
      BT="$SDK/build-tools/35.0.0"
    fi
    BT="${BT%/}"
    cp "$CACHE/talkback.apk" "$CACHE/talkback-nolib-unsigned.apk"
    zip -q -d "$CACHE/talkback-nolib-unsigned.apk" "lib/*" || true
    KS="$HOME/.android/debug.keystore"
    if [ ! -f "$KS" ]; then
      mkdir -p "$(dirname "$KS")"
      keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
        -alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US" \
        -keyalg RSA -keysize 2048 -validity 10000
    fi
    "$BT/zipalign" -f 4 "$CACHE/talkback-nolib-unsigned.apk" "$CACHE/talkback-nolib.apk"
    "$BT/apksigner" sign --ks "$KS" --ks-pass pass:android "$CACHE/talkback-nolib.apk"
    rm -f "$CACHE/talkback-nolib-unsigned.apk"
    rm -rf "$CACHE/talkback-src"
    ;;
  *)
    echo "usage: get-talkback.sh [--foss|--build]"; exit 1 ;;
esac

ls -la "$CACHE"/talkback*.apk
