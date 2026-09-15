#!/bin/bash
# Build the optional recording engine with the same JDK/Gradle/SDK as the companion.
set -euo pipefail
[ $# -eq 0 ] || { echo 'usage: aloud tts build'; exit 1; }
ROOT="$(cd "$(dirname "$0")" && pwd)"
CACHE="${ALOUD_CACHE:-.aloud-cache}"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?set ANDROID_HOME}}"
mkdir -p "$CACHE/tts-build/logging-tts" "$CACHE/tts-build/tts-shared"
cp "$ROOT/logging-tts/build.gradle" "$ROOT/logging-tts/settings.gradle" "$CACHE/tts-build/logging-tts/"
rm -rf "$CACHE/tts-build/logging-tts/src" "$CACHE/tts-build/tts-shared/src"
cp -R "$ROOT/logging-tts/src" "$CACHE/tts-build/logging-tts/src"
cp -R "$ROOT/tts-shared/src" "$CACHE/tts-build/tts-shared/src"
printf 'sdk.dir=%s\n' "$SDK" > "$CACHE/tts-build/logging-tts/local.properties"
gradle -p "$CACHE/tts-build/logging-tts" assembleDebug
cp "$CACHE/tts-build/logging-tts/build/outputs/apk/debug/AloudLoggingTts-debug.apk" "$CACHE/logging-tts.apk"
echo "Recording engine: $CACHE/logging-tts.apk (synthetic silence)"
