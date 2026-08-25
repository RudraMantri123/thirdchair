/**
 * INGESTION accuracy: what actually lands in the transcript.
 *
 * This is deliberately end-to-end through `LocalSttStream` — VAD, pre-roll,
 * segmentation, conditioning, whisper, hallucination filter — rather than
 * calling the recognizer directly. Those stages are where most real errors
 * come from, and a direct whisper call measures none of them.
 *
 * Three failure modes are reported separately, because they need different
 * fixes:
 *   WER        - words wrong once the audio reached the model
 *   splits     - one spoken sentence arriving as several transcript entries
 *   drops      - a spoken utterance producing no entry at all
 *
 * A split matters more than it looks: whisper is markedly worse on fragments
 * than on whole sentences, so a bad segmentation decision costs accuracy
 * twice.
 *
 * Run: npx tsx scripts/ingest-eval.ts
 */
import { LocalSttStream } from "../server/stt-local.ts";
import { testSpeech } from "./lib/test-speech.ts";
import { MIC_SAMPLE_RATE } from "../shared/protocol.ts";
import { normalizedWer, normalizeForScoring } from "./lib/normalize-text.ts";

const FRAME = 2048; // 128 ms, matching the capture worklet
const RATE = MIC_SAMPLE_RATE;

/** A short meeting: proper nouns, numbers, acronyms, and a thinking pause. */
interface Utterance {
  text: string;
  /** Silence after this utterance, ms. A mid-sentence pause is < 1000. */
  gapMs: number;
}

const SCRIPT: Utterance[] = [
  { text: "hey copilot what did we decide about the enterprise pricing", gapMs: 1400 },
  { text: "Priya said the tier lands at forty nine dollars a seat", gapMs: 1400 },
  // A thinking pause mid-sentence: the classic segmentation trap.
  { text: "the Kubernetes migration is blocked on", gapMs: 850 },
  { text: "the vendor contract review", gapMs: 1400 },
  { text: "Arjun owns the SOC two questionnaire and ships it Friday", gapMs: 1400 },
  { text: "our churn last quarter was three point one percent", gapMs: 1400 },
];

const REFERENCE = SCRIPT.map((u) => u.text).join(" ");

const norm = normalizeForScoring;
const wer = normalizedWer;

/** Feed audio through the real stream and collect what it commits. */
async function ingest(
  opts: { noise: number; gain: number; prompt: boolean },
): Promise<string[]> {
  const stream = new LocalSttStream();
  const committed: string[] = [];
  stream.on("committed", (t) => committed.push(t));
  stream.on("error", (e) => console.error(`    [stt error] ${e.slice(0, 90)}`));
  if (opts.prompt) {
    stream.promptProvider = () =>
      "Meeting transcript. Recurring names and terms: Priya, Arjun, Kubernetes, SOC two, enterprise tier, churn.";
  }
  stream.start();

  const send = (samples: Int16Array) => {
    stream.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  };
  const silence = (ms: number) => {
    const frames = Math.round(ms / 128);
    for (let i = 0; i < frames; i++) {
      const f = new Int16Array(FRAME);
      if (opts.noise) {
        for (let j = 0; j < FRAME; j++) f[j] = (Math.random() * 2 - 1) * opts.noise;
      }
      send(f);
    }
  };

  silence(1200); // room tone so the detector has a floor
  for (const u of SCRIPT) {
    const clean = await testSpeech(u.text, RATE);
    for (let off = 0; off < clean.length; off += FRAME) {
      const chunk = clean.subarray(off, Math.min(off + FRAME, clean.length));
      const f = new Int16Array(FRAME);
      for (let j = 0; j < chunk.length; j++) {
        let v = chunk[j] * opts.gain;
        if (opts.noise) v += (Math.random() * 2 - 1) * opts.noise;
        f[j] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
      send(f);
    }
    silence(u.gapMs);
  }
  silence(1200);

  // Let queued transcriptions finish.
  await new Promise((r) => setTimeout(r, 2500));
  stream.stop();
  return committed;
}

const CONDITIONS = [
  { label: "clean", noise: 0, gain: 1 },
  { label: "office noise", noise: 700, gain: 1 },
  { label: "quiet speaker", noise: 200, gain: 0.15 },
];

async function main() {
  const model = process.env.WHISPER_LABEL ?? "current model";
  console.log(`\nIngestion accuracy — ${model}`);
  console.log(`  reference: ${norm(REFERENCE).length} words in ${SCRIPT.length} utterances\n`);

  for (const usePrompt of [false, true]) {
    console.log(`  ${usePrompt ? "with" : "without"} vocabulary prompt:`);
    for (const c of CONDITIONS) {
      const got = await ingest({ noise: c.noise, gain: c.gain, prompt: usePrompt });
      const joined = got.join(" ");
      const w = wer(REFERENCE, joined) * 100;
      const splits = Math.max(0, got.length - SCRIPT.length);
      const drops = Math.max(0, SCRIPT.length - got.length);
      console.log(
        `    ${c.label.padEnd(15)} WER ${w.toFixed(1).padStart(5)}%   entries ${String(
          got.length,
        ).padStart(2)}/${SCRIPT.length}  splits ${splits}  drops ${drops}`,
      );
      if (process.env.VERBOSE) {
        for (const g of got) console.log(`        · ${g}`);
      }
    }
  }
  console.log("");
}

void main();
