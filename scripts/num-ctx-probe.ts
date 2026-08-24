/**
 * Does the local model silently truncate a long meeting transcript?
 *
 * Ollama applies a default context length (num_ctx) per model. If the
 * transcript exceeds it, the prompt is truncated from the FRONT with no
 * error — the model simply never sees the start of the meeting, and answers
 * confidently anyway. This probe plants a fact in the first line and checks
 * both the reported prompt token count and whether the fact survived.
 *
 * Run: npx tsx scripts/num-ctx-probe.ts
 */
const URL = "http://localhost:11434/api/chat";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3";

const CANARY = "the launch codeword is ZEBRAFISH";

function transcript(lines: number): string {
  const out = [`[0:00] You: ${CANARY}`];
  for (let i = 1; i < lines; i++) {
    out.push(
      `[${Math.floor(i / 15)}:${String((i * 4) % 60).padStart(2, "0")}] ${
        i % 3 === 0 ? "You" : "Room"
      }: we reviewed item ${i} and moved on to the next agenda point`,
    );
  }
  return out.join("\n");
}

async function probe(lines: number, numCtx?: number) {
  const text = transcript(lines);
  const body: Record<string, unknown> = {
    model: MODEL,
    stream: false,
    options: numCtx
      ? { num_predict: 24, temperature: 0, num_ctx: numCtx }
      : { num_predict: 24, temperature: 0 },
    messages: [
      { role: "system", content: "Answer from the transcript only." },
      {
        role: "user",
        content: `Transcript:\n${text}\n\nQ: what is the launch codeword?`,
      },
    ],
  };
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as {
    prompt_eval_count?: number;
    message?: { content?: string };
  };
  const answer = (j.message?.content ?? "").replace(/\s+/g, " ").trim();
  const found = /zebrafish/i.test(answer);
  console.log(
    `  ${String(lines).padStart(4)} lines | num_ctx=${String(numCtx ?? "default").padStart(7)} | prompt_eval_count=${String(
      j.prompt_eval_count ?? 0,
    ).padStart(6)} | canary ${found ? "FOUND" : "LOST "} | "${answer.slice(0, 60)}"`,
  );
}

async function main() {
  console.log(`\nnum_ctx truncation probe (model=${MODEL})`);
  console.log("Canary fact is planted in the FIRST line of the transcript.\n");
  for (const lines of [50, 200, 600, 900]) await probe(lines);
  console.log("\n  now with num_ctx raised explicitly:\n");
  for (const lines of [600, 900]) await probe(lines, 16384);
  console.log("");
}

void main();
