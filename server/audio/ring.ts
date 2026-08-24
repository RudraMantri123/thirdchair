/**
 * Fixed-capacity PCM ring buffer.
 *
 * Replaces the `Buffer[]` + `Buffer.concat()` pattern the capture path used
 * to accumulate an utterance. That pattern allocated one Buffer per 128 ms
 * frame, held them all in an array, then allocated a fresh buffer the size of
 * the whole utterance to join them — so a 30 s utterance touched ~235 small
 * allocations plus one 960 kB copy, all of it garbage immediately afterwards.
 *
 * Here the storage is allocated once at construction and reused for the whole
 * session. Steady-state allocation is zero; the only copy is the single
 * `toPcm()` at the point an utterance is actually handed to the recognizer.
 */
export class PcmRing {
  private buf: Int16Array;
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.buf = new Int16Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  get full(): boolean {
    return this.count === this.capacity;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }

  /**
   * Append samples, dropping the oldest when full. Dropping rather than
   * growing is deliberate: it makes the memory ceiling a property of the type,
   * not of how long someone talks.
   *
   * Copies in at most two bulk `set()` calls (before and after the wrap point)
   * rather than looping per sample — typed-array set is a memmove, and a
   * per-sample loop with a modulo measured ~4x slower than Buffer.concat,
   * which would have traded CPU for the allocation win.
   */
  write(samples: Int16Array): void {
    let src = samples;
    // More than a full buffer at once: only the tail can survive.
    if (src.length >= this.capacity) {
      src = src.subarray(src.length - this.capacity);
      this.buf.set(src, 0);
      this.start = 0;
      this.count = this.capacity;
      return;
    }

    const writePos = (this.start + this.count) % this.capacity;
    const firstRun = Math.min(src.length, this.capacity - writePos);
    this.buf.set(src.subarray(0, firstRun), writePos);
    if (firstRun < src.length) {
      this.buf.set(src.subarray(firstRun), 0);
    }

    const room = this.capacity - this.count;
    if (src.length <= room) {
      this.count += src.length;
    } else {
      // Overwrote `overflow` of the oldest samples; advance the read cursor.
      const overflow = src.length - room;
      this.count = this.capacity;
      this.start = (this.start + overflow) % this.capacity;
    }
  }

  /** Drop all but the newest `n` samples, in place, without allocating. */
  keepLast(n: number): void {
    if (n >= this.count) return;
    this.start = (this.start + (this.count - n)) % this.capacity;
    this.count = n;
  }

  /** Copy the contents out in chronological order. The one allocation. */
  toPcm(): Int16Array {
    const out = new Int16Array(this.count);
    const firstRun = Math.min(this.count, this.capacity - this.start);
    out.set(this.buf.subarray(this.start, this.start + firstRun), 0);
    if (this.count > firstRun) {
      out.set(this.buf.subarray(0, this.count - firstRun), firstRun);
    }
    return out;
  }

  /** Append this ring's contents onto another, oldest first. */
  drainInto(other: PcmRing): void {
    const firstRun = Math.min(this.count, this.capacity - this.start);
    other.write(this.buf.subarray(this.start, this.start + firstRun));
    if (this.count > firstRun) {
      other.write(this.buf.subarray(0, this.count - firstRun));
    }
    this.clear();
  }
}

/** Reinterpret a Buffer of little-endian 16-bit samples as Int16Array. */
export function asInt16(buf: Buffer): Int16Array {
  // Buffer from the socket may be at an odd byte offset, in which case a
  // zero-copy view is not possible and we must copy to stay aligned.
  if ((buf.byteOffset & 1) === 0) {
    return new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  }
  const copy = Buffer.allocUnsafe(buf.length);
  buf.copy(copy);
  return new Int16Array(copy.buffer, copy.byteOffset, copy.length >> 1);
}
