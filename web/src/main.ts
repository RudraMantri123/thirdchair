import { AudioCapture } from "./audio/capture.ts";
import { AudioPlayback } from "./audio/playback.ts";
import type {
  AudioChannel,
  ClientMessage,
  ServerMessage,
  SessionState,
  TranscriptEntry,
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

const playback = new AudioPlayback();
const capture = new AudioCapture((channel, pcm) => sendAudio(channel, pcm));

let ws: WebSocket | null = null;
let reconnectDelay = 500;
let listening = false;
let partials = new Map<string, HTMLElement>();
let answerEl: HTMLElement | null = null;

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
      playback.play(e.data);
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
      break;
    case "transcript_export":
      downloadTranscript(msg.startedAt, msg.entries);
      break;
    case "error":
      addLine("error", `⚠ ${msg.message}`);
      break;
  }
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
  } else {
    capture.stop();
    send({ type: "stop" });
    listening = false;
    btnStart.textContent = "Start listening";
    btnTab.disabled = true;
  }
};

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
