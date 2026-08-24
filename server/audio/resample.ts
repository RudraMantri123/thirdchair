/**
 * Sample-rate conversion with a windowed-sinc anti-aliasing filter.
 *
 * Needed on the server because speech engines emit whatever rate they like —
 * macOS `say` can be told 24 kHz, espeak-ng gives 22.05 kHz, Windows SAPI
 * gives whatever the selected voice uses — while the client's playback path
 * expects one fixed rate.
 *
 * The filter is the point. Decimating without band-limiting first folds
 * everything above the output Nyquist back into the audible range (measured
 * on our own capture path: a 10 kHz tone reappeared at 6 kHz with half its
 * amplitude). Upsampling needs the same filter to avoid imaging.
 */

const TAPS = 63;

function buildKernel(ratio: number): Float32Array {
  // Cutoff in cycles/sample of the INPUT signal: the lower of the two
  // Nyquist limits, with a little margin for the transition band.
  const cutoff = 0.45 * Math.min(1 / ratio, 1);
  const half = (TAPS - 1) / 2;
  const h = new Float32Array(TAPS);
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const n = i - half;
    const sinc =
      n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    // Blackman window — modest transition width, very low sidelobes.
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < TAPS; i++) h[i] /= sum;
  return h;
}

/**
 * Convert mono 16-bit PCM from `from` Hz to `to` Hz. Returns the input
 * unchanged when the rates already match, which is the common case.
 */
export function resamplePcm16(
  pcm: Int16Array,
  from: number,
  to: number,
): Int16Array {
  if (from === to || pcm.length === 0) return pcm;

  const ratio = from / to;
  const h = buildKernel(ratio);
  const half = (TAPS - 1) / 2;
  const outLength = Math.floor(pcm.length / ratio);
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const center = Math.round(i * ratio);
    let acc = 0;
    for (let k = 0; k < TAPS; k++) {
      const idx = center + k - half;
      // Clamp at the edges rather than zero-padding, which would put a click
      // at the start and end of every utterance.
      const j = idx < 0 ? 0 : idx >= pcm.length ? pcm.length - 1 : idx;
      acc += pcm[j] * h[k];
    }
    out[i] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
  }
  return out;
}
