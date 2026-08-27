// The deep-link navigator: every screen in the manifest carries a full
// deep link (myapp://...). goto() hands it to the walker's device shim:
//   android: adb shell am start -a android.intent.action.VIEW -d <url> <package>
//   ios:     xcrun simctl openurl <udid> <url>
// No app cooperation needed beyond registered deep links. No persona or
// eval support; those need the dev bridge (nav.mode: "bridge").

import { flattenManifest } from "./index.mjs";

export async function createNavigator(ctx) {
  if (!ctx.manifest) {
    throw new Error("deeplinks mode needs a screens manifest (nav.screens)");
  }
  const screens = flattenManifest(ctx.manifest, ctx.flowFilter);
  for (const screen of screens) {
    if (!screen.url) {
      throw new Error(`screen "${screen.id}" has no url — deeplinks mode needs one per screen`);
    }
    if (screen.persona !== undefined || screen.eval) {
      throw new Error(
        `screen "${screen.id}" uses persona/eval — those need bridge mode (nav.mode: "bridge")`,
      );
    }
  }
  return {
    name: "deeplinks",
    screens,
    async start() {},
    async goto(screen, hooks = {}) {
      if (hooks.onBeforeFinalNav) hooks.onBeforeFinalNav();
      ctx.device.openUrl(screen.url);
    },
    async stop() {},
  };
}
