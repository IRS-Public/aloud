// Turn a raw logcat dump into per-screen TalkBack transcripts.
//
// The walker (walk.mjs) logs `screen-start:<id>` / `screen-end:<id>` markers
// under the A11Y_AUDIT tag while TalkBack's verbose speech logging is on;
// this module slices the utterance lines between those markers. Pure
// functions — unit-tested on fixture logs in test/.

import { MARKER_TAG } from "./adb.mjs";

// TalkBack's utterance log line, verified against google/talkback source
// (SpeechControllerImpl.java:2041 @ 229212fd, TalkBack 16.2): logcat tag is
// `talkback: SpeechControllerImpl` (LogUtils prepends "talkback: ") and the
// line reads
//   Speaking fragment text="…", utteranceId=talkback_N, TtsSpan=…, locale=…
// Text is greedy-captured anchored on the fixed tail so embedded quotes and
// commas in the utterance survive; non-spoken items log `text=null`
// (unquoted) and are correctly not matched. Extractors are tried in order,
// first match decides the line.
export const UTTERANCE_EXTRACTORS = [
  // TalkBack 16.x (source-pinned CI build): TtsSpan field present
  { re: /Speaking fragment text="(.*)", utteranceId=talkback_\d+, TtsSpan=/, group: 1 },
  // TalkBack ~14.x (talkback-foss local spike APK; format observed live on
  // the emulator): Speaking fragment text "…" with spans … for event …
  { re: /Speaking fragment text "(.*)" with spans /, group: 1 },
  // Other intermediates — quoted text= without TtsSpan
  { re: /Speaking fragment text="(.*)", utteranceId=/, group: 1 },
];

// Noise TalkBack speaks that is real but not app content — kept OUT of the
// per-screen transcript so baselines don't churn on it.
const NOISE = [/^TalkBack on\.?$/i, /^TalkBack off\.?$/i, /^Alert$/i, /^\s*$/];

export function extractUtterance(line) {
  for (const { re, group } of UTTERANCE_EXTRACTORS) {
    const m = line.match(re);
    if (m && m[group] !== undefined) {
      // First matching extractor decides the line — falling through would
      // let a weaker pattern re-capture filtered noise with quotes intact.
      const text = m[group].replace(/\\"/g, '"').trim();
      return text && !NOISE.some((n) => n.test(text)) ? text : null;
    }
  }
  return null;
}

const markerRe = new RegExp(`\\b${MARKER_TAG}\\b.*?\\bscreen-(start|end):([\\w-]+)`);

// Returns { [screenId]: string[] } — utterances spoken while each screen was
// current. Utterances outside any marker pair (boot chatter, persona
// switches) are collected under "_between" for debugging, not baselined.
export function segmentTranscript(logcatText) {
  const screens = {};
  let current = "_between";
  screens[current] = [];
  for (const line of logcatText.split("\n")) {
    const marker = line.match(markerRe);
    if (marker) {
      const [, kind, id] = marker;
      current = kind === "start" ? id : "_between";
      if (!screens[current]) screens[current] = [];
      continue;
    }
    const utterance = extractUtterance(line);
    if (utterance !== null) {
      if (!screens[current]) screens[current] = [];
      screens[current].push(utterance);
    }
  }
  return screens;
}

// Consecutive-duplicate collapse: TalkBack re-announces on window refreshes;
// baselines compare the deduped sequence so a double-render isn't a diff.
export const dedupeConsecutive = (utterances) =>
  utterances.filter((u, i) => i === 0 || u !== utterances[i - 1]);
