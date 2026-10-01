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

// Pick the config baseline for a report dir, for the report and baseline
// scripts run without --baseline. Before 0.2.0 those scripts counted any
// path ending in "ios" as iOS, so "out/app_ios" took the iOS baseline;
// the shared rule above counts it as Android. A dir named "iOS" or
// "app-iOS" counts as Android under both rules, though it most likely
// holds iOS evidence. Rather than quietly gate such a dir against the
// Android baseline, this throws and asks for --baseline. Only a separate
// word "ios", in any case ("app_ios", "app.ios", "build/iOS"), is
// ambiguous; "radios" or "myios" was never meant as iOS. Returns
// undefined when the config names no baseline for the platform.
export function configBaselineFor(dir, platform, cfg) {
  const name = basename(resolve(dir.replace(/[\\/]+$/, "") || "/"));
  if (platform === "android" && /(^|[^A-Za-z0-9])ios$/i.test(name)) {
    const history = name.endsWith("ios") ? "; before 0.2.0 it counted as iOS" : "";
    throw new Error(
      `report dir ${dir} is named "${name}", which counts as Android (only "ios" or "*-ios" is iOS)${history}. ` +
        "Pass --baseline <file> to choose its baseline, " +
        'or rename the dir (for example to "app-ios").',
    );
  }
  return platform === "ios" ? cfg?.baseline?.ios : cfg?.baseline?.android;
}
