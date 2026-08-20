// Runs on the audio thread. Receives mixed mic (+ optional meeting tab)
// audio at the context's native sample rate, resamples to 16 kHz mono Int16,
// and posts ~128 ms buffers to the main thread for the websocket.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 2048; // 128 ms at 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.readPos = 0;
    this.input = [];
    this.inputLength = 0;
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outPos = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    this.input.push(Float32Array.from(channel));
    this.inputLength += channel.length;

    // Linear-interpolation resample from the buffered input.
    while (this.readPos + this.ratio < this.inputLength) {
      const idx = Math.floor(this.readPos);
      const frac = this.readPos - idx;
      const a = this.sampleAt(idx);
      const b = this.sampleAt(idx + 1);
      const s = a + (b - a) * frac;
      this.out[this.outPos++] = Math.max(-1, Math.min(1, s)) * 0x7fff;
      this.readPos += this.ratio;

      if (this.outPos === CHUNK_SAMPLES) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(CHUNK_SAMPLES);
        this.outPos = 0;
      }
    }

    // Drop fully-consumed input blocks to keep memory flat.
    while (this.input.length && this.readPos >= this.input[0].length) {
      this.readPos -= this.input[0].length;
      this.inputLength -= this.input[0].length;
      this.input.shift();
    }
    return true;
  }

  sampleAt(idx) {
    let i = idx;
    for (const block of this.input) {
      if (i < block.length) return block[i];
      i -= block.length;
    }
    return 0;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
