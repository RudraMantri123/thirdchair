/**
 * Check whether this machine can run ThirdChair, and say exactly what is
 * missing if not.
 *
 * The local path depends on things that vary by OS — a speech engine, a
 * whisper build, a model file — and the failure modes are otherwise silent
 * (no engine means no audio; no model means a server that exits immediately).
 *
 * Run: npm run doctor
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectSpeechEngine, speechInstallHint, voiceEnhancementHint } from "../server/audio/speech.ts";

const OK = "  ok   ";
const WARN = " warn  ";
const FAIL = " fail  ";

let failures = 0;
let warnings = 0;

function line(status: string, label: string, detail = ""): void {
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (status === FAIL) failures++;
  if (status === WARN) warnings++;
}

function has(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  const os =
    { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] ??
    process.platform;
  console.log(`\nThirdChair doctor — ${os} (${process.arch}), Node ${process.version}\n`);

  // Read the app's own resolved config rather than re-deriving it from env,
  // so the doctor can never disagree with what the server will actually do
  // (placeholder keys, defaults, and fallbacks all included).
  const { config, brainLabel, brainProblem, voiceProblem } = await import(
    "../server/config.ts"
  );

  // --- brain -----------------------------------------------------------------
  const brainIssue = brainProblem();
  if (brainIssue) {
    line(FAIL, `brain: ${config.brain}`, brainIssue);
  } else if (config.brain === "ollama") {
    if (await reachable(config.ollamaUrl)) {
      line(OK, `brain: ${brainLabel()}`, "reachable");
    } else {
      line(
        FAIL,
        `brain: ${brainLabel()}`,
        `not reachable at ${config.ollamaUrl} — run \`ollama serve\``,
      );
    }
  } else {
    line(OK, `brain: ${brainLabel()}`, "credentials present");
  }

  // --- voice -----------------------------------------------------------------
  const voiceIssue = voiceProblem();
  if (voiceIssue) {
    line(FAIL, `voice: ${config.voice}`, voiceIssue);
  } else if (config.voice === "elevenlabs") {
    line(OK, "voice: ElevenLabs", "Scribe v2 in, Flash v2.5 out");
  } else {
    const engine = await detectSpeechEngine();
    if (engine) line(OK, "voice out: local speech", engine.name);
    else line(FAIL, "voice out: local speech", speechInstallHint());

    const whisper = process.env.WHISPER_URL ?? "http://localhost:8788";
    if (await reachable(whisper)) {
      line(OK, "voice in: whisper-server", whisper);
    } else {
      const bin =
        has("whisper-server") || has("whisper.cpp-server") || has("whisper-cpp-server");
      const model =
        process.env.WHISPER_MODEL ??
        join(homedir(), ".cache", "whisper", "ggml-base.en.bin");
      line(
        FAIL,
        "voice in: whisper-server",
        `not reachable at ${whisper}. binary ${bin ? "found" : "MISSING"}, model ${
          existsSync(model) ? "found" : "MISSING"
        }. Start it with: npm run voice:local`,
      );
    }
  }

  // --- platform notes --------------------------------------------------------
  console.log("");
  line(OK, "input quality tip", `for best transcription, ${voiceEnhancementHint()}`);
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    line(
      WARN,
      "headless session",
      "sharing meeting-tab audio needs a browser with a display; mic-only will still work",
    );
  }

  console.log(
    `\n${failures === 0 ? "Ready." : `${failures} blocking problem(s).`}${
      warnings ? ` ${warnings} warning(s).` : ""
    }\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
