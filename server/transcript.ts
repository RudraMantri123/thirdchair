interface Entry {
  at: number;
  text: string;
  // True if ThirdChair was speaking when this was heard — likely its own
  // voice echoing back, so it's labeled in the context sent to Claude.
  whileSpeaking: boolean;
}

const MAX_ENTRIES = 2000;

/** Rolling transcript of everything heard since the session started. */
export class TranscriptStore {
  private entries: Entry[] = [];
  readonly startedAt = Date.now();

  add(text: string, whileSpeaking: boolean): Entry {
    const entry = { at: Date.now(), text, whileSpeaking };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    return entry;
  }

  /** Meeting context for Claude: timestamped lines, oldest first. */
  render(maxChars = 24000): string {
    const lines: string[] = [];
    let total = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const mins = Math.floor((e.at - this.startedAt) / 60000);
      const secs = Math.floor(((e.at - this.startedAt) % 60000) / 1000);
      const stamp = `[${mins}:${String(secs).padStart(2, "0")}]`;
      const who = e.whileSpeaking ? " (copilot speaking)" : "";
      const line = `${stamp}${who} ${e.text}`;
      total += line.length + 1;
      if (total > maxChars) break;
      lines.push(line);
    }
    return lines.reverse().join("\n");
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }
}
