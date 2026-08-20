/**
 * Captures microphone audio — and optionally a shared meeting tab's audio —
 * mixes them, and delivers 16 kHz mono Int16 PCM chunks to `onChunk`.
 */
export class AudioCapture {
  private ctx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private micStream: MediaStream | null = null;
  private tabStream: MediaStream | null = null;

  constructor(private onChunk: (pcm: ArrayBuffer) => void) {}

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
    this.worklet = new AudioWorkletNode(this.ctx, "capture-processor");
    this.worklet.port.onmessage = (e) => this.onChunk(e.data as ArrayBuffer);

    this.ctx.createMediaStreamSource(this.micStream).connect(this.worklet);
    // Worklet output goes nowhere — we only tap it. But Chrome garbage
    // collects unconnected graphs, so route it through a muted gain node.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.worklet.connect(mute).connect(this.ctx.destination);
  }

  /**
   * Ask the user to share a browser tab (their Meet/Zoom tab) with audio,
   * and mix that into the capture. Returns false if they cancel or the
   * share has no audio track.
   */
  async addMeetingTab(): Promise<boolean> {
    if (!this.ctx || !this.worklet) return false;
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
      this.ctx.createMediaStreamSource(stream).connect(this.worklet);
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.tabStream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.worklet = null;
  }
}
