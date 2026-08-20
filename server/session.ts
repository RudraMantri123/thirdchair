import type WebSocket from "ws";
import { SttStream } from "./stt.ts";
import { TranscriptStore } from "./transcript.ts";
import { Trigger } from "./trigger.ts";
import { answer, type AnswerHandle } from "./brain.ts";
import { TtsSpeaker, SentenceChunker } from "./tts.ts";
import { config } from "./config.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

/**
 * One connected browser = one Session. Owns the STT stream, the rolling
 * transcript, wake-phrase detection, and the answer pipeline
 * (Claude -> sentence chunker -> ElevenLabs TTS -> client).
 */
export class Session {
  private stt = new SttStream();
  private transcript = new TranscriptStore();
  private trigger = new Trigger(config.wakePhrase);
  private currentAnswer: AnswerHandle | null = null;
  private currentSpeaker: TtsSpeaker | null = null;
  private speaking = false;

  constructor(private ws: WebSocket) {
    this.stt.on("partial", (text) => this.send({ type: "partial", text }));
    this.stt.on("committed", (text) => this.onCommitted(text));
    this.stt.on("error", (message) => this.send({ type: "error", message }));

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.stt.send(data as Buffer);
      } else {
        this.onControl(JSON.parse(data.toString()) as ClientMessage);
      }
    });
    ws.on("close", () => this.destroy());

    this.send({ type: "ready", wakePhrase: config.wakePhrase });
  }

  private onControl(msg: ClientMessage): void {
    switch (msg.type) {
      case "start":
        this.stt.start();
        this.send({ type: "status", message: "listening" });
        break;
      case "stop":
        this.stt.stop();
        this.send({ type: "status", message: "stopped" });
        break;
      case "ask":
        if (msg.text.trim()) this.ask(msg.text.trim());
        break;
      case "cancel":
        this.interrupt();
        break;
      case "config":
        if (msg.wakePhrase?.trim()) this.trigger.setPhrase(msg.wakePhrase);
        break;
    }
  }

  private onCommitted(text: string): void {
    const entry = this.transcript.add(text, this.speaking);
    this.send({
      type: "committed",
      text,
      at: entry.at,
      whileSpeaking: entry.whileSpeaking,
    });

    if (this.speaking) {
      // Only a renewed wake phrase cuts through while the copilot talks —
      // everything else is probably its own voice echoing into the mic.
      if (this.trigger.mentioned(text)) {
        this.interrupt();
        const res = this.trigger.feed(text);
        if (res && "question" in res) this.ask(res.question);
        else this.send({ type: "listening_for_question" });
      }
      return;
    }

    const res = this.trigger.feed(text);
    if (!res) return;
    if ("question" in res) this.ask(res.question);
    else this.send({ type: "listening_for_question" });
  }

  private ask(question: string): void {
    this.interrupt();
    this.send({ type: "triggered", question });

    const speaker = new TtsSpeaker();
    this.currentSpeaker = speaker;
    this.speaking = true;
    this.send({ type: "speaking_start" });

    speaker.on("audio", (pcm) => {
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(pcm);
    });
    speaker.on("error", (message) => this.send({ type: "error", message }));
    speaker.on("done", () => {
      if (this.currentSpeaker === speaker) {
        this.speaking = false;
        this.currentSpeaker = null;
        this.send({ type: "speaking_end" });
      }
    });

    const chunker = new SentenceChunker((sentence) => {
      void speaker.speak(sentence);
    });

    const handle = answer(question, this.transcript.render(), (delta) => {
      chunker.push(delta);
      this.send({ type: "answer_delta", text: delta });
    });
    this.currentAnswer = handle;

    handle.done
      .then((text) => {
        chunker.flush();
        void speaker.end();
        this.send({ type: "answer_done", text });
      })
      .catch((err: unknown) => {
        if (this.currentAnswer === handle) {
          speaker.abort();
          this.speaking = false;
          this.currentSpeaker = null;
          this.send({ type: "speaking_end" });
          const message = err instanceof Error ? err.message : String(err);
          if (!/aborted/i.test(message)) {
            this.send({ type: "error", message: `Claude: ${message}` });
          }
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
      this.speaking = false;
      this.send({ type: "speaking_cancel" });
      this.send({ type: "speaking_end" });
    }
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private destroy(): void {
    this.interrupt();
    this.stt.stop();
  }
}
