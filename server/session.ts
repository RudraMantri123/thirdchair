import type WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { SttStream } from "./stt.ts";
import { LocalSttStream } from "./stt-local.ts";
import { MeetingMemory } from "./memory/index.ts";
import { Trigger } from "./trigger.ts";
import { answer, type AnswerHandle } from "./brain.ts";
import { TtsSpeaker, SentenceChunker } from "./tts.ts";
import { LocalTtsSpeaker, prewarmLocalSpeech } from "./tts-local.ts";
import { detectSpeechEngine } from "./audio/speech.ts";
import { TurnLatency, latencyStats, writeTurnRecord } from "./latency.ts";
import { SessionRecorder } from "./recording.ts";
import { modelLifecycle, PromptCalibration } from "./ollama.ts";
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
  type TurnOutcome,
} from "../shared/protocol.ts";

const AWAIT_QUESTION_MS = 10000;
/** How long a finished turn waits for the client's playback report. */
const PLAYBACK_REPORT_GRACE_MS = 3000;
const HOLD_PHRASE = "One moment.";
const APOLOGY_TIMEOUT = "Sorry, that is taking too long. Please ask me again.";
const APOLOGY_ERROR = "Sorry, I couldn't get an answer just now. Please try again.";

type AnyStt = SttStream | LocalSttStream;
type AnyTts = TtsSpeaker | LocalTtsSpeaker;

/** Monotonic stamps carried from the transcript into a voice-triggered turn. */
interface VoiceTiming {
  speechEndAt: number;
  transcriptAt: number;
  wakeAt: number;
}

/**
 * Everything one assistant turn owns. Every timer lives in `timers` so a
 * single clearTimers() on barge-in / stop / disconnect leaves nothing running.
 */
class Turn {
  handle: AnswerHandle | null = null;
  speaker: AnyTts | null = null;
  hold: AnyTts | null = null;
  /** Answer audio is held back while the holding phrase is still going out. */
  holdGate = false;
  pendingAudio: Buffer[] = [];
  /** Sentences handed to TTS, kept so a fallback engine can re-speak them. */
  sentences: string[] = [];
  answerAudioSent = false;
  holdAudioSent = false;
  llmDone = false;
  ended = false;
  recorded = false;
  outcome: TurnOutcome | null = null;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly id: string,
    readonly lat: TurnLatency,
  ) {}

  /** Arm a named one-shot timer, replacing any previous one of that name. */
  timer(name: string, ms: number, fn: () => void): void {
    this.cancel(name);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        fn();
      }, ms),
    );
  }

  cancel(name: string): void {
    const t = this.timers.get(name);
    if (t) clearTimeout(t);
    this.timers.delete(name);
  }

  armed(name: string): boolean {
    return this.timers.has(name);
  }

  clearTimers(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  awaitingPlaybackReport(): boolean {
    return (
      (this.answerAudioSent && !this.lat.has("playbackStart")) ||
      (this.holdAudioSent && !this.lat.has("holdPlaybackStart"))
    );
  }
}

/**
 * One connected browser = one Session.
 *
 * Runs one STT stream per audio channel (mic / shared meeting tab) so every
 * transcript segment carries its speaker — unmixed streams instead of
 * diarization, the way Recall.ai attributes audio per participant. The
 * session itself is an explicit state machine; every transition is pushed
 * to the client.
 *
 * Each answer is a Turn with a latency budget: monotonic marks from end of
 * speech to first audible audio, a deadline on every network wait, and
 * engine fallbacks that keep the meeting going when a provider fails.
 */
export class Session {
  private readonly id = randomUUID().slice(0, 8);
  private source = "live";
  private stt = new Map<AudioChannel, AnyStt>();
  private transcript = new MeetingMemory(config.memoryProfile);
  /** Sentences handed to TTS that we believe actually played, in order. */
  private spoken: string[] = [];
  private trigger = new Trigger(config.wakePhrase);
  private state: SessionState = "idle";
  private active = false;
  private turn: Turn | null = null;
  private turnSeq = 0;
  /** Finished turns still waiting for the client's playback report. */
  private finishing = new Map<string, Turn>();
  private awaitTimer: NodeJS.Timeout | null = null;
  /** Session-wide fallbacks in effect, e.g. "stt:local-fallback". */
  private degraded = new Set<string>();
  private sttFallback = false;
  private ttsFallback = false;
  private localTtsName = "local";
  private recorder: SessionRecorder | null = null;
  /** Tightens the context guard's estimate with this meeting's exact counts. */
  private promptCalibration = new PromptCalibration();
  /** Holds the local model resident while this session is listening. */
  private holdsModel = false;

  constructor(private ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.onAudio(data as Buffer);
      } else {
        try {
          const raw = data.toString();
          const msg = JSON.parse(raw) as ClientMessage;
          if (msg.type !== "playback_started" && msg.type !== "export") {
            this.recorder?.control(raw);
          }
          this.onControl(msg);
        } catch {
          this.send({ type: "error", message: "Malformed client message." });
        }
      }
    });
    ws.on("close", () => this.destroy());

    void detectSpeechEngine().then((e) => {
      if (e) this.localTtsName = e.name;
    });
    // The local engine is the primary voice, or the fallback for the cloud
    // one; either way its cold start should not land inside a turn.
    void prewarmLocalSpeech();

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
    this.recorder?.audio(frame);
    this.channelStt(channel).send(frame.subarray(1));
  }

  private onControl(msg: ClientMessage): void {
    switch (msg.type) {
      case "start":
        // STT streams connect lazily on first audio for their channel.
        this.active = true;
        if (msg.source) this.source = String(msg.source).slice(0, 120);
        this.startRecording();
        this.holdModel(true);
        this.setState("listening");
        break;
      case "stop":
        this.active = false;
        this.holdModel(false);
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
      case "playback_started":
        this.onPlaybackStarted(msg.turnId, msg.kind, Number(msg.leadMs));
        break;
    }
  }

  /** Load the model as the meeting starts; release it when it ends. */
  private holdModel(hold: boolean): void {
    if (hold === this.holdsModel) return;
    this.holdsModel = hold;
    if (hold) modelLifecycle.acquire();
    else modelLifecycle.release();
  }

  private startRecording(): void {
    if (!config.record || this.recorder) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.recorder = new SessionRecorder(config.recordDir, `${stamp}-${this.id}`);
    // The start message that opened the recording arrived before the file
    // existed; write one so a replay begins the same way.
    this.recorder.control(JSON.stringify({ type: "start" }));
    this.send({
      type: "notice",
      message: `Recording input audio to ${this.recorder.path}`,
    });
  }

  private channelStt(channel: AudioChannel): AnyStt {
    return this.stt.get(channel) ?? this.makeStt(channel);
  }

  private makeStt(channel: AudioChannel): AnyStt {
    const stt: AnyStt =
      config.voice === "local" || this.sttFallback
        ? new LocalSttStream()
        : new SttStream();
    const speaker = SPEAKER_BY_CHANNEL[channel];
    // Give the recognizer the meeting's own vocabulary for POST-HOC
    // correction. Deliberately not used to prime the decoder — that was
    // measured to corrupt correct words.
    if (stt instanceof LocalSttStream) {
      stt.vocabularyProvider = () => this.transcript.vocabularyTerms();
    }
    stt.on("partial", (text) => this.send({ type: "partial", speaker, text }));
    stt.on("committed", (text, speechEndAt) =>
      this.onCommitted(speaker, text, speechEndAt),
    );
    stt.on("error", (message) => this.send({ type: "error", message }));
    stt.on("notice", (message) => this.send({ type: "notice", message }));
    stt.on("fallback", (reason) => {
      if (this.stt.get(channel) !== stt) return;
      const buffered = stt instanceof SttStream ? stt.takeBuffered() : [];
      stt.stop();
      this.stt.delete(channel);
      this.sttFallback = true;
      this.degrade(
        "stt:local-fallback",
        `${reason}. Transcribing locally (whisper.cpp) for the rest of this session.`,
      );
      // Words spoken while the cloud socket was failing are not lost.
      const local = this.makeStt(channel);
      for (const pcm of buffered) local.send(pcm);
    });
    stt.start();
    this.stt.set(channel, stt);
    return stt;
  }

  // ---- transcript / trigger ---------------------------------------------

  private onCommitted(speaker: Speaker, text: string, speechEndAt: number): void {
    const transcriptAt = performance.now();
    const speaking = this.state === "speaking" || this.state === "thinking";
    const entry = this.transcript.add(speaker, text, speaking);
    this.send({ type: "committed", entry });
    const timing = (): VoiceTiming => ({
      speechEndAt,
      transcriptAt,
      wakeAt: performance.now(),
    });

    if (speaking) {
      // While answering, only a renewed wake phrase cuts through —
      // everything else may be ThirdChair's own voice echoing back.
      if (this.trigger.mentioned(text)) {
        this.interrupt();
        const res = this.trigger.feed(text);
        if (res && "question" in res) this.ask(res.question, speaker, timing());
        else this.awaitQuestion();
      }
      return;
    }

    const res = this.trigger.feed(text);
    if (!res) return;
    if ("question" in res) this.ask(res.question, speaker, timing());
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

  private ask(question: string, speaker: Speaker, timing?: VoiceTiming): void {
    const noBrain = brainProblem();
    if (noBrain) {
      this.send({ type: "error", message: noBrain });
      return;
    }
    this.interrupt();

    const id = `${this.id}-${++this.turnSeq}`;
    const lat = new TurnLatency(
      id,
      timing ? "voice" : "typed",
      question,
      timing?.speechEndAt,
    );
    if (timing) {
      lat.mark("speechEnd", timing.speechEndAt);
      lat.mark("transcript", timing.transcriptAt);
      lat.mark("wake", timing.wakeAt);
    } else {
      // A typed question has no speech or transcription stage; its budget
      // starts at receipt.
      lat.mark("transcript", lat.origin);
      lat.mark("wake", lat.origin);
    }
    for (const tag of this.degraded) lat.degraded.add(tag);

    const turn = new Turn(id, lat);
    this.turn = turn;
    this.send({ type: "triggered", question, speaker, turnId: id });
    this.setState("thinking");

    // Voice is optional: without an ElevenLabs key the answer still streams
    // as text, it just isn't spoken.
    turn.speaker = voiceProblem() ? null : this.newSpeaker(turn);

    this.spoken = [];
    const chunker = new SentenceChunker((sentence) => {
      if (this.turn !== turn || turn.outcome) return;
      lat.mark("firstSentence");
      // Record the sentence as it is handed to TTS. On barge-in only the
      // sentences up to this point are treated as spoken, so history reflects
      // what the room heard rather than what the model generated.
      this.spoken.push(sentence);
      turn.sentences.push(sentence);
      this.speak(turn, sentence);
    });

    const sections = this.transcript.build(question);
    lat.mark("llmRequest");
    turn.timer("llmFirstToken", config.timeouts.llmFirstTokenMs, () =>
      this.onFirstTokenLate(turn),
    );
    turn.timer("llmTotal", config.timeouts.llmTotalMs, () =>
      this.onLlmTimeout(turn),
    );

    const handle = answer(question, sections, (delta) => {
      if (this.turn !== turn || turn.outcome) return;
      if (!lat.has("llmFirstToken")) {
        lat.mark("llmFirstToken");
        turn.cancel("llmFirstToken");
      }
      chunker.push(delta);
      this.send({ type: "answer_delta", text: delta });
    }, this.promptCalibration);
    turn.handle = handle;

    handle.done
      .then((text) => {
        if (handle.usage) lat.llm = handle.usage;
        if (this.turn !== turn || turn.outcome) return;
        turn.cancel("llmFirstToken");
        turn.cancel("llmTotal");
        chunker.flush();
        this.recordSpoken();
        this.send({ type: "answer_done", text });
        turn.llmDone = true;
        if (turn.speaker) void turn.speaker.end();
        else this.endTurn(turn, "answered");
      })
      .catch((err: unknown) => {
        if (this.turn !== turn || turn.outcome) return; // superseded / barged in
        const message = err instanceof Error ? err.message : String(err);
        if (/aborted/i.test(message)) return;
        this.send({ type: "error", message: `Brain: ${message}` });
        lat.degraded.add("llm:error");
        this.apologise(turn, "error", APOLOGY_ERROR);
      });
  }

  /** Hand one sentence to the turn's speaker, under a first-byte deadline. */
  private speak(turn: Turn, sentence: string): void {
    if (!turn.speaker) return;
    turn.lat.mark("ttsRequest");
    if (!turn.lat.has("ttsFirstByte") && !turn.armed("ttsFirstByte")) {
      turn.timer("ttsFirstByte", config.timeouts.ttsFirstByteMs, () =>
        this.onTtsFirstByteLate(turn),
      );
    }
    void turn.speaker.speak(sentence);
  }

  private createTts(): AnyTts {
    return config.voice === "local" || this.ttsFallback
      ? new LocalTtsSpeaker()
      : new TtsSpeaker();
  }

  private newSpeaker(turn: Turn): AnyTts {
    const tts = this.createTts();
    tts.on("audio", (pcm) => {
      if (this.turn !== turn || turn.speaker !== tts) return;
      turn.lat.mark("ttsFirstByte");
      turn.cancel("ttsFirstByte");
      if (turn.holdGate) turn.pendingAudio.push(pcm);
      else this.sendAnswerAudio(turn, pcm);
    });
    tts.on("error", (message) => {
      if (this.turn !== turn || turn.speaker !== tts) return;
      if (tts instanceof TtsSpeaker) {
        this.fallbackTts(turn, message);
      } else {
        // A local engine error is per sentence; the rest may still speak.
        turn.lat.degraded.add("tts:local-error");
        this.send({ type: "error", message });
      }
    });
    tts.on("done", () => {
      if (this.turn !== turn || turn.speaker !== tts) return;
      turn.speaker = null;
      this.endTurn(turn, "answered");
    });
    return tts;
  }

  private sendAnswerAudio(turn: Turn, pcm: Buffer): void {
    if (!turn.answerAudioSent) {
      turn.answerAudioSent = true;
      this.send({ type: "audio_mark", turnId: turn.id, kind: "answer" });
    }
    // First audio chunk is the thinking -> speaking transition.
    if (this.state === "thinking") this.setState("speaking");
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(pcm);
  }

  /**
   * The cloud voice failed mid-turn. Switch this session to the local engine
   * and, if nothing was heard yet, re-speak what had already been sent so the
   * answer still starts from its first word.
   */
  private fallbackTts(turn: Turn, reason: string): void {
    turn.speaker?.abort();
    this.ttsFallback = true;
    turn.lat.degraded.add("tts:local-fallback");
    this.degrade(
      "tts:local-fallback",
      `Cloud voice failed (${reason}). Speaking with the local engine for the rest of this session.`,
    );
    turn.cancel("ttsFirstByte");
    const fresh = this.newSpeaker(turn);
    turn.speaker = fresh;
    if (!turn.answerAudioSent) {
      for (const sentence of turn.sentences) this.speak(turn, sentence);
    }
    if (turn.llmDone) void fresh.end();
  }

  private onTtsFirstByteLate(turn: Turn): void {
    if (this.turn !== turn || turn.lat.has("ttsFirstByte") || !turn.speaker) return;
    const why = `voice produced no audio within ${config.timeouts.ttsFirstByteMs} ms`;
    turn.lat.degraded.add("tts:first-byte-timeout");
    if (turn.speaker instanceof TtsSpeaker) {
      this.fallbackTts(turn, why);
      return;
    }
    // Already on the local engine: there is nowhere left to fall back to, so
    // the answer continues as text only rather than hanging the turn.
    turn.speaker.abort();
    turn.speaker = null;
    this.send({ type: "error", message: `Voice: ${why}; continuing as text.` });
    if (turn.llmDone) this.endTurn(turn, "answered");
  }

  /**
   * The model is slow. Say something short so the room knows it was heard,
   * then keep waiting; real answer audio is queued behind the phrase.
   */
  private onFirstTokenLate(turn: Turn): void {
    if (this.turn !== turn || turn.lat.has("llmFirstToken") || turn.outcome) return;
    turn.lat.degraded.add("llm:hold-phrase");
    this.send({
      type: "degraded",
      message: `Model missed its ${config.timeouts.llmFirstTokenMs} ms first-token deadline; holding.`,
      active: [...this.degraded],
    });
    if (!turn.speaker) return; // text-only: nothing to say out loud
    turn.lat.mark("holdSpoken");

    const hold = this.createTts();
    turn.hold = hold;
    turn.holdGate = true;
    const release = () => {
      if (!turn.holdGate) return;
      turn.holdGate = false;
      turn.cancel("holdGate");
      for (const pcm of turn.pendingAudio.splice(0)) this.sendAnswerAudio(turn, pcm);
    };
    hold.on("audio", (pcm) => {
      if (this.turn !== turn || turn.hold !== hold) return;
      if (!turn.holdAudioSent) {
        turn.holdAudioSent = true;
        this.send({ type: "audio_mark", turnId: turn.id, kind: "hold" });
      }
      if (this.state === "thinking") this.setState("speaking");
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(pcm);
    });
    hold.on("done", release);
    hold.on("error", release);
    // The phrase must never hold the answer hostage.
    turn.timer("holdGate", config.timeouts.ttsFirstByteMs, release);
    void hold.speak(HOLD_PHRASE);
    void hold.end();
  }

  /** Total deadline missed: abort the model, apologise, recover. */
  private onLlmTimeout(turn: Turn): void {
    if (this.turn !== turn || turn.llmDone || turn.outcome) return;
    turn.lat.degraded.add("llm:total-timeout");
    turn.handle?.abort();
    this.apologise(turn, "llm_timeout", APOLOGY_TIMEOUT);
  }

  private apologise(turn: Turn, outcome: TurnOutcome, text: string): void {
    turn.outcome = outcome;
    turn.llmDone = true;
    turn.cancel("llmFirstToken");
    turn.cancel("llmTotal");
    // Whatever was already spoken stays in the record; the apology itself
    // does not enter meeting memory.
    this.recordSpoken();
    this.send({
      type: "answer_delta",
      text: (turn.sentences.length ? " " : "") + text,
    });
    this.send({ type: "answer_done", text });
    if (turn.speaker) {
      this.speak(turn, text);
      void turn.speaker.end();
    } else {
      this.endTurn(turn, outcome);
    }
  }

  /** Close out a turn: stop its timers, return to listening, log it. */
  private endTurn(turn: Turn, outcome: TurnOutcome): void {
    if (turn.ended) return;
    turn.ended = true;
    turn.outcome ??= outcome;
    turn.lat.mark("end");
    turn.clearTimers();
    turn.hold?.abort();
    if (this.turn === turn) {
      this.turn = null;
      this.settle();
    }
    if (turn.awaitingPlaybackReport() && this.ws.readyState === this.ws.OPEN) {
      this.finishing.set(turn.id, turn);
      turn.timer("report", PLAYBACK_REPORT_GRACE_MS, () => this.writeRecord(turn));
    } else {
      this.writeRecord(turn);
    }
  }

  private onPlaybackStarted(
    turnId: string,
    kind: "hold" | "answer",
    leadMs: number,
  ): void {
    const turn = this.turn?.id === turnId ? this.turn : this.finishing.get(turnId);
    if (!turn) return;
    if (kind === "answer") {
      turn.lat.mark("playbackStart");
      if (Number.isFinite(leadMs)) turn.lat.clientLeadMs ??= Math.round(leadMs);
    } else {
      turn.lat.mark("holdPlaybackStart");
    }
    if (turn.ended && !turn.awaitingPlaybackReport()) this.writeRecord(turn);
  }

  private writeRecord(turn: Turn): void {
    if (turn.recorded) return;
    turn.recorded = true;
    turn.clearTimers();
    this.finishing.delete(turn.id);
    const record = turn.lat.record(
      { sessionId: this.id, source: this.source, engines: this.engines() },
      turn.outcome ?? "answered",
    );
    latencyStats.add(record);
    writeTurnRecord(record);
    this.send({ type: "turn_latency", record, summary: latencyStats.summary() });
    const c = record.components;
    const f = (v: number | null) => (v === null ? "-" : `${Math.round(v)}`);
    console.log(
      `  turn ${record.turnId} ${record.outcome}: e2e ${f(record.e2eMs)} ms ` +
        `[stt ${f(c.stt)} | wake ${f(c.wake)} | ttft ${f(c.llmTtft)} | ` +
        `llm->tts ${f(c.llmToTts)} | tts ${f(c.ttsTtfb)} | play ${f(c.playback)}]` +
        (record.degraded.length ? ` degraded: ${record.degraded.join(",")}` : ""),
    );
  }

  private engines() {
    const localStt = config.voice === "local" || this.sttFallback;
    const localTts = config.voice === "local" || this.ttsFallback;
    const model =
      config.brain === "claude"
        ? config.claudeModel
        : config.brain === "groq"
          ? config.groqModel
          : config.ollamaModel;
    return {
      stt: localStt ? "whisper.cpp" : "scribe-v2-realtime",
      llm: `${config.brain}/${model}`,
      tts: localTts ? `local:${this.localTtsName}` : "flash-v2.5",
    };
  }

  private degrade(tag: string, message: string): void {
    this.degraded.add(tag);
    this.turn?.lat.degraded.add(tag);
    console.warn(`  degraded [${this.id}] ${tag}: ${message}`);
    this.send({ type: "degraded", message, active: [...this.degraded] });
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
    const turn = this.turn;
    if (!turn) {
      if (this.state === "thinking" || this.state === "speaking") this.settle();
      return;
    }
    turn.handle?.abort();
    const audible = turn.speaker !== null || turn.hold !== null;
    turn.speaker?.abort();
    turn.speaker = null;
    if (audible) {
      this.recordSpoken();
      this.send({ type: "speaking_cancel" });
    }
    this.endTurn(turn, "barged_in");
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
    // The client is gone; log what we have rather than wait for reports.
    for (const turn of [...this.finishing.values()]) this.writeRecord(turn);
    this.recorder?.close();
    this.recorder = null;
    this.holdModel(false);
  }
}
