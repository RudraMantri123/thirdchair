// End-to-end voice-loop test: streams a synthesized spoken question into
// ThirdChair's websocket as if it were mic audio, and reports every event.
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WAV = "/tmp/e2e-question.wav";
execFileSync("say", [
  "-o",
  WAV,
  "--data-format=LEI16@16000",
  "hey copilot, what is two plus two?",
]);

// Extract PCM from the WAV's data chunk
const wav = readFileSync(WAV);
let offset = 12;
let pcm: Buffer | null = null;
while (offset + 8 <= wav.length) {
  const id = wav.toString("ascii", offset, offset + 4);
  const size = wav.readUInt32LE(offset + 4);
  if (id === "data") {
    pcm = wav.subarray(offset + 8, offset + 8 + size);
    break;
  }
  offset += 8 + size + (size % 2);
}
if (!pcm) throw new Error("no data chunk");

const ws = new WebSocket("ws://localhost:8787/ws");
ws.binaryType = "nodebuffer";
let audioBytes = 0;

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "start" }));
  const FRAME = 4096; // 2048 samples = 128ms
  let pos = 0;
  const timer = setInterval(() => {
    let chunk: Buffer;
    if (pos < pcm.length) {
      chunk = pcm.subarray(pos, pos + FRAME);
      pos += FRAME;
    } else {
      chunk = Buffer.alloc(FRAME); // trailing silence to end the utterance
      pos += FRAME;
      if (pos > pcm.length + 16 * FRAME) clearInterval(timer);
    }
    const frame = Buffer.alloc(1 + chunk.length);
    frame[0] = 0; // CHANNEL_MIC
    chunk.copy(frame, 1);
    ws.send(frame);
  }, 128);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    audioBytes += (data as Buffer).length;
    return;
  }
  const msg = JSON.parse(data.toString());
  console.log("EVENT:", JSON.stringify(msg).slice(0, 220));
  if (msg.type === "state" && msg.state === "listening" && audioBytes > 0) {
    console.log(`TTS AUDIO RECEIVED: ${audioBytes} bytes (~${(audioBytes / 2 / 24000).toFixed(1)}s)`);
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.log(`TIMEOUT. audio bytes so far: ${audioBytes}`);
  process.exit(1);
}, 60000);
