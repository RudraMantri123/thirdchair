/**
 * Summarize per-turn latency records: a p50/p95 table per component on the
 * terminal, plus a static HTML page with one stacked bar per turn.
 *
 * Run: npx tsx scripts/latency-report.ts [logs/latency.jsonl]
 *        [--source <substring>] [--html logs/latency-report.html] [--last N]
 *
 * Percentiles are over answered turns only; degraded and failed turns are
 * counted separately because they are a different distribution.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { percentile } from "../server/latency.ts";
import {
  LATENCY_COMPONENTS,
  type LatencyComponent,
  type TurnRecord,
} from "../shared/protocol.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const input =
  args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ??
  "logs/latency.jsonl";
const htmlOut = flag("--html") ?? "logs/latency-report.html";
const sourceFilter = flag("--source");
const last = Number(flag("--last") ?? 0);

const LABEL: Record<LatencyComponent | "e2e", string> = {
  stt: "STT (VAD commit -> transcript)",
  wake: "wake / turn overhead",
  llmTtft: "LLM time to first token",
  llmToTts: "LLM first token -> TTS request",
  ttsTtfb: "TTS time to first byte",
  playback: "transport / playback",
  e2e: "end-to-end (to first audio)",
};
const COLOR: Record<LatencyComponent, string> = {
  stt: "#3b82f6",
  wake: "#64748b",
  llmTtft: "#eab308",
  llmToTts: "#f97316",
  ttsTtfb: "#8b5cf6",
  playback: "#14b8a6",
};

let text: string;
try {
  text = await readFile(input, "utf8");
} catch {
  console.error(`No latency log at ${input}. Run a session (or scripts/replay.ts) first.`);
  process.exit(1);
}

let records: TurnRecord[] = text
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line) as TurnRecord];
    } catch {
      return [];
    }
  });
if (sourceFilter) records = records.filter((r) => r.source.includes(sourceFilter));
if (last > 0) records = records.slice(-last);
if (!records.length) {
  console.error("No matching turn records.");
  process.exit(1);
}

const answered = records.filter((r) => r.outcome === "answered");
const clean = answered.filter((r) => r.degraded.length === 0);

type Row = { key: LatencyComponent | "e2e"; n: number; p50: number; p95: number; mean: number; max: number };
const rows: Row[] = [];
for (const key of [...LATENCY_COMPONENTS, "e2e"] as const) {
  const vals = answered
    .map((r) => (key === "e2e" ? r.e2eMs : r.components[key]))
    .filter((v): v is number => v !== null);
  if (!vals.length) continue;
  rows.push({
    key,
    n: vals.length,
    p50: percentile(vals, 50),
    p95: percentile(vals, 95),
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    max: Math.max(...vals),
  });
}

const count = (xs: string[]) =>
  Object.entries(
    xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}),
  )
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");

const engines = [...new Set(records.map((r) => `${r.engines.stt} + ${r.engines.llm} + ${r.engines.tts}`))];

// ---- terminal ----------------------------------------------------------------

const r0 = (n: number) => Math.round(n).toString();
console.log(`\n${records.length} turns from ${input}${sourceFilter ? ` (source ~ "${sourceFilter}")` : ""}`);
console.log(`engines:  ${engines.join(" | ")}`);
console.log(`outcomes: ${count(records.map((r) => r.outcome))}`);
const deg = records.flatMap((r) => r.degraded);
console.log(`degraded: ${deg.length ? count(deg) : "none"} (${clean.length}/${answered.length} answered turns clean)\n`);
const w = Math.max(...rows.map((r) => LABEL[r.key].length));
console.log(`${"component (ms)".padEnd(w)}    n     p50     p95    mean     max`);
console.log("-".repeat(w + 36));
for (const r of rows) {
  console.log(
    `${LABEL[r.key].padEnd(w)} ${String(r.n).padStart(4)} ${r0(r.p50).padStart(7)} ${r0(r.p95).padStart(7)} ${r0(r.mean).padStart(7)} ${r0(r.max).padStart(7)}`,
  );
}

// ---- HTML / SVG ----------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const bars = records.slice(-60);
const maxTotal = Math.max(
  1,
  ...bars.map((r) =>
    LATENCY_COMPONENTS.reduce((a, c) => a + Math.max(0, r.components[c] ?? 0), 0),
  ),
);
const W = 760;
const labelW = 150;
const rowH = 18;
const plotW = W - labelW - 70;
const svgRows = bars
  .map((r, i) => {
    let x = labelW;
    const y = 24 + i * rowH;
    const segs = LATENCY_COMPONENTS.map((c) => {
      const v = Math.max(0, r.components[c] ?? 0);
      const wpx = (v / maxTotal) * plotW;
      const rect = v
        ? `<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(wpx, 0.5).toFixed(1)}" height="${rowH - 5}" fill="${COLOR[c]}"><title>${LABEL[c]}: ${r0(v)} ms</title></rect>`
        : "";
      x += wpx;
      return rect;
    }).join("");
    const tag = r.outcome !== "answered" ? ` ${r.outcome}` : r.degraded.length ? " degraded" : "";
    return (
      `<text x="0" y="${y + 10}" class="lbl">${esc(r.turnId)}${esc(tag)}</text>` +
      segs +
      `<text x="${(x + 6).toFixed(1)}" y="${y + 10}" class="val">${r.e2eMs === null ? "—" : r0(r.e2eMs) + " ms"}</text>`
    );
  })
  .join("\n");
const axisTicks = [0, 0.25, 0.5, 0.75, 1]
  .map((f) => {
    const x = labelW + f * plotW;
    return `<line x1="${x}" x2="${x}" y1="18" y2="${24 + bars.length * rowH}" class="grid"/><text x="${x}" y="12" class="tick">${r0(f * maxTotal)}</text>`;
  })
  .join("");
const svgH = 30 + bars.length * rowH;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ThirdChair latency</title>
<style>
:root{--bg:#fff;--fg:#111827;--dim:#6b7280;--grid:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b0e14;--fg:#e6ebf4;--dim:#8b94a7;--grid:#1f2633}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:800px;margin:24px auto;padding:0 16px}
h1{font-size:20px}p,.meta{color:var(--dim)}
table{border-collapse:collapse;font-variant-numeric:tabular-nums;margin:12px 0}
th,td{padding:3px 12px 3px 0;text-align:right}th:first-child,td:first-child{text-align:left}
th{color:var(--dim);font-weight:500}
.legend span{margin-right:14px;white-space:nowrap}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
svg{width:100%;height:auto}svg .lbl,svg .val,svg .tick{font:11px ui-monospace,monospace;fill:var(--dim)}svg .grid{stroke:var(--grid)}
</style></head><body>
<h1>ThirdChair per-turn latency</h1>
<p class="meta">${records.length} turns · ${esc(engines.join(" | "))}<br>outcomes: ${esc(count(records.map((r) => r.outcome)))} · degraded: ${esc(deg.length ? count(deg) : "none")}</p>
<table><tr><th>component</th><th>n</th><th>p50 ms</th><th>p95 ms</th><th>mean ms</th><th>max ms</th></tr>
${rows.map((r) => `<tr><td>${LABEL[r.key]}</td><td>${r.n}</td><td>${r0(r.p50)}</td><td>${r0(r.p95)}</td><td>${r0(r.mean)}</td><td>${r0(r.max)}</td></tr>`).join("\n")}
</table>
<div class="legend">${LATENCY_COMPONENTS.map((c) => `<span><i style="background:${COLOR[c]}"></i>${LABEL[c]}</span>`).join("")}</div>
<svg viewBox="0 0 ${W} ${svgH}" role="img" aria-label="Stacked latency per turn">${axisTicks}${svgRows}</svg>
<p>Percentiles over answered turns. Marks are server-side monotonic; playback is the client's report of first audible audio.</p>
</body></html>
`;
await mkdir(dirname(htmlOut), { recursive: true });
await writeFile(htmlOut, html);
console.log(`\nchart: ${htmlOut}`);
