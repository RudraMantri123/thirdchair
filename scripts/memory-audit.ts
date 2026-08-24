/**
 * Memory audit: heap growth, prompt size, and — the metric that decides
 * latency — how much of the prompt prefix is BYTE-STABLE between consecutive
 * questions. That number is the ceiling on prompt-cache and KV-cache reuse.
 *
 * Run: npx tsx scripts/memory-audit.ts
 */
import { MeetingMemory, type MemoryProfile } from "../server/memory/index.ts";
import type { Speaker } from "../shared/protocol.ts";

const MINUTES = 60;
const UTTERANCES_PER_MIN = 15;
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
  "summarize the last ten minutes",
];

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

for (const profile of ["full", "compact"] as MemoryProfile[]) {
  const mem = new MeetingMemory(profile);
  const total = MINUTES * UTTERANCES_PER_MIN;
  const askEvery = 5 * UTTERANCES_PER_MIN;

  let prevStable = "";
  const rows: { min: number; tokens: number; reuse: number }[] = [];
  const heapBefore = process.memoryUsage().heapUsed;

  for (let i = 0; i < total; i++) {
    const speaker: Speaker = i % 3 === 0 ? "you" : "room";
    mem.add(speaker, SAMPLE[i % SAMPLE.length], false);

    if (i > 0 && i % askEvery === 0) {
      const s = mem.build(QUESTIONS[(i / askEvery) % QUESTIONS.length]);
      // The cacheable prefix is the stable section; the question deliberately
      // sits after it, so a per-question rewrite costs only its own tokens.
      const reuse = prevStable
        ? (commonPrefixLength(prevStable, s.stable) /
            Math.max(1, s.stable.length)) *
          100
        : 0;
      rows.push({
        min: Math.round(i / UTTERANCES_PER_MIN),
        tokens: s.tokens.total,
        reuse,
      });
      prevStable = s.stable;
    }
  }

  const heapAfter = process.memoryUsage().heapUsed;
  console.log(`\n=== profile "${profile}" — ${MINUTES}-min meeting, ${total} utterances ===\n`);
  console.log("  min | prompt tokens | stable-prefix reuse");
  console.log("  ----+---------------+--------------------");
  for (const r of rows) {
    console.log(
      `  ${String(r.min).padStart(3)} | ${String(r.tokens).padStart(13)} | ${r.reuse
        .toFixed(1)
        .padStart(17)}%`,
    );
  }
  const avgReuse =
    rows.slice(1).reduce((n, r) => n + r.reuse, 0) / Math.max(1, rows.length - 1);
  console.log(
    `\n  mean prefix reuse after warmup: ${avgReuse.toFixed(1)}%   heap: ${(
      (heapAfter - heapBefore) /
      1024 /
      1024
    ).toFixed(2)} MB`,
  );
  console.log(
    `  claims extracted into the decision journal: ${mem.claims().length}`,
  );
}
console.log("");
