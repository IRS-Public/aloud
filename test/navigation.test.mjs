import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateConfig } from "../src/config.mjs";
import { segmentTranscript } from "../src/android/transcript.mjs";
import { createNavigator as currentScreen } from "../src/nav/current-screen.mjs";
import { createNavigator as deeplinks } from "../src/nav/deeplinks.mjs";
import { createNavigator as bridge } from "../src/nav/bridge.mjs";
import { flattenManifest } from "../src/nav/index.mjs";

const manifest = (id) => [{ id: "main", screens: [{ id, url: "example://home", route: "/home" }] }];
const config = (screenId) => ({ nav: { mode: "current-screen", screenId }, out: "aloud-report" });
const invalidIds = [
  "settings.notifications",
  "../outside",
  "",
  null,
  false,
  123,
  {},
  ["home"],
  ".",
  "/home",
  "flow/home",
  "flow\\home",
  "two words",
  "home:details",
  "café",
  "home\n",
  "_between",
  ...Object.getOwnPropertyNames(Object.prototype),
];

describe("screen IDs", () => {
  it("rejects unsupported IDs consistently before navigation", async () => {
    for (const id of invalidIds) {
      const label = JSON.stringify(id);
      assert.throws(() => flattenManifest(manifest(id)), /screen id/i, `manifest: ${label}`);
      assert.throws(() => validateConfig(config(id)), /screen.?id/i, `config: ${label}`);
      await assert.rejects(currentScreen({ config: config(id) }), /screen.?id/i, `current: ${label}`);
      await assert.rejects(deeplinks({ manifest: manifest(id) }), /screen id/i, `deeplinks: ${label}`);
      await assert.rejects(
        bridge({ manifest: manifest(id), config: { nav: { bridge: { hopRoutes: ["/home", "/other"] } } } }),
        /screen id/i,
        `bridge: ${label}`,
      );
    }
  });

  it("keeps supported IDs intact in TalkBack transcript markers", async () => {
    for (const id of ["current", "guest-home", "home_dark", "Settings2", "0", "_intro", "-details"]) {
      assert.equal(flattenManifest(manifest(id))[0].id, id);
      assert.doesNotThrow(() => validateConfig(config(id)));
      const nav = await currentScreen({ config: config(id) });
      assert.equal(nav.screens[0].id, id);
      const transcript = segmentTranscript([
        `I/A11Y_AUDIT: screen-start:${id}`,
        'V talkback: Speaking fragment text="Home", utteranceId=talkback_1, TtsSpan=null',
        `I/A11Y_AUDIT: screen-end:${id}`,
      ].join("\n"));
      assert.deepEqual(transcript[id], ["Home"]);
      assert.deepEqual(transcript._between, []);
    }
  });

  it("defaults an omitted current-screen ID and rejects a missing manifest ID", async () => {
    assert.doesNotThrow(() => validateConfig(config(undefined)));
    assert.equal((await currentScreen({})).screens[0].id, "current");
    assert.throws(() => flattenManifest(manifest(undefined)), /screen.*id/i);
  });

  it("still rejects duplicate IDs across selected flows", () => {
    const flows = [
      { id: "first", screens: [{ id: "home" }] },
      { id: "second", screens: [{ id: "home" }] },
    ];
    assert.throws(() => flattenManifest(flows), /duplicate screen id "home"/);
    assert.deepEqual(flattenManifest(flows, ["first"]), [{ id: "home" }]);
    flows[0].screens[0].id = "Home";
    assert.throws(() => flattenManifest(flows), /duplicate screen id "home"/);
  });
});
