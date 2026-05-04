// ============================================================
// sectionMaterialization/foseCache.ts — Phase 15 Task 4
// ============================================================
// Simple in-memory TTL cache for FOSE query results.
//
// Key shape:  `${termCode}|${keyword}`
// Default TTL: 5 minutes (300 000 ms)
//
// Injectable `now: () => number` clock makes the cache fully
// testable without vi.useFakeTimers — just pass a controlled
// function in tests.
// ============================================================

/** Default TTL: 5 minutes. */
export const DEFAULT_TTL_MS = 5 * 60 * 1_000; // 300 000 ms

/** A single cache slot. */
export interface FoseCacheEntry<T> {
    value: T;
    /** Absolute epoch-ms timestamp after which this entry is stale. */
    expiresAt: number;
}

/**
 * In-memory TTL cache keyed by `(termCode, keyword)` pairs.
 *
 * @template T - The type of cached values (typically `FoseSearchResult[]`).
 */
export class FoseCache<T> {
    private store: Map<string, FoseCacheEntry<T>>;

    /**
     * @param ttlMs - How long entries live, in milliseconds. Defaults to 5 minutes.
     * @param now   - Clock function returning current epoch-ms. Defaults to `Date.now`.
     *               Inject a controlled function in tests to avoid fake timers.
     */
    constructor(
        private ttlMs: number = DEFAULT_TTL_MS,
        private now: () => number = Date.now,
    ) {
        this.store = new Map();
    }

    /**
     * Build the cache key for a (termCode, keyword) pair.
     * Example: keyFor("1268", "CSCI-UA 101") → "1268|CSCI-UA 101"
     */
    static keyFor(termCode: string, keyword: string): string {
        return `${termCode}|${keyword}`;
    }

    /**
     * Retrieve a cached value.
     * Returns `undefined` if the key is absent OR if the entry has expired.
     */
    get(termCode: string, keyword: string): T | undefined {
        const key = FoseCache.keyFor(termCode, keyword);
        const entry = this.store.get(key);
        if (entry === undefined) return undefined;
        if (this.now() >= entry.expiresAt) {
            // Lazy eviction: remove the stale entry on access
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }

    /**
     * Store a value. Overwrites any existing entry for the same key
     * and resets the TTL from the current moment.
     */
    set(termCode: string, keyword: string, value: T): void {
        const key = FoseCache.keyFor(termCode, keyword);
        this.store.set(key, {
            value,
            expiresAt: this.now() + this.ttlMs,
        });
    }

    /** Remove all entries (live and expired). */
    clear(): void {
        this.store.clear();
    }

    /**
     * Count of LIVE (non-expired) entries.
     * For tests and diagnostics — iterates the store with expiry checks.
     */
    size(): number {
        const now = this.now();
        let count = 0;
        for (const entry of this.store.values()) {
            if (now < entry.expiresAt) {
                count++;
            }
        }
        return count;
    }
}
