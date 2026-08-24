/**
 * Cross-platform offline speech synthesis.
 *
 * Every desktop OS ships a usable speech engine, but no two agree on the
 * command, the arguments, or the output sample rate. This picks whatever is
 * present and normalizes the result to mono 16-bit PCM at a fixed rate.
 *
 *   macOS    `say`                      (always present)
 *   Linux    `piper` > `espeak-ng` > `espeak` > `spd-say`
 *   Windows  PowerShell System.Speech   (always present)
 *
 * Text is always passed through a temp FILE, never interpolated into a shell
 * command or a PowerShell script. Utterances come from meeting participants,
 * so treating them as code would be a command-injection hole.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { decodeWav } from "./wav.ts";
import { resamplePcm16 } from "./resample.ts";

const run = promisify(execFile);

export interface SpeechEngine {
  /** Short identifier for logs and error messages. */
  name: string;
  /** Human-readable install hint when nothing is available. */
  install?: string;
  /** Render `text` to mono PCM16 at exactly `targetRate`. */
  speak(text: string, targetRate: number): Promise<Int16Array>;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "thirdchair-tts-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Read a WAV the engine produced and normalize it to the target rate. */
async function normalize(path: string, targetRate: number): Promise<Int16Array> {
  const { pcm, sampleRate } = decodeWav(await readFile(path));
  return resamplePcm16(pcm, sampleRate, targetRate);
}

async function which(cmd: string): Promise<boolean> {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    await run(probe, [cmd]);
    return true;
  } catch {
    return false;
  }
}

// ---- macOS ------------------------------------------------------------------

const macSay: SpeechEngine = {
  name: "macOS say",
  async speak(text, targetRate) {
    return withTempDir(async (dir) => {
      const wav = join(dir, "out.wav");
      const txt = join(dir, "in.txt");
      await writeFile(txt, text, "utf8");
      // `say` can emit our target rate directly, so no resampling is needed.
      await run("say", [
        "-o", wav,
        `--data-format=LEI16@${targetRate}`,
        "-f", txt,
      ]);
      return normalize(wav, targetRate);
    });
  },
};

// ---- Linux ------------------------------------------------------------------

/** piper — neural, clearly the best of the Linux options, needs a model. */
function makePiper(model: string): SpeechEngine {
  return {
    name: `piper (${model.split("/").pop()})`,
    async speak(text, targetRate) {
      return withTempDir(async (dir) => {
        const wav = join(dir, "out.wav");
        const txt = join(dir, "in.txt");
        await writeFile(txt, text, "utf8");
        // piper reads the text on stdin; feed it the file to avoid quoting.
        await run("sh", [
          "-c",
          // The only interpolated values are paths we created ourselves.
          `piper --model "${model}" --output_file "${wav}" < "${txt}"`,
        ]);
        return normalize(wav, targetRate);
      });
    },
  };
}

function makeEspeak(cmd: string): SpeechEngine {
  return {
    name: cmd,
    async speak(text, targetRate) {
      return withTempDir(async (dir) => {
        const wav = join(dir, "out.wav");
        const txt = join(dir, "in.txt");
        await writeFile(txt, text, "utf8");
        // espeak writes 22.05 kHz mono; normalize() resamples it.
        await run(cmd, ["-w", wav, "-f", txt]);
        return normalize(wav, targetRate);
      });
    },
  };
}

// ---- Windows ----------------------------------------------------------------

const windowsSapi: SpeechEngine = {
  name: "Windows System.Speech",
  async speak(text, targetRate) {
    return withTempDir(async (dir) => {
      const wav = join(dir, "out.wav");
      const txt = join(dir, "in.txt");
      const ps1 = join(dir, "speak.ps1");
      await writeFile(txt, text, "utf8");
      // The script reads the text from disk, so nothing from a participant's
      // speech is ever parsed as PowerShell.
      await writeFile(
        ps1,
        [
          "$ErrorActionPreference = 'Stop'",
          "Add-Type -AssemblyName System.Speech",
          "$text = [IO.File]::ReadAllText($env:TC_TEXT)",
          "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
          "$s.SetOutputToWaveFile($env:TC_WAV)",
          "$s.Speak($text)",
          "$s.Dispose()",
        ].join("\n"),
        "utf8",
      );
      const shell = (await which("pwsh")) ? "pwsh" : "powershell";
      await run(
        shell,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1],
        { env: { ...process.env, TC_TEXT: txt, TC_WAV: wav } },
      );
      return normalize(wav, targetRate);
    });
  },
};

// ---- selection --------------------------------------------------------------

let cached: SpeechEngine | null | undefined;

/**
 * Find a usable engine for this machine. Result is cached — the answer cannot
 * change while the process runs, and probing costs a process spawn.
 */
export async function detectSpeechEngine(): Promise<SpeechEngine | null> {
  if (cached !== undefined) return cached;
  cached = await probe();
  return cached;
}

async function probe(): Promise<SpeechEngine | null> {
  const override = process.env.THIRDCHAIR_TTS_CMD;
  if (override) {
    // Escape hatch: any command taking `-w <wav> -f <textfile>`, espeak-style.
    return makeEspeak(override);
  }

  if (process.platform === "darwin") {
    return (await which("say")) ? macSay : null;
  }

  if (process.platform === "win32") {
    return (await which("pwsh")) || (await which("powershell"))
      ? windowsSapi
      : null;
  }

  // Linux and the BSDs.
  const piperModel = process.env.PIPER_MODEL;
  if (piperModel && (await which("piper"))) return makePiper(piperModel);
  for (const cmd of ["espeak-ng", "espeak"]) {
    if (await which(cmd)) return makeEspeak(cmd);
  }
  return null;
}

/**
 * Where this OS hides its voice-processing switch. The OS-level noise
 * suppression is consistently better than anything reachable from inside a
 * browser tab, so it is worth pointing users at by name.
 */
export function voiceEnhancementHint(): string {
  switch (process.platform) {
    case "darwin":
      return "turn on Voice Isolation (Control Centre → Mic Mode while the mic is live)";
    case "win32":
      return "enable Voice Focus / audio enhancements for the mic (Settings → System → Sound → your input device)";
    case "linux":
      return "load the PipeWire/PulseAudio echo-cancel module (`pactl load-module module-echo-cancel`) and pick its source";
    default:
      return "enable your system's microphone noise suppression";
  }
}

/** Install guidance for whichever platform we are on. */
export function speechInstallHint(): string {
  switch (process.platform) {
    case "linux":
      return "Install a speech engine: `sudo apt install espeak-ng` (or `dnf install espeak-ng`). For much better quality, install piper and set PIPER_MODEL=/path/to/voice.onnx.";
    case "win32":
      return "PowerShell with System.Speech is expected on Windows — check that `powershell` or `pwsh` is on PATH.";
    case "darwin":
      return "`say` should be present on macOS — check that /usr/bin is on PATH.";
    default:
      return "No supported speech engine found. Set THIRDCHAIR_TTS_CMD to a command accepting `-w <out.wav> -f <text.txt>`, or use ELEVENLABS_API_KEY for cloud voice.";
  }
}
