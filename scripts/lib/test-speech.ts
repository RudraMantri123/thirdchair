/**
 * Synthesize test speech for the eval scripts, on any OS.
 *
 * The evals used to call macOS `say` directly, which meant they simply could
 * not run on Linux or Windows. They now go through the same engine layer the
 * app uses, so a contributor on any platform can reproduce the measurements.
 */
import { detectSpeechEngine, speechInstallHint } from "../../server/audio/speech.ts";
import { encodeWav } from "../../server/audio/wav.ts";
import { writeFile } from "node:fs/promises";

/** Mono PCM16 at `rate`, or exit with an actionable message. */
export async function testSpeech(text: string, rate: number): Promise<Int16Array> {
  const engine = await detectSpeechEngine();
  if (!engine) {
    console.error(`No speech engine available, so this eval cannot run.`);
    console.error(`  ${speechInstallHint()}`);
    process.exit(1);
  }
  return engine.speak(text, rate);
}

/** Same, written to a WAV file for tools that want a path. */
export async function testSpeechFile(
  text: string,
  rate: number,
  path: string,
): Promise<Int16Array> {
  const pcm = await testSpeech(text, rate);
  await writeFile(path, encodeWav(pcm, rate));
  return pcm;
}

/** Int16 PCM as floats in [-1,1], for signal-processing evals. */
export function toFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}
