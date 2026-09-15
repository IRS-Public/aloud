# Android native checks

Evidence contract for roadmap [#26](https://github.com/IRS-Public/aloud/issues/26).

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
