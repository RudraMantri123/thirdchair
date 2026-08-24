/**
 * Minimal WAV reading and writing.
 *
 * Exists because every speech engine we shell out to speaks WAV and nothing
 * else, and because the containers they produce are not uniform: macOS `say`
 * emits a JUNK chunk before `data`, and some engines pad chunks to even
 * lengths. So the reader walks the chunk list rather than assuming the
 * canonical 44-byte header.
 */

export interface WavAudio {
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
}

/** Parse a 16-bit PCM WAV, downmixing to mono if needed. */
export function decodeWav(buf: Buffer): WavAudio {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("not a RIFF file");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let data: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(offset + 10) || 1;
      sampleRate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === "data") {
      // Some writers set an over-long size; clamp to what is actually there.
      data = buf.subarray(offset + 8, Math.min(offset + 8 + size, buf.length));
    }
    offset += 8 + size + (size % 2);
  }

  if (!data) throw new Error("WAV has no data chunk");
  if (bits !== 16) throw new Error(`unsupported WAV bit depth: ${bits}`);
  if (!sampleRate) throw new Error("WAV has no sample rate");

  const frames = Math.floor(data.length / 2 / channels);
  const pcm = new Int16Array(frames);
  if (channels === 1) {
    for (let i = 0; i < frames; i++) pcm[i] = data.readInt16LE(i * 2);
  } else {
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += data.readInt16LE((i * channels + c) * 2);
      }
      pcm[i] = Math.round(sum / channels);
    }
  }
  return { pcm, sampleRate, channels: 1 };
}

/** Wrap raw mono 16-bit PCM in a canonical WAV container. */
export function encodeWav(pcm: Int16Array | Buffer, sampleRate: number): Buffer {
  const body =
    pcm instanceof Int16Array
      ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      : pcm;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}
