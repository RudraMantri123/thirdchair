/**
 * Wake-phrase detection over committed transcript segments.
 *
 * STT rarely hears a wake phrase perfectly ("hey copilot" arrives as
 * "hey co-pilot", "hey, copilot", "a copilot"...), so each word is matched
 * loosely and separators are tolerated.
 */
export class Trigger {
  private regex: RegExp;
  private words: string[] = [];
  // Set when the wake phrase arrived with no question after it —
  // the next committed segment (within the window) becomes the question.
  private awaitingSince = 0;
  private static readonly AWAIT_WINDOW_MS = 10000;

  constructor(wakePhrase: string) {
    this.regex = Trigger.compile(wakePhrase);
    this.words = wakePhrase.trim().toLowerCase().split(/\s+/);
  }

  setPhrase(wakePhrase: string): void {
    this.regex = Trigger.compile(wakePhrase);
    this.words = wakePhrase.trim().toLowerCase().split(/\s+/);
  }

  /**
   * Feed one committed segment. Returns the question when the copilot has
   * been addressed and a question is available, "awaiting" when the wake
   * phrase was heard alone, or null when this segment isn't for us.
   */
  feed(text: string): { question: string } | { awaiting: true } | null {
    const match = this.match(text);
    if (match) {
      const after = text
        .slice(match.end)
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
    return this.match(text) !== null;
  }

  /**
   * Locate the wake phrase. Tries the tolerant regex first, then falls back
   * to per-word edit-distance matching — STT often mangles made-up words
   * ("copilot" comes back as "Coppola", "co-pilot", "copile it"…).
   */
  private match(text: string): { end: number } | null {
    const rx = this.regex.exec(text);
    if (rx) return { end: rx.index + rx[0].length };

    const tokens = [...text.matchAll(/[\p{L}\p{N}']+/gu)];
    const n = this.words.length;
    for (let i = 0; i + n <= tokens.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        const heard = tokens[i + j][0].toLowerCase();
        const want = this.words[j];
        // Leading filler words ("hey") get mangled the most, so they get
        // extra slack; phonetic equality catches the rest ("coppolait").
        const tolerance = want.length >= 5 ? 2 : j === 0 ? 2 : 1;
        if (
          levenshtein(heard, want) > tolerance &&
          soundex(heard) !== soundex(want)
        ) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const last = tokens[i + n - 1];
        return { end: last.index + last[0].length };
      }
    }
    return null;
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

/** American Soundex: same code = words sound alike ("copilot"/"coppolait"). */
function soundex(word: string): string {
  const codes: Record<string, string> = {
    b: "1", f: "1", p: "1", v: "1",
    c: "2", g: "2", j: "2", k: "2", q: "2", s: "2", x: "2", z: "2",
    d: "3", t: "3",
    l: "4",
    m: "5", n: "5",
    r: "6",
  };
  const s = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return "";
  let out = s[0].toUpperCase();
  let prev = codes[s[0]] ?? "";
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const code = codes[s[i]] ?? "";
    if (code && code !== prev) out += code;
    if (s[i] !== "h" && s[i] !== "w") prev = code;
  }
  return out.padEnd(4, "0");
}

/** Classic dynamic-programming edit distance (small strings only). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return m + n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}
