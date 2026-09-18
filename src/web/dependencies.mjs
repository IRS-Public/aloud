import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WEB_VERSIONS } from "./config.mjs";

const require = createRequire(import.meta.url);
export async function webDependency(name) {
  let version;
  try {
    // Some peers do not export package.json. Resolve their public entry and
    // find their own manifest without reaching through package exports.
    let dir = dirname(require.resolve(name));
    while (dirname(dir) !== dir) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === name) { version = pkg.version; break; }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      dir = dirname(dir);
    }
    if (!version) throw new Error("missing package manifest");
  }
  catch { throw new Error(`Web support needs ${name}. Install it with: npm install --save-dev ${name}@${WEB_VERSIONS[name]}`); }
  if (version !== WEB_VERSIONS[name]) throw new Error(`Experimental web capture requires ${name}@${WEB_VERSIONS[name]}; found ${version}`);
  return import(name);
}
