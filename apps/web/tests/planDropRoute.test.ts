// ============================================================
// /api/plan/drop (Phase 17 Task B) — route tests
// ============================================================
// Drop excludes a course from the plan, optionally scoped to a
// single term.
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

describe("/api/plan/drop (Phase 17 Task B)", () => {
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
        const { POST } = await import("../app/api/plan/drop/route");
        const res = await POST(fakeRequest(undefined, { courseId: "CSCI-UA 101" }) as never);
        expect(res.status).toBe(401);
    });

    it("returns 400 when courseId is missing", async () => {
        const studentId = "drop_missing_course";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/drop/route");
        const res = await POST(fakeRequest(token, {}) as never);
        expect(res.status).toBe(400);
    });

    it("returns 200 with explanation citing course + term on a term-scoped drop", async () => {
        const studentId = "drop_term_scoped";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/drop/route");
        const res = await POST(fakeRequest(token, {
            courseId: "CSCI-UA 101",
            term: "2026-fall",
        }) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.explanation).toContain("CSCI-UA 101");
        expect(json.explanation).toContain("2026-fall");
        expect(json.explanation).toMatch(/Dropping/);
        expect(json.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("returns 200 with explanation on a term-less global drop", async () => {
        const studentId = "drop_global";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/drop/route");
        const res = await POST(fakeRequest(token, { courseId: "CSCI-UA 101" }) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.explanation).toContain("CSCI-UA 101");
        expect(json.explanation).toMatch(/Dropping/);
    });
});
