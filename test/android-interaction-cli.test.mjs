import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

test("interaction CLI validates the full scenario before touching adb", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aloud-interaction-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adb = join(dir, "adb"), marker = join(dir, "adb-called");
  writeFileSync(adb, '#!/bin/sh\ntouch "$ALOUD_TEST_ADB_MARKER"\nexit 99\n', { mode: 0o700 });
  const invalid = join(dir, "invalid.json");
  writeFileSync(invalid, JSON.stringify({ id: "radio", steps: [{ action: "first" }, { action: "tap" }] }));
  const cases = [
    [[], /--scenario and --package are required/],
    [["--scenario", invalid, "--package", "org.example", "--tts", "audible"], /--tts must be system or logging/],
    [["--scenario", invalid, "--package", "org.example"], /action|step|scenario/i],
    [["--scenaro", invalid], /Unknown option/],
  ];
  for (const [args, expected] of cases) {
    const result = spawnSync(process.execPath, ["bin/aloud.mjs", "android-interaction", ...args], {
      cwd: root, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, ADB_PATH: adb, ALOUD_TEST_ADB_MARKER: marker },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.equal(existsSync(marker), false, "invalid input must not dispatch an action");
  }
});

test("interaction example validates through the supported package export", async () => {
  const { validateInteractionScenario } = await import("@irs-public/aloud/android/interaction");
  const example = JSON.parse(readFileSync(join(root, "examples/android-radio-interaction.json"), "utf8"));
  assert.equal(validateInteractionScenario(example).id, example.id);
  assert.ok(example.steps.some((step) => step.action === "activate"));
  assert.ok(example.steps.some((step) => step.action === "previous"));
});
