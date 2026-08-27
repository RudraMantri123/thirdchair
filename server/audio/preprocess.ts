/**
 * Signal conditioning applied to an utterance before transcription.
 *
 * Speech models are trained on level-normalized, DC-free audio. Real capture
 * is neither: laptop mics carry a DC bias and low-frequency rumble (HVAC,
 * desk thumps, handling noise), and input level varies by tens of dB between
 * a headset and someone across the room. Feeding that in raw wastes model
 * capacity on conditions it never saw in training.
 *
 * Everything here works IN PLACE on an Int16Array. No allocation, single
 * pass, so it can run on every utterance without adding GC pressure to the
 * hot path.
 */

/**
 * One-pole high-pass. Removes DC offset and rumble below `cutoffHz` while
 * leaving speech fundamentals (85 Hz and up for adult voices) intact.
 *
 * Deliberately gentle: an aggressive filter thins male voices and costs more
 * accuracy than the rumble it removes.
 */
export function highPassInPlace(
  pcm: Int16Array,
  sampleRate: number,
  cutoffHz = 70,
): void {
  if (pcm.length === 0) return;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const a = rc / (rc + dt);
  let prevIn = pcm[0];
  let prevOut = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i];
    const y = a * (prevOut + x - prevIn);
    prevIn = x;
    prevOut = y;
    pcm[i] = y > 32767 ? 32767 : y < -32768 ? -32768 : y;
  }
}

export interface LevelStats {
  rms: number;
  peak: number;
  appliedGain: number;
}

/**
 * Scale the utterance toward a target RMS, without ever clipping.
 *
 * The gain is capped by headroom (so a loud passage cannot be pushed into
 * distortion) and by `maxGain` (so near-silence is not amplified into a wall
 * of noise, which produces confident hallucinated transcripts — the worst
 * possible failure for a meeting assistant).
 */
export function normalizeGainInPlace(
  pcm: Int16Array,
  targetRms = 2600,
  maxGain = 8,
  /** Fraction of full scale the loudest sample may reach. */
  peakCeiling = 0.89,
): LevelStats {
  if (pcm.length === 0) return { rms: 0, peak: 0, appliedGain: 1 };

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i];
    sumSquares += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSquares / pcm.length);
  if (rms < 1 || peak === 0) return { rms, peak, appliedGain: 1 };

  // Whisper's log-mel front-end is NOT gain-invariant: the
  // `max(log_spec, log_spec.max() - 8)` step is a FLOOR, not a
  // max-subtraction, so absolute level survives as a uniform offset of
  // 0.5*log10(gain) on the encoder input. What the front-end effectively pins
  // is PEAK mel power, so a peak ceiling is better aligned with it than RMS
  // alone — we target RMS but never let the peak exceed the ceiling.
  const headroom = (32767 * peakCeiling) / peak;
  const gain = Math.min(targetRms / rms, headroom, maxGain);
  if (gain > 0.99 && gain < 1.01) return { rms, peak, appliedGain: 1 };

  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] * gain;
    pcm[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return { rms, peak, appliedGain: gain };
}

/**
 * Whisper reasons over a 30 s window and is measurably worse on very short
 * clips, so pad a brief utterance with trailing silence. Returns the original
 * array when no padding is needed, so the common case allocates nothing.
 */
export function padToMinimum(
  pcm: Int16Array,
  sampleRate: number,
  minMs = 1000,
): Int16Array {
  const minSamples = Math.ceil((minMs / 1000) * sampleRate);
  if (pcm.length >= minSamples) return pcm;
  const out = new Int16Array(minSamples);
  out.set(pcm, 0);
  return out;
}
