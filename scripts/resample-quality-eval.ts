/**
 * Does naive resampling in the capture path damage the signal?
 *
 * The OS hands us 48 kHz on most machines. An earlier version of the capture
 * worklet decimated 3:1 to 16 kHz with linear interpolation and NO
 * anti-aliasing lowpass, so everything above 8 kHz folded back into the
 * speech band. This measures that two ways:
 *
 *   1. A pure 10 kHz tone. Correct decimation removes it (above Nyquist);
 *      unfiltered decimation folds it to |10000-16000| = 6000 Hz, so energy
 *      at 6 kHz is direct proof of aliasing.
 *   2. Real speech transcribed by the same whisper-server the app uses.
 *
 * The "fixed" path calls the SHIPPING resampler (server/audio/resample.ts)
 * rather than a copy, so this eval keeps testing what actually runs.
 *
 * Honest result: the aliasing is unambiguous and large, but on synthesized
 * speech it produced no measurable transcription difference — TTS voices are
 * band-limited and have little above 8 kHz to alias. Treat the fix as
 * correctness, not as a proven accuracy win.
 *
 * Run: npx tsx scripts/resample-quality-eval.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "../server/audio/wav.ts";
import { resamplePcm16 } from "../server/audio/resample.ts";
import { testSpeech } from "./lib/test-speech.ts";

const WHISPER = process.env.WHISPER_URL ?? "http://localhost:8788";
const TMP = tmpdir();
const SOURCE_RATE = 48000;
const TARGET_RATE = 16000;

const SENTENCE =
  "The enterprise tier costs fifty six dollars per seat and Priya ships the security fixes this Friday";

/** What the worklet used to do: linear interpolation, no filter. */
function linearDecimate(pcm: Int16Array, from: number, to: number): Int16Array {
  const ratio = from / to;
  const out = new Int16Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = pcm[idx] ?? 0;
    const b = pcm[idx + 1] ?? 0;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/** Goertzel magnitude at one frequency — a cheap single-bin DFT. */
function magnitudeAt(pcm: Int16Array, freq: number, rate: number): number {
  const w = (2 * Math.PI * freq) / rate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s0 = pcm[i] / 32768 + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.abs(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / pcm.length;
}

async function transcribe(pcm: Int16Array): Promise<string> {
  const path = join(TMP, `tc-rs-${Math.abs(pcm[100] ?? 0)}-${pcm.length}.wav`);
  writeFileSync(path, encodeWav(pcm, TARGET_RATE));
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(readFileSync(path))]), "a.wav");
  form.append("response_format", "json");
  const res = await fetch(`${WHISPER}/inference`, { method: "POST", body: form });
  const j = (await res.json()) as { text?: string };
  return (j.text ?? "").replace(/\s+/g, " ").trim();
}

/** Word error rate, ignoring case and punctuation. */
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

async function main() {
  console.log("\n=== 1. Aliasing: a 10 kHz tone decimated 48k -> 16k ===\n");
  const tone = new Int16Array(SOURCE_RATE);
  for (let i = 0; i < tone.length; i++) {
    tone[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 10000 * i) / SOURCE_RATE));
  }
  for (const [name, out] of [
    ["linear (old)", linearDecimate(tone, SOURCE_RATE, TARGET_RATE)],
    ["filtered (shipping)", resamplePcm16(tone, SOURCE_RATE, TARGET_RATE)],
  ] as const) {
    const alias = magnitudeAt(out, 6000, TARGET_RATE);
    console.log(
      `  ${name.padEnd(20)} alias@6kHz = ${alias.toFixed(5)}  (${
        alias > 0.01 ? "ALIASING PRESENT" : "clean"
      })`,
    );
  }

  console.log("\n=== 2. Speech through each resampler, same STT ===\n");
  const src = await testSpeech(SENTENCE, SOURCE_RATE);
  console.log(`  source: ${SOURCE_RATE} Hz, ${(src.length / SOURCE_RATE).toFixed(1)}s\n`);

  const variants: [string, Int16Array][] = [
    ["linear interp (old)", linearDecimate(src, SOURCE_RATE, TARGET_RATE)],
    ["filtered (shipping)", resamplePcm16(src, SOURCE_RATE, TARGET_RATE)],
  ];

  // macOS ships a high-quality resampler we can use as an independent
  // reference. Skipped elsewhere — it is a cross-check, not a dependency.
  if (process.platform === "darwin") {
    try {
      const a = join(TMP, "tc-af-src.wav");
      const b = join(TMP, "tc-af-out.wav");
      writeFileSync(a, encodeWav(src, SOURCE_RATE));
      execFileSync("afconvert", [
        "-f", "WAVE", "-d", `LEI16@${TARGET_RATE}`,
        "-q", "127", "--src-complexity", "bats", a, b,
      ]);
      const { decodeWav } = await import("../server/audio/wav.ts");
      variants.push(["afconvert (OS reference)", decodeWav(readFileSync(b)).pcm]);
    } catch {
      console.log("  (afconvert unavailable, skipping OS reference)");
    }
  }

  for (const [name, pcm] of variants) {
    const text = await transcribe(pcm);
    console.log(`  ${name.padEnd(26)} WER ${(wer(SENTENCE, text) * 100).toFixed(1)}%`);
    console.log(`    "${text}"`);
  }
  console.log("");
}

void main();
