import type WebSocket from "ws";
import { SttStream } from "./stt.ts";
import { LocalSttStream } from "./stt-local.ts";
import { MeetingMemory } from "./memory/index.ts";
import { Trigger } from "./trigger.ts";
import { answer, type AnswerHandle } from "./brain.ts";
import { TtsSpeaker, SentenceChunker } from "./tts.ts";
import { LocalTtsSpeaker } from "./tts-local.ts";
import {
  config,
  configProblems,
  brainProblem,
  voiceProblem,
} from "./config.ts";
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

type AnyStt = SttStream | LocalSttStream;
type AnyTts = TtsSpeaker | LocalTtsSpeaker;

function createStt(): AnyStt {
  return config.voice === "local" ? new LocalSttStream() : new SttStream();
}

function createTts(): AnyTts {
  return config.voice === "local" ? new LocalTtsSpeaker() : new TtsSpeaker();
}

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
  private stt = new Map<AudioChannel, AnyStt>();
  private transcript = new MeetingMemory(config.memoryProfile);
  /** Sentences handed to TTS that we believe actually played, in order. */
  private spoken: string[] = [];
  private trigger = new Trigger(config.wakePhrase);
  private state: SessionState = "idle";
  private active = false;
  private currentAnswer: AnswerHandle | null = null;
  private currentSpeaker: AnyTts | null = null;
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
    // Surface setup problems once, up front — not as a stream of
    // connection failures after the user starts talking.
    for (const message of configProblems()) this.send({ type: "error", message });
  }

  // ---- inbound ----------------------------------------------------------

  private onAudio(frame: Buffer): void {
    if (frame.length < 2 || this.state === "idle") return;
    // Without a working voice provider every connection is doomed —
    // drop audio instead of opening sockets that can only fail.
    if (voiceProblem()) return;
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

  private channelStt(channel: AudioChannel): AnyStt {
    let stt = this.stt.get(channel);
    if (!stt) {
      stt = createStt();
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
    const noBrain = brainProblem();
    if (noBrain) {
      this.send({ type: "error", message: noBrain });
      return;
    }
    this.interrupt();
    this.send({ type: "triggered", question, speaker });
    this.setState("thinking");

    // Voice is optional: without an ElevenLabs key the answer still streams
    // as text, it just isn't spoken.
    const tts = voiceProblem() ? null : createTts();
    this.currentSpeaker = tts;

    if (tts) {
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
    }

    this.spoken = [];
    const chunker = new SentenceChunker((sentence) => {
      // Record the sentence as it is handed to TTS. On barge-in only the
      // sentences up to this point are treated as spoken, so history reflects
      // what the room heard rather than what the model generated.
      this.spoken.push(sentence);
      void tts?.speak(sentence);
    });

    const handle = answer(question, this.transcript.build(question), (delta) => {
      chunker.push(delta);
      this.send({ type: "answer_delta", text: delta });
    });
    this.currentAnswer = handle;

    handle.done
      .then((text) => {
        chunker.flush();
        this.recordSpoken();
        this.send({ type: "answer_done", text });
        if (tts) {
          void tts.end();
        } else {
          this.settle();
        }
      })
      .catch((err: unknown) => {
        if (this.currentAnswer !== handle) return; // superseded / barged in
        tts?.abort();
        this.currentSpeaker = null;
        this.settle();
        const message = err instanceof Error ? err.message : String(err);
        if (!/aborted/i.test(message)) {
          this.send({ type: "error", message: `Brain: ${message}` });
        }
      });
  }

  /**
   * Record what the copilot actually said into the transcript. An answer cut
   * off after two of five sentences is recorded as those two sentences — the
   * unspoken remainder never happened as far as the room is concerned, and
   * storing it would be hallucination fuel on later questions.
   */
  private recordSpoken(): void {
    const said = this.spoken.join(" ").trim();
    this.spoken = [];
    if (said) this.transcript.add("you", said, true);
  }

  /** Stop any in-flight answer and audio (barge-in or new question). */
  private interrupt(): void {
    this.currentAnswer?.abort();
    this.currentAnswer = null;
    if (this.currentSpeaker) {
      this.currentSpeaker.abort();
      this.currentSpeaker = null;
      this.recordSpoken();
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
