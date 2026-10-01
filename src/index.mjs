// The package entry for `import ... from "@irs-public/aloud"`: the shared
// Section 508 evidence -> OpenACR engine (src/acr), the part other tools
// build on. The screen-reader drivers and the rule catalog have their own
// entries, so importing the engine never loads them:
//
//   "@irs-public/aloud"                    this file (the OpenACR engine)
//   "@irs-public/aloud/acr"                the same engine, by name
//   "@irs-public/aloud/rules"              src/rules/catalog.mjs
//   "@irs-public/aloud/web/nvda"           src/web/nvda.mjs
//   "@irs-public/aloud/web/voiceover"      src/web/voiceover.mjs
//   "@irs-public/aloud/web/dependencies"   src/web/dependencies.mjs
//   "@irs-public/aloud/findings.schema.json"
//   "@irs-public/aloud/src/...", "/bin/...", "/examples/*.json"
//                                          any shipped file path, as before 0.2.0
//
// Library only: importing it reads the findings schema and nothing else.

export * from "./acr/index.mjs";
