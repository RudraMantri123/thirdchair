/**
 * Answer-quality regression over a replayed, synthesized meeting.
 *
 * Facts are stated in the first minute, buried under enough ordinary talk to
 * be sealed into history, then asked about later — the case that silent
 * context truncation breaks (it drops the START of the prompt, so the model
 * never sees the facts and answers confidently anyway). Each answer is scored
 * by keyword after number normalization, through the full live pipeline:
 * VAD, whisper, wake phrase, memory, model, voice.
 *
 *   npx tsx scripts/meeting-regression.ts                 # 8 questions, ~70 utterances
 *   npx tsx scripts/meeting-regression.ts --long          # 64 questions, ~260 utterances
 *   flags: --speed N (default 2; --long defaults to 3) --url ws://… --min-score 0..1
 *          --rebuild (re-synthesize the cached recording) --no-run --json FILE
 *
 * Needs a running server on the local path (THIRDCHAIR_VOICE=local). The
 * synthesized recording is cached under recordings/ so every configuration
 * hears byte-identical audio. Exit code is non-zero when the score is below
 * --min-score or any turn fails to answer.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { encodeRecording, readRecording } from "../server/recording.ts";
import { runHeadless, synthMeeting } from "./lib/headless-client.ts";
import { normalizeForScoring } from "./lib/normalize-text.ts";
import { percentile } from "../server/latency.ts";
import type { ServerMessage, TurnRecord } from "../shared/protocol.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const long = args.includes("--long");
const speed = Number(flag("--speed") ?? (long ? 3 : 2));
const url = flag("--url") ?? "ws://localhost:8787/ws";
const minScore = Number(flag("--min-score") ?? 0);
const jsonOut = flag("--json");

/** Stated in the first minute. */
const FACTS = [
  "Let's lock it in, the enterprise tier will be forty nine dollars per seat.",
  "Maria owns the security questionnaire and she will send it on Friday.",
  "Our monthly churn last quarter was three point one percent.",
  "We decided to delay the India launch until the second quarter.",
  "The data migration is blocked on the vendor contract review.",
  "Daniel will present the revised roadmap at the board meeting.",
  "The codeword for the project is blue falcon.",
];

/** Asked later. Any one of `expect` (normalized) counts as correct. */
const QUESTIONS: { q: string; expect: string[] }[] = [
  { q: "hey copilot, what price did we set for the enterprise tier?", expect: ["49"] },
  { q: "hey copilot, who owns the security questionnaire?", expect: ["maria"] },
  { q: "hey copilot, what was our monthly churn last quarter?", expect: ["3.1", "3 point 1", "3 1 percent"] },
  { q: "hey copilot, when is the India launch?", expect: ["second quarter", "2nd quarter", "q2", "quarter 2"] },
  { q: "hey copilot, what is blocking the data migration?", expect: ["vendor", "contract"] },
  { q: "hey copilot, who is presenting the roadmap at the board meeting?", expect: ["daniel"] },
  { q: "hey copilot, what is the project codeword?", expect: ["falcon"] },
  { q: "hey copilot, what is two plus two?", expect: ["4"] },
];

/** Ordinary meeting talk with none of the facts in it. */
const FILLER = [
  "Can everyone see my screen okay?",
  "Let's move on to the next item on the agenda.",
  "Sorry, could you repeat that last part?",
  "I think we are aligned on that one.",
  "The design review went better than expected this week.",
  "We should probably timebox this discussion to ten minutes.",
  "I will share the slides in the channel after the call.",
  "Marketing wants a clearer story for the website refresh.",
  "Support tickets were roughly flat compared to last month.",
  "The new onboarding flow is in testing with a few customers.",
  "Let's park that and come back to it at the end.",
  "I had a good call with the partner team yesterday.",
  "We need someone to update the internal wiki page.",
  "The office move is still on track for later this year.",
  "Hiring for the design role is going slowly.",
  "The mobile app crash rate went down after the last release.",
  "Can we get a quick status on the analytics dashboard?",
  "Engineering is mostly focused on reliability this sprint.",
  "The customer advisory board meets again next month.",
  "Let's make sure the notes capture the open questions.",
  "I think the documentation needs another pass before launch.",
  "Finance asked for updated numbers by the end of the week.",
  "We got positive feedback on the beta from two large accounts.",
  "Let's keep the meeting short today, a few people have conflicts.",
  "The team offsite agenda is mostly finalized.",
  "Has anyone looked at the competitor announcement?",
  "The API latency improved after the caching change.",
  "We should send a recap email to the wider group.",
  "Quality assurance found a few minor issues in staging.",
  "Okay, that sounds reasonable to me.",
];

const STATEMENT_GAP_MS = 1200;
const QUESTION_GAP_MS = long ? 18000 : 14000;

function script(): { text: string; silenceAfterMs: number }[] {
  const items: { text: string; silenceAfterMs: number }[] = [];
  const say = (text: string) => items.push({ text, silenceAfterMs: STATEMENT_GAP_MS });
  let f = 0;
  const filler = (n: number) => {
    for (let i = 0; i < n; i++) say(FILLER[f++ % FILLER.length]);
  };
  filler(2);
  for (const fact of FACTS) say(fact);
  // Enough talk after the facts that they are sealed into a history segment
  // (40 utterances) before anything is asked: recall must come from history.
  filler(45);
  const asks = long ? 64 : QUESTIONS.length;
  for (let i = 0; i < asks; i++) {
    items.push({ text: QUESTIONS[i % QUESTIONS.length].q, silenceAfterMs: QUESTION_GAP_MS });
    filler(long ? 3 : 1);
  }
  return items;
}

function normalized(text: string): string {
  return ` ${normalizeForScoring(text).join(" ")} `;
}

function correct(answer: string, expect: string[]): boolean {
  const a = normalized(answer);
  return expect.some((e) => a.includes(` ${normalizeForScoring(e).join(" ")} `));
}

async function main() {
  const path = `recordings/regression-${long ? "long" : "short"}.tcrec`;
  if (!existsSync(path) || args.includes("--rebuild")) {
    console.log(`synthesizing ${path} …`);
    const events = await synthMeeting(script());
    await mkdir("recordings", { recursive: true });
    await writeFile(path, encodeRecording(events));
  }
  if (args.includes("--no-run")) return;
  const events = await readRecording(path);
  const audioS = events[events.length - 1].tMs / 1000;
  console.log(`replaying ${path}: ${audioS.toFixed(0)} s of meeting at ${speed}x`);

  // Answers arrive as deltas then answer_done; attribute each to the turn
  // that was triggered most recently.
  const answers = new Map<string, { question: string; text: string }>();
  let current: string | null = null;
  const committed: string[] = [];
  const onMessage = (msg: ServerMessage) => {
    if (msg.type === "triggered") {
      current = msg.turnId;
      answers.set(msg.turnId, { question: msg.question, text: "" });
    } else if (msg.type === "answer_done" && current) {
      answers.get(current)!.text = msg.text;
    } else if (msg.type === "committed") {
      committed.push(msg.entry.text);
    } else if (msg.type === "error") {
      console.log(`  server error: ${msg.message}`);
    }
  };

  const t0 = performance.now();
  const res = await runHeadless(events, {
    url,
    speed,
    source: `regression:${long ? "long" : "short"}@${speed}x`,
    onMessage,
    timeoutMs: (audioS / speed) * 1000 + 180_000,
  });
  const wallS = (performance.now() - t0) / 1000;

  // Align turns to the scripted questions by what was heard, in order. A
  // question whose wake phrase was misheard produces no turn; it must count
  // as a miss without shifting every later answer onto the wrong question.
  const records = res.records;
  const rows: {
    i: number;
    asked: string;
    heard: string;
    answer: string;
    triggered: boolean;
    ok: boolean;
    rec?: TurnRecord;
  }[] = [];
  const asks = long ? 64 : QUESTIONS.length;
  const turns = [...answers.entries()];
  const words = (t: string) =>
    new Set(normalizeForScoring(t.replace(/hey,? co-?pilot,?/i, "")).filter((w) => w.length > 2));
  const overlap = (a: string, b: string) => {
    const A = words(a);
    const B = words(b);
    let n = 0;
    for (const w of A) if (B.has(w)) n++;
    return n / Math.max(1, Math.min(A.size, B.size));
  };
  let next = 0;
  const matched = new Map<number, [string, { question: string; text: string }]>();
  for (const turn of turns) {
    for (let j = next; j < Math.min(asks, next + 3); j++) {
      if (overlap(turn[1].question, QUESTIONS[j % QUESTIONS.length].q) >= 0.5) {
        matched.set(j, turn);
        next = j + 1;
        break;
      }
    }
  }
  for (let i = 0; i < asks; i++) {
    const q = QUESTIONS[i % QUESTIONS.length];
    const [turnId, a] = matched.get(i) ?? [undefined, undefined];
    const rec = records.find((r) => r.turnId === turnId);
    const answer = a?.text ?? "";
    rows.push({
      i: i + 1,
      asked: q.q,
      heard: a?.question ?? "(not triggered: wake phrase or question misheard)",
      answer,
      triggered: !!a,
      ok: !!a && rec?.outcome === "answered" && correct(answer, q.expect),
      rec,
    });
  }

  for (const r of rows) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"} #${String(r.i).padStart(2)} ${r.asked.replace("hey copilot, ", "")}\n` +
        `       heard:  ${r.heard}\n       answer: ${r.answer.replace(/\s+/g, " ").slice(0, 200)}` +
        (r.rec?.llm ? `\n       prompt ${r.rec.llm.promptTokens} tok (est ${r.rec.llm.estimatedTokens}) num_ctx ${r.rec.llm.numCtx} load ${r.rec.llm.loadMs} ms` : ""),
    );
  }

  const score = rows.filter((r) => r.ok).length / rows.length;
  const answered = records.filter((r) => r.outcome === "answered");
  const e2e = answered.map((r) => r.e2eMs).filter((v): v is number => v !== null);
  const ttft = answered.map((r) => r.components.llmTtft).filter((v): v is number => v !== null);
  const llm = records.map((r) => r.llm).filter((u) => u !== undefined);
  const maxPrompt = llm.length ? Math.max(...llm.map((u) => u.promptTokens)) : null;
  const maxEst = llm.length ? Math.max(...llm.map((u) => u.estimatedTokens)) : null;
  const ratios = llm.filter((u) => u.promptTokens > 0).map((u) => u.estimatedTokens / u.promptTokens);
  const p = (v: number[], q: number) => (v.length ? Math.round(percentile(v, q)) : "-");

  const trig = rows.filter((r) => r.triggered);
  console.log(`\nscore ${rows.filter((r) => r.ok).length}/${rows.length} (${(score * 100).toFixed(0)}%)` +
    `   answer accuracy on triggered turns ${trig.filter((r) => r.ok).length}/${trig.length}` +
    `   turns ${records.length} answered ${answered.length}   committed utterances ${committed.length}   wall ${wallS.toFixed(0)} s`);
  console.log(`e2e p50 ${p(e2e, 50)} p95 ${p(e2e, 95)} ms   llm ttft p50 ${p(ttft, 50)} p95 ${p(ttft, 95)} ms` +
    `   first-turn ttft ${answered[0]?.components.llmTtft ?? "-"} ms`);
  if (maxPrompt !== null) {
    console.log(`prompt tokens max ${maxPrompt} (estimate max ${maxEst}; estimate/actual ${Math.min(...ratios).toFixed(2)}–${Math.max(...ratios).toFixed(2)})` +
      `   num_ctx ${[...new Set(llm.map((u) => u.numCtx))].join(",")}`);
  }
  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify({ score, rows: rows.map(({ rec, ...r }) => ({ ...r, llm: rec?.llm, e2e: rec?.e2eMs, ttft: rec?.components.llmTtft })), committed }, null, 1));
  }
  const failed = res.timedOut || answered.length < records.length || score < minScore;
  process.exit(failed ? 1 : 0);
}

void main();
