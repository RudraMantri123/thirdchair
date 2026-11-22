import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Session input recording, for replaying a real session through the same
 * pipeline when debugging or regression-testing latency.
 *
 * File layout (little-endian):
 *   "TCREC1\n"                              magic, 7 bytes
 *   repeated:
 *     f64  tMs      ms since recording start (monotonic clock)
 *     u8   kind     0 = audio frame, 1 = control message
 *     u32  length
 *     ...  payload  audio: the exact client ws frame ([channel][PCM16]);
 *                   control: the client JSON message, UTF-8
 *
 * Only what the client SENT is recorded. Replaying it reproduces every
 * server-side decision (VAD, transcription, wake match, answer) downstream.
 */
const MAGIC = Buffer.from("TCREC1\n");
/**
 * Writes are not awaited, so a disk that cannot keep up would otherwise
 * buffer the whole meeting in memory. Input audio is 32 kB/s; 8 MB is
 * minutes of backlog, far past any healthy disk.
 */
const MAX_WRITE_BACKLOG = 8 * 1024 * 1024;
export const REC_AUDIO = 0;
export const REC_CONTROL = 1;

export interface RecordedEvent {
  tMs: number;
  kind: typeof REC_AUDIO | typeof REC_CONTROL;
  payload: Buffer;
}

export class SessionRecorder {
  private out: WriteStream;
  private readonly t0 = performance.now();
  private dropped = 0;
  readonly path: string;

  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${name}.tcrec`);
    this.out = createWriteStream(this.path);
    this.out.on("error", (err) =>
      console.warn(`  recording write failed: ${err.message}`),
    );
    this.out.write(MAGIC);
  }

  audio(frame: Buffer): void {
    this.write(REC_AUDIO, frame);
  }

  control(json: string): void {
    this.write(REC_CONTROL, Buffer.from(json, "utf8"));
  }

  close(): void {
    this.out.end();
  }

  private write(kind: number, payload: Buffer): void {
    if (this.out.writableLength > MAX_WRITE_BACKLOG) {
      if (this.dropped++ === 0) {
        console.warn(`  recording ${this.path}: disk is not keeping up; dropping input until it drains`);
      }
      return;
    }
    const head = Buffer.alloc(13);
    head.writeDoubleLE(performance.now() - this.t0, 0);
    head.writeUInt8(kind, 8);
    head.writeUInt32LE(payload.length, 9);
    this.out.write(head);
    this.out.write(payload);
  }
}

/** Build a recording in memory (used to synthesize test sessions). */
export function encodeRecording(events: RecordedEvent[]): Buffer {
  const parts: Buffer[] = [MAGIC];
  for (const e of events) {
    const head = Buffer.alloc(13);
    head.writeDoubleLE(e.tMs, 0);
    head.writeUInt8(e.kind, 8);
    head.writeUInt32LE(e.payload.length, 9);
    parts.push(head, e.payload);
  }
  return Buffer.concat(parts);
}

export async function readRecording(path: string): Promise<RecordedEvent[]> {
  const buf = await readFile(path);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`${path} is not a ThirdChair recording (bad magic)`);
  }
  const events: RecordedEvent[] = [];
  let off = MAGIC.length;
  while (off + 13 <= buf.length) {
    const tMs = buf.readDoubleLE(off);
    const kind = buf.readUInt8(off + 8) as RecordedEvent["kind"];
    const len = buf.readUInt32LE(off + 9);
    off += 13;
    if (off + len > buf.length) break; // truncated tail from a crash
    events.push({ tMs, kind, payload: buf.subarray(off, off + len) });
    off += len;
  }
  return events;
}
