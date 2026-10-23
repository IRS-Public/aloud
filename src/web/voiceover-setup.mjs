import { hostRefusal } from "./voiceover.mjs";

// Experimental setup of a disposable GitHub-hosted macOS runner for
// VoiceOver capture: Guidepup's setup and install, with recovery between
// attempts and a name for a machine on which no attempt can pass. Ported
// from the USWDS accessibility harness's native setup.

// Printed, with a reason, when this hosted machine cannot run VoiceOver at
// all. A workflow can match it to rerun the job on a fresh machine.
export const SETUP_UNAVAILABLE = "VOICEOVER_SETUP_UNAVAILABLE";

// Why another setup attempt on this machine cannot pass, from a failure's
// output, or undefined. Some hosted machines refuse every Apple event to
// System Events for the whole job (see hostRefusal); Guidepup's Do Not
// Disturb step then fails after minutes of its own retries. Others cannot
// stop the VoiceOver that setup started: Guidepup reports "Unable to stop
// VoiceOver", or the reader is still running after the cleanup between
// attempts, and the next attempt refuses to start beside it. And Guidepup's
// install downloads its reader assets from GitHub's release host, which
// answers 429 when a runner's address has asked too often; another machine
// downloads from another address.
export function setupRefusal(output) {
  const text = String(output ?? "");
  const refused = hostRefusal(text);
  if (refused) return refused;
  if (/Unable to stop VoiceOver|VoiceOver remained active after disposable setup/.test(text)) {
    return "VoiceOver on this machine cannot be stopped";
  }
  if (/Failed to download Guidepup cache asset[^\n]*\(429 ?\)/.test(text)) {
    return "the release host rate-limited this machine's Guidepup download (HTTP 429)";
  }
  return undefined;
}
