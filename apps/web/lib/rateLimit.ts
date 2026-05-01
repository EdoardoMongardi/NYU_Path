// ============================================================
// Per-student daily rate limit (Phase 7-E W10.5)
// ============================================================
// Cohort-A cost guard + abuse signal. Each student gets N
// requests per UTC-day window; over-the-limit requests get a
// 429 with a polite "you've used up today's quota" message.
//
// Storage: in-process Map. Resets on server restart (acceptable
// for cohort A where the server runs continuously and a restart
// effectively means we'd lose at most ~30 messages of count
// state for ~10 active users).
//
// When W12 + Postgres land, migrate to a Redis or Postgres-
// backed counter so multi-instance scale-out works. The shape
// stays the same: `consume(userId)` returns either ok or
// over-limit with reset time.
// ============================================================

const DEFAULT_LIMIT = 30; // messages per UTC-day per student
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface Bucket {
    count: number;
    /** UTC midnight epoch ms when the bucket resets. */
    windowStart: number;
}

const buckets = new Map<string, Bucket>();

export interface ConsumeOk {
    ok: true;
    remaining: number;
    limit: number;
    /** ISO timestamp when the count resets. */
    resetAt: string;
}

export interface ConsumeBlocked {
    ok: false;
    remaining: 0;
    limit: number;
    resetAt: string;
    retryAfterSeconds: number;
}

export type ConsumeResult = ConsumeOk | ConsumeBlocked;

/** Floor `t` to the most recent UTC midnight (used as bucket window-start). */
function utcMidnightFloor(t: number): number {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Try to consume one request from `userId`'s daily quota. Returns
 * `ok: true` with the remaining count, or `ok: false` with the
 * reset-at timestamp + retry-after seconds.
 *
 * `userId === "anonymous"` is bucketed globally, so anonymous-mode
 * cohort A still gets a soft cap. Once W12 lands and real userIds
 * arrive, each student gets their own bucket.
 */
export function consumeRequest(userId: string, limit: number = DEFAULT_LIMIT): ConsumeResult {
    const now = Date.now();
    const winStart = utcMidnightFloor(now);
    const winEnd = winStart + WINDOW_MS;

    const existing = buckets.get(userId);
    if (!existing || existing.windowStart < winStart) {
        // Fresh bucket for today.
        buckets.set(userId, { count: 1, windowStart: winStart });
        return {
            ok: true,
            remaining: limit - 1,
            limit,
            resetAt: new Date(winEnd).toISOString(),
        };
    }

    if (existing.count >= limit) {
        return {
            ok: false,
            remaining: 0,
            limit,
            resetAt: new Date(winEnd).toISOString(),
            retryAfterSeconds: Math.ceil((winEnd - now) / 1000),
        };
    }

    existing.count += 1;
    return {
        ok: true,
        remaining: limit - existing.count,
        limit,
        resetAt: new Date(winEnd).toISOString(),
    };
}

/** Test-only: clear all buckets. */
export function _clearBuckets(): void {
    buckets.clear();
}
