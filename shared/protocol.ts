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

export type ClientMessage =
  | { type: "start" }
  | { type: "stop" }
  // Ask directly from the UI, bypassing the wake phrase.
  | { type: "ask"; text: string }
  // Barge-in: stop the current spoken answer immediately.
  | { type: "cancel" }
  | { type: "config"; wakePhrase?: string }
  // Request the full transcript (for download / minutes).
  | { type: "export" };

export type ServerMessage =
  | { type: "ready"; wakePhrase: string; state: SessionState }
  | { type: "state"; state: SessionState }
  | { type: "partial"; speaker: Speaker; text: string }
  | { type: "committed"; entry: TranscriptEntry }
  | { type: "triggered"; question: string; speaker: Speaker }
  | { type: "answer_delta"; text: string }
  | { type: "answer_done"; text: string }
  // Client should drop any queued playback audio (barge-in).
  | { type: "speaking_cancel" }
  | { type: "transcript_export"; startedAt: number; entries: TranscriptEntry[] }
  /** Actionable advice about input audio quality, not a failure. */
  | { type: "notice"; message: string }
  | { type: "error"; message: string };

export const MIC_SAMPLE_RATE = 16000;
export const TTS_SAMPLE_RATE = 24000;
