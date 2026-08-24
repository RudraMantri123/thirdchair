/**
 * Memory audit for the transcript store.
 *
 * Simulates a 60-minute meeting and reports the three things that actually
 * cost money and latency: heap growth, prompt size per question, and how
 * much of the rendered prompt prefix is STABLE between consecutive
 * questions (the ceiling on prompt-cache / KV-cache reuse).
 *
 * Run: npx tsx scripts/memory-audit.ts
 */
import { TranscriptStore } from "../server/transcript.ts";
import type { Speaker } from "../shared/protocol.ts";

const MINUTES = 60;
const UTTERANCES_PER_MIN = 15; // one every 4s — a normal conversation
const SAMPLE = [
  "I think we should push the pricing decision to next week",
  "the enterprise tier at forty nine a seat is where we landed",
  "can you take the follow up on the security questionnaire",
  "our churn last quarter was about three percent monthly",
  "let's timebox this to ten minutes and move on",
  "the migration is blocked on the vendor contract review",
];

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

const store = new TranscriptStore();
const total = MINUTES * UTTERANCES_PER_MIN;

// Ask a question every 5 minutes and compare consecutive renders.
const askEvery = 5 * UTTERANCES_PER_MIN;
let prevRender = "";
const rows: {
  min: number;
  entries: number;
  chars: number;
  tokens: number;
  reusePct: number;
}[] = [];

const heapBefore = process.memoryUsage().heapUsed;

for (let i = 0; i < total; i++) {
  const speaker: Speaker = i % 3 === 0 ? "you" : "room";
  store.add(speaker, SAMPLE[i % SAMPLE.length], false);

  if (i > 0 && i % askEvery === 0) {
    const rendered = store.render();
    const reuse = prevRender
      ? (commonPrefixLength(prevRender, rendered) / rendered.length) * 100
      : 0;
    rows.push({
      min: Math.round(i / UTTERANCES_PER_MIN),
      entries: i + 1,
      chars: rendered.length,
      tokens: Math.round(rendered.length / 4),
      reusePct: reuse,
    });
    prevRender = rendered;
  }
}

const heapAfter = process.memoryUsage().heapUsed;

console.log(`\nSimulated ${MINUTES}-minute meeting: ${total} utterances\n`);
console.log("  min | entries | prompt chars | ~tokens | prefix reuse");
console.log("  ----+---------+--------------+---------+-------------");
for (const r of rows) {
  console.log(
    `  ${String(r.min).padStart(3)} | ${String(r.entries).padStart(7)} | ${String(
      r.chars,
    ).padStart(12)} | ${String(r.tokens).padStart(7)} | ${r.reusePct
      .toFixed(1)
      .padStart(10)}%`,
  );
}

const full = store.render(Number.MAX_SAFE_INTEGER);
console.log(
  `\n  transcript held in memory : ${store.export().length} entries, ${full.length} chars`,
);
console.log(
  `  heap growth               : ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)} MB`,
);
console.log(
  `  dropped from prompt       : ${full.length - rows.at(-1)!.chars} chars (${(
    ((full.length - rows.at(-1)!.chars) / full.length) *
    100
  ).toFixed(0)}% of the meeting is invisible to the model)`,
);

// Cost of the naive approach across the meeting, assuming one question
// every 5 minutes and no cache reuse at all.
const totalTokens = rows.reduce((n, r) => n + r.tokens, 0);
console.log(
  `  input tokens for ${rows.length} questions: ${totalTokens} (no reuse) vs ~${Math.round(
    totalTokens * 0.1,
  )} if the prefix were cacheable\n`,
);
