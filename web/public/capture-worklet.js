// Runs on the audio thread. Converts float input to 16 kHz mono Int16 and
// posts ~128 ms chunks to the main thread for the websocket.
//
// Preferred path: the page creates the AudioContext at 16 kHz, so the browser
// has already resampled from the device's native rate (48 kHz on most Macs)
// using its own high-quality resampler, and this processor only casts to
// Int16. Chrome honours the request; Safari and Firefox historically do not.
//
// Fallback path: when the context is running at some other rate, we resample
// here — with a windowed-sinc lowpass BEFORE decimating. Filtering is the
// whole point. An earlier version used bare linear interpolation, which folds
// everything above 8 kHz back into the speech band (a 10 kHz tone reappeared
// at 6 kHz with half its amplitude). Never decimate without a lowpass.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 2048; // 128 ms at 16 kHz
const TAPS = 63;

function buildLowpass(ratio) {
  // Cutoff just under the output Nyquist, expressed against the input rate.
  const cutoff = 0.45 / ratio;
  const half = (TAPS - 1) / 2;
  const h = new Float32Array(TAPS);
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const n = i - half;
    const sinc =
      n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
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

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const contextRate = (options?.processorOptions?.contextRate) || sampleRate;
    this.ratio = contextRate / TARGET_RATE;
    this.needsResample = Math.abs(this.ratio - 1) > 0.001;
    this.taps = this.needsResample ? buildLowpass(this.ratio) : null;
    // History for the filter, so chunk boundaries don't click.
    this.history = new Float32Array(TAPS);
    this.readPos = 0;
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outPos = 0;
    if (this.needsResample) {
      this.port.postMessage({
        warn: `context running at ${contextRate} Hz; resampling in the worklet`,
      });
    }
  }

  emit(sample) {
    const s = Math.max(-1, Math.min(1, sample));
    this.out[this.outPos++] = s * 0x7fff;
    if (this.outPos === CHUNK_SAMPLES) {
      this.port.postMessage(this.out.buffer, [this.out.buffer]);
      this.out = new Int16Array(CHUNK_SAMPLES);
      this.outPos = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    if (!this.needsResample) {
      for (let i = 0; i < channel.length; i++) this.emit(channel[i]);
      return true;
    }

    // Concatenate the filter history with this block so taps that straddle
    // the boundary see real samples rather than zeros.
    const buf = new Float32Array(this.history.length + channel.length);
    buf.set(this.history, 0);
    buf.set(channel, this.history.length);

    const half = (TAPS - 1) / 2;
    // Output positions land at readPos, readPos+ratio, ... within `channel`,
    // offset by the history we prepended.
    while (this.readPos + half < channel.length) {
      const center = this.history.length + Math.round(this.readPos);
      let acc = 0;
      for (let k = 0; k < TAPS; k++) {
        const idx = center + k - half;
        if (idx >= 0 && idx < buf.length) acc += buf[idx] * this.taps[k];
      }
      this.emit(acc);
      this.readPos += this.ratio;
    }
    this.readPos -= channel.length;

    this.history = buf.slice(buf.length - TAPS);
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
