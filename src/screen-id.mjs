// Screen IDs are used verbatim in report filenames, TalkBack markers, and
// plain-object report maps. Keep one contract for every navigation mode.
const RESERVED_IDS = new Set(["_between", ...Object.getOwnPropertyNames(Object.prototype)]);

export function validateScreenId(id, field = "screen id") {
  if (typeof id !== "string" || id.length === 0 || /[^A-Za-z0-9_-]/.test(id)) {
    throw new Error(`${field} must be a non-empty string containing only ASCII letters, digits, underscores, or hyphens`);
  }
  if (RESERVED_IDS.has(id)) {
    throw new Error(`${field} "${id}" is reserved — choose another screen id`);
  }
  return id;
}
