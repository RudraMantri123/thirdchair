/**
 * Does `max_context=0` disable whisper's prompt slot?
 *
 * Worth knowing precisely, because the two settings interact: `max_context`
 * caps stored text-context tokens, and the prompt is delivered through that
 * same mechanism. If setting it to 0 neutralizes prompt biasing, then the
 * "remove the vocabulary prompt" decision and the "prevent decoder drift"
 * decision are the same knob, and shipping both is confusing rather than safe.
 *
 * Run: npx tsx scripts/prompt-mechanism-probe.ts
 */
import { encodeWav } from "../server/audio/wav.ts";
import { testSpeech } from "./lib/test-speech.ts";

const WHISPER = process.env.WHISPER_URL ?? "http://localhost:8788";
const RATE = 16000;
// A sentence whose key words are easy to bias INTO error.
const SENTENCE = "our churn last quarter was three point one percent";
const BIAS = "Meeting transcript. Recurring names and terms: Arjun, Priya, Kubernetes.";

async function run(label: string, extra: Record<string, string>) {
  const pcm = await testSpeech(SENTENCE, RATE);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(encodeWav(pcm, RATE))]), "a.wav");
  form.append("response_format", "json");
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await fetch(`${WHISPER}/inference`, { method: "POST", body: form });
  const j = (await res.json()) as { text?: string };
  const text = (j.text ?? "").replace(/\s+/g, " ").trim();
  const primed = /arjun|priya|kubernetes/i.test(text);
  console.log(`  ${label.padEnd(34)} ${primed ? "PRIMED-TERM LEAKED" : "clean"}  "${text}"`);
}

async function main() {
  console.log(`\nreference: "${SENTENCE}"\n`);
  await run("no prompt", {});
  await run("prompt only", { prompt: BIAS });
  await run("prompt + max_context=0", { prompt: BIAS, max_context: "0" });
  await run("prompt + max_context=64", { prompt: BIAS, max_context: "64" });
  console.log("");
}
void main();
