// The zero-setup navigator: audit whatever screen the app is showing right
// now. It ignores the screens manifest and reports one synthetic screen.
// Works on any app with no dev bridge and no deep links.

export async function createNavigator(ctx) {
  const id = ctx.config?.nav?.screenId || "current";
  return {
    name: "current-screen",
    screens: [{ id, title: "Current screen" }],
    async start() {},
    async goto(_screen, hooks = {}) {
      // Nothing to navigate. Fire the marker hook so walker marker
      // placement matches the other modes.
      if (hooks.onBeforeFinalNav) hooks.onBeforeFinalNav();
    },
    async stop() {},
  };
}
