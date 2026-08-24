import { EventEmitter } from "node:events";
import { config } from "./config.ts";
import type { SttEvents } from "./stt.ts";
import { AdaptiveVad } from "./audio/vad.ts";
import { encodeWav } from "./audio/wav.ts";
import { voiceEnhancementHint } from "./audio/speech.ts";
import { PcmRing, asInt16 } from "./audio/ring.ts";
import {
  highPassInPlace,
  normalizeGainInPlace,
  padToMinimum,
} from "./audio/preprocess.ts";
import { MIC_SAMPLE_RATE } from "../shared/protocol.ts";

const SILENCE_END_MS = 700;
const MIN_SPEECH_MS = 250;
const MAX_UTTERANCE_MS = 30000;
/**
 * ~1 s of audio kept before speech is detected, so an utterance starts at the
 * first syllable rather than wherever the detector happened to fire. Any
 * energy-based VAD is late by construction, and a clipped wake phrase means a
 * missed question. Pipecat and LiveKit keep a 1 s ring for the same reason; at
 * 16 kHz mono it costs 32 kB.
 */
const PRE_ROLL_MS = 1024;

/**
 * Phrases Whisper emits when handed near-silence — artefacts of its training
 * data, not speech. They are indistinguishable from a real short reply, so
 * they get filtered here rather than reaching the transcript, where they would
 * become fabricated meeting content.
 */
const HALLUCINATIONS = [
  "thank you", "thanks for watching", "thank you for watching",
  "please subscribe", "subscribe to my channel", "bye", "okay",
  "you", "thanks", "the end", "music", "silence",
];

/**
 * Fully local transcription: adaptive voice activity detection over the
 * incoming 16 kHz PCM, then each detected utterance is conditioned and sent as
 * a WAV to a local whisper.cpp `whisper-server` (/inference). No cloud, no key.
 *
 * Emits only "committed" segments (whisper has no streaming partials).
 */
export class LocalSttStream extends EventEmitter<SttEvents> {
  private closed = false;
  // Pre-allocated once per stream: an utterance never grows past its cap and
  // the accumulator produces no per-frame garbage.
  private utterance = new PcmRing(
    Math.ceil((MAX_UTTERANCE_MS / 1000) * MIC_SAMPLE_RATE),
  );
  private preRoll = new PcmRing(
    Math.ceil((PRE_ROLL_MS / 1000) * MIC_SAMPLE_RATE),
  );
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

  /** Vocabulary bias for the recognizer, supplied by the session. */
  promptProvider: (() => string) | null = null;

  start(): void {
    this.closed = false;
  }

  stop(): void {
    this.closed = true;
    this.utterance.clear();
    this.preRoll.clear();
    this.inSpeech = false;
  }

  send(pcm: Buffer): void {
    if (this.closed) return;
    const samples = asInt16(pcm);
    const frameMs = (samples.length / MIC_SAMPLE_RATE) * 1000;
    const level = rms(samples);
    // Gate on the margin above the room's measured noise floor, not on an
    // absolute level: a headset and a laptop mic two metres away differ by
    // ~30 dB, and office hum alone can exceed a quiet talker's level.
    const loud = this.vad.push(level);
    this.observeLevel(level, samples);

    if (!this.inSpeech) {
      // The ring drops its own oldest samples, so pre-roll memory is capped
      // by the type rather than by how long the room stays quiet.
      this.preRoll.write(samples);
      if (loud) {
        this.inSpeech = true;
        this.utterance.clear();
        this.preRoll.drainInto(this.utterance);
        this.speechMs = frameMs;
        this.silenceMs = 0;
      }
      return;
    }

    this.utterance.write(samples);
    if (loud) {
      this.speechMs += frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }

    const utteranceMs = (this.utterance.length / MIC_SAMPLE_RATE) * 1000;
    if (
      this.silenceMs >= SILENCE_END_MS ||
      utteranceMs >= MAX_UTTERANCE_MS ||
      this.utterance.full
    ) {
      const hadSpeech = this.speechMs >= MIN_SPEECH_MS;
      const pcm16 = hadSpeech ? this.utterance.toPcm() : null;
      this.inSpeech = false;
      this.utterance.clear();
      this.speechMs = 0;
      this.silenceMs = 0;
      if (pcm16) this.enqueue(pcm16);
    }
  }

  /**
   * Watch the input for the two problems a user can actually fix: a mic hot
   * enough to clip (which destroys consonants and no amount of downstream
   * processing recovers), and a level so low that speech sits in the noise.
   * Warned once each — a repeated nag during a meeting is worse than useless.
   */
  private observeLevel(level: number, samples: Int16Array): void {
    this.frames++;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s >= 32700 || s <= -32700) {
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
        `Speech is barely above the room noise. Move closer to the mic, or ${voiceEnhancementHint()} for a large improvement.`,
      );
    }
  }

  private enqueue(pcm: Int16Array): void {
    this.inference = this.inference.then(() => this.transcribe(pcm));
  }

  private async transcribe(pcm: Int16Array): Promise<void> {
    try {
      // Condition the signal the way the model expects: DC/rumble removed,
      // level normalized, and padded if very short. Measured together these
      // cut WER on noisy and quiet input (scripts/asr-eval.ts). In place, so
      // no extra copy of the utterance.
      highPassInPlace(pcm, MIC_SAMPLE_RATE);
      normalizeGainInPlace(pcm);
      const audio = padToMinimum(pcm, MIC_SAMPLE_RATE);

      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(encodeWav(audio, MIC_SAMPLE_RATE))], {
          type: "audio/wav",
        }),
        "utterance.wav",
      );
      form.append("response_format", "json");
      // Bias decoding with the meeting's own vocabulary. A name heard once is
      // then far more likely to be transcribed correctly the next time, which
      // is exactly where a general model is weakest.
      const bias = this.promptProvider?.();
      if (bias) form.append("prompt", bias);
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
      if (clean && !this.closed && !isHallucination(clean)) {
        this.emit("committed", clean);
      }
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

/** Int16-scale RMS over a typed-array view — no per-sample method call. */
function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * True when a transcript is one of Whisper's silence artefacts. Only exact
 * matches are rejected: "okay" alone is almost certainly noise, while "okay
 * let's ship it" is real speech, so length is the discriminator.
 */
function isHallucination(text: string): boolean {
  const bare = text.toLowerCase().replace(/[^a-z ]/g, "").trim();
  return HALLUCINATIONS.includes(bare);
}
