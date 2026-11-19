import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.ts";
import {
  LATENCY_COMPONENTS,
  type LatencyComponent,
  type LatencyMark,
  type LatencyStat,
  type LatencySummary,
  type TurnRecord,
  type TurnOutcome,
} from "../shared/protocol.ts";

/** Each component is the gap between two marks. */
const BOUNDS: Record<LatencyComponent, [LatencyMark, LatencyMark]> = {
  stt: ["speechEnd", "transcript"],
  wake: ["transcript", "llmRequest"],
  llmTtft: ["llmRequest", "llmFirstToken"],
  llmToTts: ["llmFirstToken", "ttsRequest"],
  ttsTtfb: ["ttsRequest", "ttsFirstByte"],
  playback: ["ttsFirstByte", "playbackStart"],
};

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Monotonic stopwatch for one assistant turn. Marks are absolute
 * `performance.now()` values; the record re-bases them on the turn origin.
 * Only the first occurrence of a mark counts — "first token" means first.
 */
export class TurnLatency {
  private marks = new Map<LatencyMark, number>();
  private readonly wallOrigin: number;
  readonly origin: number;
  readonly degraded = new Set<string>();
  clientLeadMs: number | null = null;

  constructor(
    readonly turnId: string,
    readonly trigger: "voice" | "typed",
    readonly question: string,
    origin?: number,
  ) {
    const now = performance.now();
    this.origin = origin ?? now;
    this.wallOrigin = Date.now() - (now - this.origin);
  }

  mark(name: LatencyMark, at = performance.now()): void {
    if (!this.marks.has(name)) this.marks.set(name, at);
  }

  has(name: LatencyMark): boolean {
    return this.marks.has(name);
  }

  record(
    base: { sessionId: string; source: string; engines: TurnRecord["engines"] },
    outcome: TurnOutcome,
  ): TurnRecord {
    const rel: Partial<Record<LatencyMark, number>> = {};
    for (const [k, v] of this.marks) rel[k] = round(v - this.origin);

    const components = {} as Record<LatencyComponent, number | null>;
    for (const c of LATENCY_COMPONENTS) {
      const [a, b] = BOUNDS[c];
      const from = rel[a];
      const to = rel[b];
      components[c] =
        from !== undefined && to !== undefined ? round(to - from) : null;
    }

    const firstSound = [rel.playbackStart, rel.holdPlaybackStart].filter(
      (v): v is number => v !== undefined,
    );
    return {
      v: 1,
      turnId: this.turnId,
      sessionId: base.sessionId,
      at: new Date(this.wallOrigin).toISOString(),
      source: base.source,
      trigger: this.trigger,
      question: this.question,
      engines: base.engines,
      marks: rel,
      components,
      e2eMs: rel.playbackStart ?? null,
      firstSoundMs: firstSound.length ? Math.min(...firstSound) : null,
      clientLeadMs: this.clientLeadMs,
      degraded: [...this.degraded],
      outcome,
    };
  }
}

/** Nearest-rank percentile over an unsorted sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

/**
 * Process-wide rolling p50/p95 per component, over the most recent turns.
 * Only answered turns feed it: a barged-in or timed-out turn has no
 * meaningful end-to-end figure. Fallbacks are visible per turn in `degraded`.
 */
class LatencyStats {
  private static readonly WINDOW = 500;
  private samples = new Map<LatencyComponent | "e2e", number[]>();

  add(record: TurnRecord): void {
    if (record.outcome !== "answered") return;
    const push = (k: LatencyComponent | "e2e", v: number | null) => {
      if (v === null) return;
      let arr = this.samples.get(k);
      if (!arr) this.samples.set(k, (arr = []));
      arr.push(v);
      if (arr.length > LatencyStats.WINDOW) arr.shift();
    };
    for (const c of LATENCY_COMPONENTS) push(c, record.components[c]);
    push("e2e", record.e2eMs);
  }

  summary(): LatencySummary {
    const out: LatencySummary = {};
    for (const [k, arr] of this.samples) {
      const stat: LatencyStat = {
        n: arr.length,
        p50: round(percentile(arr, 50)),
        p95: round(percentile(arr, 95)),
      };
      out[k] = stat;
    }
    return out;
  }
}

export const latencyStats = new LatencyStats();

let logReady: Promise<void> | null = null;
let logChain: Promise<void> = Promise.resolve();

/** Append one record to the JSONL log, in order, never throwing. */
export function writeTurnRecord(record: TurnRecord): void {
  if (config.latencyLog === "off") return;
  const path = config.latencyLog;
  logReady ??= mkdir(dirname(path), { recursive: true }).then(() => {});
  logChain = logChain
    .then(() => logReady)
    .then(() => appendFile(path, JSON.stringify(record) + "\n"))
    .catch((err: unknown) => {
      console.warn(
        `  latency log write failed: ${err instanceof Error ? err.message : err}`,
      );
    });
}
