import { AudioCapture } from "./audio/capture.ts";
import { AudioPlayback } from "./audio/playback.ts";
import {
  LATENCY_COMPONENTS,
  type AudioChannel,
  type ClientMessage,
  type LatencyComponent,
  type LatencySummary,
  type ServerMessage,
  type SessionState,
  type TranscriptEntry,
  type TurnRecord,
} from "../../shared/protocol.ts";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const orb = $("orb");
const statusEl = $("status");
const feed = $("feed");
const btnStart = $<HTMLButtonElement>("btn-start");
const btnTab = $<HTMLButtonElement>("btn-tab");
const btnStopSpeaking = $<HTMLButtonElement>("btn-stop-speaking");
const btnExport = $<HTMLButtonElement>("btn-export");
const askForm = $<HTMLFormElement>("ask-form");
const askInput = $<HTMLInputElement>("ask-input");
const wakeDisplay = $("wake-display");
const degradedEl = $("degraded");
const latencyEl = $("latency");
const latencyE2e = $("latency-e2e");
const latencyTags = $("latency-tags");
const latencyBar = $("latency-bar");
const latencyLegend = $("latency-legend");
const latencyTable = $<HTMLTableElement>("latency-table");

const playback = new AudioPlayback();
const capture = new AudioCapture((channel, pcm) => sendAudio(channel, pcm));

let ws: WebSocket | null = null;
let reconnectDelay = 500;
let listening = false;
let partials = new Map<string, HTMLElement>();
let answerEl: HTMLElement | null = null;
/** Set by an audio_mark: the next binary frame starts a hold phrase / answer. */
let pendingMark: { turnId: string; kind: "hold" | "answer" } | null = null;
const playbackReports = new Set<ReturnType<typeof setTimeout>>();

// ---- websocket with auto-reconnect ---------------------------------------

function connect(): void {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    reconnectDelay = 500;
    // Resume seamlessly if we were mid-session when the socket dropped.
    if (listening) send({ type: "start" });
  };

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      const lead = playback.play(e.data);
      if (pendingMark) reportPlayback(pendingMark, lead);
      pendingMark = null;
      return;
    }
    onServerMessage(JSON.parse(e.data as string) as ServerMessage);
  };

  ws.onclose = () => {
    setState("idle");
    statusEl.textContent = "reconnecting…";
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
}

function send(msg: ClientMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/**
 * Tell the server when the first chunk of an answer actually becomes audible
 * — the last mark in the turn's latency budget. Sent at the scheduled start
 * time, so the server's receipt includes one uplink hop and nothing else.
 */
function reportPlayback(
  mark: { turnId: string; kind: "hold" | "answer" },
  leadSeconds: number,
): void {
  const leadMs = leadSeconds * 1000;
  const t = setTimeout(() => {
    playbackReports.delete(t);
    send({ type: "playback_started", turnId: mark.turnId, kind: mark.kind, leadMs });
  }, leadMs);
  playbackReports.add(t);
}

function sendAudio(channel: AudioChannel, pcm: ArrayBuffer): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const frame = new Uint8Array(1 + pcm.byteLength);
  frame[0] = channel;
  frame.set(new Uint8Array(pcm), 1);
  ws.send(frame);
}

// ---- server events ---------------------------------------------------------

function onServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "ready":
      wakeDisplay.textContent = msg.wakePhrase;
      setState(msg.state);
      break;
    case "state":
      setState(msg.state);
      if (msg.state === "awaiting_question") {
        addLine("event", "🪑 Yes? Listening for your question…");
      }
      break;
    case "partial": {
      let el = partials.get(msg.speaker);
      if (!el) {
        el = addLine("partial", "");
        partials.set(msg.speaker, el);
      }
      el.textContent = `${speakerBadge(msg.speaker)} ${msg.text}`;
      feed.scrollTop = feed.scrollHeight;
      break;
    }
    case "committed": {
      partials.get(msg.entry.speaker)?.remove();
      partials.delete(msg.entry.speaker);
      addLine(
        msg.entry.whileSpeaking ? "heard muted" : "heard",
        `${speakerBadge(msg.entry.speaker)} ${msg.entry.text}`,
      );
      break;
    }
    case "triggered":
      addLine("event", `🪑 Asked: “${msg.question}”`);
      answerEl = addLine("answer", "");
      break;
    case "answer_delta":
      if (answerEl) {
        answerEl.textContent += msg.text;
        feed.scrollTop = feed.scrollHeight;
      }
      break;
    case "answer_done":
      answerEl = null;
      break;
    case "speaking_cancel":
      playback.cancel();
      for (const t of playbackReports) clearTimeout(t);
      playbackReports.clear();
      pendingMark = null;
      break;
    case "audio_mark":
      pendingMark = { turnId: msg.turnId, kind: msg.kind };
      break;
    case "turn_latency":
      renderLatency(msg.record, msg.summary);
      break;
    case "degraded":
      addLine("notice", `⚠ ${msg.message}`);
      degradedEl.hidden = msg.active.length === 0;
      degradedEl.textContent = `degraded: ${msg.active.join(", ")}`;
      break;
    case "transcript_export":
      downloadTranscript(msg.startedAt, msg.entries);
      break;
    case "notice":
      addLine("notice", `🎚 ${msg.message}`);
      break;
    case "error":
      addLine("error", `⚠ ${msg.message}`);
      break;
  }
}

// ---- latency budget panel -------------------------------------------------

const COMPONENT_LABEL: Record<LatencyComponent, string> = {
  stt: "STT",
  wake: "wake/turn",
  llmTtft: "LLM TTFT",
  llmToTts: "LLM→TTS",
  ttsTtfb: "TTS TTFB",
  playback: "transport/playback",
};
const COMPONENT_COLOR: Record<LatencyComponent, string> = {
  stt: "#60a5fa",
  wake: "#94a3b8",
  llmTtft: "#facc15",
  llmToTts: "#fb923c",
  ttsTtfb: "#a78bfa",
  playback: "#5eead4",
};

const fmt = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? "—" : `${Math.round(ms)} ms`;

function renderLatency(record: TurnRecord, summary: LatencySummary): void {
  latencyEl.hidden = false;
  latencyE2e.textContent =
    record.e2eMs !== null
      ? `${fmt(record.e2eMs)} to first word`
      : record.outcome === "answered"
        ? "text only"
        : record.outcome.replace("_", " ");
  latencyTags.textContent = [
    record.outcome !== "answered" ? record.outcome.replace("_", " ") : "",
    ...record.degraded,
  ]
    .filter(Boolean)
    .join(" · ");

  // One stacked bar, each segment proportional to its share of the turn.
  const parts = LATENCY_COMPONENTS.map((c) => [c, record.components[c]] as const)
    .filter((p): p is readonly [LatencyComponent, number] => p[1] !== null && p[1] > 0);
  const total = parts.reduce((a, [, v]) => a + v, 0) || 1;
  latencyBar.replaceChildren(
    ...parts.map(([c, v]) => {
      const seg = document.createElement("span");
      seg.style.flex = `${v / total} 0 0`;
      seg.style.background = COMPONENT_COLOR[c];
      seg.title = `${COMPONENT_LABEL[c]}: ${fmt(v)}`;
      return seg;
    }),
  );
  latencyLegend.replaceChildren(
    ...parts.map(([c, v]) => {
      const item = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.background = COMPONENT_COLOR[c];
      item.append(swatch, `${COMPONENT_LABEL[c]} ${fmt(v)}`);
      return item;
    }),
  );

  const rows: [string, string, string, string][] = [["", "p50", "p95", "n"]];
  for (const key of [...LATENCY_COMPONENTS, "e2e"] as const) {
    const s = summary[key];
    if (!s) continue;
    const label = key === "e2e" ? "end-to-end" : COMPONENT_LABEL[key];
    rows.push([label, fmt(s.p50), fmt(s.p95), String(s.n)]);
  }
  latencyTable.replaceChildren(
    ...rows.map((cells, i) => {
      const tr = document.createElement("tr");
      for (const text of cells) {
        const cell = document.createElement(i === 0 ? "th" : "td");
        cell.textContent = text;
        tr.appendChild(cell);
      }
      return tr;
    }),
  );
}

function speakerBadge(speaker: "you" | "room"): string {
  return speaker === "you" ? "🎙" : "👥";
}

function setState(state: SessionState): void {
  orb.dataset.state = state;
  statusEl.textContent = state.replace("_", " ");
  btnStopSpeaking.disabled = state !== "speaking" && state !== "thinking";
}

function addLine(cls: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `line ${cls}`;
  el.textContent = text;
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
  return el;
}

function downloadTranscript(startedAt: number, entries: TranscriptEntry[]): void {
  const lines = entries.map((e) => {
    const elapsed = e.at - startedAt;
    const stamp = `${Math.floor(elapsed / 60000)}:${String(
      Math.floor((elapsed % 60000) / 1000),
    ).padStart(2, "0")}`;
    const who = e.whileSpeaking ? "copilot" : e.speaker;
    return `[${stamp}] ${who}: ${e.text}`;
  });
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `thirdchair-${new Date(startedAt).toISOString().slice(0, 16)}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---- controls ---------------------------------------------------------------

btnStart.onclick = async () => {
  if (!listening) {
    try {
      await capture.start();
    } catch {
      addLine("error", "⚠ Microphone access denied.");
      return;
    }
    send({ type: "start" });
    listening = true;
    btnStart.textContent = "Stop listening";
    btnTab.disabled = false;
    reportInput();
  } else {
    capture.stop();
    send({ type: "stop" });
    listening = false;
    btnStart.textContent = "Start listening";
    btnTab.disabled = true;
  }
};

/**
 * Report what the browser and OS actually handed us, and flag the input
 * problems a user can fix. Worth surfacing because the same code can end up
 * with a 48 kHz built-in mic with echo cancellation, or a Bluetooth headset
 * running a heavily compressed 16 kHz voice link — and transcription quality
 * differs sharply between them.
 */
function reportInput(): void {
  const info = capture.inputInfo();
  if (!info) return;
  const s = info.settings;
  const flags = [
    s.echoCancellation ? "AEC" : "no AEC",
    s.noiseSuppression ? "NS" : "no NS",
    s.autoGainControl ? "AGC" : "no AGC",
  ].join(", ");
  addLine(
    "event",
    `🎙 Input: ${info.label || "default mic"} — capture ${info.rate} Hz, ${flags}`,
  );

  // A Bluetooth mic routes voice over a narrowband, heavily compressed link.
  // It is usually the single biggest quality loss in the whole pipeline, and
  // the fix (use the built-in mic) is one click away in Sound settings.
  if (/airpod|bluetooth|headset|hands-?free|\bbt\b/i.test(info.label)) {
    addLine(
      "notice",
      "🎚 That looks like a Bluetooth mic. Voice over Bluetooth is narrowband and compressed — the built-in mic will usually transcribe noticeably better.",
    );
  }
}

btnTab.onclick = async () => {
  const ok = await capture.addMeetingTab();
  addLine(
    ok ? "event" : "error",
    ok
      ? "🪑 Meeting tab audio added — I can hear everyone now."
      : "⚠ Tab share cancelled or had no audio (tick “Share tab audio” in the picker).",
  );
};

btnStopSpeaking.onclick = () => {
  send({ type: "cancel" });
  playback.cancel();
};

btnExport.onclick = () => send({ type: "export" });

askForm.onsubmit = (e) => {
  e.preventDefault();
  const text = askInput.value.trim();
  if (!text) return;
  send({ type: "ask", text });
  askInput.value = "";
};

connect();
