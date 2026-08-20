import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `Missing ${name}. Copy .env.example to .env and fill in your keys.`,
    );
    process.exit(1);
  }
  return v;
}

export const config = {
  elevenLabsApiKey: required("ELEVENLABS_API_KEY"),
  // The Anthropic SDK reads ANTHROPIC_API_KEY itself; we only check presence
  // early so the failure is a clear startup error, not a mid-meeting one.
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  voiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
  wakePhrase: process.env.WAKE_PHRASE ?? "hey copilot",
  claudeModel: process.env.THIRDCHAIR_MODEL ?? "claude-opus-5",
  claudeEffort: (process.env.THIRDCHAIR_EFFORT ?? "low") as
    | "low"
    | "medium"
    | "high",
  port: Number(process.env.PORT ?? 8787),
};
