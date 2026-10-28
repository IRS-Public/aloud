import assert from "node:assert/strict";
import test from "node:test";
import { selectSimulator } from "../src/ios/simulator.mjs";
import { loadConfig } from "../src/config.mjs";

const a = { udid: "sim-a", name: "iPhone A", state: "Booted", isAvailable: true };
const b = { udid: "sim-b", name: "iPhone B", state: "Booted", isAvailable: true };
const list = (...devices) => ({ devices: { runtime: devices } });

test("ambiguous booted devices require explicit selection instead of array order", () => {
  assert.throws(() => selectSimulator(list(a, b)), /multiple.*--udid/);
  assert.throws(() => selectSimulator(list(b, a), { allowBoot: true }), /multiple.*--udid/);
  assert.equal(selectSimulator(list(a, b), { udid: b.udid }), b);
  assert.equal(selectSimulator(list(b, a), { udid: b.udid }), b);
  assert.equal(selectSimulator(list(a)), a);
});

test("an unavailable or stopped target never falls back to another prepared app", () => {
  assert.throws(() => selectSimulator(list(a), { udid: b.udid }), /unavailable/);
  assert.throws(() => selectSimulator(list(a, { ...b, isAvailable: false }), { udid: b.udid }), /unavailable/);
  assert.throws(() => selectSimulator(list(a, { ...b, state: "Shutdown" }), { udid: b.udid }), /not booted/);
  assert.throws(() => selectSimulator(list({ ...a, state: "Shutdown" })), /prepare.*current screen/);
});

test("booting is allowed only for an explicit install or reconstructable navigation", () => {
  const stopped = { ...b, state: "Shutdown" };
  assert.equal(selectSimulator(list(a, stopped), { udid: b.udid, allowBoot: true }), stopped);
  assert.equal(selectSimulator(list(stopped), { allowBoot: true }), stopped);
  assert.throws(() => selectSimulator(list(), { allowBoot: true }), /no available/);
});

test("simulator config rejects empty, malformed, and nonstring selectors", () => {
  for (const udid of ["", " ", " sim-a", 123, null, true]) {
    assert.throws(() => loadConfig(undefined, { ios: { udid } }), /ios.udid/);
  }
  assert.equal(loadConfig(undefined, { ios: { udid: a.udid } }).ios.udid, a.udid);
});
