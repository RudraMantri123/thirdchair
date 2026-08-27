/**
 * Cross-channel analysis of the mic and shared-meeting-tab streams.
 *
 * Speaker attribution in this app is structural: whatever arrives on the mic
 * channel is "you", whatever arrives on the tab channel is "the room". That is
 * free and exact — but only while the two channels stay isolated, and there is
 * one very common way for that to break:
 *
 *   The user listens on SPEAKERS instead of headphones. Room audio comes out
 *   of the speakers, back into the microphone, and is then attributed to
 *   "you". Nothing downstream can detect this, and the transcript quietly
 *   records remote participants as the local user.
 *
 * Both problems this module solves come from comparing the two channels'
 * energy envelopes, which is cheap and needs no model:
 *
 *   BLEED      - the mic envelope is a delayed, scaled copy of the tab
 *                envelope. High correlation, consistent ratio. The attribution
 *                invariant is broken; tell the user to use headphones.
 *   DOUBLE-TALK- both channels are active but their envelopes are
 *                UNcorrelated. Two people really are talking at once.
 *
 * The distinction matters: bleed is a setup fault to report, overlap is a fact
 * about the meeting to record. Overlap is worth marking because it is roughly a
 * fifth to a quarter of real meeting speech (AMI: 24.7%) and carries a
 * disproportionate share of all recognition error, so anything extracted from
 * an overlapped span deserves less trust.
 */

/** ~5 s of 128 ms frames. */
const WINDOW = 40;
/** Envelope correlation above this, with the tab leading, means bleed. */
const BLEED_CORRELATION = 0.75;
/** Frames of evidence before declaring bleed — avoids one loud coincidence. */
const BLEED_FRAMES = 12;
/** A channel counts as active when it is this far above its own floor. */
const ACTIVE_MARGIN_DB = 8;

function db(x: number): number {
  return Math.pow(10, x / 20);
}

interface Envelope {
  levels: Float64Array;
  writeIdx: number;
  filled: number;
}

function newEnvelope(): Envelope {
  return { levels: new Float64Array(WINDOW), writeIdx: 0, filled: 0 };
}

function push(env: Envelope, level: number): void {
  env.levels[env.writeIdx] = level;
  env.writeIdx = (env.writeIdx + 1) % WINDOW;
  if (env.filled < WINDOW) env.filled++;
}

/** Chronological read: index 0 is oldest retained frame. */
function at(env: Envelope, i: number): number {
  const start = env.filled < WINDOW ? 0 : env.writeIdx;
  return env.levels[(start + i) % WINDOW];
}

export interface CrossChannelState {
  /** Room audio is leaking into the mic — attribution is unreliable. */
  bleeding: boolean;
  /** Both channels carrying independent speech right now. */
  doubleTalk: boolean;
}

export class CrossChannelMonitor {
  private mic = newEnvelope();
  private tab = newEnvelope();
  private micFloor = Infinity;
  private tabFloor = Infinity;
  private bleedEvidence = 0;
  private tabEverActive = false;
  private lastState: CrossChannelState = { bleeding: false, doubleTalk: false };

  /** Feed one frame's Int16-scale RMS for a channel. */
  observe(channel: "mic" | "tab", level: number): void {
    const env = channel === "mic" ? this.mic : this.tab;
    push(env, level);
    // Track a cheap running minimum as each channel's floor.
    if (channel === "mic") this.micFloor = Math.min(this.micFloor, Math.max(level, 1));
    else this.tabFloor = Math.min(this.tabFloor, Math.max(level, 1));
  }

  /** Recompute the state. Cheap enough to call every frame. */
  evaluate(): CrossChannelState {
    // Nothing to compare until both channels have history. With no tab
    // channel shared, there is no bleed path and no cross-channel overlap.
    if (this.mic.filled < WINDOW || this.tab.filled < WINDOW) {
      return this.lastState;
    }

    const micActiveNow = at(this.mic, WINDOW - 1) > this.micFloor * db(ACTIVE_MARGIN_DB);
    const tabActiveNow = at(this.tab, WINDOW - 1) > this.tabFloor * db(ACTIVE_MARGIN_DB);
    if (tabActiveNow) this.tabEverActive = true;

    // Correlate the mic envelope against the tab envelope at small positive
    // lags: acoustic travel plus buffering means the mic sees the room's audio
    // slightly LATER, never earlier.
    let best = 0;
    for (let lag = 0; lag <= 3; lag++) {
      const r = correlate(this.tab, this.mic, lag);
      if (r > best) best = r;
    }

    // Only accumulate evidence while the tab is actually producing sound —
    // two quiet channels correlate trivially and mean nothing.
    if (tabActiveNow && micActiveNow && best >= BLEED_CORRELATION) {
      this.bleedEvidence = Math.min(this.bleedEvidence + 1, BLEED_FRAMES * 2);
    } else if (this.bleedEvidence > 0) {
      this.bleedEvidence--;
    }

    const bleeding = this.bleedEvidence >= BLEED_FRAMES;
    this.lastState = {
      bleeding,
      // Genuine overlap: both talking, but the mic is NOT just echoing the
      // tab. Without that second clause, every bleeding frame would also be
      // reported as two people speaking at once.
      doubleTalk: micActiveNow && tabActiveNow && !bleeding,
    };
    return this.lastState;
  }

  /** True once the tab channel has ever carried audio (i.e. it is shared). */
  get tabInUse(): boolean {
    return this.tabEverActive;
  }
}

/**
 * Pearson correlation of two envelopes, with `b` shifted later by `lag`
 * frames. Returns 0 when either channel is flat, since a constant signal
 * correlates with everything and nothing.
 */
function correlate(a: Envelope, b: Envelope, lag: number): number {
  const n = WINDOW - lag;
  if (n < 8) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += at(a, i);
    sumB += at(b, i + lag);
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = at(a, i) - meanA;
    const dbv = at(b, i + lag) - meanB;
    cov += da * dbv;
    varA += da * da;
    varB += dbv * dbv;
  }
  if (varA < 1e-6 || varB < 1e-6) return 0;
  return cov / Math.sqrt(varA * varB);
}
