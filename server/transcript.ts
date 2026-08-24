import type { Speaker, TranscriptEntry } from "../shared/protocol.ts";

const MAX_ENTRIES = 5000;

/**
 * LEGACY — superseded by `memory/index.ts` (MeetingMemory) and no longer used
 * by the server. Kept only as the baseline in `scripts/before-after-eval.ts`:
 * its sliding char window is the behaviour the new subsystem is measured
 * against, so deleting it would remove the ability to reproduce the
 * comparison.
 *
 * Rolling, speaker-attributed transcript of everything heard this session.
 */
export class TranscriptStore {
  private entries: TranscriptEntry[] = [];
  readonly startedAt = Date.now();

  add(speaker: Speaker, text: string, whileSpeaking: boolean): TranscriptEntry {
    const entry: TranscriptEntry = {
      at: Date.now(),
      speaker,
      text,
      whileSpeaking,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    return entry;
  }

  /** Meeting context for Claude: timestamped, speaker-labeled, oldest first. */
  render(maxChars = 24000): string {
    const lines: string[] = [];
    let total = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const line = `${this.stamp(e.at)} ${this.label(e)}: ${e.text}`;
      total += line.length + 1;
      if (total > maxChars) break;
      lines.push(line);
    }
    return lines.reverse().join("\n");
  }

  export(): TranscriptEntry[] {
    return [...this.entries];
  }

  private stamp(at: number): string {
    const elapsed = at - this.startedAt;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    return `[${mins}:${String(secs).padStart(2, "0")}]`;
  }

  private label(e: TranscriptEntry): string {
    if (e.whileSpeaking) return "Copilot-echo";
    return e.speaker === "you" ? "You" : "Room";
  }
}
