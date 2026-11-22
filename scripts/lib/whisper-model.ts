/**
 * Which whisper.cpp model to load when WHISPER_MODEL is not set.
 *
 * A 5-bit quantized copy (q5_1) is preferred whenever it is present: measured
 * on this project's ingestion eval it transcribed as well as the f16 original
 * while cutting whisper-server's memory footprint roughly in half (README,
 * "Memory footprint"). It is not downloaded for you; make it from the model
 * you already have with whisper.cpp's quantizer:
 *
 *   whisper-quantize ggml-small.en.bin ggml-small.en-q5_1.bin q5_1
 *
 * THIRDCHAIR_PROFILE=low-memory prefers base.en instead of small.en.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".cache", "whisper");

export function defaultWhisperModel(): { path: string; candidates: string[] } {
  const family =
    process.env.THIRDCHAIR_PROFILE === "low-memory" ? "base.en" : "small.en";
  const candidates = [
    join(DIR, `ggml-${family}-q5_1.bin`),
    join(DIR, `ggml-${family}.bin`),
  ];
  if (process.env.WHISPER_MODEL) {
    return { path: process.env.WHISPER_MODEL, candidates: [process.env.WHISPER_MODEL] };
  }
  return { path: candidates.find((p) => existsSync(p)) ?? candidates[1], candidates };
}
