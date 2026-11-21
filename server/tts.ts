import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { config } from "./config.ts";
import { TTS_SAMPLE_RATE } from "../shared/protocol.ts";

export interface TtsEvents {
  audio: [pcm: Buffer];
  done: [];
  error: [message: string];
}

/**
 * One spoken answer, streamed through the ElevenLabs Flash v2.5 realtime
 * websocket. Text sentences go in as Claude produces them; 24 kHz Int16 PCM
 * chunks come out. auto_mode makes ElevenLabs generate on each complete
 * sentence instead of waiting to fill a character buffer, which is what keeps
 * time-to-first-sound low.
 */
export class TtsSpeaker extends EventEmitter<TtsEvents> {
  private ws: WebSocket;
  private open: Promise<void>;
  private aborted = false;

  constructor() {
    super();
    const params = new URLSearchParams({
      model_id: "eleven_flash_v2_5",
      output_format: `pcm_${TTS_SAMPLE_RATE}`,
      auto_mode: "true",
      inactivity_timeout: "60",
    });
    this.ws = new WebSocket(
      `${config.elevenLabsWsBase}/v1/text-to-speech/${config.voiceId}/stream-input?${params}`,
      { headers: { "xi-api-key": config.elevenLabsApiKey } },
    );

    this.open = new Promise((resolve, reject) => {
      this.ws.once("open", () => {
        this.ws.send(
          JSON.stringify({
            text: " ",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
              speed: 1.05,
            },
          }),
        );
        resolve();
      });
      this.ws.once("error", reject);
    });
    // Connection failures are reported through the "error" event; this only
    // keeps a rejection nobody awaited yet from becoming unhandled.
    this.open.catch(() => {});

    this.ws.on("message", (data) => {
      let msg: { audio?: string; isFinal?: boolean; error?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.audio) this.emit("audio", Buffer.from(msg.audio, "base64"));
      if (msg.isFinal) this.emit("done");
      if (msg.error) this.emit("error", `TTS: ${msg.error}`);
    });

    this.ws.on("error", (err) => {
      if (!this.aborted) this.emit("error", `TTS socket: ${err.message}`);
    });
    this.ws.on("close", () => {
      if (!this.aborted) this.emit("done");
    });
  }

  async speak(sentence: string): Promise<void> {
    if (this.aborted) return;
    await this.open.catch(() => {});
    if (this.ws.readyState === WebSocket.OPEN) {
      // Trailing space is required by the stream-input protocol.
      this.ws.send(JSON.stringify({ text: sentence.trim() + " " }));
    }
  }

  /** No more text is coming; flush remaining audio then close. */
  async end(): Promise<void> {
    if (this.aborted) return;
    await this.open.catch(() => {});
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ text: "" }));
    }
  }

  /** Barge-in: kill the stream immediately, discarding queued audio. */
  abort(): void {
    this.aborted = true;
    this.removeAllListeners("audio");
    this.ws.terminate();
  }
}

/**
 * Accumulates streamed text deltas and emits complete sentences — the unit
 * ElevenLabs auto_mode wants. Long clause-heavy sentences are split at commas
 * past 120 chars so audio starts before Claude finishes a paragraph.
 */
export class SentenceChunker {
  private buffer = "";

  constructor(private onSentence: (s: string) => void) {}

  push(delta: string): void {
    this.buffer += delta;
    let idx: number;
    while ((idx = this.buffer.search(/[.!?](?=\s|$)/)) !== -1) {
      const sentence = this.buffer.slice(0, idx + 1).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (sentence) this.onSentence(sentence);
    }
    if (this.buffer.length > 120) {
      const comma = this.buffer.lastIndexOf(",");
      if (comma > 60) {
        const clause = this.buffer.slice(0, comma + 1).trim();
        this.buffer = this.buffer.slice(comma + 1);
        if (clause) this.onSentence(clause);
      }
    }
  }

  flush(): void {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.onSentence(rest);
  }
}
