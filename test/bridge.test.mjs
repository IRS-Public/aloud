import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configuredAppId, selectHermesTarget } from "../src/nav/bridge.mjs";

const iosTarget = {
  title: "gov.example.ios (iPhone)",
  appId: "gov.example.ios",
  webSocketDebuggerUrl: "ws://localhost/ios",
};
const androidTarget = {
  title: "gov.example.android (Android emulator)",
  appId: "gov.example.android",
  webSocketDebuggerUrl: "ws://localhost/android",
};

describe("Metro bridge target selection", () => {
  it("selects the configured app when multiple platforms share Metro", () => {
    assert.equal(
      selectHermesTarget([iosTarget, androidTarget], "gov.example.android"),
      androidTarget,
    );
  });

  it("does not silently drive a different app when the configured app is absent", () => {
    assert.equal(selectHermesTarget([iosTarget], "gov.example.android"), undefined);
  });

  it("keeps the legacy first-target fallback when no app ID is configured", () => {
    assert.equal(selectHermesTarget([iosTarget, androidTarget]), iosTarget);
  });

  it("uses the package or bundle ID for the active audit platform", () => {
    const config = {
      app: {
        android: { package: "gov.example.android" },
        ios: { bundleId: "gov.example.ios" },
      },
    };
    assert.equal(configuredAppId({ platform: "android", config }), "gov.example.android");
    assert.equal(configuredAppId({ platform: "ios", config }), "gov.example.ios");
  });
});
