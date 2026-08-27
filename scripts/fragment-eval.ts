/**
 * What does a mid-sentence split cost?
 *
 * A thinking pause longer than the silence timeout ends the utterance, so one
 * spoken sentence reaches the recognizer as two fragments. Whisper conditions
 * on the whole clip, so a fragment loses the context that disambiguates its
 * own words. This measures the penalty directly: the same audio transcribed
 * whole, versus split at each plausible pause point.
 *
 * The result decides whether better endpointing is worth building.
 *
 * Run: npx tsx scripts/fragment-eval.ts
 */
import { encodeWav } from "../server/audio/wav.ts";
import { testSpeech } from "./lib/test-speech.ts";
import { normalizedWer } from "./lib/normalize-text.ts";

const WHISPER = process.env.WHISPER_URL ?? "http://localhost:8788";
const RATE = 16000;

const SENTENCES = [
  "the Kubernetes migration is blocked on the vendor contract review",
  "Priya said the enterprise tier lands at forty nine dollars a seat",
  "we agreed to delay the India launch until the second quarter of next year",
];

async function transcribe(pcm: Int16Array): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(encodeWav(pcm, RATE))], { type: "audio/wav" }),
    "a.wav",
  );
  form.append("response_format", "json");
  const res = await fetch(`${WHISPER}/inference`, { method: "POST", body: form });
  const j = (await res.json()) as { text?: string };
  return (j.text ?? "").replace(/\s+/g, " ").trim();
}

async function main() {
  console.log(`\nCost of a mid-sentence split (normalized WER)\n`);
  console.log("  sentence                              whole    split   penalty");
  console.log("  ---------------------------------------------------------------");

  let wholeSum = 0;
  let splitSum = 0;
  for (const sentence of SENTENCES) {
    const pcm = await testSpeech(sentence, RATE);
    const whole = await transcribe(pcm);
    const wholeWer = normalizedWer(sentence, whole) * 100;

    // Split near the middle, snapped to the quietest point in the middle
    // third — the most likely place a pause-based detector would cut.
    const from = Math.floor(pcm.length / 3);
    const to = Math.floor((pcm.length * 2) / 3);
    let quietest = from;
    let quietestEnergy = Infinity;
    const win = Math.floor(RATE * 0.05);
    for (let i = from; i < to - win; i += win) {
      let e = 0;
      for (let j = i; j < i + win; j++) e += pcm[j] * pcm[j];
      if (e < quietestEnergy) {
        quietestEnergy = e;
        quietest = i;
      }
    }
    const a = await transcribe(pcm.subarray(0, quietest));
    const b = await transcribe(pcm.subarray(quietest));
    const splitWer = normalizedWer(sentence, `${a} ${b}`) * 100;

    wholeSum += wholeWer;
    splitSum += splitWer;
    console.log(
      `  ${sentence.slice(0, 36).padEnd(36)} ${wholeWer.toFixed(1).padStart(6)}% ${splitWer
        .toFixed(1)
        .padStart(7)}% ${(splitWer - wholeWer >= 0 ? "+" : "") + (splitWer - wholeWer).toFixed(1)}pp`,
    );
    if (process.env.VERBOSE) {
      console.log(`      whole: "${whole}"`);
      console.log(`      split: "${a}" | "${b}"`);
    }
  }

  const n = SENTENCES.length;
  console.log(
    `\n  mean — whole ${(wholeSum / n).toFixed(1)}%   split ${(splitSum / n).toFixed(
      1,
    )}%   penalty ${((splitSum - wholeSum) / n).toFixed(1)}pp\n`,
  );
}

void main();
