/**
 * Token estimation for prompt budgeting.
 *
 * Deliberately arithmetic, not a real tokenizer: this runs on the answer path
 * and a tokenizer call there would cost more than it saves. LangChain
 * (`count_tokens_approximately`) and Haystack (`ApproximateTokenCounter`)
 * independently settled on 4 chars/token, and Letta ships the same estimate
 * with a 1.3 safety margin because the naive figure under-counts structured
 * text by 25-35%. We apply the margin only where under-counting is dangerous
 * (fitting a hard context window), not when reporting sizes.
 */

const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 3;
const SAFETY_MARGIN = 1.3;

/** Best-effort token count for a string. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / CHARS_PER_TOKEN);
}

/** Token count with the structural-overhead margin applied — use for budgets. */
export function budgetTokens(text: string): number {
  return Math.ceil(estimateTokens(text) * SAFETY_MARGIN) + PER_MESSAGE_OVERHEAD;
}

/** Per-section accounting, summed as sections are built (never re-parsed). */
export interface TokenBreakdown {
  system: number;
  digests: number;
  journal: number;
  recent: number;
  retrieved: number;
  question: number;
  total: number;
}

export function sumBreakdown(
  parts: Omit<TokenBreakdown, "total">,
): TokenBreakdown {
  const total =
    parts.system +
    parts.digests +
    parts.journal +
    parts.recent +
    parts.retrieved +
    parts.question;
  return { ...parts, total };
}
