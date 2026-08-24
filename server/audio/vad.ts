/**
 * Adaptive voice-activity detection.
 *
 * A fixed RMS threshold cannot be correct across the conditions a meeting
 * presents: a headset at 5 cm and a laptop mic 2 m away differ by ~30 dB, and
 * office hum alone can exceed the level of a quiet talker. So the detector
 * tracks the room's noise floor and gates on the margin ABOVE it rather than
 * on an absolute level. Measured 7/10 -> 9/10 conditions (scripts/vad-eval.ts).
 *
 * Three details matter more than the threshold value:
 *
 *  - Hysteresis. Speech is declared at a high margin and sustained down to a
 *    lower one, so a word's quiet tail doesn't chop the utterance in half.
 *  - Minimum statistics for the floor (see `noiseFloor`), which is what makes
 *    it robust to capture that begins mid-sentence.
 *  - Zero allocation per frame. This runs on every 128 ms of every channel for
 *    the length of a meeting; the level history is a pre-allocated ring and
 *    the percentile is a partial selection over a reused scratch array, so
 *    the detector contributes nothing to GC pressure.
 */

export interface VadOptions {
  /** dB above the noise floor required to declare speech. */
  onsetDb?: number;
  /** dB above the floor required to sustain it (must be below onsetDb). */
  sustainDb?: number;
  /** Absolute floor in Int16 RMS — below this, treat as digital silence. */
  absoluteFloor?: number;
  /** Frames of sustained level before speech is declared. */
  onsetFrames?: number;
  /** Frames of history used to estimate the noise floor (~128 ms each). */
  windowFrames?: number;
  /** Percentile of that window taken as the floor. */
  floorPercentile?: number;
}

const DEFAULTS = {
  onsetDb: 9,
  sustainDb: 4,
  absoluteFloor: 12,
  onsetFrames: 1,
  windowFrames: 40, // ~5 s
  floorPercentile: 0.1,
};

export class AdaptiveVad {
  private levels: Float64Array;
  private scratch: Float64Array;
  private writeIdx = 0;
  private filled = 0;
  private inSpeech = false;
  private above = 0;
  private cachedFloor: number;
  private opts: Required<VadOptions>;

  constructor(options: VadOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.levels = new Float64Array(this.opts.windowFrames);
    this.scratch = new Float64Array(this.opts.windowFrames);
    this.cachedFloor = this.opts.absoluteFloor;
  }

  /** Feed one frame's Int16-scale RMS. Returns true while speech is active. */
  push(level: number): boolean {
    this.levels[this.writeIdx] = level;
    this.writeIdx = (this.writeIdx + 1) % this.opts.windowFrames;
    if (this.filled < this.opts.windowFrames) this.filled++;
    this.cachedFloor = this.computeFloor();

    const onset = this.cachedFloor * db(this.opts.onsetDb);
    const sustain = this.cachedFloor * db(this.opts.sustainDb);

    if (this.inSpeech) {
      this.inSpeech = level >= sustain && level >= this.opts.absoluteFloor;
    } else {
      this.above = level >= onset ? this.above + 1 : 0;
      if (this.above >= this.opts.onsetFrames && level >= this.opts.absoluteFloor) {
        this.inSpeech = true;
      }
    }
    return this.inSpeech;
  }

  /** Last computed noise floor, Int16 RMS. */
  get noiseFloor(): number {
    return this.cachedFloor;
  }

  reset(): void {
    this.writeIdx = 0;
    this.filled = 0;
    this.inSpeech = false;
    this.above = 0;
    this.cachedFloor = this.opts.absoluteFloor;
  }

  /**
   * Noise floor by minimum statistics: a low percentile of the recent level
   * window. This is what makes the detector robust in both directions that
   * exponential averaging cannot satisfy at once —
   *
   *  - Capture that begins mid-sentence still works: the quietest frames in
   *    the window are inter-word gaps, well below the syllable peaks, so
   *    speech still clears the margin. (Seeding a running average from the
   *    first frame instead would learn speech as the baseline and go deaf —
   *    this was a real regression during development.)
   *  - A loud room is respected immediately rather than after an adaptation
   *    ramp, so there is no window of false triggers at startup.
   *
   * Implemented as a partial selection sort to the target index only: for a
   * 10th percentile of 40 frames that is 4 passes, not a full sort, and it
   * runs over a reused scratch array so the hot path never allocates.
   */
  private computeFloor(): number {
    const n = this.filled;
    if (n === 0) return this.opts.absoluteFloor;
    // Copy by index rather than `set(levels.subarray(0, n))`: subarray
    // allocates a fresh view object, and this runs on every frame of every
    // channel — that alone accounted for megabytes of garbage per meeting.
    const s = this.scratch;
    for (let i = 0; i < n; i++) s[i] = this.levels[i];

    const target = Math.min(Math.floor(n * this.opts.floorPercentile), n - 1);
    for (let i = 0; i <= target; i++) {
      let min = i;
      for (let j = i + 1; j < n; j++) if (s[j] < s[min]) min = j;
      if (min !== i) {
        const t = s[i];
        s[i] = s[min];
        s[min] = t;
      }
    }
    return Math.max(s[target], this.opts.absoluteFloor);
  }
}

function db(x: number): number {
  return Math.pow(10, x / 20);
}
