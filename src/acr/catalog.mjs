// Load an OpenACR catalog and index it for lookups. The catalog lists every
// chapter, criterion, component, and conformance term a report built
// against it may use; findings are checked against it, and the builder
// emits every criterion it lists.
//
// Catalogs resolve inside aloud's own install of @openacr/openacr, not the
// caller's project, so the catalog always matches the validator.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { load } from "js-yaml";

// WCAG 2.2 is the edition aloud's own rules need (2.5.8 exists only there).
export const DEFAULT_CATALOG_ID = "2.5-edition-wcag-2.2-508-en";

const require = createRequire(import.meta.url);
const OPENACR_DIR = dirname(require.resolve("@openacr/openacr/package.json"));
// The validators ship as CJS with no type declarations.
const { validateCatalog } = require("@openacr/openacr/dist/validateCatalog.js");

// Catalog ids are file names in @openacr/openacr/catalog; the pattern keeps
// an id from reaching outside that directory.
const CATALOG_ID = /^[a-z0-9][a-z0-9.-]*$/;

export function catalogPath(id = DEFAULT_CATALOG_ID) {
  if (typeof id !== "string" || !CATALOG_ID.test(id)) {
    throw new Error(`invalid catalog id ${JSON.stringify(id)}`);
  }
  return join(OPENACR_DIR, "catalog", `${id}.yaml`);
}

// Read a catalog by id (from @openacr/openacr) or from an explicit YAML
// path, and check it against the OpenACR catalog schema. Throws when the
// catalog does not exist or is not a valid catalog.
export function loadCatalog({ id = DEFAULT_CATALOG_ID, path } = {}) {
  const file = path ?? catalogPath(id);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      path
        ? `catalog file not found: ${path}`
        : `unknown catalog "${id}": no such catalog in @openacr/openacr/catalog`,
    );
  }
  const catalog = load(text);
  checkCatalog(catalog, path ?? id);
  return catalog;
}

// A caller may pass a catalog object it loaded itself; check it the same way.
export function checkCatalog(catalog, name = "catalog") {
  const result = validateCatalog(catalog, "openacr-catalog-0.1.0.json");
  if (!result.result) throw new Error(`invalid OpenACR catalog (${name}): ${result.message}`);
  return catalog;
}

// Lookups the validator and builder need, computed once per catalog object:
//   criteria    criterion id -> { id, handle, chapter, components }
//   chapters    chapter id -> catalog chapter
//   components  product component ids ("none" excluded: it is the
//               placeholder the catalog uses for criteria with no component)
//   terms       conformance level ids
const indexes = new WeakMap();

export function indexCatalog(catalog) {
  if (indexes.has(catalog)) return indexes.get(catalog);
  const criteria = new Map();
  const chapters = new Map();
  for (const chapter of catalog.chapters) {
    chapters.set(chapter.id, chapter);
    for (const criterion of chapter.criteria ?? []) {
      if (criteria.has(criterion.id)) {
        throw new Error(`invalid OpenACR catalog: criterion ${criterion.id} appears in more than one chapter`);
      }
      criteria.set(criterion.id, {
        id: criterion.id,
        handle: criterion.handle,
        chapter: chapter.id,
        components: criterion.components ?? [],
      });
    }
  }
  const index = {
    criteria,
    chapters,
    components: (catalog.components ?? []).map((c) => c.id).filter((id) => id !== "none"),
    componentLabels: new Map((catalog.components ?? []).map((c) => [c.id, c.label || c.id])),
    terms: (catalog.terms ?? []).map((t) => t.id),
  };
  indexes.set(catalog, index);
  return index;
}

// True when the catalog gives a criterion no product component, only the
// "none" placeholder: the Section 508 chapters (302.1, 502.2.1, ...).
export const hasNoComponents = (entry) =>
  entry.components.length === 0 || entry.components.every((c) => c === "none");
