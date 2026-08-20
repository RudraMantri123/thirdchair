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
  private reconnectDelay = 1000;
  private lastError = "";

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
        case "session_started":
          this.reconnectDelay = 1000;
          break;
        case "partial_transcript":
          if (msg.text) this.emit("partial", msg.text);
          break;
        case "committed_transcript":
        case "final_transcript":
          if (msg.text?.trim()) this.emit("committed", msg.text.trim());
          break;
        default:
          if (msg.error) this.fail(`STT: ${msg.error}`, msg.message_type);
      }
    });

    ws.on("error", (err) => this.fail(`STT socket: ${err.message}`));

    ws.on("close", () => {
      if (this.closed) return;
      // Exponential backoff so a flapping connection doesn't hammer the API.
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
    });
  }

  /**
   * Report an error without spamming: identical messages are emitted once,
   * and unrecoverable failures (bad key, out of quota) stop the stream
   * entirely — retrying can never fix them.
   */
  private fail(message: string, messageType?: string): void {
    const fatal =
      messageType === "auth_error" ||
      messageType === "quota_exceeded" ||
      /authenticat|invalid_api_key|quota/i.test(message);
    if (message !== this.lastError) {
      this.lastError = message;
      this.emit(
        "error",
        fatal ? `${message} (transcription stopped — fix the key and restart)` : message,
      );
    }
    if (fatal) this.stop();
  }
}
