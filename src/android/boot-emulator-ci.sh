#!/bin/bash
# Create and boot a headless Android emulator on a CI runner. Hand-rolled so
# it needs no third-party actions. Mirrors the AVD recipe the scripts in this
# directory expect: google_apis image (userdebug — adb root works, which
# talkback.mjs needs), no audio, no window.
set -euo pipefail

SDK="${ANDROID_HOME:?set ANDROID_HOME}"
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="$SDK/cmdline-tools/latest/bin/avdmanager"
IMAGE="system-images;android-34;google_apis;x86_64"

yes | "$SDKMANAGER" --licenses > /dev/null 2>&1 || true
"$SDKMANAGER" "platform-tools" "emulator" "$IMAGE" > /dev/null

# Pin the AVD directory for BOTH tools. Observed in CI: avdmanager exited 0
# but put the AVD where the emulator does not look — the emulator only
# searches $ANDROID_AVD_HOME, $ANDROID_SDK_HOME/avd and $HOME/.android/avd,
# while newer cmdline-tools avdmanager writes under $ANDROID_USER_HOME (XDG
# config dir on the runner) → "Unknown AVD name [aloud-ci]".
export ANDROID_AVD_HOME="$HOME/.android/avd"
mkdir -p "$ANDROID_AVD_HOME"

echo no | "$AVDMANAGER" create avd -n aloud-ci -k "$IMAGE" -d pixel_7 --force

if ! "$SDK/emulator/emulator" -list-avds 2>/dev/null | grep -qx "aloud-ci"; then
  echo "AVD aloud-ci was not created where the emulator can see it"
  echo "── ANDROID_AVD_HOME ($ANDROID_AVD_HOME) ──"; ls -la "$ANDROID_AVD_HOME" 2>&1 || true
  echo "── emulator -list-avds ──"; "$SDK/emulator/emulator" -list-avds 2>&1 || true
  exit 1
fi

EMU_LOG="${RUNNER_TEMP:-/tmp}/emulator.log"
ADB="$SDK/platform-tools/adb"

dump_diagnostics() {
  echo "── emulator diagnostics ──"
  ls -l /dev/kvm 2>&1 || echo "/dev/kvm missing"
  "$SDK/emulator/emulator" -accel-check 2>&1 || true
  echo "── adb devices ──"
  "$ADB" devices -l 2>&1 || true
  echo "── emulator.log (last 100 lines) ──"
  tail -100 "$EMU_LOG" 2>/dev/null || echo "no emulator.log"
}

ls -l /dev/kvm 2>&1 || echo "warning: /dev/kvm missing — boot will be slow or fail"

# -memory/-cores: CI runners have 7GB RAM shared with node + adb; do not let
# the device profile size the guest.
nohup "$SDK/emulator/emulator" -avd aloud-ci \
  -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -no-snapshot \
  -memory 2048 -cores 2 \
  > "$EMU_LOG" 2>&1 &
EMU_PID=$!

# Bounded wait — a bare `adb wait-for-device` blocks FOREVER if the emulator
# process dies at launch (observed in CI: one job sat in it for 88 minutes
# and ate the whole job budget). Poll instead, and fail loudly with the
# emulator log the moment the process is gone or the deadline passes.
booted=""
for i in $(seq 1 120); do
  if ! kill -0 "$EMU_PID" 2>/dev/null; then
    echo "emulator process died during startup"
    dump_diagnostics
    exit 1
  fi
  boot=$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') || true
  if [ "$boot" = "1" ]; then
    booted=1
    break
  fi
  [ $((i % 12)) -eq 0 ] && echo "still waiting for boot (${i}0s); emulator.log tail:" && tail -3 "$EMU_LOG" 2>/dev/null
  sleep 5
done
if [ -z "$booted" ]; then
  echo "emulator failed to boot within 10 minutes"
  dump_diagnostics
  exit 1
fi
echo "emulator booted"
