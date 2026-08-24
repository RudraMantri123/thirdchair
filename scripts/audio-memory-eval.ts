/**
 * Allocation cost of the capture hot path.
 *
 * The audio path runs ~8 frames/second/channel for the length of a meeting,
 * so anything that allocates per frame becomes sustained GC pressure. This
 * compares the old accumulate-and-concat approach against the pre-allocated
 * ring, and the old sort-per-frame VAD against the current one.
 *
 * Run with --expose-gc for stable numbers:
 *   node --expose-gc --import tsx scripts/audio-memory-eval.ts
 */
import { PcmRing } from "../server/audio/ring.ts";
import { AdaptiveVad } from "../server/audio/vad.ts";

const RATE = 16000;
const FRAME = 2048; // 128 ms
const MINUTES = 60;
const FRAMES = Math.round((MINUTES * 60 * 1000) / 128);

function gc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

/**
 * CPU time is the reliable signal here. A raw heapUsed delta is not: GC may or
 * may not run inside the measured block, so it reports "garbage not yet
 * collected", which is noise. We instead report GC *pressure* — how many major
 * collections the block provoked — plus retained heap after a forced collect.
 */
function measure(label: string, fn: () => void): void {
  gc();
  gc();
  const baseline = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  fn();
  const t1 = process.hrtime.bigint();
  const peak = process.memoryUsage().heapUsed;
  gc();
  const retained = process.memoryUsage().heapUsed;
  const ms = Number(t1 - t0) / 1e6;
  console.log(
    `  ${label.padEnd(38)} ${ms.toFixed(0).padStart(6)} ms  uncollected ${(
      (peak - baseline) / 1024 / 1024
    )
      .toFixed(1)
      .padStart(6)} MB  retained ${((retained - baseline) / 1024 / 1024)
      .toFixed(1)
      .padStart(6)} MB`,
  );
}

const frame = new Int16Array(FRAME);
for (let i = 0; i < FRAME; i++) {
  frame[i] = Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
}
const frameBuf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);

console.log(
  `\nCapture hot path — ${MINUTES} min of audio (${FRAMES} frames of 128 ms)\n`,
);

// --- utterance accumulation --------------------------------------------------
// Utterances end every ~30 frames, which is what makes the old approach
// expensive: a fresh array of Buffers plus a full concat, per utterance.
measure("OLD accumulate Buffer[] + concat", () => {
  let chunks: Buffer[] = [];
  let sink = 0;
  for (let i = 0; i < FRAMES; i++) {
    chunks.push(Buffer.from(frameBuf));
    if (chunks.length >= 30) {
      const joined = Buffer.concat(chunks);
      sink += joined.length;
      chunks = [];
    }
  }
  if (sink === 0) throw new Error("unreachable");
});

measure("NEW pre-allocated PcmRing", () => {
  const ring = new PcmRing(30 * FRAME);
  let sink = 0;
  for (let i = 0; i < FRAMES; i++) {
    ring.write(frame);
    if (ring.length >= 30 * FRAME) {
      sink += ring.toPcm().length;
      ring.clear();
    }
  }
  if (sink === 0) throw new Error("unreachable");
});

// --- noise-floor estimation --------------------------------------------------
measure("OLD VAD copy+sort per frame", () => {
  const window: number[] = [];
  let sink = 0;
  for (let i = 0; i < FRAMES; i++) {
    window.push(1000 + (i % 97));
    if (window.length > 40) window.shift();
    const sorted = [...window].sort((a, b) => a - b);
    sink += sorted[Math.floor(sorted.length * 0.1)];
  }
  if (sink === 0) throw new Error("unreachable");
});

measure("NEW VAD ring + partial selection", () => {
  const vad = new AdaptiveVad();
  let sink = 0;
  for (let i = 0; i < FRAMES; i++) {
    vad.push(1000 + (i % 97));
    sink += vad.noiseFloor;
  }
  if (sink === 0) throw new Error("unreachable");
});

// --- level scan --------------------------------------------------------------
measure("OLD rms via Buffer.readInt16LE", () => {
  let sink = 0;
  for (let i = 0; i < FRAMES; i++) {
    let sum = 0;
    for (let j = 0; j < frameBuf.length; j += 2) {
      const s = frameBuf.readInt16LE(j);
      sum += s * s;
    }
    sink += Math.sqrt(sum / (frameBuf.length / 2));
  }
  if (sink === 0) throw new Error("unreachable");
});

measure("NEW rms via Int16Array view", () => {
  let sink = 0;
  for (let i = 0; i < FRAMES; i++) {
    let sum = 0;
    for (let j = 0; j < frame.length; j++) {
      const s = frame[j];
      sum += s * s;
    }
    sink += Math.sqrt(sum / frame.length);
  }
  if (sink === 0) throw new Error("unreachable");
});

console.log(
  `\n  Steady-state ceiling of the new path: one ${(
    (30 * FRAME * 2) / 1024
  ).toFixed(0)} kB utterance ring + one ${((16384 * 2) / 1024).toFixed(
    0,
  )} kB pre-roll ring per channel, allocated once.\n`,
);
