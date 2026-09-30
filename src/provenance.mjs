// Where a piece of evidence came from: the code under test, the aloud that
// checked it, the machine and runtime, the CI run, and the tool versions.
// Every evidence file aloud writes (per-screen tree and transcript reports,
// web-run.json) carries one of these records under `provenance`; report.mjs
// copies it into summary.json, and the OpenACR drafts state it in their
// notes. The shape follows the USWDS accessibility harness's evidence.json
// provenance, so both evidence sources say the same things the same way:
//
//   {
//     schemaVersion: 1,
//     commit: "<40 hex>" | null,         the audited app's repo at cwd
//     workingTreeDirty: true | false | null,
//     platform: "darwin", arch: "arm64", osRelease: "25.6.0", node: "v22.12.0",
//     aloud: { version: "0.1.0", commit: "<40 hex>" | null, workingTreeDirty: ... },
//     github: { server, repository, runId, runAttempt, runUrl } | null,
//     tools: { "talkback": "<commit>", "xcode": "Xcode 27.0 Build version 18A1", ... },
//   }
//
// null means "not known", never "clean": git may be missing, the app may
// not be a git checkout, or aloud may be installed from npm. Collecting
// provenance never throws for any of those.
//
// The pure parts (githubRun, formatProvenance, validation, combining) are
// split from the IO (collectProvenance, which runs git and tool probes
// through an injectable exec), so tests can drive them with a fake
// environment and a fake exec.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { release } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PROVENANCE_SCHEMA_VERSION = 1;

// aloud's own checkout (or installed package) root.
const ALOUD_HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isCommit = (value) => typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);

// ── pure formatting ──

// The GitHub Actions run this process belongs to, from the variables every
// Actions job sets, or null outside Actions. The URL points at the exact
// attempt when the attempt number is known.
export function githubRun(env = {}) {
  if (env.GITHUB_ACTIONS !== "true" && !env.GITHUB_RUN_ID) return null;
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repository = env.GITHUB_REPOSITORY || null;
  const runId = env.GITHUB_RUN_ID || null;
  const runAttempt = env.GITHUB_RUN_ATTEMPT || null;
  let runUrl = null;
  if (repository && runId && /^https?:\/\/\S+$/.test(server)) {
    runUrl = `${server.replace(/\/+$/, "")}/${repository}/actions/runs/${runId}`;
    if (runAttempt) runUrl += `/attempts/${runAttempt}`;
  }
  return { server, repository, runId, runAttempt, runUrl };
}

// Tool versions as a plain object with sorted keys. Tools whose version is
// unknown (null, undefined, or blank) are left out rather than recorded as
// an empty string.
export function formatTools(tools = {}) {
  if (!isRecord(tools)) throw new Error("provenance tools must be an object of name -> version");
  const entries = Object.entries(tools)
    .filter(([, version]) => version !== null && version !== undefined && String(version).trim() !== "")
    .map(([name, version]) => {
      if (!isText(name)) throw new Error("provenance tool names must be non-empty strings");
      return [name, String(version).trim()];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

// Assemble a provenance record from facts already gathered. No IO.
//
//   app       { commit, workingTreeDirty } for the audited app (nulls when unknown)
//   aloud     { version, commit, workingTreeDirty }
//   runtime   { platform, arch, osRelease, node }
//   env       environment variables (for the GitHub run)
//   tools     { name: version }
export function formatProvenance({ app = {}, aloud = {}, runtime = {}, env = {}, tools = {} } = {}) {
  const record = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    commit: app.commit ?? null,
    workingTreeDirty: app.workingTreeDirty ?? null,
    platform: runtime.platform,
    arch: runtime.arch,
    osRelease: runtime.osRelease,
    node: runtime.node,
    aloud: {
      version: aloud.version,
      commit: aloud.commit ?? null,
      workingTreeDirty: aloud.workingTreeDirty ?? null,
    },
    github: githubRun(env),
    tools: formatTools(tools),
  };
  return validateProvenance(record);
}

// ── validation ──

const RECORD_KEYS = ["schemaVersion", "commit", "workingTreeDirty", "platform", "arch", "osRelease", "node", "aloud", "github", "tools"];
const GITHUB_KEYS = ["server", "repository", "runId", "runAttempt", "runUrl"];

function checkKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${field} has unknown field(s): ${unknown.join(", ")}`);
}

function checkGitState(state, field) {
  if (state.commit !== null && !isCommit(state.commit)) {
    throw new Error(`${field}.commit must be a full git commit hash or null`);
  }
  if (state.workingTreeDirty !== null && typeof state.workingTreeDirty !== "boolean") {
    throw new Error(`${field}.workingTreeDirty must be true, false, or null`);
  }
}

// Validate one provenance record. Unknown fields, missing fields, and
// malformed values throw: a record that cannot be read exactly is not
// evidence of where anything came from. Returns the record.
export function validateProvenance(record, field = "provenance") {
  if (!isRecord(record)) throw new Error(`${field} must be an object`);
  checkKeys(record, RECORD_KEYS, field);
  if (record.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`${field}.schemaVersion must be ${PROVENANCE_SCHEMA_VERSION}`);
  }
  checkGitState(record, field);
  for (const key of ["platform", "arch", "osRelease", "node"]) {
    if (!isText(record[key])) throw new Error(`${field}.${key} must be a non-empty string`);
  }
  const aloud = record.aloud;
  if (!isRecord(aloud)) throw new Error(`${field}.aloud must be an object`);
  checkKeys(aloud, ["version", "commit", "workingTreeDirty"], `${field}.aloud`);
  if (!isText(aloud.version)) throw new Error(`${field}.aloud.version must be a non-empty string`);
  checkGitState(aloud, `${field}.aloud`);
  if (record.github !== null) {
    const github = record.github;
    if (!isRecord(github)) throw new Error(`${field}.github must be an object or null`);
    checkKeys(github, GITHUB_KEYS, `${field}.github`);
    for (const key of GITHUB_KEYS) {
      if (github[key] !== null && !isText(github[key])) throw new Error(`${field}.github.${key} must be a non-empty string or null`);
    }
    if (!isText(github.server)) throw new Error(`${field}.github.server must be a non-empty string`);
    if (github.runUrl !== null && !/^https?:\/\/\S+$/.test(github.runUrl)) {
      throw new Error(`${field}.github.runUrl must be an absolute http(s) URL or null`);
    }
  }
  if (!isRecord(record.tools)) throw new Error(`${field}.tools must be an object of name -> version`);
  for (const [name, version] of Object.entries(record.tools)) {
    if (!isText(name) || !isText(version)) throw new Error(`${field}.tools must map non-empty names to non-empty versions`);
  }
  return record;
}

// summary.json's provenance: one record, or, when mixed evidence was
// explicitly allowed (--allow-mixed), { schemaVersion, mixed: [...] }
// listing each distinct record (null for files that recorded none) and
// the files it covers. Returns the value.
export function validateSummaryProvenance(value, field = "provenance") {
  if (!isRecord(value) || !Object.hasOwn(value, "mixed")) return validateProvenance(value, field);
  checkKeys(value, ["schemaVersion", "mixed"], field);
  if (value.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`${field}.schemaVersion must be ${PROVENANCE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.mixed) || value.mixed.length < 2) {
    throw new Error(`${field}.mixed must list at least two distinct provenance groups`);
  }
  value.mixed.forEach((group, i) => {
    const at = `${field}.mixed[${i}]`;
    if (!isRecord(group)) throw new Error(`${at} must be an object`);
    checkKeys(group, ["provenance", "files"], at);
    if (group.provenance !== null) validateProvenance(group.provenance, `${at}.provenance`);
    if (!Array.isArray(group.files) || group.files.length === 0 || !group.files.every(isText)) {
      throw new Error(`${at}.files must list the evidence files the group covers`);
    }
  });
  return value;
}

export const isMixedProvenance = (value) => isRecord(value) && Object.hasOwn(value, "mixed");

// ── comparing and combining ──

// The code a record says was tested: the app commit and working tree
// state, and the aloud that checked it. Evidence with different code
// identities cannot describe one version of the product.
export function codeIdentity(record) {
  if (!record) return null;
  return {
    commit: record.commit,
    workingTreeDirty: record.workingTreeDirty,
    aloudVersion: record.aloud.version,
    aloudCommit: record.aloud.commit,
  };
}

// One line naming a record's code, for messages and notes.
export function describeCode(record) {
  if (!record) return "no recorded provenance";
  const commit = record.commit
    ? `commit ${record.commit.slice(0, 12)}${record.workingTreeDirty ? " plus uncommitted changes" : ""}`
    : "an unknown commit";
  const aloud = `aloud ${record.aloud.version}${record.aloud.commit ? ` (${record.aloud.commit.slice(0, 12)})` : ""}`;
  return `${commit}, checked by ${aloud}`;
}

// JSON with object keys sorted at every level, so equal records give
// equal strings whatever order their fields were written in.
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

// A record's tools as "name version" items.
export const toolList = (record) => Object.entries(record?.tools ?? {}).map(([name, version]) => `${name} ${version}`);

// One plain sentence describing a record, or a summary's mixed form, for
// the evidence page: the code, the machine, the CI run, and the tools.
export function describeProvenance(value) {
  if (!value) return "No provenance recorded.";
  if (isMixedProvenance(value)) {
    const groups = value.mixed.map((group) => `${describeCode(group.provenance)} (${group.files.length} file(s))`);
    return `Combined with --allow-mixed from ${value.mixed.length} different runs: ${groups.join("; ")}.`;
  }
  const parts = [
    `Evidence from ${describeCode(value)}`,
    `Node ${value.node} on ${value.platform} ${value.arch}`,
  ];
  if (value.github?.runUrl) parts.push(`run ${value.github.runUrl}`);
  const tools = toolList(value);
  if (tools.length) parts.push(`tools: ${tools.join(", ")}`);
  return `${parts.join("; ")}.`;
}

// A record without its tools, as a stable string: two captures from the
// same run agree on everything here.
const runKey = (record) => {
  if (!record) return "null";
  const { tools, ...rest } = record;
  return canonical(rest);
};

// Combine the provenance of the evidence files in one report dir into the
// value summary.json records.
//
//   entries      [{ file, provenance }] where provenance is a validated
//                record or undefined (a file written before provenance)
//   allowMixed   true to accept evidence from different runs
//
// Returns undefined when no file recorded provenance (old report dirs keep
// working unchanged). When every file agrees (same run: code, machine, CI
// run) the result is that record, with the tools of all files merged (the
// transcript and tree passes record different tools). Anything else, a
// file without provenance next to files with it included, is mixed
// evidence: it throws unless allowMixed, and then returns the mixed form
// listing every group.
export function combineProvenance(entries, { allowMixed = false, what = "report" } = {}) {
  if (!entries.some((entry) => entry.provenance)) return undefined;
  const groups = new Map();
  for (const { file, provenance } of entries) {
    const key = runKey(provenance);
    if (!groups.has(key)) groups.set(key, { provenance: provenance ?? null, files: [] });
    groups.get(key).files.push(file);
  }
  const conflicts = [];
  if (groups.size === 1) {
    const [group] = groups.values();
    const tools = {};
    for (const { file, provenance } of entries) {
      for (const [name, version] of Object.entries(provenance.tools)) {
        if (Object.hasOwn(tools, name) && tools[name] !== version) conflicts.push(`${name} ${tools[name]} vs ${version} (${file})`);
        tools[name] = version;
      }
    }
    if (conflicts.length === 0) return { ...group.provenance, tools: formatTools(tools) };
  }
  if (!allowMixed) {
    const detail = groups.size > 1
      ? [...groups.values()].map((g) => `${describeCode(g.provenance)}${g.provenance?.github?.runUrl ? ` in ${g.provenance.github.runUrl}` : ""} ` +
          `(${g.files.slice(0, 3).join(", ")}${g.files.length > 3 ? `, and ${g.files.length - 3} more` : ""})`).join("; ")
      : `tool versions differ: ${conflicts.join("; ")}`;
    throw new Error(
      `the ${what} mixes evidence from different runs, so it cannot describe one version of the product: ${detail}. ` +
        "Re-run the whole audit into a fresh report dir, or pass --allow-mixed to combine them anyway (the summary records every source).",
    );
  }
  if (groups.size === 1) {
    // Same run, conflicting tools: keep each file's own record.
    return {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      mixed: entries.map(({ file, provenance }) => ({ provenance, files: [file] })),
    };
  }
  return { schemaVersion: PROVENANCE_SCHEMA_VERSION, mixed: [...groups.values()] };
}

// ── IO ──

// Run a command and return its stdout, or throw. Bounded so a hung tool
// can never stall an audit.
export function defaultExec(command, args, { cwd } = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

const tryRun = (exec, command, args, options) => {
  try {
    return String(exec(command, args, options) ?? "");
  } catch {
    return null;
  }
};

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

// The git state of the checkout containing dir: { commit, workingTreeDirty,
// root }, each null when unknown. Never throws. exclude lists paths (such
// as the report dir, when it lives inside the app repo) whose changes do
// not make the tree dirty: aloud writes its own evidence there while it
// runs, and a later pass must not see the earlier pass's output as a
// change to the app. With requireRoot, a checkout whose top level is not
// exactly that directory counts as none (aloud installed under an app's
// node_modules must not report the app's commit as its own).
export function readGitState(dir, { exec = defaultExec, exclude = [], requireRoot } = {}) {
  const none = { commit: null, workingTreeDirty: null, root: null };
  const top = tryRun(exec, "git", ["rev-parse", "--show-toplevel"], { cwd: dir });
  if (top === null || !top.trim()) return none;
  const root = real(top.trim());
  if (requireRoot && root !== real(requireRoot)) return none;
  const head = tryRun(exec, "git", ["rev-parse", "HEAD"], { cwd: dir });
  const commit = head !== null && isCommit(head.trim()) ? head.trim() : null;
  const excludes = exclude
    .map((path) => relative(root, real(isAbsolute(path) ? path : resolve(dir, path))))
    .filter((rel) => rel && !rel.startsWith("..") && !isAbsolute(rel))
    .map((rel) => `:(top,exclude)${rel.split(sep).join("/")}`);
  const status = tryRun(exec, "git", ["status", "--porcelain", "--untracked-files=normal", "--", ":/", ...excludes], { cwd: dir });
  return { commit, workingTreeDirty: status === null ? null : status.trim() !== "", root };
}

// aloud's version from its package.json.
function aloudVersion(home) {
  try {
    return JSON.parse(readFileSync(resolve(home, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Run each tool probe and keep its first non-empty output line (or the
// first `lines` of them, joined with spaces), or null when the tool is
// missing or fails. probes: { name: [command, ...args] } or
// { name: { command: [command, ...args], lines: 2 } }.
export function probeTools(probes = {}, { exec = defaultExec } = {}) {
  return Object.fromEntries(Object.entries(probes).map(([name, probe]) => {
    const { command: [command, ...args], lines = 1 } = Array.isArray(probe) ? { command: probe } : probe;
    const output = tryRun(exec, command, args, {});
    const kept = (output ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, lines);
    return [name, kept.length ? kept.join(" ") : null];
  }));
}

// Gather this process's provenance. Never throws for missing git or tools;
// throws only for malformed arguments.
//
//   cwd        the audited app's directory (default process.cwd())
//   tools      { name: version } the caller already knows
//   probes     { name: [command, ...args] } run to read a version
//   exclude    paths whose changes do not count as app changes (report dirs)
//   env, exec, runtime, aloudHome   injectable for tests
export function collectProvenance({
  cwd = process.cwd(),
  tools = {},
  probes = {},
  exclude = [],
  env = process.env,
  exec = defaultExec,
  runtime = { platform: process.platform, arch: process.arch, osRelease: release(), node: process.version },
  aloudHome = ALOUD_HOME,
} = {}) {
  const app = readGitState(cwd, { exec, exclude });
  const own = readGitState(aloudHome, { exec, requireRoot: aloudHome });
  return formatProvenance({
    app,
    aloud: { version: aloudVersion(aloudHome), commit: own.commit, workingTreeDirty: own.workingTreeDirty },
    runtime,
    env,
    tools: { ...probeTools(probes, { exec }), ...formatTools(tools) },
  });
}
