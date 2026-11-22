/**
 * Local Ollama: context-window guard and model lifecycle.
 *
 * Two memory levers live here, both measured (README, "Memory footprint"):
 *
 *  1. num_ctx sizes the KV cache, which Ollama allocates in full at load
 *     time (llama3.2 3B, f16: 112 KiB per token of window). It is set from
 *     the largest prompt we actually measured plus a margin, not from a
 *     round number. But a window that is too small is not an error in
 *     Ollama: it silently drops the START of the prompt and reports
 *     prompt_eval_count == num_ctx. That once cut recall from 100% to 43%.
 *     So every request is checked BEFORE it is sent, and the window grows
 *     rather than truncating.
 *
 *  2. The model is loaded when a meeting starts and released when the last
 *     one ends, instead of idling in memory on the daemon's 5-minute timer
 *     (or unloading mid-meeting after a quiet stretch and paying a cold
 *     start on the next question).
 */
import { config } from "./config.ts";

/**
 * The pre-flight estimate counts "pieces": runs of letters, groups of up to
 * three digits, and single punctuation marks — roughly how llama-family BPE
 * splits text. Bytes per token is NOT usable here: measured against
 * llama3.2's own tokenizer it ranged from 4.2 bytes/token on ordinary talk
 * down to 2.25 on number-heavy talk ("Q3 revenue was $4.2M, up 18%"), so any
 * single bytes ratio either wastes a third of the window or under-counts.
 * Pieces per real token stayed within 0.85-0.94 across ordinary, numeric,
 * monologue and timestamp-dense prompts (prompt_eval_count, chat template
 * included). Dividing by 0.84 therefore over-counts every measured prompt,
 * by 1-12%, so the guard trips early rather than late.
 */
const PIECES_PER_TOKEN = 0.84;
const PIECE = /[A-Za-z]+|\d{1,3}|[^\sA-Za-z\d]/g;
/** Chat-template framing (role headers, the template's date preamble). */
const TEMPLATE_OVERHEAD_TOKENS = 64;
/**
 * Room left for the answer. Generation shares the window with the prompt,
 * and num_predict is capped to this so the two can never collide. Spoken
 * answers are 2-3 sentences; the longest measured from llama3.2 3B in the
 * regression replays was 61 tokens.
 */
export const RESPONSE_RESERVE_TOKENS = 256;

/** Conservative token estimate for a set of chat messages. */
export function estimatePromptTokens(messages: { content: string }[]): number {
  let pieces = 0;
  for (const m of messages) {
    PIECE.lastIndex = 0;
    while (PIECE.exec(m.content) !== null) pieces++;
  }
  return Math.ceil(pieces / PIECES_PER_TOKEN) + TEMPLATE_OVERHEAD_TOKENS;
}

/**
 * Per-meeting correction of the estimate using the server's exact count of
 * the previous prompt.
 *
 * The piece count over-counts ordinary talk by up to ~21% (measured), which
 * on its own would waste a fifth of the window. But consecutive prompts in a
 * meeting share almost all their content — the layout is append-only — so
 * the previous prompt's exact count plus the ESTIMATED change since then is
 * far tighter: the estimate's error is confined to the part that changed,
 * and the answer reserve covers that (worst measured under-count over three
 * 2-hour meetings: see README, "Memory footprint"). It is never allowed to
 * exceed the plain estimate, which is itself an over-count on every measured
 * prompt. One instance per session: prompts from different meetings do not
 * share content, so their counts say nothing about each other.
 */
export class PromptCalibration {
  private last: { estimated: number; actual: number } | null = null;

  /** Best upper-bound token count for a prompt whose raw estimate is `raw`. */
  correct(raw: number): number {
    if (!this.last) return raw;
    const { estimated, actual } = this.last;
    // Growth: add the estimated (over-counted) increase. Shrinkage (history
    // chunks dropped from the front) must NOT be credited at the estimate's
    // over-count rate, or the result under-counts; scale proportionally.
    const corrected =
      raw >= estimated
        ? actual + (raw - estimated)
        : Math.ceil((actual * raw) / estimated);
    return Math.min(raw, corrected);
  }

  observe(raw: number, actual: number): void {
    if (actual > 0) this.last = { estimated: raw, actual };
  }
}

/**
 * The num_ctx in force. Starts at the configured value and only ever grows:
 * changing num_ctx reloads the model (and drops the KV prefix cache), so
 * flapping between sizes would cost far more than keeping the larger one.
 */
class ContextWindow {
  private size = config.ollamaNumCtx;

  get numCtx(): number {
    return this.size;
  }

  /**
   * The window a prompt of `estimated` tokens must run with. Grows (and
   * says so, loudly) when the prompt plus the answer reserve would not fit,
   * because the alternative is silent truncation of the meeting's start.
   */
  fit(estimated: number): number {
    const need = estimated + RESPONSE_RESERVE_TOKENS;
    if (need > this.size) {
      const grown = Math.ceil(need / 1024) * 1024;
      console.error(
        `  [ctx-guard] prompt ~${estimated} tokens + ${RESPONSE_RESERVE_TOKENS} reserve exceeds num_ctx ${this.size}; ` +
          `growing the window to ${grown} for the rest of this process (one model reload). ` +
          `Raise OLLAMA_NUM_CTX if this recurs.`,
      );
      this.size = grown;
    }
    return this.size;
  }

  /**
   * Post-flight check against the server's exact count. The estimate is
   * deliberately pessimistic, so this should never fire; if it does, the
   * estimate is miscalibrated for this content and the next turn is
   * protected by growing now.
   */
  verify(promptTokens: number, numCtx: number): void {
    if (promptTokens >= numCtx) {
      console.error(
        `  [ctx-guard] prompt filled the whole ${numCtx}-token window (${promptTokens}); ` +
          `Ollama has truncated its start. The pre-flight estimate is too low for this content.`,
      );
    }
    if (promptTokens + RESPONSE_RESERVE_TOKENS > this.size) {
      this.fit(promptTokens);
    }
  }
}

export const contextWindow = new ContextWindow();

// ---- lifecycle ----------------------------------------------------------------

/**
 * Keeps the model resident for exactly as long as a meeting is running.
 *
 * While any session is live the model holds a lease (keep_alive), renewed
 * well before it lapses, so a long silence mid-meeting never unloads it. When
 * the last session ends the model is released with keep_alive 0, so an idle
 * ThirdChair costs no model memory. A lease rather than "forever" means a
 * crashed server cannot pin the model: it lapses on its own.
 *
 * Note that unloading is daemon-wide: another client using the same model on
 * the same Ollama will see it reload. Set THIRDCHAIR_OLLAMA_LIFECYCLE=daemon to
 * leave residency to Ollama's own keep-alive instead.
 */
class ModelLifecycle {
  private holders = 0;
  private renewTimer: NodeJS.Timeout | null = null;

  get enabled(): boolean {
    return config.brain === "ollama" && config.ollamaLifecycle === "session";
  }

  /** keep_alive to send with each answer request, or undefined for default. */
  get keepAlive(): string | undefined {
    return this.enabled ? `${config.ollamaLeaseMinutes}m` : undefined;
  }

  acquire(): void {
    if (!this.enabled) return;
    if (this.holders++ > 0) return;
    void this.load("preload");
    const renewMs = Math.max(30_000, (config.ollamaLeaseMinutes * 60_000) / 2);
    this.renewTimer = setInterval(() => void this.load("renew"), renewMs);
    this.renewTimer.unref();
  }

  release(): void {
    if (!this.enabled || this.holders === 0) return;
    if (--this.holders > 0) return;
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    void this.post({ model: config.ollamaModel, keep_alive: 0 }, "release");
  }

  /**
   * An empty generate request loads the model without evaluating anything.
   * It must carry the same num_ctx as the answers will, or the first answer
   * would reload the model at a different window size.
   */
  private load(why: string): Promise<void> {
    return this.post(
      {
        model: config.ollamaModel,
        keep_alive: this.keepAlive,
        options: { num_ctx: contextWindow.numCtx },
      },
      why,
    );
  }

  private async post(body: Record<string, unknown>, why: string): Promise<void> {
    const t0 = performance.now();
    try {
      const res = await fetch(`${config.ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (why !== "renew") {
        console.log(
          `  ollama ${why}: ${config.ollamaModel} in ${Math.round(performance.now() - t0)} ms`,
        );
      }
    } catch (err) {
      console.warn(
        `  ollama ${why} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const modelLifecycle = new ModelLifecycle();
