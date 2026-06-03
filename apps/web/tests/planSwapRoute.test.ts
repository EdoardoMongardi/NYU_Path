// ============================================================
// /api/plan/swap (Phase 17 Task B) — route tests
// ============================================================
// Covers BOTH discriminated body shapes:
//   - single-term swap: `{drop, add, term}` →
//       `[{kind: "swap", drop, add, term}]`
//   - cross-term exchange: `{exchanges: [...]}` →
//       `[{kind: "swap", drop: a, add: b, term: aTerm},
//         {kind: "swap", drop: b, add: a, term: bTerm}]` (atomic batch)
//
// The Phase 14 multi-mutation atomic apply prevents the cross-term
// 2-swap batch from tripping the duplicate-pin false-rejection guard.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    fakeRequest,
    issueTestToken,
    seedStudentState,
    TEST_SECRET,
} from "./_planRouteTestUtils";
import { resetStoresForTests } from "../lib/db/store";
import { _resetPendingMutationsForTests } from "../lib/planActionOrchestrator";
import { _clearBuckets } from "../lib/rateLimit";

describe("/api/plan/swap (Phase 17 Task B)", () => {
    const ORIGINAL_SECRET = process.env.SECRET_KEY;
    const ORIGINAL_DB_URL = process.env.DATABASE_URL;

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        process.env.SECRET_KEY = TEST_SECRET;
        resetStoresForTests();
        _resetPendingMutationsForTests();
        _clearBuckets();
    });
    afterEach(() => {
        if (ORIGINAL_SECRET === undefined) delete process.env.SECRET_KEY;
        else process.env.SECRET_KEY = ORIGINAL_SECRET;
        if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = ORIGINAL_DB_URL;
        resetStoresForTests();
        _resetPendingMutationsForTests();
        _clearBuckets();
    });

    it("returns 401 when the request has no session cookie", async () => {
        const { POST } = await import("../app/api/plan/swap/route");
        const res = await POST(fakeRequest(undefined, { drop: "X", add: "Y", term: "2026-fall" }) as never);
        expect(res.status).toBe(401);
    });

    it("returns 400 when neither shape (single-term nor cross-term) matches", async () => {
        const studentId = "swap_bad_shape";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/swap/route");
        const res = await POST(fakeRequest(token, { drop: "X" /* missing add + term */ }) as never);
        expect(res.status).toBe(400);
    });

    it("returns 400 when body mixes single-term AND cross-term fields (May 2026 review fix)", async () => {
        // Defensive against malformed clients: a body containing BOTH
        // {drop, add, term} AND {exchanges} would silently match the
        // single-term branch and skip cross-term. The schema's `.refine`
        // rejects mixed bodies at validation time.
        const studentId = "swap_mixed_shape";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/swap/route");
        const res = await POST(fakeRequest(token, {
            drop: "CSCI-UA 421",
            add: "CSCI-UA 480",
            term: "2026-fall",
            exchanges: [{ aCourseId: "X", aTerm: "2026-fall", bCourseId: "Y", bTerm: "2027-spring" }],
        }) as never);
        expect(res.status).toBe(400);
    });

    describe("single-term swap shape", () => {
        it("returns 200 with explanation citing both course codes + the term", async () => {
            const studentId = "swap_single_term";
            await seedStudentState(studentId);
            const token = await issueTestToken(studentId);
            const { POST } = await import("../app/api/plan/swap/route");
            const res = await POST(fakeRequest(token, {
                drop: "CSCI-UA 102",
                add: "CSCI-UA 101",
                term: "2026-fall",
            }) as never);
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.explanation).toContain("CSCI-UA 102");
            expect(json.explanation).toContain("CSCI-UA 101");
            expect(json.explanation).toContain("2026-fall");
            expect(json.explanation).toMatch(/Swapping/);
            expect(json.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
        });
    });

    describe("cross-term exchange shape", () => {
        it("accepts the {exchanges: [...]} shape and returns a 200 outcome", async () => {
            const studentId = "swap_cross_term";
            await seedStudentState(studentId);
            const token = await issueTestToken(studentId);
            const { POST } = await import("../app/api/plan/swap/route");
            const res = await POST(fakeRequest(token, {
                exchanges: [
                    {
                        aCourseId: "CSCI-UA 102",
                        aTerm: "2026-fall",
                        bCourseId: "CSCI-UA 101",
                        bTerm: "2027-spring",
                    },
                ],
            }) as never);
            expect(res.status).toBe(200);
            const json = await res.json();
            // The headline mutation rendered by explainPlanDiff is the
            // FIRST swap in the batch (a → b in aTerm).
            expect(json.explanation).toContain("CSCI-UA 102");
            expect(json.explanation).toContain("CSCI-UA 101");
            expect(json.explanation).toContain("2026-fall");
            expect(json.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
        });

        it("returns 400 when exchanges is empty", async () => {
            const studentId = "swap_empty_exchanges";
            await seedStudentState(studentId);
            const token = await issueTestToken(studentId);
            const { POST } = await import("../app/api/plan/swap/route");
            const res = await POST(fakeRequest(token, { exchanges: [] }) as never);
            expect(res.status).toBe(400);
        });
    });

    it("does NOT mutate the persisted schedule (Stage 1 is read-only)", async () => {
        const studentId = "swap_read_only";
        await seedStudentState(studentId);
        const { getStores } = await import("../lib/db/store");
        const stores = getStores({});
        const before = await stores.scheduleStore.loadLatestSchedule(studentId);

        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/swap/route");
        await POST(fakeRequest(token, { drop: "CSCI-UA 102", add: "CSCI-UA 101", term: "2026-fall" }) as never);

        const after = await stores.scheduleStore.loadLatestSchedule(studentId);
        expect(after?.schedule.computedAt).toBe(before?.schedule.computedAt);
    });
});
