// Navigation adapter loader. Every mode lives in ./<mode>.mjs and exports
// one function: createNavigator(ctx) -> Navigator. The walkers pick the
// mode from the resolved config (nav.mode) and never import a mode module
// directly.

const MODES = ["current-screen", "deeplinks", "bridge"];

export async function loadNavigator(mode = "current-screen") {
  if (!MODES.includes(mode)) {
    throw new Error(`unknown nav mode "${mode}" (use ${MODES.join(" | ")})`);
  }
  const mod = await import(`./${mode}.mjs`);
  if (typeof mod.createNavigator !== "function") {
    throw new Error(`nav module "${mode}" does not export createNavigator`);
  }
  return mod.createNavigator;
}

// Flatten the grouped screens manifest into the ordered screen list a
// walker iterates. flowFilter is the --flow ids ([] = all flows).
export function flattenManifest(manifest, flowFilter = []) {
  if (!Array.isArray(manifest)) {
    throw new Error("screens manifest must be an array of flows ([{ id, title, screens: [...] }])");
  }
  const screens = [];
  for (const flow of manifest) {
    if (flowFilter.length && !flowFilter.includes(flow.id)) continue;
    for (const screen of flow.screens ?? []) screens.push(screen);
  }
  const seen = new Set();
  for (const screen of screens) {
    if (!screen.id) throw new Error("every screen in the manifest needs an id");
    if (seen.has(screen.id)) throw new Error(`duplicate screen id "${screen.id}" in the manifest`);
    seen.add(screen.id);
  }
  return screens;
}
