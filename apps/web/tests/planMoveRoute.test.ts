// ============================================================
// /api/plan/move (Phase 17 Task B) — route tests
// ============================================================
// CRITICAL: this suite asserts the load-bearing fix the Task A spec
// reviewer flagged.
//
// At the helper layer, the `move` mutation kind only writes the
// fromTerm exclusion; the toTerm placement is the route layer's
// responsibility. The move route composes a 2-mutation batch
// `[move, pin(toTerm, freeze: true)]` so the solver re-plan
// actually relocates the course (not just drops it).
//
// The CRITICAL assertion below verifies that after the route
// returns, the proposed `forwardSchedule.semesters[<toTerm>].slots`
// CONTAINS the courseId. Without the route-layer pin composition,
// the course would vanish from BOTH terms (excluded everywhere).
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
import type { ForwardSchedule } from "@nyupath/shared";

describe("/api/plan/move (Phase 17 Task B)", () => {
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
        const { POST } = await import("../app/api/plan/move/route");
        const res = await POST(fakeRequest(undefined, { courseId: "CSCI-UA 101", fromTerm: "2026-fall", toTerm: "2027-spring" }) as never);
        expect(res.status).toBe(401);
    });

    it("returns 400 when fromTerm === toTerm (no-op gesture)", async () => {
        const studentId = "move_no_op";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/move/route");
        const res = await POST(fakeRequest(token, {
            courseId: "CSCI-UA 101",
            fromTerm: "2026-fall",
            toTerm: "2026-fall",
        }) as never);
        expect(res.status).toBe(400);
    });

    it("returns 400 when the body is missing required fields", async () => {
        const studentId = "move_missing_fields";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/move/route");
        const res = await POST(fakeRequest(token, { courseId: "CSCI-UA 101", fromTerm: "2026-fall" /* no toTerm */ }) as never);
        expect(res.status).toBe(400);
    });

    // ------------------------------------------------------------------
    // CRITICAL — the load-bearing assertion the Task A spec reviewer
    // requested. After the route returns, the proposed
    // forwardSchedule MUST contain the courseId in the toTerm
    // semesters[].slots. The composed [move, pin(toTerm, freeze=true)]
    // batch is what makes this true.
    // ------------------------------------------------------------------
    it("CRITICAL: course actually lands in toTerm semesters[].slots after route returns (load-bearing fix)", async () => {
        const studentId = "move_critical_assert";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/move/route");
        const res = await POST(fakeRequest(token, {
            courseId: "CSCI-UA 101",
            fromTerm: "2026-fall",
            toTerm: "2027-spring",
        }) as never);

        expect(res.status).toBe(200);
        const json = await res.json();

        // 1. The response carries a proposed forwardSchedule (the
        //    clone-session simulation produced one).
        expect(json.forwardSchedule).toBeDefined();
        const schedule = json.forwardSchedule as ForwardSchedule;

        // 2. The toTerm semester exists in the proposed schedule.
        const toSemester = schedule.semesters.find((s) => s.term === "2027-spring");
        expect(toSemester).toBeDefined();

        // 3. THE LOAD-BEARING ASSERTION: the course IS in the toTerm's
        //    slots. Without the route's [move, pin] composition, the
        //    course would be globally excluded and absent from both
        //    semesters — the regression this test guards against.
        const slotForCourse = toSemester!.slots.find(
            (sl) => "courseId" in sl && sl.courseId === "CSCI-UA 101",
        );
        expect(slotForCourse).toBeDefined();
        expect(slotForCourse!.kind).toBe("specific_planned");

        // 4. The course is NOT in the fromTerm anymore (the move
        //    exclusion did its job there).
        const fromSemester = schedule.semesters.find((s) => s.term === "2026-fall");
        if (fromSemester) {
            const stillInFromTerm = fromSemester.slots.find(
                (sl) => "courseId" in sl && sl.courseId === "CSCI-UA 101",
            );
            expect(stillInFromTerm).toBeUndefined();
        }
    });

    it("returns explanation citing course + both terms", async () => {
        const studentId = "move_explanation";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/move/route");
        const res = await POST(fakeRequest(token, {
            courseId: "CSCI-UA 101",
            fromTerm: "2026-fall",
            toTerm: "2027-spring",
        }) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        // The route layers [move, pin] — explainPlanDiff renders the
        // FIRST mutation (move) per the proposePlanChange contract.
        expect(json.explanation).toContain("CSCI-UA 101");
        expect(json.explanation).toContain("2026-fall");
        expect(json.explanation).toContain("2027-spring");
        expect(json.explanation).toMatch(/Moving/);
    });

    it("does NOT mutate the persisted schedule (Stage 1 is read-only — confirm path lives in /api/plan/confirm)", async () => {
        const studentId = "move_read_only";
        await seedStudentState(studentId);
        const { getStores } = await import("../lib/db/store");
        const stores = getStores({});
        const before = await stores.scheduleStore.loadLatestSchedule(studentId);

        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/move/route");
        await POST(fakeRequest(token, { courseId: "CSCI-UA 101", fromTerm: "2026-fall", toTerm: "2027-spring" }) as never);

        const after = await stores.scheduleStore.loadLatestSchedule(studentId);
        expect(after?.schedule.computedAt).toBe(before?.schedule.computedAt);
    });
});
