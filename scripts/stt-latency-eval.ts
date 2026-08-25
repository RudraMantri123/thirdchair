/**
 * Transcription latency per model — the number that decides which model can
 * be the default.
 *
 * A bigger model is only usable if it still transcribes an utterance far
 * faster than the utterance took to speak, because transcription happens after
 * the speaker stops and sits directly in front of the spoken answer.
 *
 * Point WHISPER_URLS at one or more servers:
 *   WHISPER_URLS="base.en=http://localhost:8788,small.en=http://localhost:8789"
 *
 * Run: npx tsx scripts/stt-latency-eval.ts
 */
import { encodeWav } from "../server/audio/wav.ts";
import { testSpeech } from "./lib/test-speech.ts";

const SENTENCE =
  "Priya said the enterprise tier lands at forty nine dollars a seat and Arjun ships the SOC two questionnaire on Friday";

const TARGETS = (
  process.env.WHISPER_URLS ??
  `current=${process.env.WHISPER_URL ?? "http://localhost:8788"}`
)
  .split(",")
  .map((pair) => {
    const [label, url] = pair.split("=");
    return { label: label.trim(), url: (url ?? label).trim() };
  });

async function main() {
  const pcm = await testSpeech(SENTENCE, 16000);
  const wav = encodeWav(pcm, 16000);
  const seconds = pcm.length / 16000;

  console.log(`\nSTT latency — ${seconds.toFixed(1)}s utterance, 3 runs each\n`);
  console.log("  model        mean      realtime factor   verdict");
  console.log("  -----------------------------------------------------------");

  for (const t of TARGETS) {
    const times: number[] = [];
    let failed = false;
    for (let i = 0; i < 3; i++) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(wav)]), "a.wav");
      form.append("response_format", "json");
      const t0 = performance.now();
      try {
        const res = await fetch(`${t.url}/inference`, { method: "POST", body: form });
        await res.json();
      } catch {
        failed = true;
        break;
      }
      times.push(performance.now() - t0);
    }
    if (failed) {
      console.log(`  ${t.label.padEnd(12)} unreachable at ${t.url}`);
      continue;
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const factor = (seconds * 1000) / mean;
    // Transcription sits in front of the spoken answer, so it needs to be a
    // small fraction of the utterance to stay inside a ~1s response budget.
    const verdict =
      mean < 400 ? "comfortable" : mean < 900 ? "usable" : "too slow for voice";
    console.log(
      `  ${t.label.padEnd(12)} ${mean.toFixed(0).padStart(5)} ms   ${factor
        .toFixed(1)
        .padStart(6)}x realtime   ${verdict}`,
    );
  }
  console.log("");
}

void main();
