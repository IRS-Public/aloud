# Android environment readiness

`aloud android-ready --out aloud-report/readiness` observes a booted Android device
without changing settings, launching apps, dismissing dialogs or restarting services.
It is intended for disposable CI emulators. Select a device with `ANDROID_SERIAL`
when more than one is attached. It does not run `uiautomator`, which can interrupt
TalkBack.

To check an already-open app, add `--target org.example.app`. The command reads
boot completion, the package manager, the current focused window and resumed
activity. Target mode also requires one target PID. Two observations at least one
second apart must agree on window, activity and PID. An app-owned dialog is allowed.
A current AOSP ANR/crash dialog is a specific obstruction. A different foreground
package is a target mismatch. Missing, unfamiliar or ambiguous output is unknown,
not a pass. Unsupported multi-display/user layouts may require manual inspection.

Exit 0 means only that these foreground conditions were observed. It does not
prove app responsiveness, absence of every overlay, successful TalkBack startup,
correct nodes, spoken output or accessibility conformance. The native companion's
window/session and speech checks remain required. A later window change can still
fail capture. The native focus/ATF walker runs this check before each capture.

`--timeout-ms 60000` is the default total budget (1–300 seconds), including failure
diagnostics. Every adb call has a timeout capped at three seconds and the remaining
budget, and output is capped at 4 MiB. Part of the budget is reserved for diagnostics.
An obstructing current ANR/crash dialog ends the wait early. No action repairs or
closes it. Exit 1 means not-ready or unknown; consult `readiness.json`.

The output includes each command, timeout, result, raw output path, timestamps and
parsed observations. Failed readiness also attempts an unmodified screenshot,
current window/process dumps and a bounded logcat tail. Diagnostic failures remain
visible and do not replace the readiness result. Logcat and process history are
context only: an old ANR cannot block a currently healthy window. The parser
excludes the complete stored `WINDOW MANAGER LAST ANR` section, through the next
current `WINDOW MANAGER POLICY STATE` heading. A truncated or unfamiliar boundary
is unknown. Resumed activity aliases must agree on their record and task IDs as
well as their component; two instances of one component are still ambiguous. The failure
screenshot is diagnostic evidence, not a verified target screenshot. Keep these
files private when running against anything other than synthetic fixture data.

## Verification

`node --test test/android-readiness.test.mjs` checks bounded calls, unknown output,
current versus historical ANRs, ownership, stable snapshots, diagnostic failures
and CLI errors without a device. These are synthetic parser/controller tests.

The Android companion acceptance workflow runs `node test/android-readiness-smoke.mjs`
after installing the public `org.irs_public.aloud.fixture` APK. It observes the
normal screen and app-owned dialog, then verifies that Android Settings cannot
pass as the fixture and retains a screenshot. No private app, sign-in, Metro server
or payment data is needed. The workflow uploads readiness evidence even on failure.
This smoke does not provoke a real System UI ANR; current-error parsing has unit
coverage and preserves the raw window record for inspection.
