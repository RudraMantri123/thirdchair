/**
 * Replay a recorded session through a running ThirdChair server — the same
 * websocket, VAD, transcription, wake match, brain and voice as a live
 * session — and print the per-turn latency records it produces.
 *
 * Record a real session:   THIRDCHAIR_RECORD=1 npm run dev   (-> recordings/)
 * Replay it in real time:  npx tsx scripts/replay.ts recordings/<file>.tcrec
 * As fast as possible:     npx tsx scripts/replay.ts <file> --fast
 * Synthesize a recording:  npx tsx scripts/replay.ts --synth "hey copilot, what is two plus two?" \
 *                            --out recordings/two-plus-two.tcrec [--no-run]
 * Repeat for percentiles:  npx tsx scripts/replay.ts <file> --repeat 5
 * Print server events:     --verbose
 *
 * --fast removes wall-clock pacing. VAD is sample-counted, so utterance
 * boundaries are unchanged, but a multi-question recording can then deliver
 * question N+1 while answer N is still playing, which the server treats as a
 * barge-in. Use real time (or --speed 2..4) for multi-turn recordings.
 *
 * Exit code is non-zero if any turn fails to answer, so this doubles as a
 * regression test.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  encodeRecording,
  readRecording,
  type RecordedEvent,
} from "../server/recording.ts";
import { synthSession, runHeadless, formatRecords } from "./lib/headless-client.ts";
import type { TurnRecord } from "../shared/protocol.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (name: string) => args.includes(name);

const synth = flag("--synth");
const out = flag("--out");
const url = flag("--url") ?? "ws://localhost:8787/ws";
const repeat = Math.max(1, Number(flag("--repeat") ?? 1));
const speed = has("--fast") ? Infinity : Number(flag("--speed") ?? 1);
const file = args.find(
  (a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"),
);

let events: RecordedEvent[];
let label: string;
if (synth) {
  events = await synthSession(synth.split("|").map((s) => s.trim()));
  label = "synth";
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, encodeRecording(events));
    console.log(`wrote ${out} (${events.length} events)`);
  }
} else if (file) {
  events = await readRecording(file);
  label = file.split("/").pop() ?? file;
} else {
  console.error("usage: replay.ts <recording.tcrec> [--fast|--speed N] [--repeat N] [--url ws://…]");
  console.error('       replay.ts --synth "hey copilot, …[|second question]" [--out file.tcrec]');
  process.exit(2);
}

if (synth && out && has("--no-run")) process.exit(0);

const audioMs = events.length ? events[events.length - 1].tMs : 0;
console.log(
  `replaying ${label}: ${events.length} events, ${(audioMs / 1000).toFixed(1)} s of input, ` +
    `${Number.isFinite(speed) ? `${speed}x` : "as fast as possible"}, ${repeat} run(s)`,
);

const all: TurnRecord[] = [];
let failed = false;
for (let run = 1; run <= repeat; run++) {
  const t0 = performance.now();
  const res = await runHeadless(events, {
    url,
    speed,
    source: `replay:${label}${Number.isFinite(speed) ? `@${speed}x` : "@fast"}`,
    onMessage: has("--verbose")
      ? (msg) => {
          if (msg.type !== "answer_delta") console.log("  event:", JSON.stringify(msg).slice(0, 200));
        }
      : undefined,
  });
  const wall = performance.now() - t0;
  all.push(...res.records);
  const ok = !res.timedOut && res.records.length > 0 &&
    res.records.every((r) => r.outcome === "answered");
  if (!ok) failed = true;
  console.log(
    `run ${run}: ${res.records.length} turn(s), ${(res.audioBytes / 2 / 24000).toFixed(1)} s of answer audio, ` +
      `wall ${(wall / 1000).toFixed(1)} s${res.timedOut ? ", TIMED OUT" : ""}`,
  );
}

if (all.length) {
  console.log("\nLatency budget (ms):\n" + formatRecords(all));
}
process.exit(failed ? 1 : 0);
