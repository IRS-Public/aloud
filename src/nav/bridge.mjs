// The dev-bridge navigator: drives the app over Metro's Hermes CDP proxy.
// The bridge talks to Metro's /json endpoint on the host, so the same code
// drives an iOS simulator or an Android emulator — whichever debug app is
// attached to Metro.
//
// The app must install three dev-only globals (names configurable via
// nav.bridge.globals, defaults shown):
//   __devNav(route)        navigate to a route
//   __devSignInAs(name)    switch to a named test persona
//   __devSignOut()         end the session
// These exist only in debug builds; nothing ships to production.

import { flattenManifest } from "./index.mjs";

// ── Hermes eval over the Metro-proxied CDP socket ──
// Resolves with the evaluated value (returnByValue) and REJECTS if the
// expression threw inside the app — a swallowed ReferenceError from a
// dev-bridge global that isn't installed yet reads as success and produces
// silent-garbage walks, so exceptions must be loud.
export async function hermesEval(expr, port = "8081") {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target =
    list.find((t) => /Experience|Hermes|main/i.test(t.title || "") && t.webSocketDebuggerUrl) ||
    list.find((t) => t.webSocketDebuggerUrl);
  if (!target) throw new Error("no Hermes inspector target — is the DEBUG app running on Metro?");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const value = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`eval timeout: ${expr}`)), 10000);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: expr, returnByValue: true },
        }),
      );
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.id === 1) {
        clearTimeout(timer);
        const details = msg.result?.exceptionDetails;
        if (details) {
          const text = details.exception?.description || details.text || "unknown exception";
          reject(new Error(`eval threw in app: ${expr} → ${text.split("\n")[0]}`));
        } else {
          resolve(msg.result?.result?.value);
        }
      }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  ws.close();
  return value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createNavigator(ctx) {
  const bridgeCfg = ctx.config?.nav?.bridge ?? {};
  const globals = {
    nav: "__devNav",
    signIn: "__devSignInAs",
    signOut: "__devSignOut",
    ...(bridgeCfg.globals ?? {}),
  };
  const port = String(bridgeCfg.port ?? "8081");
  const readyExpr = bridgeCfg.readyExpr || `typeof globalThis.${globals.nav} === 'function'`;

  if (!ctx.manifest) {
    throw new Error("bridge mode needs a screens manifest (nav.screens)");
  }
  const screens = flattenManifest(ctx.manifest, ctx.flowFilter);
  for (const screen of screens) {
    if (!screen.route) {
      throw new Error(`screen "${screen.id}" has no route — bridge mode needs one per screen`);
    }
  }

  const hopRoutes = bridgeCfg.hopRoutes;
  if (!Array.isArray(hopRoutes) || hopRoutes.length !== 2) {
    throw new Error(
      "bridge mode needs nav.bridge.hopRoutes: [routeA, routeB] — two tab routes the walker hops through between screens",
    );
  }
  const hopRoutesSignedOut =
    Array.isArray(bridgeCfg.hopRoutesSignedOut) && bridgeCfg.hopRoutesSignedOut.length === 2
      ? bridgeCfg.hopRoutesSignedOut
      : hopRoutes;

  const evalInApp = (expr) => hermesEval(expr, port);
  let persona; // undefined = unknown, null = signed out

  return {
    name: "bridge",
    screens,

    // The first bundle build on a cold Metro takes minutes in CI, and the
    // inspector target can register before the bundle has EXECUTED — so
    // proving the target exists isn't enough. Poll until the dev-bridge
    // globals are actually installed (they appear only after the app's
    // root layout mounts).
    async start(timeoutMs = 420_000) {
      const deadline = Date.now() + timeoutMs;
      let lastErr = "no Hermes inspector target";
      while (Date.now() < deadline) {
        try {
          if ((await evalInApp(readyExpr)) === true) {
            await sleep(4000);
            return;
          }
          lastErr = "app JS running but dev bridge not installed (is this a DEBUG build?)";
        } catch (err) {
          lastErr = err.message;
        }
        await sleep(2000);
      }
      throw new Error(
        `app never became drivable on :${port} after ${timeoutMs / 1000}s — ${lastErr}`,
      );
    },

    // Bring the screen up. Timing lives HERE for bridge mode (the walker
    // must not add its own settle sleeps): the sleeps below reproduce the
    // proven walk exactly. hooks.onBeforeFinalNav fires after the hop and
    // right before the final nav, so a transcript walker can place its
    // start marker there — speech from the hop lands OUTSIDE the marker
    // pair, speech from the target screen lands inside it.
    async goto(screen, hooks = {}) {
      if ("persona" in screen && screen.persona !== persona) {
        if (screen.persona === null) {
          await evalInApp(`${globals.signOut}()`);
          await sleep(3000);
        } else {
          await evalInApp(`${globals.signIn}('${screen.persona}')`);
          await sleep(6000);
        }
        persona = screen.persona;
      }
      // Route through a tab first so stacked sheets never bleed between
      // screens (navigate-to-tab dismisses them). The hop must be to a
      // DIFFERENT tab than the screen's own route: if the app is already
      // on the target, the post-marker navigation is a same-route no-op
      // that the screen reader never announces — the screen's speech
      // would land outside its markers.
      const targetRoute = screen.route;
      const pair = screen.persona === null ? hopRoutesSignedOut : hopRoutes;
      const hop = targetRoute === pair[0] ? pair[1] : pair[0];
      await evalInApp(`${globals.nav}('${hop}')`);
      await sleep(1200);
      if (hooks.onBeforeFinalNav) hooks.onBeforeFinalNav();
      await evalInApp(`${globals.nav}('${targetRoute}')`);
      await sleep(screen.settleMs ?? 2500);
      if (screen.eval) {
        await evalInApp(screen.eval);
        await sleep(screen.settleMs ?? 2500);
        // An eval that ends the session leaves the app signed out without
        // going through the persona block — forget the persona so the next
        // screen re-establishes it.
        if (screen.eval.includes("__devEndSession") || screen.eval.includes(globals.signOut)) {
          persona = undefined;
        }
      }
    },

    async stop() {},
  };
}
