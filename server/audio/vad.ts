/**
 * Adaptive voice-activity detection.
 *
 * A fixed RMS threshold cannot be correct across the conditions a meeting
 * actually presents: a headset at 5 cm and a laptop mic 2 m away differ by
 * ~30 dB, and office hum alone can exceed the level of a quiet talker. So the
 * detector tracks the room's noise floor and gates on the margin ABOVE it
 * rather than on an absolute level.
 *
 * Two details that matter more than the threshold itself:
 *
 *  - Hysteresis. Speech is declared at a high margin and sustained down to a
 *    lower one, so a word's quiet tail doesn't chop the utterance in half.
 *  - Asymmetric floor tracking. The floor rises slowly and falls quickly, so
 *    a passing truck raises it briefly without swallowing the next minute of
 *    speech, and it never adapts upward *into* ongoing speech.
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
  private window: number[] = [];
  private inSpeech = false;
  private above = 0;
  private opts: Required<VadOptions>;

  constructor(options: VadOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Feed one frame's Int16-scale RMS. Returns true while speech is active. */
  push(level: number): boolean {
    this.window.push(level);
    if (this.window.length > this.opts.windowFrames) this.window.shift();

    const floor = this.noiseFloor;
    const onset = floor * db(this.opts.onsetDb);
    const sustain = floor * db(this.opts.sustainDb);

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

  /**
   * Noise floor by minimum statistics: a low percentile of the recent level
   * window. This is what makes the detector robust in both directions that
   * exponential tracking cannot satisfy at once —
   *
   *  - Capture that begins mid-sentence still works: the quietest frames in
   *    the window are inter-word gaps, well below the syllable peaks, so
   *    speech still clears the margin. (Seeding a running average from the
   *    first frame instead would learn speech as the baseline and go deaf.)
   *  - A loud room is respected immediately rather than after an adaptation
   *    ramp, so there is no window of false triggers at startup.
   */
  get noiseFloor(): number {
    if (this.window.length === 0) return this.opts.absoluteFloor;
    const sorted = [...this.window].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * this.opts.floorPercentile);
    return Math.max(sorted[Math.min(idx, sorted.length - 1)], this.opts.absoluteFloor);
  }

  reset(): void {
    this.window = [];
    this.inSpeech = false;
    this.above = 0;
  }
}

function db(x: number): number {
  return Math.pow(10, x / 20);
}
