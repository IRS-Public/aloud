// Which platform a report dir holds. One rule for every entry point, so
// `aloud report`, `aloud baseline`, and the report modules they spawn can
// never disagree about which baseline a dir belongs to.
//
//   web      the dir holds experimental web evidence (web-run.json or
//            *.web.json files) — detected from contents, not the name
//   ios      the dir's own name is "ios" or ends in "-ios" (the iOS leg
//            writes <out>/ios; "my-app-ios" is the documented variant)
//   android  everything else (the Android leg writes <out>/android)
//
// Only the last segment of the resolved path counts, so "radios" or
// "ios-archive/android" are not iOS, and a trailing slash ("out/ios/"), a
// trailing "." ("out/ios/."), or "." run from inside the ios dir all give the
// same answer bin/aloud.mjs gets after it resolves the dir.

import { basename, resolve } from "node:path";
import { isWebReport } from "../web/evidence.mjs";

// Name-only check (no filesystem access), for callers that already know the
// dir is not web evidence.
export function isIosReportDir(dir) {
  if (typeof dir !== "string" || dir.trim() === "") {
    throw new Error(`report dir must be a non-empty path, got ${JSON.stringify(dir)}`);
  }
  // Resolve first so "." and "out/ios/." name the real dir. Strip trailing
  // "\" too, for Windows paths passed on a POSIX host.
  const name = basename(resolve(dir.replace(/[\\/]+$/, "") || "/"));
  return name === "ios" || name.endsWith("-ios");
}

export function platformForReportDir(dir) {
  const ios = isIosReportDir(dir);
  if (isWebReport(dir)) return "web";
  return ios ? "ios" : "android";
}
