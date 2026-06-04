// ============================================================
// Retry-with-backoff for external API calls (RAG tool path)
// ============================================================
// The agent's RAG tools (`search_policy`, `get_program_requirements`)
// each make an OpenAI embed + a Cohere rerank call. When the model
// fires several RAG tool calls in one turn, that burst can trip a
// provider rate limit (429). Previously the only safety net was the
// agent loop's single 100ms `executeTool` retry — useless against a
// per-minute rate window — so the rate-limited tool surfaced an error
// to the model, which then answered from PARTIAL retrieval (observed
// live: a CAS major/minor question truncated mid-retrieval, missing a
// section that retrieval ranked #1).
//
// This wraps the API boundary itself with exponential backoff + full
// jitter so a transient 429 / 5xx / network blip self-heals before it
// ever reaches the tool layer. It is intentionally generic (no SDK
// types) so the OpenAI embedder, the Cohere reranker, and the offline
// embed tool can all share one implementation.
// ============================================================

export interface RetryOptions {
    /** Total attempts, including the first. Default 5. */
    maxAttempts?: number;
    /** Initial backoff before the first retry. Default 800ms. */
    baseMs?: number;
    /** Cap on any single backoff wait. Default 20s. */
    maxMs?: number;
    /** Invoked before each backoff sleep (e.g., to log). */
    onRetry?: (info: { attempt: number; waitMs: number; error: unknown }) => void;
}

/**
 * True for errors worth retrying: HTTP 429 / 5xx (read from the common
 * `status` / `statusCode` fields the OpenAI + Cohere SDKs expose), the
 * `rate_limit*` error codes, and transient network failures. Anything
 * else (4xx other than 429, bad input, auth) is surfaced immediately —
 * retrying those just wastes wall-clock.
 */
export function isRetryableApiError(err: unknown): boolean {
    const e = err as { status?: number; statusCode?: number; code?: string | number; message?: string };
    const status = typeof e?.status === "number" ? e.status : e?.statusCode;
    if (status === 429) return true;
    if (typeof status === "number" && status >= 500 && status <= 599) return true;
    const code = String(e?.code ?? "").toLowerCase();
    if (/rate.?limit|etimedout|econnreset|enotfound|epipe|eai_again/.test(code)) return true;
    const msg = String(e?.message ?? "").toLowerCase();
    return /rate.?limit|\b429\b|\b50[234]\b|timeout|temporarily unavailable|econnreset|etimedout|network/.test(msg);
}

/**
 * Run `fn`, retrying retryable failures with exponential backoff and
 * full jitter. Non-retryable errors throw on the first occurrence; a
 * retryable error on the final attempt is rethrown as-is.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? 5;
    const baseMs = opts.baseMs ?? 800;
    const maxMs = opts.maxMs ?? 20_000;
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= maxAttempts || !isRetryableApiError(err)) throw err;
            const expMs = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
            // Full jitter: a uniform draw in [expMs/2, expMs] spreads
            // concurrent retriers so they don't re-collide on the window.
            const waitMs = Math.round(expMs * (0.5 + Math.random() * 0.5));
            opts.onRetry?.({ attempt, waitMs, error: err });
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }
}
