#!/usr/bin/env node
// aloud — the first 508 audit that actually listens.
//
// Thin dispatcher: parse subcommand + flags, load the config, write
// <out>/config.resolved.json, then hand off to the leg scripts or report
// modules. No audit logic lives here.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, validateForLeg } from "../src/config.mjs";

const ALOUD_HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GLOBAL_OPTIONS = {
  config: { type: "string" },
  out: { type: "string" },
  help: { type: "boolean" },
};

const LEG_OPTIONS = {
  ...GLOBAL_OPTIONS,
  nav: { type: "string" },
  screens: { type: "string" },
  flow: { type: "string" },
  port: { type: "string" },
  "no-gate": { type: "boolean" },
  "skip-app-server": { type: "boolean" },
  "screen-id": { type: "string" },
};

const OPTIONS = {
  android: { ...LEG_OPTIONS, apk: { type: "string" }, pass: { type: "string" },
    talkback: { type: "string" }, "talkback-max-steps": { type: "string" }, tts: { type: "string" }, atf: { type: "boolean" } },
  ios: { ...LEG_OPTIONS, app: { type: "string" }, "apple-audit": { type: "boolean" },
    voiceover: { type: "string" }, "voiceover-max-steps": { type: "string" } },
  report: {
    ...GLOBAL_OPTIONS,
    dir: { type: "string" },
    baseline: { type: "string" },
    gate: { type: "boolean" },
  },
  baseline: { ...GLOBAL_OPTIONS, baseline: { type: "string" } },
  openacr: {
    ...GLOBAL_OPTIONS,
    android: { type: "string" },
    ios: { type: "string" },
    report: { type: "string" },
    "report-ios": { type: "string" },
    date: { type: "string" },
    catalog: { type: "string" },
    version: { type: "string" },
  },
};

const USAGE = `aloud — the first 508 audit that actually listens

Usage: aloud <command> [flags]

Commands:
  demo         Try aloud with no device: replay the bundled sample capture through the
               real checks and report into ./aloud-demo-report [--out <dir>]
  android      Run the Android leg: TalkBack transcript pass + tree pass + report + gate
  ios          Run the iOS leg: computed VoiceOver transcript + tree checks + report + gate
  talkback     Manage TalkBack on the device: status | install <apk> | enable | disable |
               configure | get [--foss|--build]
  tts          Build or install the optional silent recording TTS engine
  report       Re-aggregate an existing report dir (--dir, --baseline, --gate)
  baseline     Accept current counts into a baseline: aloud baseline <report-dir> [--baseline <file>]
  openacr      Emit a draft OpenACR (--android/--ios baselines or --report/--report-ios dirs)

Global flags:
  --config <file>   Config file (default: ./aloud.config.json if present)
  --out <dir>       Report root (default: aloud-report)

Leg flags (android, ios):
  --apk <path> / --app <path>   Install this build first
  --nav <mode>                  current-screen | deeplinks | bridge
  --screens <file>              Screens manifest
  --flow <ids>                  Comma-separated flow ids
  --pass <p>                    android only: transcript | tree | both (default both)
  --port <n>                    Bridge / app-server port (default 8081)
  --no-gate                     Skip the ratchet gate
  --skip-app-server             Do not spawn nav.bridge.appServer.command
  --screen-id <id>              current-screen mode report key (default "current")
  --talkback startup|focus      Android transcript mode (focus requires a companion build)
  --talkback-max-steps N        Limit per rewind/forward traversal (1–200, default: 100)
  --atf                        Android native node capture and report-only ATF checks
  --tts system|logging         Android TTS mode (logging requires focus; emits silence)
  --apple-audit                 iOS only: add report-only Apple accessibility audit evidence
  --voiceover computed|real     iOS speech source (default: computed; real needs Xcode 27)
  --voiceover-max-steps N       Maximum forward moves for real speech (1–100, default: 20)

  aloud --help          Show this help
  aloud --version       Show the aloud version
`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function aloudVersion() {
  try {
    return JSON.parse(readFileSync(join(ALOUD_HOME, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parse(command, argv, { allowPositionals = false } = {}) {
  try {
    return parseArgs({ args: argv, options: OPTIONS[command], allowPositionals });
  } catch (err) {
    fail(`aloud ${command}: ${err.message}\n\nRun "aloud --help" for usage.`);
  }
}

// Set a nested key on the overrides object (skips undefined values).
function setPath(obj, keyPath, value) {
  if (value === undefined) return;
  let node = obj;
  for (const key of keyPath.slice(0, -1)) {
    node[key] = node[key] ?? {};
    node = node[key];
  }
  node[keyPath[keyPath.length - 1]] = value;
}

// Load config with CLI overrides, create <out>, write config.resolved.json.
// Every leg and report module reads only that file (env ALOUD_CONFIG).
function resolveAndWriteConfig(values, overrides = {}) {
  if (values.out) overrides.out = values.out;
  let cfg;
  try {
    cfg = loadConfig(values.config, overrides);
  } catch (err) {
    fail(`aloud: ${err.message}`);
  }
  mkdirSync(cfg.out, { recursive: true });
  const resolvedPath = join(cfg.out, "config.resolved.json");
  writeFileSync(resolvedPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return { cfg, resolvedPath };
}

function run(cmd, args, resolvedPath) {
  const child = spawnSync(cmd, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ALOUD_HOME,
      ...(resolvedPath ? { ALOUD_CONFIG: resolvedPath } : {}),
    },
  });
  if (child.error) fail(`aloud: could not run ${cmd}: ${child.error.message}`);
  process.exit(child.status ?? 1);
}

function runLeg(platform, argv) {
  const { values } = parse(platform, argv);
  if (values.help) return console.log(USAGE);

  if (platform === "android" && values.pass && !["transcript", "tree", "both"].includes(values.pass)) {
    fail(`aloud android: unknown --pass ${values.pass} (use transcript | tree | both)`);
  }

  const overrides = {};
  setPath(overrides, ["nav", "mode"], values.nav);
  setPath(overrides, ["nav", "screens"], values.screens);
  setPath(overrides, ["nav", "bridge", "port"], values.port);
  setPath(overrides, ["nav", "screenId"], values["screen-id"]);
  if (platform === "android") setPath(overrides, ["app", "android", "apk"], values.apk);
  if (platform === "ios") setPath(overrides, ["app", "ios", "app"], values.app);
  if (platform === "android") {
    setPath(overrides, ["android", "talkBack"], values.talkback);
    setPath(overrides, ["android", "tts"], values.tts);
    setPath(overrides, ["android", "atf"], values.atf);
    if (values["talkback-max-steps"] !== undefined) setPath(overrides, ["android", "talkBackMaxSteps"], Number(values["talkback-max-steps"]));
  }
  if (platform === "ios") setPath(overrides, ["ios", "appleAudit"], values["apple-audit"]);
  if (platform === "ios") setPath(overrides, ["ios", "voiceOver"], values.voiceover);
  if (platform === "ios" && values["voiceover-max-steps"] !== undefined) {
    setPath(overrides, ["ios", "voiceOverMaxSteps"], Number(values["voiceover-max-steps"]));
  }

  const { cfg, resolvedPath } = resolveAndWriteConfig(values, overrides);
  try {
    validateForLeg(cfg, platform);
  } catch (err) {
    fail(`aloud ${platform}: ${err.message}`);
  }

  const passThrough = [];
  if (values.flow) passThrough.push("--flow", values.flow);
  if (platform === "android" && values.pass && values.pass !== "both") {
    passThrough.push("--pass", values.pass);
  }
  if (values.port) passThrough.push("--port", values.port);
  if (values["no-gate"]) passThrough.push("--no-gate");
  if (values["skip-app-server"]) passThrough.push("--skip-app-server");

  run("bash", [join(ALOUD_HOME, "src", platform, "run.sh"), ...passThrough], resolvedPath);
}

function runTalkback(argv) {
  if (!argv.length || argv[0] === "--help") {
    return console.log(
      "Usage: aloud talkback <status | install <apk> | enable | disable | configure | get [--foss|--build]>",
    );
  }
  if (argv[0] === "get") {
    return run("bash", [join(ALOUD_HOME, "src", "android", "get-talkback.sh"), ...argv.slice(1)]);
  }
  run(process.execPath, [join(ALOUD_HOME, "src", "android", "talkback.mjs"), ...argv]);
}

function runDemo(argv) {
  if (argv.includes("--help")) {
    return console.log(
      `Usage: aloud demo [--out <dir>]

Replays the bundled sample capture through the real checks and the real
report generator. Writes ./aloud-demo-report by default. No device needed.
Demo data. This is a replay of a captured audit of the bundled sample
screen, not your app.`,
    );
  }
  run(process.execPath, [join(ALOUD_HOME, "src", "demo", "demo.mjs"), ...argv]);
}

function runReport(argv) {
  const { values } = parse("report", argv);
  if (values.help) return console.log(USAGE);
  const { cfg, resolvedPath } = resolveAndWriteConfig(values);
  const dir = values.dir ? resolve(values.dir) : join(cfg.out, "android");
  const isIos = basename(dir) === "ios" || basename(dir).endsWith("-ios");
  const baseline = values.baseline
    ? resolve(values.baseline)
    : isIos
      ? cfg.baseline.ios
      : cfg.baseline.android;
  const args = [join(ALOUD_HOME, "src", "report", "report.mjs"), "--out", dir, "--baseline", baseline];
  if (values.gate) args.push("--gate");
  run(process.execPath, args, resolvedPath);
}

function runBaseline(argv) {
  const { values, positionals } = parse("baseline", argv, { allowPositionals: true });
  if (values.help) return console.log(USAGE);
  const reportDir = positionals[0];
  if (!reportDir) fail("Usage: aloud baseline <report-dir> [--baseline <file>]");
  const dir = resolve(reportDir);
  const { cfg, resolvedPath } = resolveAndWriteConfig(values);
  const isIos = basename(dir) === "ios" || basename(dir).endsWith("-ios");
  const baseline = values.baseline
    ? resolve(values.baseline)
    : isIos
      ? cfg.baseline.ios
      : cfg.baseline.android;
  run(
    process.execPath,
    [join(ALOUD_HOME, "src", "report", "baseline.mjs"), dir, "--baseline", baseline],
    resolvedPath,
  );
}

function runOpenacr(argv) {
  const { values } = parse("openacr", argv);
  if (values.help) return console.log(USAGE);
  // For openacr, --out names the output YAML file (config: openacr.out).
  // The report root still comes from the config file.
  const overrides = {};
  if (values.out) setPath(overrides, ["openacr", "out"], resolve(values.out));
  const { cfg, resolvedPath } = resolveAndWriteConfig({ ...values, out: undefined }, overrides);
  try {
    validateForLeg(cfg, "openacr", { requireVersion: !values.version });
  } catch (err) {
    fail(`aloud openacr: ${err.message}`);
  }
  const args = [join(ALOUD_HOME, "src", "report", "openacr.mjs")];
  for (const flag of ["android", "ios", "report", "report-ios", "date", "catalog", "version"]) {
    if (values[flag]) args.push(`--${flag}`, values[flag]);
  }
  if (values.out) args.push("--out", cfg.openacr.out);
  run(process.execPath, args, resolvedPath);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(USAGE);
    break;
  case "--version":
  case "-v":
    console.log(aloudVersion());
    break;
  case "demo":
    runDemo(rest);
    break;
  case "android":
  case "ios":
    runLeg(command, rest);
    break;
  case "talkback":
    runTalkback(rest);
    break;
  case "tts":
    if (rest[0] === "build") run("bash", [join(ALOUD_HOME, "src/android/get-logging-tts.sh"), ...rest.slice(1)]);
    else if (rest[0] === "install" && rest[1]) run(process.execPath, [join(ALOUD_HOME, "src/android/talkback.mjs"), "install", rest[1]]);
    else console.log("Usage: aloud tts build | install <apk>");
    break;
  case "report":
    runReport(rest);
    break;
  case "baseline":
    runBaseline(rest);
    break;
  case "openacr":
    runOpenacr(rest);
    break;
  default:
    fail(`aloud: unknown command "${command}"\n\n${USAGE}`);
}
