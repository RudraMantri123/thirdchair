/**
 * A browser stand-in for scripts: streams recorded or synthesized input into
 * a running ThirdChair server over the same websocket protocol the web client
 * uses, acknowledges answer playback, and collects the per-turn latency
 * records the server emits.
 *
 * Playback acknowledgement: a headless client has no audio device, so it
 * reports "audible" the moment the first answer chunk arrives. The browser
 * additionally schedules a ~50 ms jitter lead-in before the first chunk,
 * which these numbers therefore do not include.
 */
import WebSocket from "ws";
import { testSpeech } from "./test-speech.ts";
import {
  REC_AUDIO,
  REC_CONTROL,
  type RecordedEvent,
} from "../../server/recording.ts";
import type { ServerMessage, TurnRecord, LatencySummary } from "../../shared/protocol.ts";

const FRAME_BYTES = 4096; // 2048 samples = 128 ms at 16 kHz
const FRAME_MS = 128;

/**
 * Build a session recording from text: start, ~1 s of room tone, the spoken
 * text, then trailing silence long enough for the VAD to commit.
 */
export async function synthSession(texts: string[]): Promise<RecordedEvent[]> {
  return synthMeeting(texts.map((text) => ({ text, silenceAfterMs: 2048 })));
}

/**
 * Same, with a chosen silence after each utterance — long after a question
 * so the answer finishes before the next line arrives (a line heard while
 * the copilot is answering is treated as its own echo, by design).
 */
export async function synthMeeting(
  items: { text: string; silenceAfterMs: number }[],
): Promise<RecordedEvent[]> {
  const events: RecordedEvent[] = [
    { tMs: 0, kind: REC_CONTROL, payload: Buffer.from(JSON.stringify({ type: "start" })) },
  ];
  let t = 0;
  const pushFrame = (chunk: Buffer) => {
    const frame = Buffer.alloc(1 + FRAME_BYTES);
    frame[0] = 0; // CHANNEL_MIC
    chunk.copy(frame, 1);
    events.push({ tMs: (t += FRAME_MS), kind: REC_AUDIO, payload: frame });
  };
  for (const { text, silenceAfterMs } of items) {
    const samples = await testSpeech(text, 16000);
    const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    // Real capture always carries a moment of room tone before the first
    // word, so the detector observes a noise floor first.
    for (let i = 0; i < 8; i++) pushFrame(Buffer.alloc(FRAME_BYTES));
    for (let pos = 0; pos < pcm.length; pos += FRAME_BYTES) {
      pushFrame(pcm.subarray(pos, pos + FRAME_BYTES));
    }
    // Trailing silence: ends the utterance, and leaves room for the answer
    // before the next question when several are chained.
    const tailFrames = Math.max(8, Math.ceil(silenceAfterMs / FRAME_MS));
    for (let i = 0; i < tailFrames; i++) pushFrame(Buffer.alloc(FRAME_BYTES));
  }
  return events;
}

export interface HeadlessOptions {
  url?: string;
  /** 1 = real time; Infinity = as fast as possible. */
  speed?: number;
  /** Tag written into each turn record's `source`. */
  source?: string;
  /** Called for every JSON server message (for logging). */
  onMessage?: (msg: ServerMessage) => void;
  /** Quiet time after the last input before declaring the run finished. */
  settleMs?: number;
  timeoutMs?: number;
}

export interface HeadlessResult {
  records: TurnRecord[];
  summary: LatencySummary;
  audioBytes: number;
  timedOut: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runHeadless(
  events: RecordedEvent[],
  opts: HeadlessOptions = {},
): Promise<HeadlessResult> {
  const url = opts.url ?? "ws://localhost:8787/ws";
  const speed = opts.speed ?? 1;
  const settleMs = opts.settleMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 120000;

  const ws = new WebSocket(url);
  ws.binaryType = "nodebuffer";
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const records: TurnRecord[] = [];
  let summary: LatencySummary = {};
  let audioBytes = 0;
  let lastActivity = performance.now();
  const openTurns = new Set<string>();
  let mark: { turnId: string; kind: "hold" | "answer" } | null = null;

  ws.on("message", (data, isBinary) => {
    lastActivity = performance.now();
    if (isBinary) {
      audioBytes += (data as Buffer).length;
      if (mark) {
        ws.send(JSON.stringify({ type: "playback_started", ...mark, leadMs: 0 }));
        mark = null;
      }
      return;
    }
    const msg = JSON.parse(data.toString()) as ServerMessage;
    opts.onMessage?.(msg);
    switch (msg.type) {
      case "triggered":
        openTurns.add(msg.turnId);
        break;
      case "audio_mark":
        mark = { turnId: msg.turnId, kind: msg.kind };
        break;
      case "turn_latency":
        openTurns.delete(msg.record.turnId);
        records.push(msg.record);
        summary = msg.summary;
        break;
    }
  });

  const deadline = performance.now() + timeoutMs;
  const t0 = performance.now();
  for (const e of events) {
    if (performance.now() > deadline) break;
    if (Number.isFinite(speed)) {
      const wait = t0 + e.tMs / speed - performance.now();
      if (wait > 0) await sleep(wait);
    } else {
      // Yield so server replies are still processed while we flood.
      await new Promise((r) => setImmediate(r));
    }
    if (e.kind === REC_AUDIO) {
      ws.send(e.payload);
    } else {
      const msg = JSON.parse(e.payload.toString("utf8"));
      if (msg.type === "start" && opts.source) msg.source = opts.source;
      ws.send(JSON.stringify(msg));
    }
  }
  lastActivity = performance.now();

  // Input is exhausted; wait for in-flight turns and a quiet period.
  let timedOut = false;
  for (;;) {
    const now = performance.now();
    if (now > deadline) {
      timedOut = true;
      break;
    }
    if (openTurns.size === 0 && now - lastActivity > settleMs) break;
    await sleep(100);
  }
  ws.close();
  return { records, summary, audioBytes, timedOut };
}

/** Plain-text table of turn records, shared by the e2e test and replay. */
export function formatRecords(records: TurnRecord[]): string {
  const f = (v: number | null | undefined) =>
    v === null || v === undefined ? "-" : String(Math.round(v));
  const head = ["turn", "outcome", "stt", "wake", "ttft", "llm>tts", "tts", "play", "e2e", "degraded"];
  const rows = records.map((r) => [
    r.turnId,
    r.outcome,
    f(r.components.stt),
    f(r.components.wake),
    f(r.components.llmTtft),
    f(r.components.llmToTts),
    f(r.components.ttsTtfb),
    f(r.components.playback),
    f(r.e2eMs),
    r.degraded.join(",") || "-",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i < 2 || i === 9 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
