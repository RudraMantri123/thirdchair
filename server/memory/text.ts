/**
 * Deterministic text utilities for the memory subsystem.
 *
 * Everything here is CPU-only: no LLM call, no embedding, no network. That is
 * a hard requirement, not a preference — the local model serves a single
 * prompt-cache slot, so any second differently-prefixed inference call evicts
 * the answer-path prefix and costs the next spoken answer a full cold prompt
 * eval (measured: 5.5 s vs 97 ms). Memory maintenance therefore has to be
 * free.
 *
 * The dedup cascade (exact -> entropy gate -> MinHash/LSH -> Jaccard) follows
 * Graphiti's `dedup_helpers.py`; the entity extraction and its generic-head
 * stoplist follow mem0's `entity_extraction.py`.
 */

export const FUZZY_JACCARD_THRESHOLD = 0.9;
export const NAME_ENTROPY_THRESHOLD = 1.5;
export const MIN_NAME_LENGTH = 6;
export const MIN_TOKEN_COUNT = 2;
const MINHASH_PERMUTATIONS = 32;
const SHINGLE_SIZE = 3;

/** Lowercase + collapse whitespace. Used for exact-match canonicalization. */
export function normalizeExact(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Keep only [a-z0-9' ] — the shape MinHash shingles expect. */
export function normalizeFuzzy(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shannon entropy over characters, spaces stripped. */
export function shannonEntropy(s: string): number {
  const chars = s.replace(/\s/g, "");
  if (chars.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / chars.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * True when a name is too short or too repetitive for shingle comparison to
 * be trustworthy ("Q3", "the app"). Such names skip fuzzy matching rather
 * than risk a false merge.
 */
export function tooWeakForFuzzy(name: string): boolean {
  const fuzzy = normalizeFuzzy(name);
  const tokens = fuzzy.split(" ").filter(Boolean);
  if (fuzzy.length < MIN_NAME_LENGTH && tokens.length < MIN_TOKEN_COUNT) {
    return true;
  }
  return shannonEntropy(fuzzy) < NAME_ENTROPY_THRESHOLD;
}

/** Seeded FNV-1a. Cheap, well-distributed enough for MinHash permutations. */
function hash32(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Character n-gram shingles with spaces stripped. */
export function shingles(s: string, size = SHINGLE_SIZE): Set<string> {
  const t = normalizeFuzzy(s).replace(/ /g, "");
  const out = new Set<string>();
  if (t.length === 0) return out;
  if (t.length <= size) {
    out.add(t);
    return out;
  }
  for (let i = 0; i + size <= t.length; i++) out.add(t.slice(i, i + size));
  return out;
}

/** MinHash signature over MINHASH_PERMUTATIONS seeded hashes. */
export function minhash(sh: Set<string>): number[] {
  const sig = new Array<number>(MINHASH_PERMUTATIONS).fill(0xffffffff);
  for (const s of sh) {
    for (let p = 0; p < MINHASH_PERMUTATIONS; p++) {
      const h = hash32(s, p);
      if (h < sig[p]) sig[p] = h;
    }
  }
  return sig;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Canonicalizes surface forms of the same topic ("the Pro tier" / "Pro plan"
 * / "pro-tier") onto one key, so the journal can look claims up by hash
 * instead of searching. Graphiti's cascade, minus the LLM fallback: an
 * unresolved name simply becomes its own canonical key.
 */
export class Canonicalizer {
  private exact = new Map<string, string>();
  private buckets = new Map<string, string[]>();
  private shingleCache = new Map<string, Set<string>>();

  canonical(name: string): string {
    const exactKey = normalizeExact(name);
    if (!exactKey) return "";

    const hit = this.exact.get(exactKey);
    if (hit) return hit;

    if (!tooWeakForFuzzy(name)) {
      const sh = shingles(name);
      const sig = minhash(sh);
      // LSH: band the signature so only plausible candidates get compared.
      const bandKeys: string[] = [];
      for (let b = 0; b + 4 <= sig.length; b += 4) {
        bandKeys.push(`${b}:${sig.slice(b, b + 4).join(",")}`);
      }
      const seen = new Set<string>();
      for (const bk of bandKeys) {
        for (const cand of this.buckets.get(bk) ?? []) {
          if (seen.has(cand)) continue;
          seen.add(cand);
          const candSh = this.shingleCache.get(cand);
          if (candSh && jaccard(sh, candSh) >= FUZZY_JACCARD_THRESHOLD) {
            this.exact.set(exactKey, cand);
            return cand;
          }
        }
      }
      // New canonical form — register it in its bands.
      this.exact.set(exactKey, exactKey);
      this.shingleCache.set(exactKey, sh);
      for (const bk of bandKeys) {
        const arr = this.buckets.get(bk);
        if (arr) arr.push(exactKey);
        else this.buckets.set(bk, [exactKey]);
      }
      return exactKey;
    }

    this.exact.set(exactKey, exactKey);
    return exactKey;
  }
}

/**
 * Heads so generic they carry no discriminating power in a meeting
 * transcript. mem0's `_GENERIC_HEADS`, extended with meeting filler.
 */
const GENERIC_HEADS = new Set([
  "thing", "things", "way", "ways", "issue", "issues", "approach", "process",
  "result", "results", "outcome", "goal", "goals", "task", "tasks", "topic",
  "topics", "level", "item", "items", "point", "points", "part", "parts",
  "side", "case", "cases", "time", "times", "lot", "bit", "kind", "sort",
  "stuff", "one", "ones", "everyone", "everybody", "something", "anything",
  "nothing", "someone", "guys", "folks", "team", "call", "meeting", "sense",
  "idea", "ideas", "question", "questions", "minute", "minutes", "second",
  "seconds", "screen", "sorry", "yeah", "okay", "right", "sure", "thanks",
]);

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "we", "i", "you",
  "he", "she", "it", "they", "them", "us", "our", "your", "their", "my", "me",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did",
  "have", "has", "had", "will", "would", "can", "could", "should", "shall",
  "may", "might", "must", "to", "of", "in", "on", "at", "for", "with", "from",
  "by", "about", "as", "into", "over", "after", "before", "up", "down", "out",
  "that", "this", "these", "those", "there", "here", "what", "which", "who",
  "whom", "when", "where", "why", "how", "all", "any", "both", "each", "few",
  "more", "most", "other", "some", "such", "no", "not", "only", "own", "same",
  "than", "too", "very", "just", "now", "also", "like", "get", "got", "going",
  "know", "think", "want", "need", "let", "lets", "okay", "yeah", "really",
]);

export function isStopword(w: string): boolean {
  return STOPWORDS.has(w);
}

/** Content tokens: lowercased, stopwords and pure punctuation removed. */
export function contentTokens(text: string): string[] {
  return normalizeFuzzy(text)
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Deterministic entity extraction: quoted spans, capitalized runs, and
 * numeric/currency/percentage/date mentions, plus noun-ish compounds whose
 * head is not generic. No POS tagger, no model.
 */
export function extractEntities(text: string): string[] {
  const found = new Set<string>();

  for (const m of text.matchAll(/["'“”']([^"'“”']{3,60})["'“”']/g)) {
    found.add(m[1].trim());
  }

  // Capitalized runs, ignoring a run that is only the first word of the line.
  for (const m of text.matchAll(/\b([A-Z][a-z0-9']+(?:\s+[A-Z][a-z0-9']+)*)/g)) {
    const phrase = m[1].trim();
    const head = phrase.split(/\s+/).pop()!.toLowerCase();
    if (GENERIC_HEADS.has(head) || STOPWORDS.has(head)) continue;
    if (m.index === 0 && !phrase.includes(" ")) continue;
    found.add(phrase);
  }

  for (const m of text.matchAll(
    /(\$\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:%|percent|dollars?|usd|k\b|million|billion)|\bq[1-4]\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b)/gi,
  )) {
    found.add(m[1].trim());
  }

  // Two-token compounds with a non-generic head ("enterprise tier").
  const toks = contentTokens(text);
  for (let i = 0; i + 1 < toks.length; i++) {
    const head = toks[i + 1];
    if (GENERIC_HEADS.has(head)) continue;
    found.add(`${toks[i]} ${head}`);
  }

  return [...found];
}

/** Utterance salience cues. Drives both sealing and importance scoring. */
const DECISION_CUES =
  /\b(decided?|decision|agreed?|agree|settled?|we'?ll|we will|let'?s go with|going with|approved?|sign(?:ed)? off|final(?:ised|ized)?|conclusion|resolved)\b/i;
const ACTION_CUES =
  /\b(action item|owns?|owner|will (?:send|take|do|draft|prepare|present|follow)|follow(?:s|ing)? up|take the|by (?:mon|tues|wednes|thurs|fri|satur|sun)day|deadline|due|assign(?:ed)?|responsible)\b/i;
const BLOCKER_CUES =
  /\b(blocked?|blocker|blocking|at risk|slipp(?:ed|ing)|delayed?|dependency|waiting on|holdup|hold up)\b/i;
const NUMERIC_CUE = /(\$\s?\d|\b\d+(?:\.\d+)?\s?(?:%|percent|dollars?|k\b))/i;
const FILLER =
  /^\s*(?:yeah|yep|yes|no|nope|mhm|mm+|uh+|um+|ok(?:ay)?|right|sure|exactly|got it|thanks?|hello|hi|sorry|cool|nice|agreed)\b[\s.,!?]*$/i;

export type ClaimKind = "decision" | "action" | "blocker" | "fact";

/** Classify an utterance, or null when it carries no durable signal. */
export function classify(text: string): ClaimKind | null {
  if (FILLER.test(text)) return null;
  if (DECISION_CUES.test(text)) return "decision";
  if (ACTION_CUES.test(text)) return "action";
  if (BLOCKER_CUES.test(text)) return "blocker";
  if (NUMERIC_CUE.test(text) && text.trim().split(/\s+/).length >= 5) {
    return "fact";
  }
  return null;
}

/**
 * Salience in [0,1] — how much this line deserves to survive compression.
 * Deliberately simple and explainable: cue class dominates, with small
 * bonuses for numbers and named entities and a penalty for very short lines.
 */
export function salience(text: string): number {
  if (FILLER.test(text)) return 0;
  const words = text.trim().split(/\s+/).length;
  let score = 0;
  const kind = classify(text);
  if (kind === "decision") score += 0.6;
  else if (kind === "action") score += 0.55;
  else if (kind === "blocker") score += 0.5;
  else if (kind === "fact") score += 0.35;
  if (NUMERIC_CUE.test(text)) score += 0.15;
  score += Math.min(extractEntities(text).length, 4) * 0.05;
  if (words < 5) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

/**
 * American Soundex: words with the same code sound alike. Used both for
 * wake-phrase matching and for correcting misheard vocabulary terms.
 */
export function soundex(word: string): string {
  const codes: Record<string, string> = {
    b: "1", f: "1", p: "1", v: "1",
    c: "2", g: "2", j: "2", k: "2", q: "2", s: "2", x: "2", z: "2",
    d: "3", t: "3",
    l: "4",
    m: "5", n: "5",
    r: "6",
  };
  const t = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return "";
  let out = t[0].toUpperCase();
  let prev = codes[t[0]] ?? "";
  for (let i = 1; i < t.length && out.length < 4; i++) {
    const code = codes[t[i]] ?? "";
    if (code && code !== prev) out += code;
    if (t[i] !== "h" && t[i] !== "w") prev = code;
  }
  return out.padEnd(4, "0");
}

/** Levenshtein distance. Small strings only. */
export function editDistance(a: string, b: string): number {
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
