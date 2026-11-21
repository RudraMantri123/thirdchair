import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { config } from "./config.ts";
import { MIC_SAMPLE_RATE } from "../shared/protocol.ts";

const SCRIBE_PATH = "/v1/speech-to-text/realtime";

export interface SttEvents {
  partial: [text: string];
  /**
   * `speechEndAt` is the monotonic time (performance.now()) the utterance's
   * end of speech was detected — the origin of the turn's latency budget.
   */
  committed: [text: string, speechEndAt: number];
  error: [message: string];
  /** Actionable input-quality advice (clipping, level too low). */
  notice: [message: string];
  /** This engine cannot serve the session; the owner should switch engines. */
  fallback: [reason: string];
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
  private sessionStarted = false;
  private connectTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private commitTimer: NodeJS.Timeout | null = null;
  private lastPartial = "";
  private lastPartialAt = 0;
  /** A partial promoted after a missed commit; its late commit is dropped. */
  private promoted = "";

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
    this.clearTimers();
    this.ws?.removeAllListeners();
    this.ws?.on("error", () => {}); // a late socket error must not throw
    this.ws?.terminate();
    this.ws = null;
  }

  /** Audio buffered while disconnected — handed to a fallback engine. */
  takeBuffered(): Buffer[] {
    return this.queue.splice(0);
  }

  private clearTimers(): void {
    for (const t of [this.connectTimer, this.reconnectTimer, this.commitTimer]) {
      if (t) clearTimeout(t);
    }
    this.connectTimer = this.reconnectTimer = this.commitTimer = null;
  }

  /**
   * Connecting (or re-connecting) did not produce a working session. Rather
   * than retrying into the void mid-meeting, hand the session to the local
   * engine — a slower transcript beats a silent one.
   */
  private giveUp(reason: string): void {
    if (this.closed) return;
    this.stop();
    this.emit("fallback", reason);
  }

  /**
   * Scribe commits on its own VAD. If it has shown us words but never commits
   * (stalled socket, server-side hiccup), the question would sit unanswered
   * forever — so after the deadline the last partial is promoted to a commit.
   */
  private armCommitTimer(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      const text = this.lastPartial.trim();
      if (!text || this.closed) return;
      this.promoted = text;
      this.lastPartial = "";
      this.emit(
        "notice",
        `Transcription commit missed its ${config.timeouts.sttCommitMs} ms deadline; using the interim text.`,
      );
      this.emit("committed", text, this.lastPartialAt);
    }, config.timeouts.sttCommitMs);
  }

  private connect(): void {
    const params = new URLSearchParams({
      model_id: "scribe_v2_realtime",
      audio_format: `pcm_${MIC_SAMPLE_RATE}`,
      commit_strategy: "vad",
      vad_silence_threshold_secs: "0.6",
    });
    const ws = new WebSocket(`${config.elevenLabsWsBase}${SCRIBE_PATH}?${params}`, {
      headers: { "xi-api-key": config.elevenLabsApiKey },
    });
    this.ws = ws;
    this.sessionStarted = false;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (!this.sessionStarted) {
        this.giveUp(
          `Cloud STT did not connect within ${config.timeouts.sttConnectMs} ms`,
        );
      }
    }, config.timeouts.sttConnectMs);

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
          this.sessionStarted = true;
          if (this.connectTimer) clearTimeout(this.connectTimer);
          this.connectTimer = null;
          this.reconnectDelay = 1000;
          break;
        case "partial_transcript":
          if (msg.text) {
            // Scribe has no explicit end-of-speech event; the last partial
            // before a commit is the closest observable proxy for it.
            this.lastPartial = msg.text;
            this.lastPartialAt = performance.now();
            this.armCommitTimer();
            this.emit("partial", msg.text);
          }
          break;
        case "committed_transcript":
        case "final_transcript": {
          if (this.commitTimer) clearTimeout(this.commitTimer);
          this.commitTimer = null;
          const text = msg.text?.trim();
          const speechEndAt = this.lastPartialAt || performance.now();
          this.lastPartial = "";
          if (this.promoted && text && sameWords(text, this.promoted)) {
            this.promoted = "";
            break; // already delivered by the commit deadline
          }
          this.promoted = "";
          if (text) this.emit("committed", text, speechEndAt);
          break;
        }
        default:
          if (msg.error) this.fail(`STT: ${msg.error}`, msg.message_type);
      }
    });

    ws.on("error", (err) => {
      if (!this.sessionStarted) {
        this.giveUp(`Cloud STT connect failed: ${err.message}`);
        return;
      }
      this.fail(`STT socket: ${err.message}`);
    });

    ws.on("close", () => {
      if (this.closed) return;
      if (!this.sessionStarted) {
        this.giveUp("Cloud STT closed before the session started");
        return;
      }
      // Exponential backoff so a flapping connection doesn't hammer the API.
      // A reconnect that fails to start a session falls back (see above).
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
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
        fatal ? `${message} (switching to local transcription — fix the key and restart to use the cloud engine)` : message,
      );
    }
    if (fatal) this.giveUp(message);
  }
}

function sameWords(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
}
