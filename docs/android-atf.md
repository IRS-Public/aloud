# Android native checks

Evidence contract for roadmap [#26](https://github.com/IRS-Public/aloud/issues/26).

## Run

Use an Android 14 userdebug emulator, JDK 17, Gradle 8.14.3, and Android SDK 36.
Rebuild the companion to include the ATF dependency and capture receiver:

```bash
aloud talkback get --build --companion --no-native
aloud talkback install .aloud-cache/talkback.apk
aloud android --atf --pass tree --no-gate
```

Configuration: `android.atf: true` (default false). The option requires a tree
pass; it also works with the normal two-pass run and `--talkback focus`. In ATF
mode the tree pass uses the running companion, so it does not call
`uiautomator`. The runner restores accessibility settings and TalkBack
preferences on success, failure, SIGINT, and SIGTERM. `--no-gate` is optional:
the existing tree-rule ratchet remains available, with no ATF finding counts
added to it. Native hints can resolve the XML-only approximation for empty
text fields, so review baseline decreases when switching capture sources.

The opt-in Android ATF mode captures the current active app window through the
pinned TalkBack companion. Google's Accessibility Test Framework (ATF) 4.1.1
builds an `AccessibilityHierarchyAndroid` from `AccessibilityNodeInfo`. Its
origin map connects each framework element to the exact node captured, including
virtual nodes. Resource IDs and labels alone are not element identities.

## Scope

The fixed `aloud-node-v1` suite contains `SpeakableTextPresentCheck`,
`EditableContentDescCheck`, `TouchTargetSizeCheck`, `DuplicateSpeakableTextCheck`,
`RedundantDescriptionCheck`, and `ClassNameCheck`. Each has a stable Aloud rule
ID and retains the upstream class, result ID, result type, message, and version.
These are report-only results. They do not add WCAG/OpenACR conformance coverage
or change the existing tree-rule ratchet.

Check execution and check applicability are distinct: a completed check can
emit `NOT_RUN` for some or all elements. Preserve those results and their reasons;
never label them as passes. Checks outside the suite are explicitly unselected.
The capture covers the exposed active-window snapshot, not offscreen content,
other app windows, visual contrast, or a complete focus traversal.

## Rich properties and integrity

Record the supported native hint, state description, pane title, and AndroidX
role-description extra. A supported-but-unset property is `null`; an unavailable
API is separately identified. Never infer those properties from text or class.
Their presence in the evidence does not imply every ATF check consumes them.

The native companion writes a private atomic JSON artifact. The shell-only
broadcast returns a receipt containing its request identity, length, and SHA-256.
The host retains the receipt and raw bytes before validating them. Check target
package/process/window, companion session/pin, snapshot identity, node graph,
check inventory, and result references. Incomplete, changed, stale, failed, or
missing capture cannot become a completed report on regeneration.

Both captures must have matching node data, window/process identities, and
the same app/window-change counter around the screenshot. Dynamic app content,
window changes, or notifications fail capture. Unrelated status-bar text and
focus-only window events are outside this node snapshot's scope. Raw files,
receipts, and failures are under `<out>/android/atf/`; interrupted runs retain
their request identity and export available native artifacts as incomplete.
The host stores the expected screen inventory before walking it, so a missing
screen cannot disappear during report regeneration.

Capture is bounded to 500 nodes, 50 levels, 65,536 characters per field, 5,000
results per check, and 8 MiB per native artifact. Native work checks a seven
second budget; the host times out each broadcast after 15 seconds. Bound
failures remain failed evidence. Private device artifacts are retained for
diagnosis; use a disposable emulator for repeated test runs.

The existing tree rules use an adapter of the same native snapshot in ATF mode.
Retain exact node IDs on their findings and show potentially overlapping ATF
findings without double-counting them in the gate. Supported native hints prevent
the XML-only missing-hint approximation from incorrectly labeling a hinted field.

## Release verification

Controlled Android fixtures must establish a positive and negative case for
each selected check, supported and unset rich properties, duplicate identity,
skipped results, target changes, missing/failed capture, and state restoration.
Persist authentic native evidence for report and tampering regression tests.
Run the complete native suite on a fresh Android 14 userdebug emulator before
marking the milestone ready.
