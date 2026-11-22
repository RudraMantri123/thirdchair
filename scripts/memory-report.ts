/**
 * Memory footprint of every process a local ThirdChair meeting runs on,
 * sampled over time — optionally while a replay (or any command) drives it.
 *
 *   ThirdChair server   RSS + V8 heapUsed      (GET /debug/memory)
 *   whisper-server      RSS + phys footprint   (the process listening on the STT port)
 *   Ollama runner(s)    RSS + phys footprint   (children of the daemon on the Ollama port)
 *   Ollama /api/ps      model size + context   (Ollama's own accounting)
 *
 * "Footprint" is macOS phys_footprint (what Activity Monitor calls Memory):
 * it includes GPU (Metal) allocations and compressed pages, which RSS misses.
 * An idle whisper-server can show ~12 MB RSS while owning ~200 MB. On other
 * platforms the footprint column is left blank and RSS is the measure.
 *
 * Run:
 *   npx tsx scripts/memory-report.ts --duration 30
 *   npx tsx scripts/memory-report.ts --run "npx tsx scripts/replay.ts recordings/x.tcrec --repeat 50"
 *
 * Flags:
 *   --server URL      ThirdChair HTTP base         (default http://localhost:8787)
 *   --ollama URL      Ollama daemon                (default $OLLAMA_URL or :11434)
 *   --whisper-port N  whisper-server port          (default port of $WHISPER_URL or 8788)
 *   --interval MS     sampling interval            (default 2000)
 *   --duration S      sample for S seconds when no --run is given (default 20)
 *   --run CMD         spawn CMD, sample until it exits; its exit code is passed through
 *   --label TEXT      tag for the summary line
 *   --json FILE       also write every sample as JSON
 *   --quiet           summary only, no per-sample rows
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import "dotenv/config";

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const serverUrl = flag("--server") ?? "http://localhost:8787";
const ollamaUrl = flag("--ollama") ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
const whisperPort = Number(
  flag("--whisper-port") ??
    new URL(process.env.WHISPER_URL ?? "http://localhost:8788").port,
);
const intervalMs = Number(flag("--interval") ?? 2000);
const durationS = Number(flag("--duration") ?? 20);
const command = flag("--run");
const label = flag("--label") ?? "";
const jsonOut = flag("--json");
const quiet = args.includes("--quiet");

const MB = 1024 * 1024;

interface Sample {
  t: number;
  nodeRss: number | null;
  nodeHeap: number | null;
  whisperRss: number | null;
  whisperFoot: number | null;
  runnerRss: number | null;
  runnerFoot: number | null;
  ollamaSize: number | null;
  ollamaCtx: number | null;
  ollamaModels: string;
}

async function sh(cmd: string, argv: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, argv, { maxBuffer: 8 * MB });
    return stdout;
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? "";
  }
}

async function listeningPid(port: number): Promise<number | null> {
  const out = await sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const pid = Number(out.trim().split("\n")[0]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

interface Proc {
  pid: number;
  ppid: number;
  rss: number;
  command: string;
}

async function processTable(): Promise<Proc[]> {
  const out = await sh("ps", ["-axo", "pid=,ppid=,rss=,command="]);
  return out
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3] * 1024, command: m[4] }));
}

/** macOS phys_footprint in bytes; null elsewhere or on failure. */
async function footprint(pid: number): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  const out = await sh("footprint", ["-f", "bytes", "--noCategories", "-p", String(pid)]);
  const m = out.match(/Footprint:\s+(\d+)\s+B/);
  return m ? Number(m[1]) : null;
}

async function sumFootprint(pids: number[]): Promise<number | null> {
  if (pids.length === 0) return 0;
  const vals = await Promise.all(pids.map(footprint));
  return vals.some((v) => v === null) ? null : vals.reduce<number>((a, b) => a + (b ?? 0), 0);
}

async function nodeMemory(): Promise<{ rss: number; heapUsed: number } | null> {
  try {
    const res = await fetch(`${serverUrl}/debug/memory`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()) as { rss: number; heapUsed: number };
  } catch {
    return null;
  }
}

async function ollamaPs(): Promise<{ size: number; ctx: number; models: string }> {
  try {
    const res = await fetch(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(1500) });
    const j = (await res.json()) as {
      models?: { name: string; size: number; context_length?: number }[];
    };
    const models = j.models ?? [];
    return {
      size: models.reduce((a, m) => a + m.size, 0),
      ctx: Math.max(0, ...models.map((m) => m.context_length ?? 0)),
      models: models.map((m) => m.name).join("+") || "-",
    };
  } catch {
    return { size: NaN, ctx: NaN, models: "unreachable" };
  }
}

const ollamaPort = Number(new URL(ollamaUrl).port || 11434);

async function sample(t0: number): Promise<Sample> {
  const [procs, daemonPid, whisperPid, node, ps] = await Promise.all([
    processTable(),
    listeningPid(ollamaPort),
    listeningPid(whisperPort),
    nodeMemory(),
    ollamaPs(),
  ]);
  // Runners are children of THIS daemon only, so a second Ollama on another
  // port (or another client's models) never pollutes the numbers.
  const runners = procs.filter(
    (p) => p.ppid === daemonPid && /ollama.*runner/.test(p.command),
  );
  const whisper = procs.find((p) => p.pid === whisperPid);
  const [whisperFoot, runnerFoot] = await Promise.all([
    whisperPid ? footprint(whisperPid) : Promise.resolve(null),
    sumFootprint(runners.map((r) => r.pid)),
  ]);
  return {
    t: (performance.now() - t0) / 1000,
    nodeRss: node?.rss ?? null,
    nodeHeap: node?.heapUsed ?? null,
    whisperRss: whisper?.rss ?? null,
    whisperFoot,
    runnerRss: runners.reduce((a, r) => a + r.rss, 0),
    runnerFoot,
    ollamaSize: Number.isFinite(ps.size) ? ps.size : null,
    ollamaCtx: Number.isFinite(ps.ctx) && ps.ctx > 0 ? ps.ctx : null,
    ollamaModels: ps.models,
  };
}

const mb = (v: number | null) => (v === null ? "-" : (v / MB).toFixed(0));
const COLS: [string, (s: Sample) => string][] = [
  ["t(s)", (s) => s.t.toFixed(0)],
  ["node rss", (s) => mb(s.nodeRss)],
  ["node heap", (s) => (s.nodeHeap === null ? "-" : (s.nodeHeap / MB).toFixed(1))],
  ["whisper rss", (s) => mb(s.whisperRss)],
  ["whisper foot", (s) => mb(s.whisperFoot)],
  ["runner rss", (s) => mb(s.runnerRss)],
  ["runner foot", (s) => mb(s.runnerFoot)],
  ["ollama ps", (s) => mb(s.ollamaSize)],
  ["ctx", (s) => (s.ollamaCtx === null ? "-" : String(s.ollamaCtx))],
  ["models", (s) => s.ollamaModels],
];
const WIDTH = [5, 8, 9, 11, 12, 10, 11, 9, 6, 0];
const row = (cells: string[]) =>
  cells.map((c, i) => (WIDTH[i] ? c.padStart(WIDTH[i]) : c)).join("  ");

/** Least-squares slope, units per hour. */
function slopePerHour(points: [number, number][]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? null : (num / den) * 3600;
}

async function main() {
  const samples: Sample[] = [];
  const t0 = performance.now();
  let child: ReturnType<typeof spawn> | null = null;
  let exitCode: number | null = null;
  let finished = !command;
  if (command) {
    child = spawn(command, { shell: true, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => {
      exitCode = code ?? 1;
      finished = true;
    });
  }

  if (!quiet) {
    console.log(`memory sampling every ${intervalMs} ms (MB)${label ? ` — ${label}` : ""}`);
    console.log(row(COLS.map(([h]) => h)));
  }
  const deadline = t0 + durationS * 1000;
  for (;;) {
    const s = await sample(t0);
    samples.push(s);
    if (!quiet) console.log(row(COLS.map(([, f]) => f(s))));
    if (command ? finished : performance.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  // One more sample after the driver exits, so "end" reflects the settled state.
  if (command) samples.push(await sample(t0));

  const stat = (pick: (s: Sample) => number | null) => {
    const v = samples.map(pick).filter((x): x is number => x !== null);
    return v.length
      ? { min: Math.min(...v), max: Math.max(...v), last: v[v.length - 1] }
      : null;
  };
  const fmt = (st: ReturnType<typeof stat>, div = MB, dp = 0) =>
    st ? `${(st.min / div).toFixed(dp)} / ${(st.max / div).toFixed(dp)} / ${(st.last / div).toFixed(dp)}` : "-";

  const heapPts = samples
    .filter((s) => s.nodeHeap !== null)
    .map((s) => [s.t, s.nodeHeap! / MB] as [number, number]);
  const rssPts = samples
    .filter((s) => s.nodeRss !== null)
    .map((s) => [s.t, s.nodeRss! / MB] as [number, number]);
  // Skip the first quarter: JIT warm-up and first-use allocations are not leaks.
  const tail = <T,>(a: T[]) => a.slice(Math.floor(a.length / 4));
  const heapSlope = slopePerHour(tail(heapPts));
  const rssSlope = slopePerHour(tail(rssPts));

  console.log(`\nsummary${label ? ` — ${label}` : ""} (MB, min / max / last, ${samples.length} samples over ${samples[samples.length - 1].t.toFixed(0)} s)`);
  console.log(`  ThirdChair node rss    ${fmt(stat((s) => s.nodeRss))}`);
  console.log(`  ThirdChair node heap   ${fmt(stat((s) => s.nodeHeap), MB, 1)}`);
  console.log(`  whisper-server rss     ${fmt(stat((s) => s.whisperRss))}`);
  console.log(`  whisper-server foot    ${fmt(stat((s) => s.whisperFoot))}`);
  console.log(`  ollama runner rss      ${fmt(stat((s) => s.runnerRss))}`);
  console.log(`  ollama runner foot     ${fmt(stat((s) => s.runnerFoot))}`);
  console.log(`  ollama ps size         ${fmt(stat((s) => s.ollamaSize))}`);
  console.log(
    `  node heap trend        ${heapSlope === null ? "-" : `${heapSlope >= 0 ? "+" : ""}${heapSlope.toFixed(1)} MB/h`}` +
      `   node rss trend ${rssSlope === null ? "-" : `${rssSlope >= 0 ? "+" : ""}${rssSlope.toFixed(1)} MB/h`}` +
      "   (least squares, first quarter excluded)",
  );

  if (jsonOut) {
    await mkdir(dirname(jsonOut), { recursive: true });
    await writeFile(jsonOut, JSON.stringify({ label, samples }, null, 1));
  }
  process.exit(exitCode ?? 0);
}

void main();
