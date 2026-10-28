// Select once and pass the concrete UDID to every simulator operation.
// `booted` and the first array entry can address different devices when
// several QA simulators are running on the same host.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function selectSimulator(list, { udid, allowBoot = false } = {}) {
  const devices = Object.values(list.devices ?? {}).flat().filter(d => d.isAvailable !== false);
  if (udid) {
    const selected = devices.find(d => d.udid === udid);
    if (!selected) throw new Error(`requested iOS simulator ${udid} is unavailable`);
    if (!allowBoot && selected.state !== "Booted") throw new Error(`requested iOS simulator ${udid} is not booted; preserve the prepared current screen`);
    return selected;
  }
  const booted = devices.filter(d => d.state === "Booted");
  if (booted.length > 1) throw new Error("multiple iOS simulators are booted; select the intended target with --udid or ios.udid");
  if (booted.length === 1) return booted[0];
  if (!allowBoot) throw new Error("no booted iOS simulator; prepare the target app's current screen first");
  const selected = devices.filter(d => d.name?.includes("iPhone")).at(-1);
  if (!selected) throw new Error("no available iPhone simulator");
  return selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const cfg = JSON.parse(readFileSync(process.env.ALOUD_CONFIG, "utf8"));
    const list = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "available", "-j"], { encoding: "utf8" }));
    const selected = selectSimulator(list, { udid: cfg.ios?.udid, allowBoot: process.argv.includes("--allow-boot") });
    if (selected.state !== "Booted") {
      execFileSync("xcrun", ["simctl", "boot", selected.udid], { stdio: ["ignore", "ignore", "inherit"] });
      execFileSync("xcrun", ["simctl", "bootstatus", selected.udid, "-b"], { stdio: ["ignore", "ignore", "inherit"] });
    }
    process.stdout.write(selected.udid);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
