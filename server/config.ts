import "dotenv/config";

export type BrainProvider = "claude" | "groq" | "ollama";

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

export const config = {
  elevenLabsApiKey: key("ELEVENLABS_API_KEY"),
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
  ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.2",
  voiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
  wakePhrase: process.env.WAKE_PHRASE ?? "hey copilot",
  port: Number(process.env.PORT ?? 8787),
};

/** Why voice (STT + TTS) can't run, or undefined if it can. */
export function voiceProblem(): string | undefined {
  if (!config.elevenLabsApiKey) {
    return "ELEVENLABS_API_KEY is not set — voice in/out is disabled (answers will be text-only). Free key at https://elevenlabs.io, then edit .env and restart.";
  }
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
