// Reconstruct speech audio from a captured transcript.
//
// One WAV per utterance, synthesized with whatever TTS the host has:
// macOS `say`, else `espeak-ng`, else skip. The audio is a reconstruction
// of the captured text, never a recording of the device. Callers must
// label it that way wherever they surface it.
//
// Used by `aloud demo`; the real legs can call reconstructSpeech() on any
// report dir's transcripts to attach reconstructed audio.
//
// Output layout under <reportDir>:
//   speech-audio/<screenId>-<i>.wav        (i = 0-based utterance index)
//   speech-audio/manifest.json
//     { "<screenId>": [ { "i": 0, "file": "speech-audio/<screenId>-0.wav",
//                         "text": "<utterance>" }, ... ] }

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hasCommand = (cmd) => spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;

// Pick the platform TTS: "say" (macOS) or "espeak-ng", null when neither exists.
export function findTts() {
  if (process.platform === "darwin" && hasCommand("say")) return "say";
  if (hasCommand("espeak-ng")) return "espeak-ng";
  return null;
}

// Synthesize one utterance to a WAV file. Returns true on success.
export function synthesizeWav(tts, text, outFile) {
  const argv =
    tts === "say"
      ? ["say", "-o", outFile, "--file-format=WAVE", "--data-format=LEI16@22050", "--", text]
      : ["espeak-ng", "-w", outFile, "--", text];
  return spawnSync(argv[0], argv.slice(1), { stdio: "ignore" }).status === 0;
}

// screens: { [screenId]: string[] } — utterances in spoken order.
// Writes the WAVs and manifest under <reportDir>/speech-audio.
// Returns { tts, files } or null when no TTS exists (prints the one skip line).
export function reconstructSpeech(screens, reportDir) {
  const tts = findTts();
  if (!tts) {
    console.log("No TTS voice found. Skipping audio reconstruction.");
    return null;
  }
  const audioDir = join(reportDir, "speech-audio");
  mkdirSync(audioDir, { recursive: true });
  const manifest = {};
  let files = 0;
  for (const [screenId, utterances] of Object.entries(screens)) {
    manifest[screenId] = [];
    utterances.forEach((text, i) => {
      const name = `${screenId}-${i}.wav`;
      if (!synthesizeWav(tts, text, join(audioDir, name))) {
        console.error(`  could not synthesize "${text}" with ${tts}; skipping that clip`);
        return;
      }
      manifest[screenId].push({ i, file: `speech-audio/${name}`, text });
      files++;
    });
  }
  writeFileSync(join(audioDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { tts, files };
}
