import { AudioCapture } from "./audio/capture.ts";
import { AudioPlayback } from "./audio/playback.ts";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const orb = $("orb");
const statusEl = $("status");
const feed = $("feed");
const btnStart = $<HTMLButtonElement>("btn-start");
const btnTab = $<HTMLButtonElement>("btn-tab");
const btnStopSpeaking = $<HTMLButtonElement>("btn-stop-speaking");
const askForm = $<HTMLFormElement>("ask-form");
const askInput = $<HTMLInputElement>("ask-input");
const wakeDisplay = $("wake-display");

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const ws = new WebSocket(wsUrl);
ws.binaryType = "arraybuffer";

const playback = new AudioPlayback();
const capture = new AudioCapture((pcm) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
});

let listening = false;
let partialEl: HTMLElement | null = null;
let answerEl: HTMLElement | null = null;

function send(msg: ClientMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function setState(state: "idle" | "listening" | "thinking" | "speaking"): void {
  orb.dataset.state = state;
  statusEl.textContent = state;
}

function addLine(cls: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `line ${cls}`;
  el.textContent = text;
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
  return el;
}

ws.onmessage = (e) => {
  if (e.data instanceof ArrayBuffer) {
    playback.play(e.data);
    return;
  }
  const msg = JSON.parse(e.data as string) as ServerMessage;
  switch (msg.type) {
    case "ready":
      wakeDisplay.textContent = msg.wakePhrase;
      setState("idle");
      break;
    case "partial":
      if (!partialEl) partialEl = addLine("partial", "");
      partialEl.textContent = msg.text;
      feed.scrollTop = feed.scrollHeight;
      break;
    case "committed":
      partialEl?.remove();
      partialEl = null;
      addLine(msg.whileSpeaking ? "heard muted" : "heard", msg.text);
      break;
    case "listening_for_question":
      addLine("event", "🪑 Yes? Listening for your question…");
      break;
    case "triggered":
      addLine("event", `🪑 Asked: “${msg.question}”`);
      setState("thinking");
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
    case "speaking_start":
      setState("speaking");
      btnStopSpeaking.disabled = false;
      break;
    case "speaking_cancel":
      playback.cancel();
      break;
    case "speaking_end":
      btnStopSpeaking.disabled = true;
      setState(listening ? "listening" : "idle");
      break;
    case "status":
      break;
    case "error":
      addLine("error", `⚠ ${msg.message}`);
      break;
  }
};

ws.onclose = () => {
  setState("idle");
  addLine("error", "⚠ Connection lost — reload the page.");
};

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
    setState("listening");
  } else {
    capture.stop();
    send({ type: "stop" });
    listening = false;
    btnStart.textContent = "Start listening";
    btnTab.disabled = true;
    setState("idle");
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

askForm.onsubmit = (e) => {
  e.preventDefault();
  const text = askInput.value.trim();
  if (!text) return;
  send({ type: "ask", text });
  askInput.value = "";
};
