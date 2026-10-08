// ============================================================
// /api/auth/otp/{verify,issue} — rate limits + trusted IP bucketing
// ============================================================
// /verify is rate-limited per IP AND per email (429 + Retry-After)
// before any code is compared; the durable per-code attempt budget is
// covered by otpVerifyAttempts.test.ts. On Vercel the IP bucket keys on
// the platform-set `x-vercel-forwarded-for`, so rotating a
// client-supplied `x-forwarded-for` does not buy a fresh bucket.
//
// `issueOtp` / `verifyOtp` are mocked: these tests are about the route
// layer, not the DB.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { _clearBuckets } from "../lib/rateLimit";
import type { VerifyResult } from "../lib/auth/otp";

const verifyOtp = vi.fn<(email: string, code: string) => Promise<VerifyResult>>();
const issueOtp = vi.fn(async () => ({ ok: true }));
vi.mock("../lib/auth/otp", () => ({
    verifyOtp: (email: string, code: string) => verifyOtp(email, code),
    issueOtp: () => issueOtp(),
}));

const { POST: verifyPOST } = await import("../app/api/auth/otp/verify/route");
const { POST: issuePOST } = await import("../app/api/auth/otp/issue/route");

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
    return {
        headers: new Headers(headers),
        json: async () => body,
    } as unknown as NextRequest;
}

const ORIGINAL_VERCEL = process.env.VERCEL;

beforeEach(() => {
    _clearBuckets();
    verifyOtp.mockReset();
    verifyOtp.mockResolvedValue({ ok: false, reason: "code_mismatch" });
    issueOtp.mockClear();
    delete process.env.VERCEL;
});

afterEach(() => {
    if (ORIGINAL_VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = ORIGINAL_VERCEL;
});

describe("POST /api/auth/otp/verify rate limits", () => {
    it("blocks the 26th attempt from one IP with 429 + Retry-After, without checking the code", async () => {
        const ip = { "x-forwarded-for": "203.0.113.7" };
        for (let i = 0; i < 25; i++) {
            const res = await verifyPOST(req({ email: `student${i}@nyu.edu`, code: "000000" }, ip));
            expect(res.status).toBe(401);
        }
        const blocked = await verifyPOST(req({ email: "another@nyu.edu", code: "000000" }, ip));
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
        expect(verifyOtp).toHaveBeenCalledTimes(25);
    });

    it("blocks the 11th attempt for one email across IPs, case-insensitively", async () => {
        for (let i = 0; i < 10; i++) {
            const email = i % 2 === 0 ? "victim@nyu.edu" : " Victim@NYU.edu ";
            const res = await verifyPOST(req({ email, code: "000000" }, { "x-forwarded-for": `198.51.100.${i}` }));
            expect(res.status).toBe(401);
        }
        const blocked = await verifyPOST(
            req({ email: "VICTIM@nyu.edu", code: "123456" }, { "x-forwarded-for": "192.0.2.99" }),
        );
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
        expect(verifyOtp).toHaveBeenCalledTimes(10);
    });

    it("on Vercel, rotating x-forwarded-for does not escape the IP bucket", async () => {
        process.env.VERCEL = "1";
        for (let i = 0; i < 25; i++) {
            await verifyPOST(
                req(
                    { email: `s${i}@nyu.edu`, code: "000000" },
                    { "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": `10.9.8.${i}` },
                ),
            );
        }
        const blocked = await verifyPOST(
            req(
                { email: "fresh@nyu.edu", code: "000000" },
                { "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "10.9.8.250" },
            ),
        );
        expect(blocked.status).toBe(429);
    });

    it("tells the student to request a new code once the code's attempts are spent", async () => {
        verifyOtp.mockResolvedValue({ ok: false, reason: "too_many_attempts" });
        const res = await verifyPOST(req({ email: "a@nyu.edu", code: "000000" }, { "x-forwarded-for": "203.0.113.1" }));
        expect(res.status).toBe(401);
        const body = (await res.json()) as { ok: boolean; error: string };
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/too many incorrect/i);
        expect(body.error).toMatch(/request a new code/i);
    });
});

describe("POST /api/auth/otp/issue IP bucketing", () => {
    it("on Vercel, rotating x-forwarded-for does not escape the 5/day issue cap", async () => {
        process.env.VERCEL = "1";
        for (let i = 0; i < 5; i++) {
            const res = await issuePOST(
                req({ email: "a@nyu.edu" }, { "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": `10.0.0.${i}` }),
            );
            expect(res.status).toBe(200);
        }
        const blocked = await issuePOST(
            req({ email: "a@nyu.edu" }, { "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "10.0.0.99" }),
        );
        expect(blocked.status).toBe(429);
        expect(issueOtp).toHaveBeenCalledTimes(5);
    });
});
