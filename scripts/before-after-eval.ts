/**
 * Head-to-head: the OLD sliding-char-window transcript vs the NEW append-only
 * MeetingMemory, on the same simulated meeting, asking the same questions,
 * against the same live local model.
 *
 * Reports the prompt-eval time Ollama charges per question — the dominant
 * component of time-to-first-spoken-word on the local path.
 *
 * Run: npx tsx scripts/before-after-eval.ts
 */
import { MeetingMemory } from "../server/memory/index.ts";
import { TranscriptStore } from "../server/transcript.ts";
import type { Speaker } from "../shared/protocol.ts";

const URL = "http://localhost:11434/api/chat";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3";
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

const PER_MIN = 15;
const MINUTES = 50;
const ASK_EVERY = 5 * PER_MIN;

async function promptEvalMs(user: string): Promise<{ ms: number; tokens: number }> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { num_predict: 1, temperature: 0, num_ctx: 8192 },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });
  const j = (await res.json()) as {
    prompt_eval_duration?: number;
    prompt_eval_count?: number;
  };
  return {
    ms: (j.prompt_eval_duration ?? 0) / 1e6,
    tokens: j.prompt_eval_count ?? 0,
  };
}

/**
 * Each implementation gets its own pass. Interleaving them would make the two
 * prompt shapes alternate against a single cache slot and evict each other,
 * measuring prompt size while hiding the caching effect entirely — in
 * production only one shape ever runs.
 */
async function pass(
  label: string,
  render: (i: number, q: string) => string,
): Promise<number[]> {
  console.log(`  ${label}`);
  console.log("    min | tokens | prompt_eval");
  console.log("    ----+--------+------------");
  const times: number[] = [];
  for (let i = 0; i < MINUTES * PER_MIN; i++) {
    if (i > 0 && i % ASK_EVERY === 0) {
      const q = QUESTIONS[(i / ASK_EVERY) % QUESTIONS.length];
      const r = await promptEvalMs(render(i, q));
      times.push(r.ms);
      console.log(
        `    ${String(Math.round(i / PER_MIN)).padStart(3)} | ${String(r.tokens).padStart(6)} | ${r.ms
          .toFixed(0)
          .padStart(8)} ms`,
      );
    } else if (i % ASK_EVERY !== 0) {
      render(i, "");
    }
  }
  return times;
}

async function main() {
  console.log(`\nBefore/after — model=${MODEL}, ${MINUTES}-min meeting, separate passes\n`);

  const old = new TranscriptStore();
  const oldTimes = await pass("OLD — sliding char window, re-rendered per question", (i, q) => {
    const speaker: Speaker = i % 3 === 0 ? "you" : "room";
    old.add(speaker, SAMPLE[i % SAMPLE.length], false);
    if (!q) return "";
    return `Meeting transcript so far:\n<transcript>\n${old.render()}\n</transcript>\n\nYou were just addressed with: "${q}"\n\nSpeak your reply.`;
  });

  console.log("");
  const neu = new MeetingMemory("compact");
  const newTimes = await pass("NEW — append-only sealed segments, volatile tail last", (i, q) => {
    const speaker: Speaker = i % 3 === 0 ? "you" : "room";
    neu.add(speaker, SAMPLE[i % SAMPLE.length], false);
    if (!q) return "";
    const s = neu.build(q);
    const volatile = [
      s.recent,
      s.retrieved && `Possibly relevant earlier lines:\n${s.retrieved}`,
      `You were just addressed with: "${q}"\n\nSpeak your reply.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return s.stable ? `${s.stable}\n\n${volatile}` : volatile;
  });

  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const om = mean(oldTimes);
  const nm = mean(newTimes);
  console.log(`\n  mean prompt eval — OLD: ${om.toFixed(0)} ms   NEW: ${nm.toFixed(0)} ms`);
  console.log(`  improvement: ${nm > 0 ? (om / nm).toFixed(1) : "?"}x faster`);
  console.log(
    `  worst case      — OLD: ${Math.max(...oldTimes).toFixed(0)} ms   NEW: ${Math.max(
      ...newTimes,
    ).toFixed(0)} ms\n`,
  );
}

void main();
