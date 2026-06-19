// ============================================================
// /api/plan/add (Phase 17 Task B) — route tests
// ============================================================
// Validates the plumbing contract:
//   - missing auth → 401
//   - malformed JSON / missing fields → 400
//   - rate-limit hit → 429 (separate bucket from chat)
//   - successful pin propose returns
//     { explanation, pendingMutationId, futureTerms[], forwardSchedule? }
//   - the propose is read-only — the persisted schedule is unchanged
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    fakeRequest,
    issueTestToken,
    seedStudentState,
    TEST_SECRET,
} from "./_planRouteTestUtils";
import { resetStoresForTests, getStores } from "../lib/db/store";
import { _resetPendingMutationsForTests } from "../lib/planActionOrchestrator";
import { _clearBuckets } from "../lib/rateLimit";
import {
    _PLAN_ACTION_LIMIT_PER_DAY_FOR_TESTS,
    _RATE_BUCKET_PREFIX_FOR_TESTS,
} from "../lib/planActionRouteHelpers";

describe("/api/plan/add (Phase 17 Task B)", () => {
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
        const { POST } = await import("../app/api/plan/add/route");
        const res = await POST(fakeRequest(undefined, { courseId: "CSCI-UA 101", term: "2026-fall" }) as never);
        expect(res.status).toBe(401);
    });

    it("returns 400 when the body is missing required fields", async () => {
        const studentId = "add_missing_fields";
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/add/route");
        const res = await POST(fakeRequest(token, { courseId: "CSCI-UA 101" /* no term */ }) as never);
        expect(res.status).toBe(400);
    });

    it("returns 200 with explanation + pendingMutationId + futureTerms on a successful pin propose", async () => {
        const studentId = "add_happy_path";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/add/route");
        const res = await POST(fakeRequest(token, {
            courseId: "CSCI-UA 101",
            term: "2026-fall",
        }) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(typeof json.explanation).toBe("string");
        expect(json.explanation).toContain("CSCI-UA 101");
        expect(json.explanation).toContain("2026-fall");
        // The Add verb sends freeze: true → "Locking" copy from the
        // explainPlanDiff template (the verb-vs-copy mapping is
        // intentional; see PHASE_17_PLAN.md Task B critical-context).
        expect(json.explanation).toMatch(/Locking/);
        expect(json.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(Array.isArray(json.futureTerms)).toBe(true);
    });

    it("does NOT mutate the persisted schedule (Stage 1 is read-only)", async () => {
        const studentId = "add_read_only";
        await seedStudentState(studentId);
        const stores = getStores({});
        const before = await stores.scheduleStore.loadLatestSchedule(studentId);

        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/add/route");
        await POST(fakeRequest(token, { courseId: "CSCI-UA 101", term: "2026-fall" }) as never);

        const after = await stores.scheduleStore.loadLatestSchedule(studentId);
        expect(after?.schedule.computedAt).toBe(before?.schedule.computedAt);
    });

    it("returns 429 once the per-student plan-action quota is exhausted", async () => {
        const studentId = "add_rate_limited";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/add/route");

        // Burn the quota to 0 (the test-only limit constant is
        // re-exported from planActionRouteHelpers).
        for (let i = 0; i < _PLAN_ACTION_LIMIT_PER_DAY_FOR_TESTS; i++) {
            await POST(fakeRequest(token, { courseId: "CSCI-UA 101", term: "2026-fall" }) as never);
        }
        const overflow = await POST(fakeRequest(token, { courseId: "CSCI-UA 101", term: "2026-fall" }) as never);
        expect(overflow.status).toBe(429);
    });

    it("uses a separate rate-limit bucket from chat (sanity guard against bucket-prefix typos)", () => {
        // Pure constant assertion — protects against silent renames
        // that would re-merge the chat + plan-action buckets.
        expect(_RATE_BUCKET_PREFIX_FOR_TESTS).toBe("plan-action");
    });

    // E3 — course-existence validation
    it("returns 422 when the courseId is not in the NYU catalog", async () => {
        const studentId = "add_nonexistent_course";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/add/route");
        const res = await POST(fakeRequest(token, {
            courseId: "ZZZZ-UA 9999",
            term: "2026-fall",
        }) as never);
        expect(res.status).toBe(422);
        const json = await res.json();
        expect(json.message).toMatch(/ZZZZ-UA 9999/);
        expect(json.message).toMatch(/NYU course catalog/);
    });

    it("still returns 200 for a valid catalog course after E3 (regression guard)", async () => {
        const studentId = "add_valid_course_e3";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/add/route");
        const res = await POST(fakeRequest(token, {
            courseId: "CSCI-UA 101",
            term: "2026-fall",
        }) as never);
        expect(res.status).toBe(200);
    });
});
