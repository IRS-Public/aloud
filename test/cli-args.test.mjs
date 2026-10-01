import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../src/cli-args.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPTIONS = {
  dir: { type: "string" },
  "screen-id": { type: "string" },
  gate: { type: "boolean" },
};

describe("cli args", () => {
  it("reads string values in both spellings and falls back when absent", () => {
    const args = parseCliArgs(["--dir", "out/android", "--screen-id=home"], OPTIONS);
    assert.equal(args.opt("dir", "fallback"), "out/android");
    assert.equal(args.opt("screen-id", "current"), "home");
    const none = parseCliArgs([], OPTIONS);
    assert.equal(none.opt("dir", "fallback"), "fallback");
    assert.equal(none.opt("dir"), undefined);
    assert.equal(none.opt("dir", null), null);
  });

  it("treats an empty value as absent, like the hand-rolled parsers did", () => {
    assert.equal(parseCliArgs(["--dir", ""], OPTIONS).opt("dir", "fallback"), "fallback");
    assert.equal(parseCliArgs(["--dir="], OPTIONS).opt("dir", "fallback"), "fallback");
  });

  it("reports boolean flags only when passed", () => {
    assert.equal(parseCliArgs(["--gate"], OPTIONS).flag("gate"), true);
    assert.equal(parseCliArgs([], OPTIONS).flag("gate"), false);
  });

  it("rejects unknown flags instead of ignoring a typo", () => {
    assert.throws(() => parseCliArgs(["--gat"], OPTIONS), /Unknown option '--gat'/);
  });

  it("rejects a string flag with no value, including one swallowing the next flag", () => {
    assert.throws(() => parseCliArgs(["--dir"], OPTIONS), /argument missing/);
    assert.throws(() => parseCliArgs(["--dir", "--gate"], OPTIONS), /ambiguous/);
  });

  it("rejects a value on a boolean flag", () => {
    assert.throws(() => parseCliArgs(["--gate=yes"], OPTIONS), /does not take an argument/);
  });

  it("rejects a flag given twice rather than guessing which one was meant", () => {
    assert.throws(() => parseCliArgs(["--dir", "a", "--dir", "b"], OPTIONS), /--dir was given more than once/);
    assert.throws(() => parseCliArgs(["--gate", "--gate"], OPTIONS), /--gate was given more than once/);
  });

  it("rejects positionals unless the caller allows them", () => {
    assert.throws(() => parseCliArgs(["out/android"], OPTIONS), /Unexpected argument 'out\/android'/);
    const args = parseCliArgs(["out/android", "--dir", "x"], OPTIONS, { allowPositionals: true });
    assert.deepEqual(args.positionals, ["out/android"]);
    assert.equal(args.opt("dir"), "x");
  });

  it("refuses to read a flag the caller never declared", () => {
    const args = parseCliArgs([], OPTIONS);
    assert.throws(() => args.opt("out"), /--out is not a declared string option/);
    assert.throws(() => args.flag("dir"), /--dir is not a declared boolean option/);
    assert.throws(() => args.opt("gate"), /--gate is not a declared string option/);
  });

  it("rejects malformed input and option declarations", () => {
    assert.throws(() => parseCliArgs("--dir x", OPTIONS), /argv must be an array of strings/);
    assert.throws(() => parseCliArgs([1], OPTIONS), /argv must be an array of strings/);
    assert.throws(() => parseCliArgs([], { dir: {} }), /--dir must declare type/);
  });

  it("script entry points exit 1 with the parse error and no stack trace", () => {
    const result = spawnSync(process.execPath, [join(ROOT, "src/report/report.mjs"), "--dir", "x", "--gat"], {
      encoding: "utf8", env: { ...process.env, ALOUD_CONFIG: "" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^report\.mjs: Unknown option '--gat'/);
    assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
  });
});
