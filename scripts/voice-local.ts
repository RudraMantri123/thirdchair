/**
 * Start whisper-server for the fully-local voice path, on any OS.
 *
 * Exists because the obvious npm script (`whisper-server -m $HOME/...`) is a
 * POSIX shell expression and fails on Windows. This resolves the model path
 * with Node, finds the binary under whatever name the platform installed it
 * as, and prints an actionable message when something is missing rather than
 * a bare ENOENT.
 *
 * Run: npm run voice:local
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODEL =
  process.env.WHISPER_MODEL ??
  join(homedir(), ".cache", "whisper", "ggml-base.en.bin");
const PORT = process.env.WHISPER_PORT ?? "8788";

// Homebrew ships `whisper-server`; a source build produces `whisper-server`
// too, but some distro packages use `whisper.cpp-server`.
const CANDIDATES = process.env.WHISPER_SERVER_BIN
  ? [process.env.WHISPER_SERVER_BIN]
  : ["whisper-server", "whisper.cpp-server", "whisper-cpp-server"];

function resolveBinary(): string | null {
  const probe = process.platform === "win32" ? "where" : "which";
  for (const bin of CANDIDATES) {
    try {
      execFileSync(probe, [bin], { stdio: "ignore" });
      return bin;
    } catch {
      // keep looking
    }
  }
  return null;
}

const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

function installHint(): string {
  switch (process.platform) {
    case "darwin":
      return "brew install whisper-cpp";
    case "linux":
      return "Install whisper.cpp: your distro may package it, otherwise build it —\n    git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j --config Release\n  then put build/bin on PATH, or set WHISPER_SERVER_BIN to the binary.";
    case "win32":
      return "Download a whisper.cpp release build from https://github.com/ggerganov/whisper.cpp/releases,\n  then set WHISPER_SERVER_BIN to the extracted server executable.";
    default:
      return "Build whisper.cpp from https://github.com/ggerganov/whisper.cpp and set WHISPER_SERVER_BIN.";
  }
}

const bin = resolveBinary();
if (!bin) {
  console.error(`Could not find a whisper-server binary (tried: ${CANDIDATES.join(", ")}).`);
  console.error(`  ${installHint()}`);
  process.exit(1);
}

if (!existsSync(MODEL)) {
  console.error(`Whisper model not found at ${MODEL}`);
  console.error(`  Download it (~150 MB):`);
  console.error(`    curl -L --create-dirs -o "${MODEL}" ${MODEL_URL}`);
  console.error(`  Or set WHISPER_MODEL to a model you already have.`);
  console.error(
    `  If your network blocks Hugging Face, fetch OpenAI's original weights and\n  convert them with whisper.cpp's models/convert-pt-to-ggml.py instead.`,
  );
  process.exit(1);
}

console.log(`whisper-server: ${bin}`);
console.log(`  model: ${MODEL}`);
console.log(`  port : ${PORT}`);

const child = spawn(bin, ["-m", MODEL, "--port", PORT], { stdio: "inherit" });
child.on("error", (err) => {
  console.error(`Failed to start ${bin}: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
