import { EventEmitter } from "node:events";
import type { TtsEvents } from "./tts.ts";
import { TTS_SAMPLE_RATE } from "../shared/protocol.ts";
import { detectSpeechEngine, speechInstallHint } from "./audio/speech.ts";

let warm: Promise<void> | null = null;

/**
 * Render one throwaway word so the first real sentence does not pay the
 * engine's cold start (process spawn, voice load, and on macOS the dead
 * default-voice probe in speech.ts) inside a turn's TTS deadline. Once per
 * process; failures are left for the real call to report.
 */
export function prewarmLocalSpeech(): Promise<void> {
  warm ??= detectSpeechEngine()
    .then((engine) => engine?.speak("Ready.", TTS_SAMPLE_RATE))
    .then(() => {})
    .catch(() => {});
  return warm;
}

/**
 * Fully local speech synthesis, emitting the same 24 kHz Int16 PCM stream as
 * the ElevenLabs speaker so the client cannot tell them apart.
 *
 * The engine underneath is whatever this OS provides — `say` on macOS,
 * piper/espeak-ng on Linux, System.Speech on Windows — normalized to a single
 * rate by `audio/speech.ts`. Sentences are synthesized strictly in order,
 * because they will be played in order.
 */
export class LocalTtsSpeaker extends EventEmitter<TtsEvents> {
  private queue: string[] = [];
  private processing = false;
  private ended = false;
  private aborted = false;

  async speak(sentence: string): Promise<void> {
    if (this.aborted) return;
    const trimmed = sentence.trim();
    if (trimmed) this.queue.push(trimmed);
    void this.pump();
  }

  async end(): Promise<void> {
    this.ended = true;
    if (!this.processing && this.queue.length === 0) this.emit("done");
  }

  abort(): void {
    this.aborted = true;
    this.queue = [];
    this.removeAllListeners("audio");
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    const engine = await detectSpeechEngine();
    if (!engine) {
      this.processing = false;
      this.emit("error", `No local speech engine. ${speechInstallHint()}`);
      this.emit("done");
      return;
    }

    while (this.queue.length > 0 && !this.aborted) {
      const sentence = this.queue.shift()!;
      try {
        const pcm = await engine.speak(sentence, TTS_SAMPLE_RATE);
        if (this.aborted) break;
        this.emit(
          "audio",
          Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        );
      } catch (err) {
        if (this.aborted) break;
        this.emit(
          "error",
          `${engine.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.processing = false;
    if (this.ended && !this.aborted) this.emit("done");
  }
}
