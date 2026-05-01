// ============================================================
// Phase 7-E W10.5 — per-student rate-limit tests
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import { consumeRequest, _clearBuckets } from "../lib/rateLimit";

afterEach(() => _clearBuckets());

describe("consumeRequest", () => {
    it("first call returns ok with remaining=limit-1", () => {
        const r = consumeRequest("user-A", 30);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.remaining).toBe(29);
    });

    it("decrements remaining on each call", () => {
        consumeRequest("user-B", 5);
        consumeRequest("user-B", 5);
        const r = consumeRequest("user-B", 5);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.remaining).toBe(2);
    });

    it("returns ok:false at the limit, with retryAfterSeconds set", () => {
        for (let i = 0; i < 3; i++) consumeRequest("user-C", 3);
        const r = consumeRequest("user-C", 3);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.remaining).toBe(0);
            expect(r.retryAfterSeconds).toBeGreaterThan(0);
            expect(r.retryAfterSeconds).toBeLessThanOrEqual(24 * 60 * 60);
            expect(r.resetAt).toMatch(/T00:00:00\.000Z$/); // UTC midnight
        }
    });

    it("buckets are per-user", () => {
        for (let i = 0; i < 3; i++) consumeRequest("user-D", 3);
        const blocked = consumeRequest("user-D", 3);
        expect(blocked.ok).toBe(false);
        const fresh = consumeRequest("user-E", 3);
        expect(fresh.ok).toBe(true);
    });

    it("uses the default limit of 30 when no limit argument is passed", () => {
        for (let i = 0; i < 30; i++) {
            const r = consumeRequest("user-F");
            expect(r.ok).toBe(true);
        }
        const blocked = consumeRequest("user-F");
        expect(blocked.ok).toBe(false);
    });

    it("anonymous mode shares one bucket", () => {
        // Two requests under the literal "anonymous" id share the
        // counter — cohort-A pre-auth guard.
        for (let i = 0; i < 30; i++) consumeRequest("anonymous");
        const blocked = consumeRequest("anonymous");
        expect(blocked.ok).toBe(false);
    });
});
