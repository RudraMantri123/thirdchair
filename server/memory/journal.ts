/**
 * Append-only decision journal with bi-temporal validity.
 *
 * Modeled on Graphiti's `EntityEdge` and `resolve_edge_contradictions`: a
 * claim is never deleted or edited when it is contradicted. Instead the older
 * claim's validity window is CLOSED and the new claim is APPENDED carrying a
 * note that it supersedes the earlier one.
 *
 * That distinction is what makes the journal safe to put early in the prompt:
 * rendered lines are immutable once written, so the prompt prefix stays
 * byte-identical and the KV/prompt cache survives. mem0's alternative — an
 * in-place UPDATE/DELETE over a fact list — would rewrite earlier prompt
 * bytes and invalidate everything after them.
 *
 * The model resolves precedence itself from the timestamps and the
 * supersession note, exactly as Graphiti renders `invalid_at or 'Present'`.
 */
import {
  Canonicalizer,
  classify,
  extractEntities,
  normalizeExact,
  type ClaimKind,
} from "./text.ts";
import type { Speaker } from "../../shared/protocol.ts";

export interface Claim {
  id: number;
  kind: ClaimKind;
  /** Canonical topic key — what this claim is *about*. */
  subject: string;
  text: string;
  speaker: Speaker;
  /** Session-relative ms when the claim became true. */
  validAt: number;
  /** Session-relative ms when it stopped being true, or null if current. */
  invalidAt: number | null;
  supersedes: number | null;
}

export class DecisionJournal {
  private claims: Claim[] = [];
  private canon = new Canonicalizer();
  /** Latest open claim per (kind, subject) — the contradiction candidates. */
  private open = new Map<string, Claim>();
  private nextId = 1;

  /**
   * Offer an utterance to the journal. Returns the appended claim, or null
   * when the line carries no durable decision/action/blocker signal.
   */
  offer(
    text: string,
    speaker: Speaker,
    validAt: number,
    entities?: string[],
  ): Claim | null {
    const kind = classify(text);
    if (kind === null) return null;

    const subject = this.subjectOf(text, entities);
    if (!subject) return null;

    const key = `${kind}:${subject}`;
    const prior = this.open.get(key);

    // mem0's NONE event: a restatement that says the same thing is not new
    // information. Without this, a point repeated through a meeting appends a
    // near-identical claim every time and bloats the prompt.
    if (prior && normalizeExact(prior.text) === normalizeExact(text)) return null;

    const claim: Claim = {
      id: this.nextId++,
      kind,
      subject,
      text: text.trim(),
      speaker,
      validAt,
      invalidAt: null,
      supersedes: null,
    };

    if (prior) {
      // Graphiti's arithmetic: close the older claim at the moment the newer
      // one became true. Never mutate the older claim's rendered line.
      if (prior.validAt < claim.validAt) {
        prior.invalidAt = claim.validAt;
        claim.supersedes = prior.id;
      } else {
        // Out-of-order arrival: the incoming claim is already stale.
        claim.invalidAt = prior.validAt;
      }
    }

    this.claims.push(claim);
    if (claim.invalidAt === null) this.open.set(key, claim);
    return claim;
  }

  /**
   * The journal as append-only prompt text. Each line is emitted once and
   * never revised, so this string only ever grows at the tail.
   */
  render(): string {
    if (this.claims.length === 0) return "";
    return this.claims.map((c) => this.line(c)).join("\n");
  }

  /** Rendered lines for claims appended at or after `fromId` (for appends). */
  renderFrom(fromId: number): string {
    return this.claims
      .filter((c) => c.id >= fromId)
      .map((c) => this.line(c))
      .join("\n");
  }

  get lastId(): number {
    return this.nextId - 1;
  }

  all(): Claim[] {
    return [...this.claims];
  }

  private line(c: Claim): string {
    const label = c.kind.toUpperCase();
    const who = c.speaker === "you" ? "You" : "Room";
    const window =
      c.invalidAt === null
        ? `${stamp(c.validAt)}→present`
        : `${stamp(c.validAt)}→${stamp(c.invalidAt)}`;
    const note = c.supersedes !== null ? ` (revises #${c.supersedes})` : "";
    return `#${c.id} [${window}] ${label} ${who}: ${c.text}${note}`;
  }

  /**
   * A claim's subject is its most specific entity, canonicalized so that
   * "the Pro tier" / "Pro plan" / "pro-tier" collapse to one key and
   * contradiction detection is a hash lookup rather than a search.
   */
  private subjectOf(text: string, precomputed?: string[]): string {
    const entities = precomputed ?? extractEntities(text);
    if (entities.length === 0) return "";
    // Prefer the longest entity — the most specific description available.
    const best = entities.reduce((a, b) => (b.length > a.length ? b : a));
    return this.canon.canonical(best);
  }
}

function stamp(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
