import { EventEmitter } from "node:events";
import { config } from "./config.ts";
import type { SttEvents } from "./stt.ts";
import { AdaptiveVad } from "./audio/vad.ts";
import { MIC_SAMPLE_RATE } from "../shared/protocol.ts";

/**
 * Fully local transcription: energy-based voice activity detection over the
 * incoming 16 kHz PCM, then each detected utterance is sent as a WAV to a
 * local whisper.cpp `whisper-server` (/inference). No cloud, no API key.
 *
 * Emits only "committed" segments (whisper has no streaming partials).
 */
export class LocalSttStream extends EventEmitter<SttEvents> {
  private closed = false;
  private utterance: Buffer[] = [];
  private preRoll: Buffer[] = [];
  private inSpeech = false;
  private silenceMs = 0;
  private speechMs = 0;
  private lastError = "";
  private vad = new AdaptiveVad();
  // Serialize whisper calls so utterances come back in spoken order.
  private inference: Promise<void> = Promise.resolve();
  private clipped = 0;
  private frames = 0;
  private warnedClipping = false;
  private warnedQuiet = false;

  private static readonly SILENCE_END_MS = 700;
  private static readonly MIN_SPEECH_MS = 250;
  private static readonly MAX_UTTERANCE_MS = 30000;
  /**
   * ~1 s of audio kept before speech is detected, so the utterance starts at
   * the first syllable rather than wherever the detector happened to fire.
   * Any energy-based VAD is late by construction, and a clipped wake phrase
   * means a missed question. Pipecat and LiveKit both keep a 1 s ring here
   * for the same reason; at 16 kHz mono it costs 32 kB.
   */
  private static readonly PRE_ROLL_FRAMES = 8;

  start(): void {
    this.closed = false;
  }

  stop(): void {
    this.closed = true;
    this.utterance = [];
    this.preRoll = [];
    this.inSpeech = false;
  }

  send(pcm: Buffer): void {
    if (this.closed) return;
    const frameMs = (pcm.length / 2 / MIC_SAMPLE_RATE) * 1000;
    const level = rms(pcm);
    // Gate on the margin above the room's measured noise floor, not on an
    // absolute level: a headset and a laptop mic two metres away differ by
    // ~30 dB, and office hum alone can exceed a quiet talker's level.
    const loud = this.vad.push(level);
    this.observeLevel(level, pcm);

    if (!this.inSpeech) {
      this.preRoll.push(pcm);
      if (this.preRoll.length > LocalSttStream.PRE_ROLL_FRAMES) {
        this.preRoll.shift();
      }
      if (loud) {
        this.inSpeech = true;
        this.utterance = [...this.preRoll];
        this.preRoll = [];
        this.speechMs = frameMs;
        this.silenceMs = 0;
      }
      return;
    }

    this.utterance.push(pcm);
    if (loud) {
      this.speechMs += frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }

    const utteranceMs =
      (this.utterance.reduce((n, b) => n + b.length, 0) / 2 / MIC_SAMPLE_RATE) *
      1000;
    if (
      this.silenceMs >= LocalSttStream.SILENCE_END_MS ||
      utteranceMs >= LocalSttStream.MAX_UTTERANCE_MS
    ) {
      const chunks = this.utterance;
      const hadSpeech = this.speechMs >= LocalSttStream.MIN_SPEECH_MS;
      this.inSpeech = false;
      this.utterance = [];
      this.speechMs = 0;
      this.silenceMs = 0;
      if (hadSpeech) this.enqueue(Buffer.concat(chunks));
    }
  }

  /**
   * Watch the input for the two problems a user can actually fix: a mic hot
   * enough to clip (which destroys consonants and no amount of downstream
   * processing recovers), and a level so low that speech sits in the noise.
   * Warned once each — a repeated nag during a meeting is worse than useless.
   */
  private observeLevel(level: number, pcm: Buffer): void {
    this.frames++;
    for (let i = 0; i < pcm.length; i += 2) {
      if (Math.abs(pcm.readInt16LE(i)) >= 32700) {
        this.clipped++;
        break;
      }
    }
    if (this.frames < 40) return; // ~5 s before judging anything

    if (!this.warnedClipping && this.clipped / this.frames > 0.02) {
      this.warnedClipping = true;
      this.emit(
        "notice",
        "Your microphone is clipping — lower the input level or move back slightly. Clipped speech loses consonants and cannot be recovered later.",
      );
    }
    if (
      !this.warnedQuiet &&
      this.frames > 200 &&
      this.vad.noiseFloor > 0 &&
      level < this.vad.noiseFloor * 1.4
    ) {
      this.warnedQuiet = true;
      this.emit(
        "notice",
        "Speech is barely above the room noise. Move closer to the mic, or turn on macOS Voice Isolation (Control Centre → Mic Mode) for a large improvement.",
      );
    }
  }

  private enqueue(pcm: Buffer): void {
    this.inference = this.inference.then(() => this.transcribe(pcm));
  }

  private async transcribe(pcm: Buffer): Promise<void> {
    try {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(wavWrap(pcm))], { type: "audio/wav" }),
        "utterance.wav",
      );
      form.append("response_format", "json");
      const res = await fetch(`${config.whisperUrl}/inference`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        throw new Error(`whisper-server ${res.status} ${await res.text()}`);
      }
      const { text } = (await res.json()) as { text?: string };
      const clean = (text ?? "")
        .replace(/\[[^\]]*\]|\([^)]*\)/g, "") // [BLANK_AUDIO], (door closes)…
        .trim();
      if (clean && !this.closed) this.emit("committed", clean);
    } catch (err) {
      const message = `Local STT: ${
        err instanceof Error ? err.message : String(err)
      }. Is whisper-server running? Start it with: npm run voice:local`;
      if (message !== this.lastError) {
        this.lastError = message;
        this.emit("error", message);
      }
    }
  }
}

function rms(pcm: Buffer): number {
  let sum = 0;
  const samples = pcm.length / 2;
  if (samples === 0) return 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

/** Wrap raw 16 kHz mono s16le PCM in a minimal WAV container. */
function wavWrap(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(MIC_SAMPLE_RATE, 24);
  header.writeUInt32LE(MIC_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
