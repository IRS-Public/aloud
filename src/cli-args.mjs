// Flag parsing for aloud's internal scripts (the leg walkers, the report
// modules, the demo). bin/aloud.mjs validates what users type and forwards
// only known flags, but these scripts can also be run directly, so they
// share one parser instead of each hand-rolling `opt(name, fallback)`.
//
// Built on node:util parseArgs, strict: an unknown flag, a string flag with
// no value, or a flag given twice is an error, never a silently ignored
// typo (a mistyped --gate must not quietly skip the gate).
//
//   const args = cliArgs("report.mjs", {
//     dir: { type: "string" },
//     gate: { type: "boolean" },
//   });
//   args.opt("dir", "fallback")   // string value, or the fallback
//   args.flag("gate")             // true only when --gate was passed
//   args.positionals              // bare arguments (only when allowed)
//
// Both `--dir value` and `--dir=value` work. An empty value (`--dir ""`)
// counts as absent and yields the fallback, as the older hand-rolled
// parsers did.

import { parseArgs } from "node:util";

// Pure: parse argv against the declared options, or throw.
export function parseCliArgs(argv, options, { allowPositionals = false } = {}) {
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string")) {
    throw new Error("argv must be an array of strings");
  }
  for (const [name, spec] of Object.entries(options)) {
    if (spec?.type !== "string" && spec?.type !== "boolean") {
      throw new Error(`option --${name} must declare type "string" or "boolean"`);
    }
  }

  const { values, positionals, tokens } = parseArgs({
    args: argv,
    options,
    allowPositionals,
    strict: true,
    tokens: true,
  });

  // parseArgs keeps the last of a repeated flag; which one the caller meant
  // is unknowable, so refuse instead.
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`option --${token.name} was given more than once`);
    seen.add(token.name);
  }

  const declared = (name, type) => {
    if (options[name]?.type !== type) {
      throw new Error(`--${name} is not a declared ${type} option`);
    }
  };

  return {
    positionals,
    opt(name, fallback) {
      declared(name, "string");
      const value = values[name];
      return value === undefined || value === "" ? fallback : value;
    },
    flag(name) {
      declared(name, "boolean");
      return values[name] === true;
    },
  };
}

// For script entry points: parse process.argv, and on bad input print a
// short error naming the script and exit 1 (no stack trace).
export function cliArgs(script, options, settings = {}) {
  const { argv = process.argv.slice(2), ...parseSettings } = settings;
  try {
    return parseCliArgs(argv, options, parseSettings);
  } catch (error) {
    console.error(`${script}: ${error.message}`);
    process.exit(1);
  }
}
