/**
 * Wake-phrase detection over committed transcript segments.
 *
 * STT rarely hears a wake phrase perfectly ("hey copilot" arrives as
 * "hey co-pilot", "hey, copilot", "a copilot"...), so each word is matched
 * loosely and separators are tolerated.
 */
export class Trigger {
  private regex: RegExp;
  // Set when the wake phrase arrived with no question after it —
  // the next committed segment (within the window) becomes the question.
  private awaitingSince = 0;
  private static readonly AWAIT_WINDOW_MS = 10000;

  constructor(wakePhrase: string) {
    this.regex = Trigger.compile(wakePhrase);
  }

  setPhrase(wakePhrase: string): void {
    this.regex = Trigger.compile(wakePhrase);
  }

  /**
   * Feed one committed segment. Returns the question when the copilot has
   * been addressed and a question is available, "awaiting" when the wake
   * phrase was heard alone, or null when this segment isn't for us.
   */
  feed(text: string): { question: string } | { awaiting: true } | null {
    const match = this.regex.exec(text);
    if (match) {
      const after = text
        .slice(match.index + match[0].length)
        .replace(/^[\s,.:;!?-]+/, "")
        .trim();
      if (after.length >= 3) {
        this.awaitingSince = 0;
        return { question: after };
      }
      this.awaitingSince = Date.now();
      return { awaiting: true };
    }

    if (
      this.awaitingSince &&
      Date.now() - this.awaitingSince < Trigger.AWAIT_WINDOW_MS
    ) {
      this.awaitingSince = 0;
      return { question: text.trim() };
    }
    this.awaitingSince = 0;
    return null;
  }

  /** True if the text contains the wake phrase at all (used for barge-in). */
  mentioned(text: string): boolean {
    return this.regex.test(text);
  }

  private static compile(phrase: string): RegExp {
    const words = phrase.trim().toLowerCase().split(/\s+/);
    // Each word matches with optional internal hyphens/spaces
    // (copilot / co-pilot / co pilot); words separated by space/punctuation.
    const parts = words.map((w) => {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return escaped.replace(/(?<=\w)(?=\w)/g, "[\\s-]?");
    });
    return new RegExp(`\\b${parts.join("[\\s,]+")}\\b`, "i");
  }
}
