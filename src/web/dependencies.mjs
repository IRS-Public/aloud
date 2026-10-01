import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WEB_VERSIONS } from "./config.mjs";

const require = createRequire(import.meta.url);

// The directory and version of an installed package, found from its public
// entry. Some peers do not export package.json, so walk up to their own
// manifest instead of reaching through package exports.
function installed(name, resolver = require) {
  let dir = dirname(resolver.resolve(name));
  while (dirname(dir) !== dir) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === name) return { dir, version: pkg.version };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    dir = dirname(dir);
  }
  throw new Error("missing package manifest");
}

// An optional web peer at its pinned version. Missing or different versions
// throw with the install command.
function pinned(name) {
  let found;
  try { found = installed(name); }
  catch { throw new Error(`Web support needs ${name}. Install it with: npm install --save-dev ${name}@${WEB_VERSIONS[name]}`); }
  if (found.version !== WEB_VERSIONS[name]) throw new Error(`Experimental web capture requires ${name}@${WEB_VERSIONS[name]}; found ${found.version}`);
  return found;
}

export async function webDependency(name) {
  pinned(name);
  return import(name);
}

// The axe-core build that the pinned @axe-core/playwright adapter uses, as
// source text to inject into a browser that Playwright does not drive
// (Safari under VoiceOver). Resolved from the adapter's own dependencies,
// so both browsers run the same engine. The adapter itself is not loaded.
export function axeCoreSource() {
  const adapter = pinned("@axe-core/playwright");
  const fromAdapter = createRequire(join(adapter.dir, "package.json"));
  const engine = installed("axe-core", fromAdapter);
  return { version: engine.version, source: readFileSync(join(engine.dir, "axe.min.js"), "utf8") };
}
