/**
 * Does a second, different prompt evict the answer-path KV cache?
 *
 * This decides the architecture: if a background "summarize the old chunk"
 * call blows away the cached prefix that answers use, then summarization on
 * the local path must either share the answer prefix or not call the LLM at
 * all.
 *
 * Alternates two different prefixes (ANSWER and SUMMARIZE) and prints the
 * prompt-eval time of each. One slot => both always cold. Two slots => both
 * warm after the first round.
 *
 * Run with the default single slot, then compare:
 *   OLLAMA_NUM_PARALLEL=2 ollama serve
 *
 * Run: npx tsx scripts/kv-slots-probe.ts
 */
const URL = "http://localhost:11434/api/chat";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3";

const line = (i: number) =>
  `[${Math.floor(i / 15)}:${String((i * 4) % 60).padStart(2, "0")}] ${
    i % 3 === 0 ? "You" : "Room"
  }: we discussed item ${i} and agreed to revisit the pricing tier next week`;

const transcript = Array.from({ length: 120 }, (_, i) => line(i)).join("\n");

// Two DIFFERENT prefixes — this is the point. They diverge at the system
// message, so neither can serve as a prefix for the other.
const ANSWER_SYS = "You are a meeting assistant answering questions out loud.";
const SUMMARIZE_SYS = "You compress meeting transcript chunks into terse notes.";

async function ask(system: string, user: string): Promise<number> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { num_predict: 1, temperature: 0 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const j = (await res.json()) as { prompt_eval_duration?: number };
  return (j.prompt_eval_duration ?? 0) / 1e6;
}

async function main() {
  console.log(`\nKV slot contention probe (model=${MODEL})`);
  console.log(`OLLAMA_NUM_PARALLEL as seen by this script: ${process.env.OLLAMA_NUM_PARALLEL ?? "(unset — server default)"}\n`);
  console.log("  round | ANSWER prompt_eval | SUMMARIZE prompt_eval");
  console.log("  ------+--------------------+----------------------");

  for (let round = 1; round <= 3; round++) {
    const a = await ask(ANSWER_SYS, `Transcript:\n${transcript}\n\nQ: what did we decide?`);
    const s = await ask(SUMMARIZE_SYS, `Transcript:\n${transcript}\n\nCompress the above.`);
    console.log(
      `  ${String(round).padStart(5)} | ${a.toFixed(0).padStart(15)} ms | ${s
        .toFixed(0)
        .padStart(17)} ms`,
    );
  }

  console.log(
    "\n  If both columns stay high on rounds 2-3, the two prompts are fighting",
  );
  console.log(
    "  over one cache slot — a background summarizer would make every spoken",
  );
  console.log("  answer pay full prompt eval.\n");
}

void main();
