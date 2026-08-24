/**
 * Empirically measure whether Ollama/llama.cpp reuses the KV cache for a
 * shared prompt prefix — and what breaks it.
 *
 * Three requests:
 *   A  : long transcript + question           (cold)
 *   A' : SAME transcript, different question appended at the END (append-only)
 *   B  : transcript with the FRONT changed    (what our sliding window does)
 *
 * If prefix reuse works, A' has a far lower prompt_eval_duration than A,
 * and B goes back up to roughly A's cost.
 */
const URL = "http://localhost:11434/api/chat";
const MODEL = "llama3";

const line = (i: number) =>
  `[${Math.floor(i / 15)}:${String((i * 4) % 60).padStart(2, "0")}] ${
    i % 3 === 0 ? "You" : "Room"
  }: we discussed item ${i} and agreed to revisit the pricing tier next week`;

const head = Array.from({ length: 120 }, (_, i) => line(i)).join("\n");
const headShifted = Array.from({ length: 120 }, (_, i) => line(i + 30)).join("\n");

async function probe(label: string, transcript: string, question: string) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { num_predict: 1, temperature: 0 },
      messages: [
        { role: "system", content: "You are a meeting assistant." },
        { role: "user", content: `Transcript:\n${transcript}\n\nQ: ${question}` },
      ],
    }),
  });
  const j = (await res.json()) as {
    prompt_eval_count?: number;
    prompt_eval_duration?: number;
  };
  const ms = (j.prompt_eval_duration ?? 0) / 1e6;
  console.log(
    `  ${label.padEnd(34)} prompt_tokens=${String(j.prompt_eval_count ?? 0).padStart(
      5,
    )}  prompt_eval=${ms.toFixed(0).padStart(6)} ms`,
  );
  return ms;
}

async function main() {
  console.log("\nKV-cache prefix reuse probe (Ollama /api/chat)\n");
  const a = await probe("A  cold, transcript+Q1", head, "what did we decide?");
  const a2 = await probe("A' same prefix, new Q appended", head, "who owns the follow up?");
  const b = await probe("B  front of transcript changed", headShifted, "what did we decide?");
  const a3 = await probe("A  repeat of A (control)", head, "what did we decide?");

  const pct = (x: number) => (a > 0 ? (((a - x) / a) * 100).toFixed(0) : "?");
  console.log(`\n  append-only (new Q at end) : ${pct(a2)}% faster prompt eval than cold`);
  console.log(`  front-of-transcript changed: ${pct(b)}% faster (expect ~0 → cache lost)`);
  console.log(`  control re-send            : ${pct(a3)}% faster\n`);
}

void main();
