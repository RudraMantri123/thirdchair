// End-to-end voice-loop test: streams a synthesized spoken question into
// ThirdChair's websocket as if it were mic audio, reports every event, and
// prints the turn's latency budget.
//
// Needs a running server (npm run dev:server) on the local path.
import { synthSession, runHeadless, formatRecords } from "./lib/headless-client.ts";

const events = await synthSession(["hey copilot, what is two plus two?"]);

const result = await runHeadless(events, {
  source: "e2e-voice-test",
  timeoutMs: 60000,
  onMessage: (msg) => console.log("EVENT:", JSON.stringify(msg).slice(0, 220)),
});

console.log(
  `TTS AUDIO RECEIVED: ${result.audioBytes} bytes (~${(result.audioBytes / 2 / 24000).toFixed(1)}s)`,
);
if (result.records.length) {
  console.log("\nLatency budget (ms):\n" + formatRecords(result.records));
}

const answered = result.records.some((r) => r.outcome === "answered");
if (result.timedOut || !answered || result.audioBytes === 0) {
  console.log(
    `FAIL: ${result.timedOut ? "timed out" : !answered ? "no answered turn" : "no audio"}`,
  );
  process.exit(1);
}
process.exit(0);
