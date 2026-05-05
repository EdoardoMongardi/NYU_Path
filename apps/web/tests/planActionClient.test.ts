// ============================================================
// Phase 17 Task C — planActionClient typed-wrapper tests
// ============================================================
// Pins the wire contract for each verb's browser-side helper:
//   (a) every verb POSTs to its expected route with the verb's body
//       shape (the route layer's Zod schema is what would reject a
//       drift in either direction),
//   (b) a 200 + JSON body round-trips into `{ok: true, data}`,
//   (c) a non-2xx + JSON `{error}` body surfaces as
//       `{ok: false, status, error}` with no exception thrown,
//   (d) a transport failure (fetch reject) becomes `{ok: false,
//       status: 0, error}` rather than bubbling the exception,
//   (e) the `Drop` wrapper omits `term` when undefined so the
//       strict-mode route schema does not reject it.
// ============================================================

import { describe, it, expect, afterEach, vi } from "vitest";
import {
    planAdd,
    planSwap,
    planDrop,
    planLock,
    planMove,
    planConfirm,
} from "../lib/planActionClient";

interface RecordedCall {
    url: string;
    init: RequestInit;
}

function installFetch(impl: (url: string, init: RequestInit) => Promise<Response>): RecordedCall[] {
    const calls: RecordedCall[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return impl(url, init);
    }) as any;
    return calls;
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
});

describe("planActionClient (Phase 17 Task C)", () => {
    // ---------- planAdd ----------
    it("planAdd POSTs the {courseId, term} body to /api/plan/add and returns the parsed payload", async () => {
        const calls = installFetch(async () => jsonResponse(200, {
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            explanation: "Locking CSCI-UA 101 to 2026-fall.",
            pendingMutationId: "11111111-2222-3333-4444-555555555555",
            futureTerms: ["2026-fall"],
        }));
        const result = await planAdd({ courseId: "CSCI-UA 101", term: "2026-fall" });
        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("/api/plan/add");
        expect(calls[0]!.init.method).toBe("POST");
        const body = JSON.parse(calls[0]!.init.body as string);
        expect(body).toEqual({ courseId: "CSCI-UA 101", term: "2026-fall" });
        if (result.ok) {
            expect(result.data.explanation).toContain("CSCI-UA 101");
            expect(result.data.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
            expect(result.data.futureTerms).toEqual(["2026-fall"]);
        }
    });

    // ---------- planSwap (single + batch) ----------
    it("planSwap (single-term) POSTs {drop, add, term} to /api/plan/swap", async () => {
        const calls = installFetch(async () => jsonResponse(200, {
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            explanation: "Swapping A → B in 2026-fall.",
            pendingMutationId: "11111111-2222-3333-4444-555555555555",
            futureTerms: ["2026-fall"],
        }));
        await planSwap({ drop: "A", add: "B", term: "2026-fall" });
        const body = JSON.parse(calls[0]!.init.body as string);
        expect(body).toEqual({ drop: "A", add: "B", term: "2026-fall" });
        expect(calls[0]!.url).toBe("/api/plan/swap");
    });

    it("planSwap (cross-term batch) POSTs {exchanges} to /api/plan/swap", async () => {
        const calls = installFetch(async () => jsonResponse(200, {
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            explanation: "Cross-term exchange.",
            pendingMutationId: "11111111-2222-3333-4444-555555555555",
            futureTerms: ["2026-fall", "2027-spring"],
        }));
        await planSwap({
            exchanges: [{
                aCourseId: "X",
                aTerm: "2026-fall",
                bCourseId: "Y",
                bTerm: "2027-spring",
            }],
        });
        const body = JSON.parse(calls[0]!.init.body as string);
        expect(body).toEqual({
            exchanges: [{
                aCourseId: "X",
                aTerm: "2026-fall",
                bCourseId: "Y",
                bTerm: "2027-spring",
            }],
        });
    });

    // ---------- planDrop ----------
    it("planDrop omits the term field entirely when undefined (strict-mode route compatibility)", async () => {
        const calls = installFetch(async () => jsonResponse(200, {
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            explanation: "Excluding CSCI-UA 480 globally.",
            pendingMutationId: "11111111-2222-3333-4444-555555555555",
            futureTerms: [],
        }));
        await planDrop({ courseId: "CSCI-UA 480" });
        const body = JSON.parse(calls[0]!.init.body as string);
        expect(body).toEqual({ courseId: "CSCI-UA 480" });
        expect("term" in body).toBe(false);
    });

    it("planDrop forwards term when present", async () => {
        const calls = installFetch(async () => jsonResponse(200, {
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            explanation: "ok",
            pendingMutationId: "11111111-2222-3333-4444-555555555555",
            futureTerms: ["2026-fall"],
        }));
        await planDrop({ courseId: "CSCI-UA 480", term: "2026-fall" });
        const body = JSON.parse(calls[0]!.init.body as string);
        expect(body).toEqual({ courseId: "CSCI-UA 480", term: "2026-fall" });
    });

    // ---------- planLock ----------
    it("planLock POSTs {courseId, term, locked} to /api/plan/lock", async () => {
        const calls = installFetch(async () => jsonResponse(200, {
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            explanation: "Locked.",
            pendingMutationId: "11111111-2222-3333-4444-555555555555",
            futureTerms: ["2026-fall"],
        }));
        await planLock({ courseId: "CSCI-UA 101", term: "2026-fall", locked: true });
        expect(calls[0]!.url).toBe("/api/plan/lock");
        const body = JSON.parse(calls[0]!.init.body as string);
        expect(body).toEqual({ courseId: "CSCI-UA 101", term: "2026-fall", locked: true });
    });

    // ---------- planMove ----------
    it("planMove POSTs {courseId, fromTerm, toTerm} to /api/plan/move", async () => {
        const calls = installFetch(async () => jsonResponse(200, {
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            explanation: "Moved.",
            pendingMutationId: "11111111-2222-3333-4444-555555555555",
            futureTerms: ["2027-spring"],
        }));
        await planMove({ courseId: "CSCI-UA 101", fromTerm: "2026-fall", toTerm: "2027-spring" });
        expect(calls[0]!.url).toBe("/api/plan/move");
        const body = JSON.parse(calls[0]!.init.body as string);
        expect(body).toEqual({
            courseId: "CSCI-UA 101",
            fromTerm: "2026-fall",
            toTerm: "2027-spring",
        });
    });

    // ---------- planConfirm ----------
    it("planConfirm POSTs {pendingMutationId} to /api/plan/confirm and returns the confirm payload", async () => {
        const calls = installFetch(async () => jsonResponse(200, {
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            storedIn: "forwardSchedule",
            consumedMutationId: "11111111-2222-3333-4444-555555555555",
        }));
        const result = await planConfirm({ pendingMutationId: "11111111-2222-3333-4444-555555555555" });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.storedIn).toBe("forwardSchedule");
            expect(result.data.consumedMutationId).toBe("11111111-2222-3333-4444-555555555555");
        }
        expect(calls[0]!.url).toBe("/api/plan/confirm");
    });

    // ---------- Error surfaces ----------
    it("returns {ok: false, status, error} on a non-2xx JSON response (does not throw)", async () => {
        installFetch(async () => jsonResponse(409, {
            error: "No persisted student profile. Onboard first via /api/onboard.",
            kind: "no_profile",
        }));
        const result = await planAdd({ courseId: "CSCI-UA 101", term: "2026-fall" });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.status).toBe(409);
            expect(result.error).toMatch(/No persisted student profile/);
            expect(result.kind).toBe("no_profile");
        }
    });

    it("returns {ok: false, status: 0, error} on a transport failure (fetch reject)", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).fetch = (async () => {
            throw new TypeError("Failed to fetch");
        }) as any;
        const result = await planAdd({ courseId: "CSCI-UA 101", term: "2026-fall" });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.status).toBe(0);
            expect(result.error).toMatch(/Failed to fetch/);
        }
    });

    it("preserves a 401 from the auth gate without inventing a kind", async () => {
        installFetch(async () => jsonResponse(401, { error: "Unauthorized" }));
        const result = await planLock({ courseId: "X", term: "2026-fall", locked: true });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.status).toBe(401);
            expect(result.error).toBe("Unauthorized");
            expect(result.kind).toBeUndefined();
        }
    });

    it("sends credentials: same-origin so the session cookie reaches the route", async () => {
        const calls = installFetch(async () => jsonResponse(200, {
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            explanation: "ok",
            pendingMutationId: "11111111-2222-3333-4444-555555555555",
            futureTerms: [],
        }));
        await planAdd({ courseId: "X", term: "2026-fall" });
        // Defensive: every call must carry the session cookie.
        expect((calls[0]!.init as RequestInit & { credentials?: string }).credentials).toBe("same-origin");
    });
});
