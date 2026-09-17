# Native ATF fixtures

Captured on an Android 14 userdebug emulator using the pinned companion and
Google's ATF 4.1.1 artifact. `atf-bad` deliberately triggers each of the six
selected checks; `atf-good` corrects the same controls. Both contain native
hint, state description, pane title, and role-description-extra values.

`capture.json` and `verify.json` are the exact native bytes before and after
the screenshot. `evidence.json` retains the transport receipts and process
identity; tests load the two raw files into their corresponding envelope fields.
The receipt hashes are unchanged. These are real framework outputs, including
its `NOT_RUN` applicability results, rather than hand-authored check outcomes.
