/**
 * End-to-end proof: does the prompt MeetingMemory actually builds hit the
 * local KV cache across successive questions in one meeting?
 *
 * Simulates a meeting, asks a question every few minutes through the real
 * prompt assembly, and reports the prompt-eval time Ollama charges for each.
 * A warm append-only prefix should cost a small fraction of a cold one.
 *
 * Run: npx tsx scripts/live-cache-eval.ts
 */
import { MeetingMemory, type MemoryProfile } from "../server/memory/index.ts";
import type { Speaker } from "../shared/protocol.ts";

const URL = "http://localhost:11434/api/chat";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3";
const NUM_CTX = 8192;
const PROFILE = (process.env.THIRDCHAIR_MEMORY ?? "compact") as MemoryProfile;

const SYSTEM = "You are ThirdChair, an AI teammate in a live meeting. Answer in two short sentences of plain spoken prose.";
const SAMPLE = [
  "I think we should push the pricing decision to next week",
  "the enterprise tier at forty nine a seat is where we landed",
  "can you take the follow up on the security questionnaire",
  "our churn last quarter was about three percent monthly",
  "let's timebox this to ten minutes and move on",
  "the migration is blocked on the vendor contract review",
];
const QUESTIONS = [
  "what did we decide about pricing?",
  "who owns the follow up?",
  "what is blocking the migration?",
  "what was our churn?",
];

async function ask(stable: string, volatile: string): Promise<number> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { num_predict: 1, temperature: 0, num_ctx: NUM_CTX },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: stable ? `${stable}\n\n${volatile}` : volatile },
      ],
    }),
  });
  const j = (await res.json()) as { prompt_eval_duration?: number };
  return (j.prompt_eval_duration ?? 0) / 1e6;
}

async function main() {
  console.log(`\nLive KV-cache eval — model=${MODEL}, profile=${PROFILE}, num_ctx=${NUM_CTX}\n`);
  console.log("  min | prompt tokens | prompt_eval");
  console.log("  ----+---------------+------------");

  const mem = new MeetingMemory(PROFILE);
  const perMin = 15;
  const askEvery = 5 * perMin;
  const times: number[] = [];

  for (let i = 0; i < 55 * perMin; i++) {
    const speaker: Speaker = i % 3 === 0 ? "you" : "room";
    mem.add(speaker, SAMPLE[i % SAMPLE.length], false);

    if (i > 0 && i % askEvery === 0) {
      const q = QUESTIONS[(i / askEvery) % QUESTIONS.length];
      const s = mem.build(q);
      const volatile = [
        s.recent,
        s.retrieved && `Possibly relevant earlier lines:\n${s.retrieved}`,
        `You were just addressed with: "${q}"\n\nSpeak your reply.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const ms = await ask(s.stable, volatile);
      times.push(ms);
      console.log(
        `  ${String(Math.round(i / perMin)).padStart(3)} | ${String(s.tokens.total).padStart(13)} | ${ms
          .toFixed(0)
          .padStart(8)} ms`,
      );
    }
  }

  const cold = times[0];
  const warm = times.slice(1);
  const mean = warm.reduce((a, b) => a + b, 0) / Math.max(1, warm.length);
  console.log(`\n  first question (cold): ${cold.toFixed(0)} ms`);
  console.log(`  later questions mean : ${mean.toFixed(0)} ms`);
  console.log(
    `  speedup vs cold      : ${cold > 0 ? (cold / Math.max(1, mean)).toFixed(1) : "?"}x\n`,
  );
}

void main();
