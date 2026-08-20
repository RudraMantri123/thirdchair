// Wire protocol between the web client and the ThirdChair server.
// JSON text frames carry control/transcript messages; binary frames carry raw
// PCM audio (client -> server: 16 kHz mono Int16 mic audio; server -> client:
// 24 kHz mono Int16 TTS audio).

export type ClientMessage =
  | { type: "start" }
  | { type: "stop" }
  // Ask directly from the UI, bypassing the wake phrase.
  | { type: "ask"; text: string }
  // Barge-in: stop the current spoken answer immediately.
  | { type: "cancel" }
  | { type: "config"; wakePhrase?: string };

export type ServerMessage =
  | { type: "ready"; wakePhrase: string }
  | { type: "partial"; text: string }
  | { type: "committed"; text: string; at: number; whileSpeaking: boolean }
  | { type: "listening_for_question" }
  | { type: "triggered"; question: string }
  | { type: "answer_delta"; text: string }
  | { type: "answer_done"; text: string }
  | { type: "speaking_start" }
  | { type: "speaking_end" }
  // Client should drop any queued playback audio.
  | { type: "speaking_cancel" }
  | { type: "status"; message: string }
  | { type: "error"; message: string };

export const MIC_SAMPLE_RATE = 16000;
export const TTS_SAMPLE_RATE = 24000;
