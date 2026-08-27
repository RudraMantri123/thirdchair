/**
 * Post-hoc correction of misheard vocabulary terms.
 *
 * This replaces prompt-based contextual biasing, which was measured to be
 * actively harmful. Putting the meeting's vocabulary in whisper's `prompt`
 * slot improved rare words but corrupted ordinary ones — reproducibly turning
 * "our churn last quarter" into "Arjun last quarter", because that slot is
 * where whisper expects the PREVIOUS TRANSCRIPT, not a word list, so a list
 * behaves as a generative prior. Published measurements agree: rare-word error
 * falls, but error on words outside the list rises on 11/11 datasets and
 * overall WER worsens on 6/11 (arXiv 2502.11572).
 *
 * Correcting AFTER decoding cannot have that failure mode. It only ever
 * rewrites a token that is already phonetically close to a known term, it
 * never invents one, and — critically — it refuses to touch ordinary English
 * words, so "churn" can never become "Arjun".
 */
import { soundex, editDistance, isStopword } from "./text.ts";

/**
 * Consonant skeleton: vowels dropped, runs collapsed. Complements Soundex,
 * which anchors on the first letter and is therefore blind exactly when the
 * leading consonant is what got misheard, and which changes code entirely
 * when a middle consonant is dropped ("vendor" V536 vs "vedor" V360).
 *
 *   priya -> pry   preah -> pr    vendor -> vndr   vedor -> vdr
 */
function consonantSkeleton(word: string): string {
  const t = word.toLowerCase().replace(/[^a-z]/g, "").replace(/[aeiou]/g, "");
  let out = "";
  for (const c of t) if (out[out.length - 1] !== c) out += c;
  return out;
}

/**
 * Words common enough that a phonetic near-match to a meeting term is far
 * more likely to be a real word than a mishearing. Without this guard the
 * corrector would reintroduce exactly the bug it exists to fix.
 */
const PROTECTED = new Set([
  "churn", "burn", "turn", "learn", "earn", "return", "concern", "current",
  "quarter", "charter", "start", "chart", "part", "cart", "heart",
  "tier", "year", "clear", "near", "hear", "here", "there", "their",
  "price", "prices", "pricing", "rice", "nice", "twice",
  "sock", "shock", "stock", "block", "clock", "talk", "walk",
  "team", "seem", "seam", "deem", "stream", "dream",
  "board", "bored", "word", "world", "ward", "work",
  "contract", "contact", "content", "context", "correct",
  "vendor", "render", "gender", "sender", "tender",
  "migration", "operation", "creation", "duration",
  "customer", "consumer", "summer", "number",
  "meeting", "meaning", "morning", "warning",
  "launch", "lunch", "branch", "brunch",
  "review", "revenue", "avenue", "value",
]);

export interface Correction {
  from: string;
  to: string;
}

export class VocabularyCorrector {
  /** canonical term -> phonetic key, rebuilt only when terms change. */
  private terms: { term: string; key: string; lower: string; skeleton: string }[] = [];
  private signature = "";

  /**
   * Set the correction vocabulary. Terms should already be evidence-filtered
   * (heard more than once) — a term derived from a single mishearing would
   * otherwise become a magnet for that same mistake.
   */
  setTerms(terms: string[]): void {
    const sig = terms.join("|");
    if (sig === this.signature) return;
    this.signature = sig;
    this.terms = terms
      // Single tokens only. Multi-word terms would need alignment across token
      // boundaries, and the failure modes there are much harder to bound.
      .filter((t) => !t.includes(" ") && t.length >= 4)
      .map((term) => ({
        term,
        key: soundex(term),
        lower: term.toLowerCase(),
        skeleton: consonantSkeleton(term),
      }));
  }

  /** Correct a transcript, returning the text and what was changed. */
  correct(text: string): { text: string; corrections: Correction[] } {
    if (this.terms.length === 0) return { text, corrections: [] };
    const corrections: Correction[] = [];

    const out = text.replace(/[\p{L}\p{N}']+/gu, (token) => {
      const lower = token.toLowerCase();
      if (lower.length < 4) return token;
      if (isStopword(lower) || PROTECTED.has(lower)) return token;

      const key = soundex(lower);
      const skel = consonantSkeleton(lower);
      for (const t of this.terms) {
        if (t.lower === lower) return token; // already correct

        // Two independent phonetic views, either of which may match — they
        // fail on different things, so requiring both agreed on almost
        // nothing (3 of 6 real mishearings were missed).
        const phoneticallyClose =
          t.key === key || editDistance(skel, t.skeleton) <= 1;
        if (!phoneticallyClose) continue;

        // Surface distance still bounds it, so a phonetic collision alone
        // cannot rewrite an unrelated word. Scaled to term length: short
        // words are held to a tighter bar than long ones.
        const tolerance = Math.max(1, Math.ceil(t.term.length / 3));
        if (editDistance(lower, t.lower) > tolerance) continue;
        corrections.push({ from: token, to: t.term });
        // Preserve the original capitalisation style where it was capitalised.
        return /^[A-Z]/.test(token) ? capitalize(t.term) : t.term;
      }
      return token;
    });

    return { text: out, corrections };
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
