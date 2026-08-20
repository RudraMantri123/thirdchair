import {
  CHANNEL_MIC,
  CHANNEL_TAB,
  type AudioChannel,
} from "../../../shared/protocol.ts";

/**
 * Captures microphone audio — and optionally a shared meeting tab's audio —
 * as two SEPARATE channels, each resampled to 16 kHz mono Int16 PCM.
 * Keeping the streams unmixed is what lets the server attribute every
 * transcript line to "you" vs. "the room" without diarization.
 */
export class AudioCapture {
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private tabStream: MediaStream | null = null;

  constructor(
    private onChunk: (channel: AudioChannel, pcm: ArrayBuffer) => void,
  ) {}

  async start(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Echo cancellation is what stops the copilot from hearing its own
        // answers when they play through speakers.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("/capture-worklet.js");
    this.attach(this.micStream, CHANNEL_MIC);
  }

  /**
   * Ask the user to share a browser tab (their Meet/Zoom tab) with audio,
   * captured as its own channel. Returns false if they cancel or the share
   * has no audio track.
   */
  async addMeetingTab(): Promise<boolean> {
    if (!this.ctx) return false;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // required by the picker; we ignore the track
        audio: true,
      });
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      stream.getVideoTracks().forEach((t) => t.stop());
      this.tabStream = stream;
      this.attach(stream, CHANNEL_TAB);
      return true;
    } catch {
      return false;
    }
  }

  private attach(stream: MediaStream, channel: AudioChannel): void {
    if (!this.ctx) return;
    const worklet = new AudioWorkletNode(this.ctx, "capture-processor");
    worklet.port.onmessage = (e) => this.onChunk(channel, e.data as ArrayBuffer);
    this.ctx.createMediaStreamSource(stream).connect(worklet);
    // Worklet output goes nowhere — we only tap it. But Chrome garbage
    // collects unconnected graphs, so route it through a muted gain node.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    worklet.connect(mute).connect(this.ctx.destination);
  }

  stop(): void {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.tabStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.tabStream = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}
