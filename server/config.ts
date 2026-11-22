import "dotenv/config";

export type BrainProvider = "claude" | "groq" | "ollama";
export type VoiceProvider = "elevenlabs" | "local";

/** Returns the env var, treating unset/placeholder values as missing. */
function key(name: string): string | undefined {
  const v = process.env[name];
  return !v || v.includes("placeholder") ? undefined : v;
}

const brain = (process.env.THIRDCHAIR_BRAIN ?? "claude") as BrainProvider;
if (!["claude", "groq", "ollama"].includes(brain)) {
  console.error(
    `THIRDCHAIR_BRAIN must be "claude", "groq", or "ollama" (got "${brain}").`,
  );
  process.exit(1);
}

const elevenLabsApiKey = key("ELEVENLABS_API_KEY");

/**
 * Resource profile. "low-memory" swaps in smaller local models where an
 * explicit setting does not already choose one; see README, "Memory
 * footprint", for what it saves and what it costs.
 */
const profile = (process.env.THIRDCHAIR_PROFILE ?? "default") as
  | "default"
  | "low-memory";
if (!["default", "low-memory"].includes(profile)) {
  console.error(
    `THIRDCHAIR_PROFILE must be "default" or "low-memory" (got "${profile}").`,
  );
  process.exit(1);
}
const lowMemory = profile === "low-memory";

/** A positive integer env var in milliseconds, else the default. */
function ms(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  elevenLabsApiKey,
  // Voice defaults to ElevenLabs when a key is present, otherwise the fully
  // local pipeline (whisper.cpp STT + macOS `say` TTS) — no key needed.
  voice: (process.env.THIRDCHAIR_VOICE ??
    (elevenLabsApiKey ? "elevenlabs" : "local")) as VoiceProvider,
  whisperUrl: process.env.WHISPER_URL ?? "http://localhost:8788",
  vadThreshold: Number(process.env.THIRDCHAIR_VAD_THRESHOLD ?? 600),
  anthropicApiKey: key("ANTHROPIC_API_KEY"),
  groqApiKey: key("GROQ_API_KEY"),
  brain,
  claudeModel: process.env.THIRDCHAIR_MODEL ?? "claude-opus-5",
  claudeEffort: (process.env.THIRDCHAIR_EFFORT ?? "low") as
    | "low"
    | "medium"
    | "high",
  groqModel: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  profile,
  ollamaModel:
    process.env.OLLAMA_MODEL ?? (lowMemory ? "qwen2.5:1.5b" : "llama3.2"),
  // Ollama defaults to 4096 and silently truncates the prompt from the FRONT,
  // so the model answers confidently about a meeting whose start it never saw.
  // The KV cache is allocated for the whole window, so this is a memory
  // setting. 8192 is the largest prompt measured over 2-hour meetings plus
  // the answer reserve (scripts/prompt-size-probe.ts): 5,236 tokens for
  // ordinary talk, but 7,642 when half the talk is figures and ticket ids and
  // 7,476 for back-to-back monologues. 6144 fits ordinary talk and saves
  // ~120 MB at q8_0; either way a prompt that would not fit grows the window
  // instead of being truncated (server/ollama.ts).
  ollamaNumCtx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),
  // "session": load the model when a meeting starts, hold it for the meeting,
  // release it when the last one ends. "daemon": leave it to Ollama's own
  // keep-alive (default 5 minutes after the last request).
  ollamaLifecycle: (process.env.THIRDCHAIR_OLLAMA_LIFECYCLE ?? "session") as
    | "session"
    | "daemon",
  // Lease length while a meeting is live; renewed at half this interval.
  ollamaLeaseMinutes: ms("THIRDCHAIR_OLLAMA_LEASE_MIN", 10),
  // Memory profile: "full" keeps every word (fine for Claude's window),
  // "compact" digests older segments to fit a small local context.
  memoryProfile: (process.env.THIRDCHAIR_MEMORY ??
    (brain === "claude" ? "full" : "compact")) as "full" | "compact",
  voiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
  wakePhrase: process.env.WAKE_PHRASE ?? "hey copilot",
  port: Number(process.env.PORT ?? 8787),
  // Base of the ElevenLabs realtime websockets. Overridable so a test can
  // point it at an unreachable host and exercise the local fallback path.
  elevenLabsWsBase: process.env.ELEVENLABS_WS_BASE ?? "wss://api.elevenlabs.io",
  /**
   * Every network wait on the answer path has a deadline. Nothing may hang a
   * turn indefinitely; each of these either degrades (fallback / holding
   * phrase) or ends the turn with a spoken apology.
   */
  timeouts: {
    // Cloud STT socket open + session_started. Missing it falls back to local.
    sttConnectMs: ms("THIRDCHAIR_STT_CONNECT_TIMEOUT_MS", 5000),
    // Local: one whisper /inference call. Cloud: last partial -> commit; on a
    // miss the last partial is promoted to a committed segment.
    sttCommitMs: ms("THIRDCHAIR_STT_COMMIT_TIMEOUT_MS", 8000),
    // No token by then: speak a short holding phrase and keep waiting.
    llmFirstTokenMs: ms("THIRDCHAIR_LLM_FIRST_TOKEN_TIMEOUT_MS", 2500),
    // Whole answer. On a miss the answer is aborted and an apology spoken.
    llmTotalMs: ms("THIRDCHAIR_LLM_TOTAL_TIMEOUT_MS", 25000),
    // First sentence handed to TTS -> first audio byte back.
    ttsFirstByteMs: ms("THIRDCHAIR_TTS_FIRST_BYTE_TIMEOUT_MS", 4000),
  },
  // Per-turn latency records, one JSON object per line. "off" disables.
  latencyLog: process.env.THIRDCHAIR_LATENCY_LOG ?? "logs/latency.jsonl",
  // Opt-in: record each session's input audio frames for replay.
  record: /^(1|true|yes|on)$/i.test(process.env.THIRDCHAIR_RECORD ?? ""),
  recordDir: process.env.THIRDCHAIR_RECORD_DIR ?? "recordings",
};

/** Why voice (STT + TTS) can't run, or undefined if it can. */
export function voiceProblem(): string | undefined {
  if (config.voice === "elevenlabs" && !config.elevenLabsApiKey) {
    return "ELEVENLABS_API_KEY is not set — voice in/out is disabled (answers will be text-only). Free key at https://elevenlabs.io, or go fully local with THIRDCHAIR_VOICE=local (see README).";
  }
  // Deliberately not a platform check. Local voice works anywhere a speech
  // engine and whisper-server exist; the engine is probed at first use and
  // reports its own install hint, so a new platform needs no change here.
  return undefined;
}

/** Why the answering brain can't run, or undefined if it can. */
export function brainProblem(): string | undefined {
  if (config.brain === "claude" && !config.anthropicApiKey) {
    return "ANTHROPIC_API_KEY is not set — answers are disabled. Get a key at https://console.anthropic.com, or run free: THIRDCHAIR_BRAIN=groq (free key at https://console.groq.com) or THIRDCHAIR_BRAIN=ollama (no key at all).";
  }
  if (config.brain === "groq" && !config.groqApiKey) {
    return "GROQ_API_KEY is not set — answers are disabled. Free key at https://console.groq.com/keys (no card needed), then edit .env and restart.";
  }
  return undefined;
}

/** Human-readable setup problems; empty when fully configured. */
export function configProblems(): string[] {
  return [voiceProblem(), brainProblem()].filter(
    (p): p is string => p !== undefined,
  );
}

export function voiceLabel(): string {
  return config.voice === "elevenlabs"
    ? "elevenlabs (scribe v2 + flash v2.5)"
    : `local (whisper.cpp @ ${config.whisperUrl} + macOS say)`;
}

export function brainLabel(): string {
  switch (config.brain) {
    case "claude":
      return `${config.claudeModel} (effort: ${config.claudeEffort})`;
    case "groq":
      return `groq/${config.groqModel}`;
    case "ollama":
      return `ollama/${config.ollamaModel} @ ${config.ollamaUrl}`;
  }
}
