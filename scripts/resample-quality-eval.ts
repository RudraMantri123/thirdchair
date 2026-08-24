/**
 * Does our capture-path resampler damage speech recognition?
 *
 * The OS hands us 48 kHz. The capture worklet decimates 3:1 to 16 kHz with
 * linear interpolation and NO anti-aliasing lowpass, so everything above
 * 8 kHz folds back into the speech band as distortion. This measures the
 * damage two ways:
 *
 *   1. A pure 10 kHz tone. Correct 3:1 decimation removes it (it is above
 *      Nyquist). Unfiltered decimation folds it to |10000-16000| = 6000 Hz,
 *      so energy at 6 kHz is proof of aliasing.
 *   2. Real speech, transcribed by the same whisper-server the app uses,
 *      compared against a properly resampled reference (macOS `afconvert`).
 *
 * Run: npx tsx scripts/resample-quality-eval.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WHISPER = process.env.WHISPER_URL ?? "http://localhost:8788";
const TMP = tmpdir();

const SENTENCE =
  "The enterprise tier costs fifty six dollars per seat and Priya ships the security fixes this Friday";

// ---- WAV helpers ------------------------------------------------------------

function readWavMono(path: string): { pcm: Float32Array; rate: number } {
  const buf = readFileSync(path);
  let offset = 12;
  let rate = 0;
  let bits = 16;
  let channels = 1;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      rate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === "data") {
      data = buf.subarray(offset + 8, Math.min(offset + 8 + size, buf.length));
    }
    offset += 8 + size + (size % 2);
  }
  if (!data || bits !== 16) throw new Error(`unsupported wav: ${path}`);
  const n = Math.floor(data.length / 2 / channels);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = data.readInt16LE(i * 2 * channels) / 32768;
  return { pcm, rate };
}

function writeWavMono(path: string, pcm: Float32Array, rate: number): void {
  const header = Buffer.alloc(44);
  const bytes = pcm.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  const body = Buffer.alloc(bytes);
  for (let i = 0; i < pcm.length; i++) {
    body.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), i * 2);
  }
  writeFileSync(path, Buffer.concat([header, body]));
}

// ---- the two resamplers -----------------------------------------------------

/** Exactly what capture-worklet.js does today: linear interp, no filter. */
function linearDecimate(pcm: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = pcm[idx] ?? 0;
    const b = pcm[idx + 1] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Windowed-sinc lowpass at 0.45*to, then decimate — the correct approach. */
function filteredDecimate(pcm: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to;
  const cutoff = 0.45 / ratio; // normalized to the INPUT rate
  const taps = 63;
  const half = (taps - 1) / 2;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - half;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    // Blackman window
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;

  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const center = Math.round(i * ratio);
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const idx = center + k - half;
      if (idx >= 0 && idx < pcm.length) acc += pcm[idx] * h[k];
    }
    out[i] = acc;
  }
  return out;
}

// ---- measurement ------------------------------------------------------------

/** Goertzel magnitude at one frequency — cheap single-bin DFT. */
function magnitudeAt(pcm: Float32Array, freq: number, rate: number): number {
  const w = (2 * Math.PI * freq) / rate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s0 = pcm[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / pcm.length;
}

async function transcribe(path: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(readFileSync(path))]), "a.wav");
  form.append("response_format", "json");
  const res = await fetch(`${WHISPER}/inference`, { method: "POST", body: form });
  const j = (await res.json()) as { text?: string };
  return (j.text ?? "").replace(/\s+/g, " ").trim();
}

/** Word error rate against a reference, ignoring case and punctuation. */
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
  console.log("\n=== 1. Aliasing proof: a 10 kHz tone decimated 48k -> 16k ===\n");
  const RATE = 48000;
  const tone = new Float32Array(RATE);
  for (let i = 0; i < tone.length; i++) {
    tone[i] = 0.5 * Math.sin((2 * Math.PI * 10000 * i) / RATE);
  }
  // A 10 kHz tone is above the 8 kHz Nyquist of 16 kHz audio. Correct
  // decimation removes it; unfiltered decimation folds it to 6 kHz.
  for (const [name, fn] of [
    ["linear (current)", linearDecimate],
    ["filtered (fixed)", filteredDecimate],
  ] as const) {
    const out = fn(tone, RATE, 16000);
    const alias = magnitudeAt(out, 6000, 16000);
    const speech = magnitudeAt(out, 1000, 16000);
    console.log(
      `  ${name.padEnd(18)} alias@6kHz = ${alias.toFixed(5)}  (${
        alias > 0.01 ? "ALIASING PRESENT" : "clean"
      })`,
    );
    void speech;
  }

  console.log("\n=== 2. Speech: same audio, two resamplers, same STT ===\n");
  const src48 = join(TMP, "tc-src48.wav");
  execFileSync("say", ["-o", src48, "--data-format=LEI16@48000", SENTENCE]);
  const { pcm, rate } = readWavMono(src48);
  console.log(`  source: ${rate} Hz, ${(pcm.length / rate).toFixed(1)}s\n`);

  const variants: { name: string; path: string }[] = [];

  const lin = join(TMP, "tc-linear.wav");
  writeWavMono(lin, linearDecimate(pcm, rate, 16000), 16000);
  variants.push({ name: "linear interp (current)", path: lin });

  const fil = join(TMP, "tc-filtered.wav");
  writeWavMono(fil, filteredDecimate(pcm, rate, 16000), 16000);
  variants.push({ name: "windowed-sinc (fixed)", path: fil });

  // macOS's own high-quality resampler, as an independent reference.
  const afc = join(TMP, "tc-afconvert.wav");
  try {
    execFileSync("afconvert", [
      "-f", "WAVE", "-d", "LEI16@16000", "-q", "127", "--src-complexity", "bats",
      src48, afc,
    ]);
    variants.push({ name: "afconvert (OS reference)", path: afc });
  } catch {
    console.log("  (afconvert unavailable, skipping OS reference)");
  }

  for (const v of variants) {
    const text = await transcribe(v.path);
    const rate = wer(SENTENCE, text);
    console.log(`  ${v.name.padEnd(26)} WER ${(rate * 100).toFixed(1)}%`);
    console.log(`    "${text}"`);
  }

  // Synthetic TTS is band-limited, so it has nothing above 8 kHz to alias.
  // A real microphone in a real room does: sibilants reach past 10 kHz, and
  // so do fan noise, keyboard clicks and chair scrapes. Add that content and
  // the two resamplers stop being equivalent.
  console.log("\n=== 3. Same speech + realistic high-frequency content ===\n");
  for (const level of [0.02, 0.05, 0.1]) {
    const noisy = new Float32Array(pcm.length);
    // Tones spread over 9-21 kHz: all above the 8 kHz Nyquist of 16 kHz audio,
    // so a correct resampler discards them and a naive one folds them inward.
    const freqs = [9500, 11300, 13700, 15100, 17900, 20300];
    for (let i = 0; i < pcm.length; i++) {
      let hf = 0;
      for (const f of freqs) hf += Math.sin((2 * Math.PI * f * i) / rate);
      noisy[i] = pcm[i] + (hf / freqs.length) * level;
    }
    console.log(`  HF content at amplitude ${level}:`);
    for (const [name, fn] of [
      ["linear interp (current)", linearDecimate],
      ["windowed-sinc (fixed)", filteredDecimate],
    ] as const) {
      const p = join(TMP, `tc-noisy-${name.slice(0, 6)}-${level}.wav`);
      writeWavMono(p, fn(noisy, rate, 16000), 16000);
      const text = await transcribe(p);
      console.log(
        `    ${name.padEnd(24)} WER ${(wer(SENTENCE, text) * 100).toFixed(1)}%  "${text.slice(0, 70)}"`,
      );
    }
  }
  console.log("");
}

void main();
