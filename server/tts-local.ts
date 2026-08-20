import { EventEmitter } from "node:events";
import { execFile, type ChildProcess } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TtsEvents } from "./tts.ts";
import { TTS_SAMPLE_RATE } from "../shared/protocol.ts";

let counter = 0;

/**
 * Fully local speech synthesis using macOS's built-in `say`, emitting the
 * same 24 kHz Int16 PCM stream as the ElevenLabs speaker. Sentences are
 * synthesized sequentially so audio arrives in order.
 */
export class LocalTtsSpeaker extends EventEmitter<TtsEvents> {
  private queue: string[] = [];
  private processing = false;
  private ended = false;
  private aborted = false;
  private child: ChildProcess | null = null;

  async speak(sentence: string): Promise<void> {
    if (this.aborted) return;
    this.queue.push(sentence.trim());
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
    this.child?.kill();
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0 && !this.aborted) {
      const sentence = this.queue.shift()!;
      const file = join(tmpdir(), `thirdchair-tts-${process.pid}-${counter++}.wav`);
      try {
        await new Promise<void>((resolve, reject) => {
          this.child = execFile(
            "say",
            ["-o", file, `--data-format=LEI16@${TTS_SAMPLE_RATE}`, sentence],
            (err) => (err && !this.aborted ? reject(err) : resolve()),
          );
        });
        if (!this.aborted) {
          const pcm = wavData(await readFile(file));
          if (pcm) this.emit("audio", pcm);
        }
      } catch (err) {
        this.emit(
          "error",
          `Local TTS: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.child = null;
        void unlink(file).catch(() => {});
      }
    }
    this.processing = false;
    if (this.ended && !this.aborted) this.emit("done");
  }
}

/** Extract the `data` chunk payload from a RIFF/WAVE file (handles JUNK etc.). */
function wavData(wav: Buffer): Buffer | null {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") return null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      return wav.subarray(offset + 8, Math.min(offset + 8 + size, wav.length));
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}
