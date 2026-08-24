/**
 * Voice-activity detection across realistic room conditions.
 *
 * The capture path currently gates on a FIXED RMS threshold
 * (THIRDCHAIR_VAD_THRESHOLD, default 600). A fixed number cannot be right
 * across a quiet room and a noisy one, a headset mic and a laptop mic 2 m
 * away, or a loud talker and a quiet one. This measures where it fails and
 * compares an adaptive noise-floor detector on the same signals.
 *
 * Reported per condition:
 *   detected  - was the utterance found at all
 *   onset     - how much of the first word was clipped off (ms late)
 *   falsePos  - did silence/noise alone trigger speech
 *
 * Run: npx tsx scripts/vad-eval.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdaptiveVad } from "../server/audio/vad.ts";

const RATE = 16000;
const FRAME = 2048; // 128 ms, matching the capture worklet
const FIXED_THRESHOLD = 600;

function speechPcm(): Float32Array {
  const path = join(tmpdir(), "tc-vad-src.wav");
  execFileSync("say", [
    "-o", path, `--data-format=LEI16@${RATE}`,
    "we agreed the enterprise tier lands at forty nine dollars a seat",
  ]);
  const buf = readFileSync(path);
  let offset = 12;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") data = buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!data) throw new Error("no data chunk");
  const n = Math.floor(data.length / 2);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = data.readInt16LE(i * 2) / 32768;
  return pcm;
}

const SPEECH = speechPcm();

/** Build: 2 s of noise floor, then speech scaled to `gain`, then 1 s noise. */
function scenario(gain: number, noise: number): { pcm: Float32Array; speechStart: number } {
  const lead = RATE * 2;
  const tail = RATE;
  const pcm = new Float32Array(lead + SPEECH.length + tail);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (Math.random() * 2 - 1) * noise;
  for (let i = 0; i < SPEECH.length; i++) pcm[lead + i] += SPEECH[i] * gain;
  return { pcm, speechStart: lead };
}

function rms(frame: Float32Array): number {
  let sum = 0;
  for (const s of frame) sum += s * s;
  return Math.sqrt(sum / Math.max(1, frame.length)) * 32768;
}

interface Result { detected: boolean; onsetMs: number; falsePos: boolean }

function runFixed(pcm: Float32Array, speechStart: number): Result {
  let firstHit = -1;
  let falsePos = false;
  for (let off = 0; off + FRAME <= pcm.length; off += FRAME) {
    const loud = rms(pcm.subarray(off, off + FRAME)) >= FIXED_THRESHOLD;
    if (!loud) continue;
    if (off + FRAME <= speechStart) falsePos = true;
    else if (firstHit < 0) firstHit = off;
  }
  return {
    detected: firstHit >= 0,
    onsetMs: firstHit < 0 ? Infinity : ((firstHit - speechStart) / RATE) * 1000,
    falsePos,
  };
}

function runAdaptive(pcm: Float32Array, speechStart: number): Result {
  const vad = new AdaptiveVad();
  let firstHit = -1;
  let falsePos = false;
  for (let off = 0; off + FRAME <= pcm.length; off += FRAME) {
    const speech = vad.push(rms(pcm.subarray(off, off + FRAME)));
    if (!speech) continue;
    if (off + FRAME <= speechStart) falsePos = true;
    else if (firstHit < 0) firstHit = off;
  }
  return {
    detected: firstHit >= 0,
    onsetMs: firstHit < 0 ? Infinity : ((firstHit - speechStart) / RATE) * 1000,
    falsePos,
  };
}

const CONDITIONS: { label: string; gain: number; noise: number }[] = [
  { label: "headset, quiet room",      gain: 1.0,  noise: 0.0005 },
  { label: "laptop mic, quiet room",   gain: 0.35, noise: 0.001 },
  { label: "laptop mic, office hum",   gain: 0.35, noise: 0.006 },
  { label: "distant speaker (2m)",     gain: 0.10, noise: 0.002 },
  { label: "distant + noisy room",     gain: 0.10, noise: 0.008 },
  { label: "very quiet talker",        gain: 0.04, noise: 0.001 },
  { label: "loud fan, no speech",      gain: 0.0,  noise: 0.020 },
  { label: "hot mic / clipping",       gain: 3.0,  noise: 0.001 },
  // Open-plan office / cafe: the room alone is louder than the fixed
  // threshold, so it can neither stay quiet nor find a soft talker.
  { label: "loud AC, no speech",       gain: 0.0,  noise: 0.050 },
  { label: "quiet talker, loud room",  gain: 0.08, noise: 0.050 },
];

console.log(`\nVAD eval — fixed threshold ${FIXED_THRESHOLD} vs adaptive noise floor\n`);
console.log("  condition                 | fixed                      | adaptive");
console.log("  --------------------------+----------------------------+---------------------------");

let fixedScore = 0;
let adaptiveScore = 0;
for (const c of CONDITIONS) {
  const { pcm, speechStart } = scenario(c.gain, c.noise);
  const expectSpeech = c.gain > 0;
  const f = runFixed(pcm, speechStart);
  const a = runAdaptive(pcm, speechStart);

  const verdict = (r: Result) => {
    if (!expectSpeech) return r.falsePos || r.detected ? "FALSE TRIGGER" : "correctly silent";
    if (!r.detected) return "MISSED";
    const late = r.onsetMs > 200 ? ` (+${r.onsetMs.toFixed(0)}ms late)` : "";
    return `${r.falsePos ? "detected, noise-trig" : "detected"}${late}`;
  };
  const ok = (r: Result) =>
    expectSpeech ? r.detected && !r.falsePos && r.onsetMs <= 200 : !r.detected && !r.falsePos;
  if (ok(f)) fixedScore++;
  if (ok(a)) adaptiveScore++;

  console.log(
    `  ${c.label.padEnd(25)} | ${verdict(f).padEnd(26)} | ${verdict(a)}`,
  );
}

console.log(
  `\n  conditions handled correctly — fixed: ${fixedScore}/${CONDITIONS.length}   adaptive: ${adaptiveScore}/${CONDITIONS.length}\n`,
);
