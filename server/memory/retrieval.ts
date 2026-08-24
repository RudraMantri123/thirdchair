/**
 * Lexical retrieval over the meeting transcript.
 *
 * No embeddings and no vector store: an embedding round-trip on the answer
 * path is latency we cannot spend, and the whole transcript is already in
 * memory. BM25 with mem0's query-length-adaptive logistic normalization
 * (`normalize_bm25` / `get_bm25_params` in `mem0/utils/scoring.py`), combined
 * additively with recency and importance the way Generative Agents weights
 * relevance 3 : importance 2 : recency 0.5, each min-max normalized within
 * the candidate set.
 *
 * Note the ordering discipline borrowed from mem0: gate on the primary score
 * BEFORE combining, so a weak lexical match cannot be rescued into the
 * results by recency alone.
 */
import { contentTokens, jaccard, shingles, salience } from "./text.ts";

const K1 = 1.5;
const B = 0.75;
const RELEVANCE_WEIGHT = 3;
const IMPORTANCE_WEIGHT = 2;
const RECENCY_WEIGHT = 0.5;
const PRIMARY_GATE = 0.1;
const MMR_LAMBDA = 0.6;

export interface Doc {
  id: string;
  text: string;
  /** Milliseconds since session start — drives the recency term. */
  at: number;
}

interface Scored {
  doc: Doc;
  relevance: number;
  importance: number;
  recency: number;
  score: number;
}

/** BM25 index over sealed transcript segments. Rebuilt when a segment seals. */
export class LexicalIndex {
  private docs: Doc[] = [];
  private tokens = new Map<string, string[]>();
  private df = new Map<string, number>();
  private avgLen = 0;

  add(doc: Doc): void {
    const toks = contentTokens(doc.text);
    this.docs.push(doc);
    this.tokens.set(doc.id, toks);
    for (const t of new Set(toks)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen =
      [...this.tokens.values()].reduce((n, t) => n + t.length, 0) /
      Math.max(1, this.tokens.size);
  }

  get size(): number {
    return this.docs.length;
  }

  /**
   * Rank documents for a question. `now` is the session-relative time of the
   * question, used for the recency term.
   */
  search(query: string, now: number, limit = 4): Doc[] {
    if (this.docs.length === 0) return [];
    const qTokens = contentTokens(query);
    if (qTokens.length === 0) return [];

    const { midpoint, steepness } = bm25Params(qTokens.length);
    const N = this.docs.length;

    // Over-fetch, then rank — mem0's internal_limit discipline.
    const scored: Scored[] = [];
    for (const doc of this.docs) {
      const toks = this.tokens.get(doc.id)!;
      let raw = 0;
      const counts = new Map<string, number>();
      for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const q of new Set(qTokens)) {
        const tf = counts.get(q);
        if (!tf) continue;
        const df = this.df.get(q) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        raw +=
          idf *
          ((tf * (K1 + 1)) /
            (tf + K1 * (1 - B + B * (toks.length / Math.max(1, this.avgLen)))));
      }
      const relevance = logistic(raw, midpoint, steepness);
      if (relevance < PRIMARY_GATE) continue;
      scored.push({
        doc,
        relevance,
        importance: salience(doc.text),
        recency: now > 0 ? Math.max(0, Math.min(1, doc.at / now)) : 0,
        score: 0,
      });
    }
    if (scored.length === 0) return [];

    // Min-max normalize each component within the candidate set, then weight.
    normalize(scored, "relevance");
    normalize(scored, "importance");
    normalize(scored, "recency");
    for (const s of scored) {
      s.score =
        s.relevance * RELEVANCE_WEIGHT +
        s.importance * IMPORTANCE_WEIGHT +
        s.recency * RECENCY_WEIGHT;
    }
    scored.sort((a, b) => b.score - a.score);

    return mmr(scored, limit).map((s) => s.doc);
  }
}

/**
 * Maximal Marginal Relevance over shingle overlap. A decision restated four
 * times across a meeting would otherwise fill the whole retrieval budget
 * with one fact; this spends it on four different ones instead.
 */
function mmr(scored: Scored[], limit: number): Scored[] {
  const picked: Scored[] = [];
  const pool = [...scored];
  const shingleCache = new Map<string, Set<string>>();
  const sh = (s: Scored) => {
    let v = shingleCache.get(s.doc.id);
    if (!v) {
      v = shingles(s.doc.text);
      shingleCache.set(s.doc.id, v);
    }
    return v;
  };

  while (picked.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const maxSim = picked.reduce(
        (m, p) => Math.max(m, jaccard(sh(pool[i]), sh(p))),
        0,
      );
      const val = MMR_LAMBDA * pool[i].score - (1 - MMR_LAMBDA) * maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    picked.push(pool.splice(bestIdx, 1)[0]);
  }
  return picked;
}

function normalize(rows: Scored[], key: "relevance" | "importance" | "recency"): void {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    if (r[key] < min) min = r[key];
    if (r[key] > max) max = r[key];
  }
  const span = max - min;
  for (const r of rows) r[key] = span > 0 ? (r[key] - min) / span : 0;
}

/** Raw BM25 is unbounded; squash it so it can be added to bounded terms. */
function logistic(raw: number, midpoint: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * (raw - midpoint)));
}

/** mem0's get_bm25_params: the midpoint scales with query length. */
function bm25Params(terms: number): { midpoint: number; steepness: number } {
  if (terms <= 3) return { midpoint: 5.0, steepness: 0.7 };
  if (terms <= 6) return { midpoint: 7.0, steepness: 0.6 };
  if (terms <= 9) return { midpoint: 9.0, steepness: 0.5 };
  if (terms <= 15) return { midpoint: 10.0, steepness: 0.5 };
  return { midpoint: 12.0, steepness: 0.5 };
}
