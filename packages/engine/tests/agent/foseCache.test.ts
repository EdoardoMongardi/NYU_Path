// ============================================================
// foseCache.test.ts — Phase 15 Task 4 tests
// ============================================================
// Tests for FoseCache<T> with injectable clock for TTL testing.
// All cases use a controllable `now` function to avoid real timers.
// ============================================================

import { describe, it, expect } from "vitest";
import { FoseCache, DEFAULT_TTL_MS } from "../../src/agent/sectionMaterialization/foseCache.js";

// ---- Shared clock helper ----

/** Creates a controllable clock starting at `initial` ms. */
function makeClock(initial: number = 0): { now: () => number; advance: (ms: number) => void } {
    let t = initial;
    return {
        now: () => t,
        advance: (ms: number) => { t += ms; },
    };
}

describe("DEFAULT_TTL_MS", () => {
    it("is 5 minutes (300000 ms)", () => {
        expect(DEFAULT_TTL_MS).toBe(5 * 60 * 1000);
    });
});

describe("FoseCache.keyFor", () => {
    it("produces '${termCode}|${keyword}' format", () => {
        expect(FoseCache.keyFor("1268", "CSCI-UA 101")).toBe("1268|CSCI-UA 101");
    });

    it("keys differ for different termCodes", () => {
        const k1 = FoseCache.keyFor("1268", "MATH-UA 121");
        const k2 = FoseCache.keyFor("1274", "MATH-UA 121");
        expect(k1).not.toBe(k2);
    });

    it("keys differ for different keywords", () => {
        const k1 = FoseCache.keyFor("1268", "CSCI-UA 101");
        const k2 = FoseCache.keyFor("1268", "CSCI-UA 201");
        expect(k1).not.toBe(k2);
    });
});

describe("FoseCache — hit/miss within TTL", () => {
    // ---- Case 1: set + get within TTL returns value ----
    it("set + get within TTL → returns the stored value", () => {
        const clock = makeClock(1_000_000);
        const cache = new FoseCache<string[]>(DEFAULT_TTL_MS, clock.now);

        cache.set("1268", "CSCI-UA 101", ["section-a", "section-b"]);
        // Advance 1 minute — still within 5-min TTL
        clock.advance(60_000);

        const result = cache.get("1268", "CSCI-UA 101");
        expect(result).toEqual(["section-a", "section-b"]);
    });

    // ---- Case 2: get after TTL elapsed → undefined ----
    it("set + get AFTER TTL elapsed → returns undefined", () => {
        const clock = makeClock(1_000_000);
        const cache = new FoseCache<string[]>(DEFAULT_TTL_MS, clock.now);

        cache.set("1268", "CSCI-UA 101", ["section-a"]);
        // Advance exactly TTL + 1 ms — just expired
        clock.advance(DEFAULT_TTL_MS + 1);

        const result = cache.get("1268", "CSCI-UA 101");
        expect(result).toBeUndefined();
    });

    // ---- Case 3: different (termCode, keyword) keys are independent ----
    it("different (termCode, keyword) pairs are independent entries", () => {
        const clock = makeClock(0);
        const cache = new FoseCache<number>(DEFAULT_TTL_MS, clock.now);

        cache.set("1268", "CSCI-UA 101", 10);
        cache.set("1268", "MATH-UA 121", 20);
        cache.set("1274", "CSCI-UA 101", 30);

        expect(cache.get("1268", "CSCI-UA 101")).toBe(10);
        expect(cache.get("1268", "MATH-UA 121")).toBe(20);
        expect(cache.get("1274", "CSCI-UA 101")).toBe(30);
    });

    // ---- Case 3b: missing key returns undefined (no set performed) ----
    it("get on a key that was never set → returns undefined", () => {
        const clock = makeClock(0);
        const cache = new FoseCache<string>(DEFAULT_TTL_MS, clock.now);

        expect(cache.get("1268", "CSCI-UA 999")).toBeUndefined();
    });
});

describe("FoseCache — clear()", () => {
    // ---- Case 4: clear() empties the cache ----
    it("clear() removes all entries", () => {
        const clock = makeClock(0);
        const cache = new FoseCache<string>(DEFAULT_TTL_MS, clock.now);

        cache.set("1268", "CSCI-UA 101", "a");
        cache.set("1268", "MATH-UA 121", "b");
        cache.set("1274", "ECON-UA 1", "c");

        cache.clear();

        expect(cache.get("1268", "CSCI-UA 101")).toBeUndefined();
        expect(cache.get("1268", "MATH-UA 121")).toBeUndefined();
        expect(cache.get("1274", "ECON-UA 1")).toBeUndefined();
    });

    it("clear() on empty cache is a no-op", () => {
        const clock = makeClock(0);
        const cache = new FoseCache<string>(DEFAULT_TTL_MS, clock.now);
        expect(() => cache.clear()).not.toThrow();
        expect(cache.size()).toBe(0);
    });
});

describe("FoseCache — size()", () => {
    // ---- Case 5: size() reports live (non-expired) entries only ----
    it("size() counts only live entries", () => {
        const clock = makeClock(0);
        const cache = new FoseCache<string>(DEFAULT_TTL_MS, clock.now);

        cache.set("1268", "CSCI-UA 101", "a");
        cache.set("1268", "MATH-UA 121", "b");
        cache.set("1274", "ECON-UA 1", "c");
        expect(cache.size()).toBe(3);

        // Expire all three by advancing past TTL
        clock.advance(DEFAULT_TTL_MS + 1);
        expect(cache.size()).toBe(0);
    });

    it("size() is 0 on empty cache", () => {
        const clock = makeClock(0);
        const cache = new FoseCache<string>(DEFAULT_TTL_MS, clock.now);
        expect(cache.size()).toBe(0);
    });

    it("size() after clear() is 0", () => {
        const clock = makeClock(0);
        const cache = new FoseCache<string>(DEFAULT_TTL_MS, clock.now);

        cache.set("1268", "CSCI-UA 101", "a");
        cache.set("1268", "MATH-UA 121", "b");
        expect(cache.size()).toBe(2);

        cache.clear();
        expect(cache.size()).toBe(0);
    });

    it("size() reflects partial expiry — some entries expired, others live", () => {
        const clock = makeClock(0);
        // Use a short custom TTL of 1000 ms for easy partial expiry test
        const cache = new FoseCache<string>(1000, clock.now);

        cache.set("1268", "CSCI-UA 101", "a");   // set at t=0
        clock.advance(500);
        cache.set("1268", "MATH-UA 121", "b");   // set at t=500

        // Advance to t=1001 — first entry expired, second still live
        clock.advance(501);
        expect(cache.size()).toBe(1);
        expect(cache.get("1268", "CSCI-UA 101")).toBeUndefined();
        expect(cache.get("1268", "MATH-UA 121")).toBe("b");
    });
});

describe("FoseCache — overwrite", () => {
    it("set() on same key overwrites the value and resets TTL", () => {
        const clock = makeClock(0);
        const cache = new FoseCache<string>(1000, clock.now);

        cache.set("1268", "CSCI-UA 101", "v1");
        clock.advance(800);
        // Overwrite at t=800; new expiry = 800 + 1000 = 1800
        cache.set("1268", "CSCI-UA 101", "v2");

        // At t=1001 the original would have expired, but the overwrite reset the TTL
        clock.advance(201); // now t=1001
        expect(cache.get("1268", "CSCI-UA 101")).toBe("v2");

        // At t=1799 the overwritten entry is still live (expiry is t=1800, exclusive)
        clock.advance(798); // now t=1799
        expect(cache.get("1268", "CSCI-UA 101")).toBe("v2");
        // At t=1800 the entry expires (now() >= expiresAt → expired)
        clock.advance(1);   // now t=1800
        expect(cache.get("1268", "CSCI-UA 101")).toBeUndefined();
    });
});
