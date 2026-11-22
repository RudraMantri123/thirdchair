// Wire protocol between the web client and the ThirdChair server.
//
// JSON text frames carry control/transcript messages. Binary frames carry
// raw PCM audio:
//   client -> server: [1 channel byte][16 kHz mono Int16 PCM]
//   server -> client: [24 kHz mono Int16 PCM]  (spoken answer audio)
//
// Audio channels are kept separate end-to-end (mic vs. shared meeting tab)
// and transcribed by independent STT streams — the same approach Recall.ai
// takes with unmixed per-participant audio: speaker attribution comes from
// stream identity, not from diarizing a mixed signal.

export const CHANNEL_MIC = 0;
export const CHANNEL_TAB = 1;
export type AudioChannel = typeof CHANNEL_MIC | typeof CHANNEL_TAB;

/** Who a transcript segment is attributed to. */
export type Speaker = "you" | "room";

export const SPEAKER_BY_CHANNEL: Record<AudioChannel, Speaker> = {
  [CHANNEL_MIC]: "you",
  [CHANNEL_TAB]: "room",
};

/**
 * Session lifecycle, modeled as an explicit state machine (analogous to a
 * Recall.ai bot's status transitions). Every transition is pushed to the
 * client as a `state` event.
 *
 *   idle -> listening -> awaiting_question -> thinking -> speaking -> listening
 *                    \________________________^ (wake phrase + question together)
 */
export type SessionState =
  | "idle"
  | "listening"
  | "awaiting_question"
  | "thinking"
  | "speaking";

export interface TranscriptEntry {
  at: number;
  speaker: Speaker;
  text: string;
  /** Heard while ThirdChair itself was speaking — likely its own echo. */
  whileSpeaking: boolean;
}

/**
 * Per-turn latency budget. Every stage of one assistant turn, stamped on the
 * server's monotonic clock and expressed in ms from the turn's origin (end of
 * user speech for a spoken question, receipt for a typed one).
 */
export const LATENCY_COMPONENTS = [
  "stt", // VAD commit -> final transcript
  "wake", // final transcript -> LLM request sent (wake match, prompt build)
  "llmTtft", // LLM request -> first token
  "llmToTts", // first token -> first sentence handed to TTS
  "ttsTtfb", // TTS request -> first audio byte
  "playback", // first audio byte -> audible in the client
] as const;
export type LatencyComponent = (typeof LATENCY_COMPONENTS)[number];

export type LatencyMark =
  | "speechEnd"
  | "transcript"
  | "wake"
  | "llmRequest"
  | "llmFirstToken"
  | "firstSentence"
  | "ttsRequest"
  | "ttsFirstByte"
  | "playbackStart"
  | "holdSpoken"
  | "holdPlaybackStart"
  | "end";

export type TurnOutcome =
  | "answered" // spoken (or text-only when voice is off) to completion
  | "barged_in" // interrupted by the user or a new question
  | "llm_timeout" // total deadline missed; apology spoken
  | "error"; // the brain failed; apology spoken

export interface TurnRecord {
  v: 1;
  turnId: string;
  sessionId: string;
  /** Wall-clock ISO time of the turn origin (for humans; never for deltas). */
  at: string;
  /** "live", or whatever a replay/test client tagged the session with. */
  source: string;
  trigger: "voice" | "typed";
  question: string;
  engines: { stt: string; llm: string; tts: string };
  /** ms from origin, monotonic; absent when the stage never happened. */
  marks: Partial<Record<LatencyMark, number>>;
  /** Stage durations in ms; null when either bounding mark is missing. */
  components: Record<LatencyComponent, number | null>;
  /** Origin -> first answer audio audible; null if nothing was played. */
  e2eMs: number | null;
  /** Origin -> first sound of any kind (the holding phrase counts). */
  firstSoundMs: number | null;
  /** Client-reported scheduling lead before the first chunk sounded. */
  clientLeadMs: number | null;
  /** Fallbacks and deadline misses that shaped this turn. Empty = clean. */
  degraded: string[];
  outcome: TurnOutcome;
  /**
   * What the model was actually asked to process, when the brain reports it
   * (local Ollama does). Optional: absent on older records and cloud brains.
   */
  llm?: LlmUsage;
}

/** Prompt accounting for one answer, as reported by the model server. */
export interface LlmUsage {
  /** Exact prompt tokens, from the server's own tokenizer. */
  promptTokens: number;
  /** Generated tokens. */
  evalTokens: number;
  /** Context window (num_ctx) the request ran with. */
  numCtx: number;
  /** Our pre-flight estimate for the same prompt, for calibration. */
  estimatedTokens: number;
  /** Time the server spent loading the model for this request (cold start). */
  loadMs: number;
  /** Time spent evaluating the uncached part of the prompt. */
  promptEvalMs: number;
}

export interface LatencyStat {
  n: number;
  p50: number;
  p95: number;
}
export type LatencySummary = Partial<
  Record<LatencyComponent | "e2e", LatencyStat>
>;

export type ClientMessage =
  | { type: "start"; source?: string }
  | { type: "stop" }
  // Ask directly from the UI, bypassing the wake phrase.
  | { type: "ask"; text: string }
  // Barge-in: stop the current spoken answer immediately.
  | { type: "cancel" }
  | { type: "config"; wakePhrase?: string }
  // Request the full transcript (for download / minutes).
  | { type: "export" }
  // The first chunk following an audio_mark became audible.
  | {
      type: "playback_started";
      turnId: string;
      kind: "hold" | "answer";
      leadMs: number;
    };

export type ServerMessage =
  | { type: "ready"; wakePhrase: string; state: SessionState }
  | { type: "state"; state: SessionState }
  | { type: "partial"; speaker: Speaker; text: string }
  | { type: "committed"; entry: TranscriptEntry }
  | { type: "triggered"; question: string; speaker: Speaker; turnId: string }
  | { type: "answer_delta"; text: string }
  | { type: "answer_done"; text: string }
  // Client should drop any queued playback audio (barge-in).
  | { type: "speaking_cancel" }
  // The next binary frame is the first of a hold phrase / the answer.
  | { type: "audio_mark"; turnId: string; kind: "hold" | "answer" }
  | { type: "turn_latency"; record: TurnRecord; summary: LatencySummary }
  /** An engine fell back or missed a deadline; `active` is the full set. */
  | { type: "degraded"; message: string; active: string[] }
  | { type: "transcript_export"; startedAt: number; entries: TranscriptEntry[] }
  /** Actionable advice about input audio quality, not a failure. */
  | { type: "notice"; message: string }
  | { type: "error"; message: string };

export const MIC_SAMPLE_RATE = 16000;
export const TTS_SAMPLE_RATE = 24000;
