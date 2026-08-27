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
/**
 * Three ways to use whisper's prompt slot, because the choice is contested.
 *
 *  none   - no bias at all.
 *  list   - a comma-separated vocabulary list. What we shipped. Research
 *           measured this raising error on words NOT in the list across 11/11
 *           datasets, and overall WER on 6/11 (arXiv 2502.11572) — which is
 *           exactly the failure seen here, where a primed name displaced
 *           "our churn".
 *  spoken - the same terms wrapped to look like the transcript of a previous
 *           utterance, which is what the slot was TRAINED to hold. Reported to
 *           move MER 4.4% -> 2.9% where the list form made it worse
 *           (arXiv 2309.09552).
 */
type PromptStyle = "none" | "list" | "spoken";

const TERMS = "Priya, Arjun, Kubernetes, SOC two, enterprise tier, churn";
const PROMPTS: Record<PromptStyle, string> = {
  none: "",
  list: `Meeting transcript. Recurring names and terms: ${TERMS}.`,
  spoken: `So, um, just to recap what we were saying about ${TERMS}. Okay, let me continue.`,
};

async function ingest(
  opts: { noise: number; gain: number; prompt: PromptStyle },
): Promise<string[]> {
  const rng = makeRng(SEED);
  const stream = new LocalSttStream();
  const committed: string[] = [];
  stream.on("committed", (t) => committed.push(t));
  stream.on("error", (e) => console.error(`    [stt error] ${e.slice(0, 90)}`));
  if (opts.prompt !== "none") {
    stream.promptProvider = () => PROMPTS[opts.prompt];
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
        for (let j = 0; j < FRAME; j++) f[j] = (rng() * 2 - 1) * opts.noise;
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
        if (opts.noise) v += (rng() * 2 - 1) * opts.noise;
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

/**
 * Repeats per cell. A single run is NOT enough to compare variants: the
 * injected noise is random and the recognizer is not perfectly
 * deterministic, and identical configurations were observed to differ by
 * several points. Without repetition this eval reports noise as signal —
 * which it did, until this was added.
 */
const REPEATS = Number(process.env.REPEATS ?? 1);

/**
 * Seeded PRNG for the injected noise.
 *
 * Unseeded noise made every run different, and the resulting run-to-run spread
 * (6-13pp on the noisy conditions) was LARGER than the differences between the
 * variants being compared — so the eval was reporting noise as signal. Seeding
 * makes each condition byte-identical across runs, which turns a comparison
 * between two configurations into an exact one.
 *
 * Set SEED to a different value to check that a conclusion is not an artifact
 * of one particular noise draw.
 */
function makeRng(seed: number): () => number {
  let x = seed || 0x9e3779b9;
  return () => {
    // xorshift32
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}
const SEED = Number(process.env.SEED ?? 12345);

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}
function spread(xs: number[]): number {
  return xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs);
}

async function main() {
  const model = process.env.WHISPER_LABEL ?? "current model";
  console.log(`\nIngestion accuracy — ${model}`);
  console.log(`  reference: ${norm(REFERENCE).length} words in ${SCRIPT.length} utterances\n`);

  console.log(`  ${REPEATS} run(s) per cell, noise seed ${SEED}; spread is max-min.\n`);
  const styles = (process.env.PROMPT_STYLES ?? "none,list,spoken").split(",") as PromptStyle[];
  for (const usePrompt of styles) {
    console.log(`  prompt style: ${usePrompt}`);
    for (const c of CONDITIONS) {
      const wers: number[] = [];
      let splits = 0;
      let drops = 0;
      let last: string[] = [];
      for (let r = 0; r < REPEATS; r++) {
        const got = await ingest({ noise: c.noise, gain: c.gain, prompt: usePrompt });
        wers.push(wer(REFERENCE, got.join(" ")) * 100);
        splits += Math.max(0, got.length - SCRIPT.length);
        drops += Math.max(0, SCRIPT.length - got.length);
        last = got;
      }
      console.log(
        `    ${c.label.padEnd(15)} WER ${mean(wers).toFixed(1).padStart(5)}% ` +
          `(spread ${spread(wers).toFixed(1).padStart(4)}pp)  splits ${splits}  drops ${drops}`,
      );
      if (process.env.VERBOSE) for (const g of last) console.log(`        · ${g}`);
    }
  }
  console.log("");
}

void main();
