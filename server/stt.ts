import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { config } from "./config.ts";
import { MIC_SAMPLE_RATE } from "../shared/protocol.ts";

const SCRIBE_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

export interface SttEvents {
  partial: [text: string];
  committed: [text: string];
  error: [message: string];
}

/**
 * One live Scribe v2 Realtime transcription stream.
 *
 * Audio in: raw 16 kHz mono Int16 PCM buffers via send().
 * Events out: "partial" (interim text) and "committed" (VAD-finalized text).
 * Reconnects automatically if ElevenLabs drops the socket mid-meeting.
 */
export class SttStream extends EventEmitter<SttEvents> {
  private ws: WebSocket | null = null;
  private closed = false;
  private queue: Buffer[] = [];

  start(): void {
    this.closed = false;
    this.connect();
  }

  send(pcm: Buffer): void {
    if (this.closed) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: pcm.toString("base64"),
          sample_rate: MIC_SAMPLE_RATE,
        }),
      );
    } else {
      // Buffer a little audio across reconnects so words aren't lost.
      this.queue.push(pcm);
      if (this.queue.length > 50) this.queue.shift();
    }
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const params = new URLSearchParams({
      model_id: "scribe_v2_realtime",
      audio_format: `pcm_${MIC_SAMPLE_RATE}`,
      commit_strategy: "vad",
      vad_silence_threshold_secs: "0.6",
    });
    const ws = new WebSocket(`${SCRIBE_URL}?${params}`, {
      headers: { "xi-api-key": config.elevenLabsApiKey },
    });
    this.ws = ws;

    ws.on("open", () => {
      for (const pcm of this.queue.splice(0)) this.send(pcm);
    });

    ws.on("message", (data) => {
      let msg: {
        message_type?: string;
        text?: string;
        error?: string;
      };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.message_type) {
        case "partial_transcript":
          if (msg.text) this.emit("partial", msg.text);
          break;
        case "committed_transcript":
        case "final_transcript":
          if (msg.text?.trim()) this.emit("committed", msg.text.trim());
          break;
        default:
          if (msg.error) this.emit("error", `STT: ${msg.error}`);
      }
    });

    ws.on("error", (err) => this.emit("error", `STT socket: ${err.message}`));

    ws.on("close", () => {
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    });
  }
}
