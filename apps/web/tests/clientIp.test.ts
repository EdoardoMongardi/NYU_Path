// ============================================================
// clientIp — rate-limit IP derivation (trusted-header model)
// ============================================================
// On Vercel (`VERCEL=1`) the platform sets `x-vercel-forwarded-for`
// and overwrites `x-forwarded-for` / `x-real-ip`, so a client can't
// pick its own bucket. Off Vercel nothing is trusted: the helper keeps
// the legacy first-XFF-hop order and the caller treats the result as a
// speed bump only.
// ============================================================

import { describe, expect, it } from "vitest";
import { clientIp } from "../lib/clientIp";

const ON_VERCEL = { VERCEL: "1" };
const OFF_VERCEL = {};

describe("clientIp", () => {
    it("on Vercel, prefers x-vercel-forwarded-for over a client-chosen x-forwarded-for", () => {
        const h = new Headers({
            "x-vercel-forwarded-for": "203.0.113.7",
            "x-forwarded-for": "198.51.100.99, 203.0.113.7",
        });
        expect(clientIp(h, ON_VERCEL)).toBe("203.0.113.7");
    });

    it("on Vercel without x-vercel-forwarded-for, falls back to the first x-forwarded-for hop", () => {
        const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
        expect(clientIp(h, ON_VERCEL)).toBe("203.0.113.7");
    });

    it("off Vercel, ignores a client-supplied x-vercel-forwarded-for", () => {
        const h = new Headers({
            "x-vercel-forwarded-for": "192.0.2.1",
            "x-forwarded-for": "198.51.100.5",
        });
        expect(clientIp(h, OFF_VERCEL)).toBe("198.51.100.5");
    });

    it("falls back to x-real-ip when x-forwarded-for is absent", () => {
        const h = new Headers({ "x-real-ip": " 198.51.100.8 " });
        expect(clientIp(h, OFF_VERCEL)).toBe("198.51.100.8");
    });

    it("returns 'anonymous' when no IP header is present", () => {
        expect(clientIp(new Headers(), OFF_VERCEL)).toBe("anonymous");
        expect(clientIp(new Headers(), ON_VERCEL)).toBe("anonymous");
    });

    it("treats an empty first hop as missing", () => {
        const h = new Headers({ "x-forwarded-for": " , 10.0.0.1", "x-real-ip": "198.51.100.8" });
        expect(clientIp(h, OFF_VERCEL)).toBe("198.51.100.8");
    });
});
