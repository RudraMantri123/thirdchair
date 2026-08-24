/**
 * MeetingMemory — the transcript, shaped for a prompt.
 *
 * One governing rule, derived from measurement: prompt-eval cost is
 * proportional to the number of tokens AFTER the first byte that differs from
 * the cached prefix. So prompt sections are ordered by how often they change,
 * ascending, and anything early must be append-only:
 *
 *   [0] system          never changes (no timestamps in it)
 *   [1] sealed segments append-only; grows only when a segment seals
 *   [2] live tail       appends as speech arrives
 *   [3] retrieved spans rewritten per question — late on purpose
 *   [4] the question    rewritten per question
 *
 * Two profiles, because the two brains have opposite constraints:
 *
 *   "full"    (Claude, 1M window) — a 60-minute meeting is only ~20-35k
 *             tokens, so nothing is ever compacted. Full verbatim recall.
 *   "compact" (local model, 8k window) — sealed segments contribute an
 *             EXTRACTIVE digest. Extractive, not abstractive, because a
 *             summarizer LLM call would evict the single prompt-cache slot
 *             and cost the next spoken answer a full cold prompt eval.
 */
import type { Speaker, TranscriptEntry } from "../../shared/protocol.ts";
import { DecisionJournal } from "./journal.ts";
import { LexicalIndex } from "./retrieval.ts";
import { extractEntities, salience } from "./text.ts";
import { budgetTokens, estimateTokens, sumBreakdown, type TokenBreakdown } from "./tokens.ts";

export type MemoryProfile = "full" | "compact";

/** Utterances per segment. Coarse on purpose: few, large prompt blocks keep
 * us clear of Anthropic's 20-block cache lookback window. */
const SEGMENT_SIZE = 40;
/** Salient lines quoted verbatim per digest — quotes let answers attribute. */
const DIGEST_LINES = 4;

interface Segment {
  index: number;
  startAt: number;
  endAt: number;
  entries: TranscriptEntry[];
  /** Immutable once written. Never recomputed. */
  digest: string;
  /** Claims decided during this segment, rendered once at seal time. */
  claimLines: string;
  /** Verbatim rendering, also frozen at seal time. */
  verbatim: string;
}

export interface PromptSections {
  /** Journal + sealed history. Append-only; changes only on seal. */
  stable: string;
  /** Verbatim tail since the last seal. Appends between seals. */
  recent: string;
  /** Retrieved spans for this question. Rewritten per turn — placed late. */
  retrieved: string;
  tokens: TokenBreakdown;
}

export class MeetingMemory {
  readonly startedAt = Date.now();
  private entries: TranscriptEntry[] = [];
  private segments: Segment[] = [];
  private tail: TranscriptEntry[] = [];
  private journal = new DecisionJournal();
  private index = new LexicalIndex();
  /** Highest journal claim id already folded into a sealed segment. */
  private claimWatermark = 0;
  /** Entity -> times heard. Feeds the recognizer its own vocabulary. */
  private vocab = new Map<string, number>();
  private vocabCache: string | null = null;
  private vocabCacheSize = -1;

  constructor(
    private profile: MemoryProfile,
    /** Token budget for history in compact mode. */
    private historyBudget = 5000,
  ) {}

  /** Session-relative milliseconds. */
  private rel(at: number): number {
    return at - this.startedAt;
  }

  add(speaker: Speaker, text: string, whileSpeaking: boolean): TranscriptEntry {
    const entry: TranscriptEntry = { at: Date.now(), speaker, text, whileSpeaking };
    this.entries.push(entry);
    this.tail.push(entry);
    // Echo of our own voice is recorded for the UI but never offered to the
    // journal — it is not something a participant said.
    if (!whileSpeaking) {
      const entities = extractEntities(text);
      for (const e of entities) {
        this.vocab.set(e, (this.vocab.get(e) ?? 0) + 1);
      }
      this.journal.offer(text, speaker, this.rel(entry.at), entities);
    }
    this.maybeSeal();
    return entry;
  }

  /**
   * Seal the oldest complete segment when the tail grows past SEGMENT_SIZE,
   * snapping the boundary to a speaker change so a decision is never cut in
   * half. Sealing is the only moment a digest is computed, and it happens
   * exactly once per segment.
   */
  private maybeSeal(): void {
    if (this.tail.length < SEGMENT_SIZE) return;

    let cut = SEGMENT_SIZE;
    while (
      cut < this.tail.length &&
      this.tail[cut].speaker === this.tail[cut - 1].speaker
    ) {
      cut++;
    }
    const taken = this.tail.slice(0, cut);
    this.tail = this.tail.slice(cut);

    // Freeze every rendering of this segment now, at seal time, so nothing
    // downstream ever recomputes (and therefore changes) earlier prompt bytes.
    const segment: Segment = {
      index: this.segments.length,
      startAt: this.rel(taken[0].at),
      endAt: this.rel(taken[taken.length - 1].at),
      entries: taken,
      digest: this.digestOf(taken),
      claimLines: this.journal.renderFrom(this.claimWatermark + 1),
      verbatim: taken.map((e) => this.line(e)).join("\n"),
    };
    this.claimWatermark = this.journal.lastId;
    this.segments.push(segment);
    // Sealed segments are the retrieval corpus; the tail is already in-prompt.
    this.index.add({
      id: `seg-${segment.index}`,
      text: taken.map((e) => e.text).join(" "),
      at: segment.endAt,
    });
  }

  /**
   * Extractive digest: the most salient lines, quoted verbatim, plus lookup
   * hints for what was dropped. Verbatim quotes are the point — an answer
   * like "what did we decide about pricing?" needs the actual words, and a
   * paraphrase cannot be attributed.
   */
  private digestOf(entries: TranscriptEntry[]): string {
    const ranked = entries
      .filter((e) => !e.whileSpeaking)
      .map((e) => ({ e, s: salience(e.text) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, DIGEST_LINES)
      .sort((a, b) => a.e.at - b.e.at);

    const quoted = ranked.map((r) => this.line(r.e));

    // Lookup hints: terms present in the segment but not in the quoted lines,
    // so lexical retrieval can still find material that was compressed away.
    const kept = new Set(quoted.join(" ").toLowerCase().split(/\s+/));
    const hints = new Set<string>();
    for (const e of entries) {
      for (const ent of extractEntities(e.text)) {
        if (!kept.has(ent.toLowerCase()) && hints.size < 8) hints.add(ent);
      }
    }

    const header = `[${stamp(this.rel(entries[0].at))}-${stamp(
      this.rel(entries[entries.length - 1].at),
    )}]`;
    const body = quoted.length > 0 ? quoted.join("\n") : "(no decisions in this stretch)";
    const hintLine = hints.size > 0 ? `\n  also mentioned: ${[...hints].join(", ")}` : "";
    return `${header}\n${body}${hintLine}`;
  }

  private line(e: TranscriptEntry): string {
    const who = e.whileSpeaking ? "Copilot" : e.speaker === "you" ? "You" : "Room";
    return `[${stamp(this.rel(e.at))}] ${who}: ${e.text}`;
  }

  /**
   * Build the prompt sections for a question. Pure arithmetic and string
   * assembly — no LLM call, no embedding, no I/O.
   */
  build(question: string): PromptSections {
    // ONE append-only stream. Each sealed segment contributes exactly one
    // immutable chunk (its decisions, then its content), appended in order.
    // Concatenating two separately-growing sections instead would break
    // append-only-ness: growth in the first shifts every byte of the second.
    const chunks = this.profile === "full" ? this.fullChunks() : this.compactChunks();
    const stable = chunks.join("\n\n");

    // Claims from the live tail are not yet sealed, so they ride with the
    // volatile section — where a rewrite is cheap.
    const liveClaims = this.journal.renderFrom(this.claimWatermark + 1);
    const recentLines = this.tail.map((e) => this.line(e)).join("\n");
    const recent = [
      liveClaims && `Just decided:\n${liveClaims}`,
      recentLines && `Just said:\n${recentLines}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // Retrieval only earns its place when history was actually compressed.
    let retrieved = "";
    if (this.profile === "compact" && this.index.size > 0) {
      const now = this.rel(Date.now());
      const hits = this.index.search(question, now, 3);
      const verbatim = hits
        .map((h) => {
          const seg = this.segments[Number(h.id.replace("seg-", ""))];
          return seg
            ? seg.entries
                .filter((e) => salience(e.text) > 0)
                .slice(0, 3)
                .map((e) => this.line(e))
                .join("\n")
            : "";
        })
        .filter(Boolean);
      if (verbatim.length > 0) retrieved = verbatim.join("\n");
    }

    return {
      stable,
      recent,
      retrieved,
      tokens: sumBreakdown({
        system: 0,
        digests: estimateTokens(stable),
        journal: estimateTokens(liveClaims),
        recent: estimateTokens(recentLines),
        retrieved: estimateTokens(retrieved),
        question: estimateTokens(question),
      }),
    };
  }

  /** One frozen chunk per sealed segment, full verbatim content. */
  private fullChunks(): string[] {
    return this.segments.map((s) => this.chunkOf(s, s.verbatim));
  }

  /**
   * Same append-only chunk stream, with every sealed segment contributing its
   * digest. Deliberately NOT "verbatim for the most recent few, digest for
   * older": that would rewrite a segment's chunk as newer ones seal, mutating
   * earlier prompt bytes and capping cache reuse. Verbatim recency comes from
   * the unsealed tail, which lives in the volatile section where a rewrite is
   * cheap; exact older lines come from retrieval when a question needs them.
   *
   * The oldest chunks are dropped once the budget is exceeded. That does break
   * the prefix, but at most once per segment rather than once per question,
   * and the decisions those chunks carried were frozen into their claim lines.
   */
  private compactChunks(): string[] {
    const parts = this.segments.map((s) => this.chunkOf(s, s.digest));
    let start = 0;
    while (
      start < parts.length &&
      budgetTokens(parts.slice(start).join("\n\n")) > this.historyBudget
    ) {
      start++;
    }
    return parts.slice(start);
  }

  private chunkOf(s: Segment, body: string): string {
    return s.claimLines ? `${s.claimLines}\n${body}` : body;
  }

  /**
   * The meeting's own vocabulary, formatted as a decoding bias prompt for the
   * recognizer. This closes a useful loop: a name or product term heard once
   * makes the recognizer far more likely to get it right the next time, which
   * is exactly where a general-purpose model is weakest. Measured 21.1% ->
   * 15.8% WER on a sentence full of proper nouns (scripts/asr-eval.ts).
   *
   * Ordered by frequency, capped, and rebuilt only when the vocabulary
   * actually changes — the string is sent with every utterance.
   */
  vocabularyPrompt(max = 24): string {
    if (this.vocab.size === 0) return "";
    if (this.vocabCacheSize === this.vocab.size && this.vocabCache !== null) {
      return this.vocabCache;
    }
    const terms = [...this.vocab.entries()]
      .filter(([term, n]) => n >= 2 || /[A-Z]/.test(term))
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([term]) => term);
    this.vocabCache = terms.length
      ? `Meeting transcript. Recurring names and terms: ${terms.join(", ")}.`
      : "";
    this.vocabCacheSize = this.vocab.size;
    return this.vocabCache;
  }

  export(): TranscriptEntry[] {
    return [...this.entries];
  }

  claims() {
    return this.journal.all();
  }
}

function stamp(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
