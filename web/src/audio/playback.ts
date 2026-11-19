import { TTS_SAMPLE_RATE } from "../../../shared/protocol.ts";

/**
 * Gapless playback of streamed 24 kHz Int16 PCM: each incoming chunk is
 * scheduled to start exactly where the previous one ends.
 */
export class AudioPlayback {
  private ctx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
  private playhead = 0;
  private sources = new Set<AudioBufferSourceNode>();

  /** Schedules the chunk; returns seconds until it becomes audible. */
  play(chunk: ArrayBuffer): number {
    void this.ctx.resume();
    const int16 = new Int16Array(chunk);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;

    const buffer = this.ctx.createBuffer(1, float32.length, TTS_SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);

    const now = this.ctx.currentTime;
    // Small initial lead-in absorbs network jitter on the first chunk.
    if (this.playhead < now) this.playhead = now + 0.05;
    source.start(this.playhead);
    const lead = Math.max(0, this.playhead - now);
    this.playhead += buffer.duration;
    return lead;
  }

  /** Barge-in: drop everything queued and go silent now. */
  cancel(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // already ended
      }
    }
    this.sources.clear();
    this.playhead = 0;
  }
}
