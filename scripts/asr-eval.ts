/**
 * How much can we raise the recognition rate without changing the model?
 *
 * Tests each lever independently, across the input conditions a real meeting
 * produces, and reports word error rate. Levers:
 *
 *   highpass  - remove DC offset and rumble (server/audio/preprocess.ts)
 *   gain      - normalize toward the level the model was trained on
 *   prompt    - bias decoding with the meeting's own vocabulary
 *   beam      - beam search instead of greedy decoding
 *
 * Run: npx tsx scripts/asr-eval.ts
 */
import { encodeWav } from "../server/audio/wav.ts";
import {
  highPassInPlace,
  normalizeGainInPlace,
  padToMinimum,
} from "../server/audio/preprocess.ts";
import { testSpeech } from "./lib/test-speech.ts";

const WHISPER = process.env.WHISPER_URL ?? "http://localhost:8788";
const RATE = 16000;

const SENTENCE =
  "Priya and Arjun agreed the Kubernetes migration slips to Q3 and the enterprise tier stays at forty nine dollars";

// What a real deployment would have: names and topics already in the
// transcript. This is free context the recognizer is otherwise denied.
const VOCAB_PROMPT =
  "Meeting notes. Attendees: Priya, Arjun. Topics: Kubernetes migration, enterprise tier pricing, Q3 roadmap, churn.";

interface Opts {
  highpass?: boolean;
  gain?: boolean;
  prompt?: string;
  beam?: number;
}

async function transcribe(pcm: Int16Array, o: Opts): Promise<string> {
  const work = Int16Array.from(pcm);
  if (o.highpass) highPassInPlace(work, RATE);
  if (o.gain) normalizeGainInPlace(work);
  const padded = padToMinimum(work, RATE);

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(encodeWav(padded, RATE))], { type: "audio/wav" }),
    "a.wav",
  );
  form.append("response_format", "json");
  if (o.prompt) form.append("prompt", o.prompt);
  if (o.beam) form.append("beam_size", String(o.beam));
  const res = await fetch(`${WHISPER}/inference`, { method: "POST", body: form });
  const j = (await res.json()) as { text?: string };
  return (j.text ?? "").replace(/\s+/g, " ").trim();
}

function wer(reference: string, got: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const r = norm(reference);
  const h = norm(got);
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) =>
    Array.from({ length: h.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
    }
  }
  return d[r.length][h.length] / Math.max(1, r.length);
}

/** Degrade clean speech the way a real room does. */
function degrade(
  src: Int16Array,
  kind: "clean" | "quiet" | "noisy" | "dc" | "quiet+noisy",
): Int16Array {
  const out = new Int16Array(src.length);
  const gain = kind === "quiet" || kind === "quiet+noisy" ? 0.08 : 1;
  const noise = kind === "noisy" || kind === "quiet+noisy" ? 900 : 0;
  const dc = kind === "dc" ? 2500 : 0;
  for (let i = 0; i < src.length; i++) {
    // Low-frequency rumble plus broadband hiss, which is what HVAC sounds like.
    const rumble = noise ? Math.sin((2 * Math.PI * 45 * i) / RATE) * noise * 1.5 : 0;
    const hiss = noise ? (Math.random() * 2 - 1) * noise : 0;
    const v = src[i] * gain + rumble + hiss + dc;
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

const LEVERS: { label: string; opts: Opts }[] = [
  { label: "baseline", opts: {} },
  { label: "+highpass", opts: { highpass: true } },
  { label: "+gain", opts: { gain: true } },
  { label: "+highpass+gain", opts: { highpass: true, gain: true } },
  { label: "+hp+gain+prompt", opts: { highpass: true, gain: true, prompt: VOCAB_PROMPT } },
  { label: "+hp+gain+prompt+beam", opts: { highpass: true, gain: true, prompt: VOCAB_PROMPT, beam: 5 } },
];

const CONDITIONS = ["clean", "quiet", "noisy", "dc", "quiet+noisy"] as const;

async function main() {
  console.log(`\nASR eval — WER by condition and lever (lower is better)\n`);
  const src = await testSpeech(SENTENCE, RATE);
  console.log(`  reference: "${SENTENCE}"`);
  console.log(`  ${(src.length / RATE).toFixed(1)}s of speech\n`);

  const header = ["lever".padEnd(22), ...CONDITIONS.map((c) => c.padStart(11))].join("");
  console.log(`  ${header}`);
  console.log(`  ${"-".repeat(header.length)}`);

  const totals = new Map<string, number>();
  for (const lever of LEVERS) {
    const cells: string[] = [];
    let sum = 0;
    for (const cond of CONDITIONS) {
      const pcm = degrade(src, cond);
      const text = await transcribe(pcm, lever.opts);
      const w = wer(SENTENCE, text) * 100;
      sum += w;
      cells.push(`${w.toFixed(1)}%`.padStart(11));
    }
    totals.set(lever.label, sum / CONDITIONS.length);
    console.log(`  ${lever.label.padEnd(22)}${cells.join("")}`);
  }

  console.log(`\n  mean WER across conditions:`);
  const sorted = [...totals.entries()].sort((a, b) => a[1] - b[1]);
  for (const [label, mean] of sorted) {
    console.log(`    ${label.padEnd(22)} ${mean.toFixed(1)}%`);
  }
  const best = sorted[0];
  const base = totals.get("baseline")!;
  console.log(
    `\n  best: ${best[0]} — ${base.toFixed(1)}% -> ${best[1].toFixed(1)}% (${(
      ((base - best[1]) / Math.max(base, 0.001)) * 100
    ).toFixed(0)}% relative reduction)\n`,
  );
}

void main();
