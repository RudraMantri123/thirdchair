import type WebSocket from "ws";
import { SttStream } from "./stt.ts";
import { TranscriptStore } from "./transcript.ts";
import { Trigger } from "./trigger.ts";
import { answer, type AnswerHandle } from "./brain.ts";
import { TtsSpeaker, SentenceChunker } from "./tts.ts";
import { config } from "./config.ts";
import {
  CHANNEL_MIC,
  CHANNEL_TAB,
  SPEAKER_BY_CHANNEL,
  type AudioChannel,
  type ClientMessage,
  type ServerMessage,
  type SessionState,
  type Speaker,
} from "../shared/protocol.ts";

const AWAIT_QUESTION_MS = 10000;

/**
 * One connected browser = one Session.
 *
 * Runs one STT stream per audio channel (mic / shared meeting tab) so every
 * transcript segment carries its speaker — unmixed streams instead of
 * diarization, the way Recall.ai attributes audio per participant. The
 * session itself is an explicit state machine; every transition is pushed
 * to the client.
 */
export class Session {
  private stt = new Map<AudioChannel, SttStream>();
  private transcript = new TranscriptStore();
  private trigger = new Trigger(config.wakePhrase);
  private state: SessionState = "idle";
  private active = false;
  private currentAnswer: AnswerHandle | null = null;
  private currentSpeaker: TtsSpeaker | null = null;
  private awaitTimer: NodeJS.Timeout | null = null;

  constructor(private ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.onAudio(data as Buffer);
      } else {
        try {
          this.onControl(JSON.parse(data.toString()) as ClientMessage);
        } catch {
          this.send({ type: "error", message: "Malformed client message." });
        }
      }
    });
    ws.on("close", () => this.destroy());

    this.send({ type: "ready", wakePhrase: config.wakePhrase, state: this.state });
  }

  // ---- inbound ----------------------------------------------------------

  private onAudio(frame: Buffer): void {
    if (frame.length < 2 || this.state === "idle") return;
    const channel = frame[0] as AudioChannel;
    if (channel !== CHANNEL_MIC && channel !== CHANNEL_TAB) return;
    this.channelStt(channel).send(frame.subarray(1));
  }

  private onControl(msg: ClientMessage): void {
    switch (msg.type) {
      case "start":
        // STT streams connect lazily on first audio for their channel.
        this.active = true;
        this.setState("listening");
        break;
      case "stop":
        this.active = false;
        this.interrupt();
        for (const stt of this.stt.values()) stt.stop();
        this.stt.clear();
        this.setState("idle");
        break;
      case "ask":
        if (msg.text.trim()) this.ask(msg.text.trim(), "you");
        break;
      case "cancel":
        this.interrupt();
        break;
      case "config":
        if (msg.wakePhrase?.trim()) this.trigger.setPhrase(msg.wakePhrase);
        break;
      case "export":
        this.send({
          type: "transcript_export",
          startedAt: this.transcript.startedAt,
          entries: this.transcript.export(),
        });
        break;
    }
  }

  private channelStt(channel: AudioChannel): SttStream {
    let stt = this.stt.get(channel);
    if (!stt) {
      stt = new SttStream();
      const speaker = SPEAKER_BY_CHANNEL[channel];
      stt.on("partial", (text) => this.send({ type: "partial", speaker, text }));
      stt.on("committed", (text) => this.onCommitted(speaker, text));
      stt.on("error", (message) => this.send({ type: "error", message }));
      stt.start();
      this.stt.set(channel, stt);
    }
    return stt;
  }

  // ---- transcript / trigger ---------------------------------------------

  private onCommitted(speaker: Speaker, text: string): void {
    const speaking = this.state === "speaking" || this.state === "thinking";
    const entry = this.transcript.add(speaker, text, speaking);
    this.send({ type: "committed", entry });

    if (speaking) {
      // While answering, only a renewed wake phrase cuts through —
      // everything else may be ThirdChair's own voice echoing back.
      if (this.trigger.mentioned(text)) {
        this.interrupt();
        const res = this.trigger.feed(text);
        if (res && "question" in res) this.ask(res.question, speaker);
        else this.awaitQuestion();
      }
      return;
    }

    const res = this.trigger.feed(text);
    if (!res) return;
    if ("question" in res) this.ask(res.question, speaker);
    else this.awaitQuestion();
  }

  private awaitQuestion(): void {
    this.setState("awaiting_question");
    this.clearAwaitTimer();
    this.awaitTimer = setTimeout(() => {
      if (this.state === "awaiting_question") this.setState("listening");
    }, AWAIT_QUESTION_MS);
  }

  // ---- answer pipeline ----------------------------------------------------

  private ask(question: string, speaker: Speaker): void {
    this.interrupt();
    this.send({ type: "triggered", question, speaker });
    this.setState("thinking");

    const tts = new TtsSpeaker();
    this.currentSpeaker = tts;

    tts.on("audio", (pcm) => {
      // First audio chunk is the thinking -> speaking transition.
      if (this.state === "thinking") this.setState("speaking");
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(pcm);
    });
    tts.on("error", (message) => this.send({ type: "error", message }));
    tts.on("done", () => {
      if (this.currentSpeaker === tts) {
        this.currentSpeaker = null;
        this.settle();
      }
    });

    const chunker = new SentenceChunker((sentence) => void tts.speak(sentence));

    const handle = answer(question, this.transcript.render(), (delta) => {
      chunker.push(delta);
      this.send({ type: "answer_delta", text: delta });
    });
    this.currentAnswer = handle;

    handle.done
      .then((text) => {
        chunker.flush();
        void tts.end();
        this.send({ type: "answer_done", text });
      })
      .catch((err: unknown) => {
        if (this.currentAnswer !== handle) return; // superseded / barged in
        tts.abort();
        this.currentSpeaker = null;
        this.settle();
        const message = err instanceof Error ? err.message : String(err);
        if (!/aborted/i.test(message)) {
          this.send({ type: "error", message: `Claude: ${message}` });
        }
      });
  }

  /** Stop any in-flight answer and audio (barge-in or new question). */
  private interrupt(): void {
    this.currentAnswer?.abort();
    this.currentAnswer = null;
    if (this.currentSpeaker) {
      this.currentSpeaker.abort();
      this.currentSpeaker = null;
      this.send({ type: "speaking_cancel" });
    }
    if (this.state === "thinking" || this.state === "speaking") this.settle();
  }

  // ---- state machine ------------------------------------------------------

  private setState(state: SessionState): void {
    if (state === this.state) return;
    if (state !== "awaiting_question") this.clearAwaitTimer();
    this.state = state;
    this.send({ type: "state", state });
  }

  /** Return to listening if the session is live, otherwise idle. */
  private settle(): void {
    this.setState(this.active ? "listening" : "idle");
  }

  private clearAwaitTimer(): void {
    if (this.awaitTimer) {
      clearTimeout(this.awaitTimer);
      this.awaitTimer = null;
    }
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private destroy(): void {
    this.interrupt();
    this.clearAwaitTimer();
    for (const stt of this.stt.values()) stt.stop();
    this.stt.clear();
  }
}
