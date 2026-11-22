/**
 * How big does the real prompt get? Sizes OLLAMA_NUM_CTX from measurement.
 *
 * Drives MeetingMemory through a long simulated meeting (simulated clock, so
 * timestamps have their real width), asks a question every couple of
 * minutes, renders the exact messages the brain would send, and has the
 * model server count them with the model's own tokenizer and chat template
 * (prompt_eval_count, run with a window large enough that nothing can be
 * truncated). Also reports our pre-flight estimate for the same prompt, which
 * is what the context guard in server/ollama.ts relies on.
 *
 * Three meetings:
 *   typical  utterances of ordinary meeting length (3-40 words)
 *   numeric  half the talk is figures, ticket ids and versions (dense tokens)
 *   stress   every utterance at the 30 s VAD cap (~80 words), copilot answers
 *            at their longest — an upper bound, not a realistic meeting
 *
 * Run: OLLAMA_URL=http://127.0.0.1:11435 npx tsx scripts/prompt-size-probe.ts [--minutes 120] [--modes typical,numeric,stress]
 */
import { MeetingMemory } from "../server/memory/index.ts";
import { chatMessages } from "../server/brain.ts";
import { estimatePromptTokens, PromptCalibration, RESPONSE_RESERVE_TOKENS } from "../server/ollama.ts";
import { config } from "../server/config.ts";
import type { Speaker } from "../shared/protocol.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const MINUTES = Number(flag("--minutes") ?? 120);
const PER_MIN = 15;
const ASK_EVERY_MIN = 2;
const COUNT_CTX = 32768;

const SENTENCES = [
  "Let's lock it in, the enterprise tier will be forty nine dollars per seat",
  "Maria owns the security questionnaire and she will send it on Friday",
  "our monthly churn last quarter was three point one percent",
  "we decided to delay the India launch until the second quarter",
  "the data migration is blocked on the vendor contract review",
  "Daniel will present the revised roadmap at the board meeting",
  "can everyone see my screen okay",
  "let's move on to the next item on the agenda",
  "I think we are aligned on that one",
  "the design review went better than expected this week",
  "marketing wants a clearer story for the website refresh",
  "support tickets were roughly flat compared to last month",
  "the new onboarding flow is in testing with a few customers and the early numbers look promising",
  "we need someone to update the internal wiki page before the partner training next Tuesday",
  "the mobile app crash rate went down after the last release, mostly the Android startup crash",
  "finance asked for updated numbers by the end of the week so we can close the quarterly forecast",
  "we got positive feedback on the beta from two large accounts, Northwind and Contoso, both want the export feature",
  "action item for Sam to follow up with legal about the data processing agreement",
  "the API latency improved after the caching change, p95 is down from eight hundred to three hundred milliseconds",
  "okay",
  "yeah that makes sense",
];
/** Number-dense talk tokenizes far more densely per byte. */
const NUMERIC = [
  "Q3 revenue was $4.2M, up 18% QoQ; ARR hit 17.5M on 1,240 accounts",
  "ticket JIRA-4821 and PR #3310 block the v2.14.0 release on 2026-03-04",
  "p95 went from 812 ms to 297 ms after build 4471, error rate 0.03%",
  "the Q4 target is 2,300 seats at $49, so roughly $112,700 MRR",
];
const QUESTIONS = [
  "what price did we set for the enterprise tier?",
  "who owns the security questionnaire?",
  "what was our monthly churn last quarter?",
  "summarize the last ten minutes",
  "what are the open action items?",
];
const ANSWER_SHORT =
  "Maria owns the security questionnaire, and she said she would send it on Friday.";
const ANSWER_LONG =
  "Earlier in the meeting the team agreed on several things. The enterprise tier is forty nine dollars a seat, Maria owns the security questionnaire due Friday, " +
  "the India launch moved to the second quarter, and the data migration is waiting on the vendor contract review. Daniel presents the revised roadmap at the board meeting.";

let now = Date.parse("2026-01-01T09:00:00Z");
Date.now = () => now;

interface Row {
  minute: number;
  tokens: number;
  /** Raw pre-flight estimate. */
  estimate: number;
  /** Estimate after per-meeting calibration — what the guard acts on. */
  guarded: number;
  bytes: number;
}

async function countTokens(messages: { role: string; content: string }[]): Promise<number> {
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.ollamaModel,
      stream: false,
      messages,
      options: { num_ctx: COUNT_CTX, num_predict: 1, temperature: 0 },
    }),
  });
  const j = (await res.json()) as { prompt_eval_count?: number; error?: string };
  if (j.error) throw new Error(j.error);
  return j.prompt_eval_count ?? 0;
}

type Mode = "typical" | "numeric" | "stress";

function utterance(i: number, mode: Mode): string {
  if (mode === "typical") return SENTENCES[(i * 7) % SENTENCES.length];
  if (mode === "numeric") {
    return i % 2 ? NUMERIC[(i >> 1) % NUMERIC.length] : SENTENCES[(i * 7) % SENTENCES.length];
  }
  // ~80 words: what a 30 s monologue chunk (the VAD's cap) transcribes to.
  const parts: string[] = [];
  for (let k = 0; parts.join(" ").split(" ").length < 80; k++) {
    parts.push(SENTENCES[(i * 7 + k * 3) % SENTENCES.length]);
  }
  return parts.join(", ");
}

async function meeting(mode: Mode): Promise<Row[]> {
  const stress = mode === "stress";
  now = Date.parse("2026-01-01T09:00:00Z");
  const mem = new MeetingMemory(config.memoryProfile);
  const calibration = new PromptCalibration();
  const rows: Row[] = [];
  const total = MINUTES * PER_MIN;
  for (let i = 1; i <= total; i++) {
    now += 60_000 / PER_MIN;
    const speaker: Speaker = i % 3 === 0 ? "you" : "room";
    mem.add(speaker, utterance(i, mode), false);
    if (i % (ASK_EVERY_MIN * PER_MIN) === 0) {
      const q = QUESTIONS[(i / (ASK_EVERY_MIN * PER_MIN)) % QUESTIONS.length];
      const messages = chatMessages(q, mem.build(q));
      const tokens = await countTokens(messages);
      const estimate = estimatePromptTokens(messages);
      const guarded = calibration.correct(estimate);
      calibration.observe(estimate, tokens);
      rows.push({
        minute: Math.round(i / PER_MIN),
        tokens,
        estimate,
        guarded,
        bytes: messages.reduce((a, m) => a + Buffer.byteLength(m.content), 0),
      });
      // What the room heard back goes into the transcript, as in a session.
      mem.add("you", stress ? ANSWER_LONG : ANSWER_SHORT, true);
    }
  }
  return rows;
}

async function main() {
  console.log(
    `prompt size over a ${MINUTES}-minute meeting — model ${config.ollamaModel}, memory profile "${config.memoryProfile}", ` +
      `counted by ${config.ollamaUrl} at num_ctx ${COUNT_CTX}`,
  );
  const modes = (flag("--modes") ?? "typical,numeric,stress").split(",") as Mode[];
  for (const mode of modes) {
    const rows = await meeting(mode);
    const max = rows.reduce((a, r) => (r.tokens > a.tokens ? r : a));
    const bpt = rows.map((r) => r.bytes / r.tokens);
    const ratio = rows.map((r) => r.estimate / r.tokens);
    const under = rows.map((r) => r.tokens - r.guarded);
    const maxGuarded = Math.max(...rows.map((r) => r.guarded));
    console.log(`\n=== ${mode === "stress" ? "stress (every utterance ~80 words)" : mode === "numeric" ? "numeric (half the talk is figures, tickets, versions)" : "typical"} ===`);
    console.log("  min | prompt tokens | estimate | guarded | bytes/token");
    for (const r of rows.filter((x, k) => k % 5 === 0 || x === max)) {
      console.log(
        `  ${String(r.minute).padStart(3)} | ${String(r.tokens).padStart(13)} | ${String(r.estimate).padStart(8)} | ${String(r.guarded).padStart(7)} | ${(r.bytes / r.tokens).toFixed(2)}`,
      );
    }
    console.log(
      `  max ${max.tokens} tokens at minute ${max.minute}; bytes/token ${Math.min(...bpt).toFixed(2)}–${Math.max(...bpt).toFixed(2)}; ` +
        `raw estimate/actual ${Math.min(...ratio).toFixed(2)}–${Math.max(...ratio).toFixed(2)} (must stay > 1)`,
    );
    console.log(
      `  guarded estimate: max ${maxGuarded} -> needs num_ctx >= ${maxGuarded + RESPONSE_RESERVE_TOKENS}; ` +
        `worst under-count ${Math.max(...under)} tokens (must stay below the ${RESPONSE_RESERVE_TOKENS}-token reserve)`,
    );
  }
}

void main();
