import {
  CHANNEL_MIC,
  CHANNEL_TAB,
  MIC_SAMPLE_RATE,
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

  async start(deviceId?: string): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // The browser's own AEC/NS/AGC. Echo cancellation is what stops the
        // copilot from transcribing its own answers back off the speakers.
        // On macOS these compose with the OS mic mode (Voice Isolation),
        // which the user selects in Control Centre and which is strictly
        // better than anything available from inside the page.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        // Ask for mono at the rate we actually want. The browser resamples
        // from the device's native rate (usually 48 kHz) with a real
        // anti-aliasing filter, so the worklet never has to.
        channelCount: 1,
        sampleRate: MIC_SAMPLE_RATE,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });

    // Pinning the context to the target rate is what delegates resampling to
    // the platform. Falls back to the default rate if a browser refuses.
    try {
      this.ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
    } catch {
      this.ctx = new AudioContext();
    }
    await this.ctx.audioWorklet.addModule("/capture-worklet.js");
    this.attach(this.micStream, CHANNEL_MIC);
  }

  /** What the browser actually gave us, for diagnostics and warnings. */
  inputInfo(): { rate: number; label: string; settings: MediaTrackSettings } | null {
    const track = this.micStream?.getAudioTracks()[0];
    if (!track || !this.ctx) return null;
    return {
      rate: this.ctx.sampleRate,
      label: track.label,
      settings: track.getSettings(),
    };
  }

  static async inputDevices(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "audioinput");
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
    // Tell the worklet the real context rate so it can resample itself if the
    // browser refused our 16 kHz request. Without this it would emit 48 kHz
    // audio labelled as 16 kHz — three times too fast, and unintelligible.
    const worklet = new AudioWorkletNode(this.ctx, "capture-processor", {
      processorOptions: { contextRate: this.ctx.sampleRate },
    });
    worklet.port.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.onChunk(channel, e.data);
      } else if (e.data?.warn) {
        console.warn("capture:", e.data.warn);
      }
    };
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
