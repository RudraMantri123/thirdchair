/**
 * Recall eval: does the prompt we build still CONTAIN the information needed
 * to answer a question about something said earlier in the meeting?
 *
 * This measures information retention independently of the model — if the
 * fact isn't in the rendered prompt, no model can answer it, and no amount
 * of prompt engineering will help.
 *
 * Run: npx tsx scripts/recall-eval.ts
 */
import { TranscriptStore } from "../server/transcript.ts";
import type { Speaker } from "../shared/protocol.ts";

const UTTERANCES_PER_MIN = 15;

/** Facts planted at specific minutes, with the keyword that proves recall. */
const PLANTED: { atMin: number; line: string; probe: string; asks: string }[] = [
  { atMin: 2, line: "we agreed the enterprise tier lands at forty nine dollars a seat", probe: "forty nine", asks: "what did we decide about pricing?" },
  { atMin: 7, line: "Priya owns the security questionnaire and will send it Friday", probe: "Priya", asks: "who owns the security questionnaire?" },
  { atMin: 13, line: "our monthly churn last quarter was three point one percent", probe: "three point one", asks: "what was our churn?" },
  { atMin: 22, line: "we decided to delay the India launch until the second quarter", probe: "India launch", asks: "what did we decide about India?" },
  { atMin: 34, line: "the vendor contract review is the blocker on the migration", probe: "vendor contract", asks: "what is blocking the migration?" },
  { atMin: 46, line: "Arjun will present the revised roadmap at the next board meeting", probe: "Arjun", asks: "who presents the roadmap?" },
  { atMin: 55, line: "we settled on hiring two more backend engineers this half", probe: "two more backend", asks: "what did we decide about hiring?" },
];

const FILLER = [
  "yeah that makes sense to me",
  "can everyone see my screen okay",
  "let's move on to the next item",
  "sorry could you repeat that last part",
  "I think we're aligned on that one",
  "mhm right exactly",
];

function buildMeeting(minutes: number): TranscriptStore {
  const store = new TranscriptStore();
  const total = minutes * UTTERANCES_PER_MIN;
  for (let i = 0; i < total; i++) {
    const min = Math.floor(i / UTTERANCES_PER_MIN);
    const planted = PLANTED.find(
      (p) => p.atMin === min && i % UTTERANCES_PER_MIN === 0,
    );
    const speaker: Speaker = i % 3 === 0 ? "you" : "room";
    store.add(speaker, planted ? planted.line : FILLER[i % FILLER.length], false);
  }
  return store;
}

const MEETING_MINUTES = 60;
const store = buildMeeting(MEETING_MINUTES);
const prompt = store.render();

console.log(`\nRecall eval — ${MEETING_MINUTES}-minute meeting, prompt is ${prompt.length} chars\n`);
console.log("  planted at | fact                          | in prompt? | question");
console.log("  -----------+-------------------------------+------------+---------");

let recalled = 0;
for (const p of PLANTED) {
  const present = prompt.includes(p.probe);
  if (present) recalled++;
  console.log(
    `  ${String(p.atMin).padStart(7)}min | ${p.probe.padEnd(29)} | ${(present ? "YES" : "LOST").padEnd(10)} | ${p.asks}`,
  );
}

const pct = ((recalled / PLANTED.length) * 100).toFixed(0);
console.log(`\n  recall: ${recalled}/${PLANTED.length} (${pct}%)`);
if (recalled < PLANTED.length) {
  console.log(
    `  ${PLANTED.length - recalled} question(s) above are UNANSWERABLE — the fact is not in the prompt at all.\n`,
  );
} else {
  console.log("  every planted fact survived into the prompt.\n");
}
