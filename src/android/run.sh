#!/bin/bash
# aloud Android leg — orchestrates the full run against an attached Android
# emulator/device (see docs/how-it-works.md):
#
#   1. transcript pass: TalkBack ON, walk every screen in the manifest,
#      capture what TalkBack speaks (logcat)
#   2. tree pass: TalkBack OFF, walk again, uiautomator-dump + 508 rules +
#      evidence screenshots
#   3. aggregate report + ratchet gate vs the configured baseline
#
# Invoked by bin/aloud.mjs with:
#   ALOUD_CONFIG  absolute path to <out>/config.resolved.json (required)
#   ALOUD_HOME    absolute path to the aloud package root
# Flags: [--apk path] [--flow ids] [--port 8081] [--pass transcript|tree|both]
#        [--no-gate] [--skip-app-server]
#
# App-server note: in bridge nav mode, when nav.bridge.appServer.command is
# set, this script owns its app server child process and kills it on exit —
# pass --skip-app-server if you already have one running in a terminal.
set -euo pipefail

[ -n "${ALOUD_CONFIG:-}" ] || { echo "ALOUD_CONFIG is not set (run via: aloud android)"; exit 1; }
[ -f "$ALOUD_CONFIG" ] || { echo "ALOUD_CONFIG does not exist: $ALOUD_CONFIG"; exit 1; }
[ -n "${ALOUD_HOME:-}" ] || ALOUD_HOME="$(cd "$(dirname "$0")/../.." && pwd)"
export ALOUD_CONFIG ALOUD_HOME

# Read one value out of the resolved config (empty string when unset).
cfg() {
  node -p "const c=require(process.env.ALOUD_CONFIG);const v=(()=>{try{return $1}catch{return undefined}})();v==null?'':String(v)"
}

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ADB="$SDK/platform-tools/adb"
[ -x "$ADB" ] || ADB="$(command -v adb || true)"
[ -n "$ADB" ] || { echo "adb not found — set ANDROID_HOME"; exit 1; }
export ANDROID_HOME="$SDK"

OUT_ROOT="$(cfg 'c.out')"
[ -n "$OUT_ROOT" ] || { echo "resolved config has no out dir"; exit 1; }
ALOUD_OUT="$OUT_ROOT/android"
export ALOUD_OUT

PORT="$(cfg 'c.nav?.bridge?.port')"; [ -n "$PORT" ] || PORT=8081
APK="$(cfg 'c.app?.android?.apk')"
NAV_MODE="$(cfg 'c.nav?.mode')"; [ -n "$NAV_MODE" ] || NAV_MODE=current-screen
APP_SERVER_CMD="$(cfg 'c.nav?.bridge?.appServer?.command')"

FLOW=""; PASSES="transcript tree"; GATE="--gate"; SKIP_APP_SERVER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apk) APK="$2"; shift 2 ;;
    --flow) FLOW="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --pass)
      case "$2" in
        both) PASSES="transcript tree" ;;
        transcript) PASSES="transcript" ;;
        tree) PASSES="tree" ;;
        *) echo "unknown --pass $2 (use transcript|tree|both)"; exit 1 ;;
      esac
      shift 2 ;;
    --no-gate) GATE=""; shift ;;
    --skip-app-server) SKIP_APP_SERVER=1; shift ;;
    *) echo "unknown flag $1"; exit 1 ;;
  esac
done
# Capture tree/screenshot at the requested viewport before focus traversal scrolls it.
if [ "$(cfg 'c.android?.talkBack')" = "focus" ] && [ "$PASSES" = "transcript tree" ]; then
  PASSES="tree transcript"
fi
FLOW_ARGS=(); [ -n "$FLOW" ] && FLOW_ARGS=(--flow "$FLOW")
# Fresh report dir per run — stale per-screen reports from a previous run
# would pollute the gate, the evidence page, and baseline merges.
rm -rf "$ALOUD_OUT"
mkdir -p "$ALOUD_OUT"

echo "── device ──"
"$ADB" wait-for-device
"$ADB" shell getprop ro.build.version.release

if [ -n "$APK" ]; then
  echo "── install $APK ──"
  "$ADB" install -r "$APK"
  if [ "$NAV_MODE" = "current-screen" ]; then
    # An explicitly installed build needs opening before current-screen can
    # capture it. Runs without installation preserve the user's navigation.
    APP_PACKAGE="$(cfg 'c.app?.android?.package')"
    APP_ACTIVITY="$(cfg 'c.app?.android?.activity')"
    "$ADB" shell am start -n "$APP_PACKAGE/${APP_ACTIVITY:-.MainActivity}"
  fi
fi

STATE_FILE="$ALOUD_OUT/accessibility-state.json"
STATE_ARGS=(); [[ " $PASSES " == *" transcript "* ]] || STATE_ARGS=(--settings-only)
node "$ALOUD_HOME/src/android/talkback.mjs" snapshot "$STATE_FILE" ${STATE_ARGS[@]+"${STATE_ARGS[@]}"}
APP_SERVER_PID=""
cleanup() {
  local result=$?
  trap - EXIT
  if ! node "$ALOUD_HOME/src/android/talkback.mjs" restore "$STATE_FILE"; then
    echo "accessibility settings restoration failed; retain $STATE_FILE" >&2
    result=1
  else
    rm -f "$STATE_FILE"
  fi
  if [ -n "$APP_SERVER_PID" ]; then
    kill "$APP_SERVER_PID" 2>/dev/null || true
    wait "$APP_SERVER_PID" 2>/dev/null || true
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$NAV_MODE" = "bridge" ] && [ -n "$APP_SERVER_CMD" ] && [ "$SKIP_APP_SERVER" -eq 0 ]; then
  # Any HTTP response (even an error status) means something is listening.
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    echo "── app server already on :$PORT — reusing it ──"
  else
    echo "── starting app server on :$PORT (managed, killed on exit) ──"
    # nav.bridge.appServer.env from the config, as `export KEY="VALUE"` lines
    ENVFILE="$ALOUD_OUT/app-server.env"
    node -e "const e=(require(process.env.ALOUD_CONFIG).nav?.bridge?.appServer?.env)||{};for(const [k,v] of Object.entries(e))console.log('export '+k+'='+JSON.stringify(String(v)))" > "$ENVFILE"
    ( . "$ENVFILE"; exec bash -c "$APP_SERVER_CMD" ) > "$ALOUD_OUT/app-server.log" 2>&1 &
    APP_SERVER_PID=$!
    for _ in $(seq 1 60); do
      curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
      kill -0 "$APP_SERVER_PID" 2>/dev/null || { echo "app server died — see $ALOUD_OUT/app-server.log"; exit 1; }
      sleep 2
    done
  fi
fi

for PASS in $PASSES; do
  # ${FLOW_ARGS[@]+…} not "${FLOW_ARGS[@]}": expanding an EMPTY array under
  # set -u is fatal on macOS /bin/bash 3.2 (fixed only in bash 4.4).
  if [ "$PASS" = "transcript" ]; then
    echo "── transcript pass (TalkBack on) ──"
    # current-screen enables TalkBack inside its capture markers so the
    # initial announcement is retained. Other modes announce on navigation.
    if [ "$NAV_MODE" != "current-screen" ]; then
      node "$ALOUD_HOME/src/android/talkback.mjs" enable
    fi
    node "$ALOUD_HOME/src/android/walk.mjs" --pass transcript --port "$PORT" ${FLOW_ARGS[@]+"${FLOW_ARGS[@]}"}
    node "$ALOUD_HOME/src/android/talkback.mjs" disable
  else
    echo "── tree pass (TalkBack off) ──"
    node "$ALOUD_HOME/src/android/talkback.mjs" disable || true
    node "$ALOUD_HOME/src/android/walk.mjs" --pass tree --port "$PORT" ${FLOW_ARGS[@]+"${FLOW_ARGS[@]}"}
  fi
done

echo "── report ──"
node "$ALOUD_HOME/src/report/report.mjs" --dir "$ALOUD_OUT" $GATE
