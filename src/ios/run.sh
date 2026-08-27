#!/bin/bash
# aloud 508 audit, iOS leg — walk every screen in the manifest on an iOS
# simulator, compute the VoiceOver transcript per screen, run the iOS rules,
# and gate against the iOS baseline from the resolved config.
#
#   ALOUD_CONFIG=/abs/path/config.resolved.json ALOUD_HOME=/abs/path/to/aloud \
#     src/ios/run.sh [--app path/to/YourApp.app] [--flow ids] [--port 8081]
#                    [--no-gate] [--skip-app-server] [--screen-id id]
#
# Needs Xcode (simctl) and idb (brew install idb-companion + pip3 install
# fb-idb). In bridge nav mode with nav.bridge.appServer.command set, this
# script owns its app server child process and kills it on exit.
set -euo pipefail

: "${ALOUD_CONFIG:?ALOUD_CONFIG must point at config.resolved.json (bin/aloud.mjs sets it)}"
: "${ALOUD_HOME:?ALOUD_HOME must point at the aloud package root}"

command -v xcrun > /dev/null || { echo "xcrun not found — Xcode required"; exit 1; }
xcrun simctl help > /dev/null 2>&1 || { echo "simctl unavailable — install full Xcode, not just CLT"; exit 1; }
command -v idb > /dev/null || { echo "idb not found — brew install idb-companion && pip3 install fb-idb"; exit 1; }

# Read one value out of the resolved config (empty string when absent).
cfgget() {
  node -e "
    const c = JSON.parse(require('fs').readFileSync(process.env.ALOUD_CONFIG, 'utf8'));
    const v = ($1);
    if (v !== undefined && v !== null) process.stdout.write(String(v));
  "
}

ALOUD_OUT="$(cfgget 'c.out')"
[ -n "$ALOUD_OUT" ] || ALOUD_OUT="aloud-report"
IOS_OUT="$ALOUD_OUT/ios"

PORT="$(cfgget 'c.nav?.bridge?.port')"; [ -n "$PORT" ] || PORT=8081
APP="$(cfgget 'c.app?.ios?.app')"
NAV_MODE="$(cfgget 'c.nav?.mode')"; [ -n "$NAV_MODE" ] || NAV_MODE="current-screen"
BASELINE="$(cfgget 'c.baseline?.ios')"; [ -n "$BASELINE" ] || BASELINE="aloud-baseline-ios.json"
APP_SERVER_CMD="$(cfgget 'c.nav?.bridge?.appServer?.command')"

FLOW=""; GATE="--gate"; SKIP_APP_SERVER=0; SCREEN_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --flow) FLOW="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-gate) GATE=""; shift ;;
    --skip-app-server) SKIP_APP_SERVER=1; shift ;;
    --screen-id) SCREEN_ID="$2"; shift 2 ;;
    *) echo "unknown flag $1"; exit 1 ;;
  esac
done
# bash-3.2 (macOS default) treats an empty array as unset under `set -u`;
# the ${arr[@]+"${arr[@]}"} expansions below are the standard workaround.
FLOW_ARGS=(); [ -n "$FLOW" ] && FLOW_ARGS=(--flow "$FLOW")
SCREEN_ID_ARGS=(); [ -n "$SCREEN_ID" ] && SCREEN_ID_ARGS=(--screen-id "$SCREEN_ID")

# Fresh report dir per run — stale per-screen files from a previous run must
# not leak into this run's summary.
rm -rf "$IOS_OUT"
mkdir -p "$IOS_OUT"

echo "── simulator ──"
if ! xcrun simctl list devices booted | grep -q Booted; then
  UDID=$(xcrun simctl list devices available -j | python3 -c "
import json,sys
devs=[d for v in json.load(sys.stdin)['devices'].values() for d in v if 'iPhone' in d['name']]
print(devs[-1]['udid'] if devs else '')")
  [ -n "$UDID" ] || { echo "no available iPhone simulator"; exit 1; }
  echo "booting $UDID"
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID"
fi

if [ -n "$APP" ]; then
  echo "── install $APP ──"
  xcrun simctl install booted "$APP"
fi

# idb reads come back EMPTY unless the simulator's app-accessibility flag is
# on (idb docs: ApplicationAccessibilityEnabled in com.apple.Accessibility).
# Preempt rather than debug an all-silent audit.
xcrun simctl spawn booted defaults write com.apple.Accessibility ApplicationAccessibilityEnabled -bool true || true
xcrun simctl spawn booted defaults write com.apple.Accessibility AccessibilityEnabled -bool true || true

APP_SERVER_PID=""
cleanup() {
  if [ -n "$APP_SERVER_PID" ]; then
    kill "$APP_SERVER_PID" 2>/dev/null || true
    wait "$APP_SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# App server (bridge nav mode only): the dev bridge needs the app's JS
# served, e.g. Metro for React Native. This script owns the child and kills
# it on exit; --skip-app-server if you manage it yourself.
if [ "$NAV_MODE" = "bridge" ] && [ -n "$APP_SERVER_CMD" ] && [ "$SKIP_APP_SERVER" -eq 0 ]; then
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
    echo "── app server already on :$PORT — reusing it ──"
  else
    echo "── starting app server on :$PORT (managed, killed on exit) ──"
    # nav.bridge.appServer.env entries are exported into the child only.
    APP_SERVER_ENV=()
    while IFS= read -r kv || [ -n "$kv" ]; do
      [ -n "$kv" ] && APP_SERVER_ENV+=("$kv")
    done < <(cfgget "Object.entries(c.nav?.bridge?.appServer?.env ?? {}).map(([k,v])=>k+'='+v).join('\n')")
    env ${APP_SERVER_ENV[@]+"${APP_SERVER_ENV[@]}"} bash -c "$APP_SERVER_CMD" \
      > "$IOS_OUT/app-server.log" 2>&1 &
    APP_SERVER_PID=$!
    for _ in $(seq 1 60); do
      curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" && break
      kill -0 "$APP_SERVER_PID" 2>/dev/null || { echo "app server died — see $IOS_OUT/app-server.log"; exit 1; }
      sleep 2
    done
  fi
fi

echo "── walk (computed VoiceOver + tree checks) ──"
node "$ALOUD_HOME/src/ios/walk.mjs" --port "$PORT" --out "$IOS_OUT" \
  ${FLOW_ARGS[@]+"${FLOW_ARGS[@]}"} ${SCREEN_ID_ARGS[@]+"${SCREEN_ID_ARGS[@]}"}

echo "── report ──"
node "$ALOUD_HOME/src/report/report.mjs" --out "$IOS_OUT" \
  --baseline "$BASELINE" $GATE
