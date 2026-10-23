// Device-free tests for the experimental VoiceOver runner setup. Every
// operating-system call is a fake: nothing here runs Guidepup, lists or
// stops processes, or changes a preference.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SETUP_UNAVAILABLE, setupRefusal } from "../src/web/voiceover-setup.mjs";

test("a setup failure names a machine no further attempt can help", () => {
  assert.equal(SETUP_UNAVAILABLE, "VOICEOVER_SETUP_UNAVAILABLE");
  assert.equal(setupRefusal("execution error: Not authorized to send Apple events to System Events. (-1743)"),
    "this machine refuses Apple events to System Events");
  assert.equal(setupRefusal("Error: Unable to stop VoiceOver"), "VoiceOver on this machine cannot be stopped");
  assert.equal(setupRefusal("VoiceOver remained active after disposable setup"), "VoiceOver on this machine cannot be stopped");
  assert.equal(setupRefusal("Failed to download Guidepup cache asset voiceover.zip (429 )"),
    "the release host rate-limited this machine's Guidepup download (HTTP 429)");
  assert.equal(setupRefusal("Failed to download Guidepup cache asset voiceover.zip (429)"),
    "the release host rate-limited this machine's Guidepup download (HTTP 429)");
  // Other failures may pass on another attempt.
  for (const output of ["Failed to enable Do Not Disturb", "Failed to download Guidepup cache asset (500)", "", undefined]) {
    assert.equal(setupRefusal(output), undefined);
  }
});
