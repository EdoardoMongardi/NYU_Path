// ============================================================
// H1.1 — scheduleDiff.test.ts
//
// TDD: RED first (import the module before it exists), then GREEN
// once scheduleDiff.ts is written.
//
// Uses the same fixture helpers as the plan-route test suites.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    makeFeasibleScheduleWithSemesters,
    specificSlot,
} from "./_planRouteTestUtils";
import { diffSchedules } from "../lib/scenarios/scheduleDiff";

const S = "student-a";

// ---------------------------------------------------------------------------
// Helper: collect all DiffRows from a column (flat)
// ---------------------------------------------------------------------------
function flatRows(col: ReturnType<typeof diffSchedules>["base"]) {
    return col.terms.flatMap((t) => t.rows);
}

// ---------------------------------------------------------------------------
// 1. same — identical schedules
// ---------------------------------------------------------------------------
describe("diffSchedules — same", () => {
    it("identical schedules: every row is 'same' in both columns", () => {
        const sems = [
            { term: "2026-fall", slots: [specificSlot("CSCI-UA 101"), specificSlot("CSCI-UA 102")] },
            { term: "2027-spring", slots: [specificSlot("MATH-UA 121")] },
        ];
        const base = makeFeasibleScheduleWithSemesters(S, sems);
        const other = makeFeasibleScheduleWithSemesters(S, sems);

        const diff = diffSchedules(base, other);

        for (const row of flatRows(diff.base)) {
            expect(row.diff).toBe("same");
        }
        for (const row of flatRows(diff.other)) {
            expect(row.diff).toBe("same");
        }
    });

    it("empty schedules: no rows in either column", () => {
        const base = makeFeasibleScheduleWithSemesters(S, []);
        const other = makeFeasibleScheduleWithSemesters(S, []);

        const diff = diffSchedules(base, other);

        expect(flatRows(diff.base)).toHaveLength(0);
        expect(flatRows(diff.other)).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// 2. added — other has a course base lacks
// ---------------------------------------------------------------------------
describe("diffSchedules — added", () => {
    it("extra course in other→ that row is 'added' in other; base unaffected", () => {
        // Use course ids without leading zeros so canonical form = input form.
        const sharedSlot = specificSlot("CSCI-UA 101");
        const extraSlot = specificSlot("CSCI-UA 102");

        const base = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [sharedSlot] },
        ]);
        const other = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [sharedSlot, extraSlot] },
        ]);

        const diff = diffSchedules(base, other);

        // base column: only the shared course, marked same
        const baseRows = flatRows(diff.base);
        expect(baseRows).toHaveLength(1);
        expect(baseRows[0].courseId).toContain("CSCI-UA");
        expect(baseRows[0].diff).toBe("same");

        // other column: shared=same, extra=added
        const otherRows = flatRows(diff.other);
        expect(otherRows).toHaveLength(2);
        const addedRow = otherRows.find((r) => r.courseId.includes("102"));
        expect(addedRow).toBeDefined();
        expect(addedRow!.diff).toBe("added");

        const sameRow = otherRows.find((r) => r.courseId.includes("101"));
        expect(sameRow).toBeDefined();
        expect(sameRow!.diff).toBe("same");
    });
});

// ---------------------------------------------------------------------------
// 3. removed — base has a course other lacks
// ---------------------------------------------------------------------------
describe("diffSchedules — removed", () => {
    it("course in base but not other → row is 'removed' in base", () => {
        const removedSlot = specificSlot("CSCI-UA 201");
        const sharedSlot = specificSlot("MATH-UA 121");

        const base = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [sharedSlot, removedSlot] },
        ]);
        const other = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [sharedSlot] },
        ]);

        const diff = diffSchedules(base, other);

        const baseRows = flatRows(diff.base);
        const removedRow = baseRows.find((r) => r.courseId.includes("201"));
        expect(removedRow).toBeDefined();
        expect(removedRow!.diff).toBe("removed");

        const sharedRow = baseRows.find((r) => r.courseId.includes("121"));
        expect(sharedRow!.diff).toBe("same");

        // other column: only the shared course
        const otherRows = flatRows(diff.other);
        expect(otherRows).toHaveLength(1);
        expect(otherRows[0].diff).toBe("same");
    });
});

// ---------------------------------------------------------------------------
// 4. moved — course in both schedules but different terms
//    A course that shifts to an EARLIER term (base=fall, other=earlier spring
//    of the SAME year) is a pure forward re-scheduling, not a retake.
//    The retake heuristic only fires when ordinal(other) > ordinal(base).
// ---------------------------------------------------------------------------
describe("diffSchedules — moved", () => {
    it("course moved to an earlier term (fall→spring of same year) stays 'moved' in both", () => {
        // base has the course in 2027-fall; other has it in 2027-spring (earlier).
        // ordinal(2027-fall) = 20272, ordinal(2027-spring) = 20270 → other < base → no retake.
        const movedSlot = specificSlot("CSCI-UA 301");
        const baseFixed = specificSlot("MATH-UA 234");

        const base = makeFeasibleScheduleWithSemesters(S, [
            { term: "2027-spring", slots: [baseFixed] },
            { term: "2027-fall", slots: [movedSlot] },
        ]);
        const other = makeFeasibleScheduleWithSemesters(S, [
            { term: "2027-spring", slots: [movedSlot, baseFixed] },
            { term: "2027-fall", slots: [] },
        ]);

        const diff = diffSchedules(base, other);

        // In the other column the moved course is in 2027-spring with diff="moved"
        const otherSpring = diff.other.terms.find((t) => t.term === "2027-spring");
        expect(otherSpring).toBeDefined();
        const movedRow = otherSpring!.rows.find((r) => r.courseId.includes("301"));
        expect(movedRow).toBeDefined();
        expect(movedRow!.diff).toBe("moved");

        // In the base column the same course is also marked "moved" (consistent marking)
        const baseFall = diff.base.terms.find((t) => t.term === "2027-fall");
        expect(baseFall).toBeDefined();
        const baseMoved = baseFall!.rows.find((r) => r.courseId.includes("301"));
        expect(baseMoved).toBeDefined();
        expect(baseMoved!.diff).toBe("moved");
    });
});

// ---------------------------------------------------------------------------
// 5. retake — base has CourseX in Fall; other drops it from Fall AND has it in a later Spring
// ---------------------------------------------------------------------------
describe("diffSchedules — retake", () => {
    it("course dropped from base term and re-appears in a later other term → retake", () => {
        const retakeSlot = specificSlot("CSCI-UA 4");
        const unrelatedSlot = specificSlot("MATH-UA 121");

        // base: CSCI-UA 4 in 2026-fall (normal planned slot)
        const base = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [retakeSlot, unrelatedSlot] },
            { term: "2027-spring", slots: [] },
        ]);

        // other: CSCI-UA 4 is ABSENT from 2026-fall, but re-appears in 2027-spring
        const other = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [unrelatedSlot] },
            { term: "2027-spring", slots: [retakeSlot] },
        ]);

        const diff = diffSchedules(base, other);

        // base 2026-fall: CSCI-UA 4 should be "removed" (it was dropped from this term)
        const baseFall = diff.base.terms.find((t) => t.term === "2026-fall");
        expect(baseFall).toBeDefined();
        const baseRetakeRow = baseFall!.rows.find((r) => r.courseId.includes("CSCI-UA 4"));
        expect(baseRetakeRow).toBeDefined();
        expect(baseRetakeRow!.diff).toBe("removed");

        // other 2027-spring: CSCI-UA 4 should be "retake" (not plain "added")
        const otherSpring = diff.other.terms.find((t) => t.term === "2027-spring");
        expect(otherSpring).toBeDefined();
        const retakeRow = otherSpring!.rows.find((r) => r.courseId.includes("CSCI-UA 4"));
        expect(retakeRow).toBeDefined();
        expect(retakeRow!.diff).toBe("retake");
    });

    it("J-term ordering: dropped from a january term, retaken the FOLLOWING spring → retake", () => {
        // Engine SEASON_ORD convention: "YYYY-january" follows "YYYY-fall" and
        // precedes "(YYYY+1)-spring". So 2027-january (20273) < 2028-spring (20280)
        // → the spring retake is LATER → "retake". (The earlier +1-year-rollover
        // bug computed 2027-january as 20283 > 2028-spring 20280 → wrongly "moved".)
        const jSlot = specificSlot("CSCI-UA 7");
        const unrelated = specificSlot("MATH-UA 121");
        const base = makeFeasibleScheduleWithSemesters(S, [
            { term: "2027-january", slots: [jSlot, unrelated] },
            { term: "2028-spring", slots: [] },
        ]);
        const other = makeFeasibleScheduleWithSemesters(S, [
            { term: "2027-january", slots: [unrelated] },
            { term: "2028-spring", slots: [jSlot] },
        ]);
        const diff = diffSchedules(base, other);
        const baseJan = diff.base.terms.find((t) => t.term === "2027-january");
        expect(baseJan!.rows.find((r) => r.courseId.includes("CSCI-UA 7"))!.diff).toBe("removed");
        const otherSpring = diff.other.terms.find((t) => t.term === "2028-spring");
        expect(otherSpring!.rows.find((r) => r.courseId.includes("CSCI-UA 7"))!.diff).toBe("retake");
    });

    it("course added fresh in a later term (not in base at all) → plain 'added', not retake", () => {
        const freshSlot = specificSlot("CSCI-UA 999");
        const sharedSlot = specificSlot("MATH-UA 121");

        const base = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [sharedSlot] },
        ]);
        const other = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [sharedSlot] },
            { term: "2027-spring", slots: [freshSlot] },
        ]);

        const diff = diffSchedules(base, other);

        const otherSpring = diff.other.terms.find((t) => t.term === "2027-spring");
        expect(otherSpring).toBeDefined();
        const freshRow = otherSpring!.rows.find((r) => r.courseId.includes("999"));
        expect(freshRow).toBeDefined();
        // CSCI-UA 999 was NEVER in base → it's "added", not "retake"
        expect(freshRow!.diff).toBe("added");
    });
});

// ---------------------------------------------------------------------------
// 6. Structure: column terms preserve schedule ordering
// ---------------------------------------------------------------------------
describe("diffSchedules — structural", () => {
    it("base and other columns each emit terms in schedule order", () => {
        const s1 = specificSlot("CSCI-UA 101");
        const s2 = specificSlot("CSCI-UA 102");

        const base = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [s1] },
            { term: "2027-spring", slots: [s2] },
        ]);
        const other = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [s1] },
            { term: "2027-spring", slots: [s2] },
        ]);

        const diff = diffSchedules(base, other);

        const baseTerms = diff.base.terms.map((t) => t.term);
        expect(baseTerms).toEqual(["2026-fall", "2027-spring"]);

        const otherTerms = diff.other.terms.map((t) => t.term);
        expect(otherTerms).toEqual(["2026-fall", "2027-spring"]);
    });

    it("a term present in other but absent in base still appears in other column", () => {
        const s1 = specificSlot("CSCI-UA 101");
        const s2 = specificSlot("CSCI-UA 201");

        const base = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [s1] },
        ]);
        const other = makeFeasibleScheduleWithSemesters(S, [
            { term: "2026-fall", slots: [s1] },
            { term: "2027-spring", slots: [s2] },
        ]);

        const diff = diffSchedules(base, other);

        const otherTermNames = diff.other.terms.map((t) => t.term);
        expect(otherTermNames).toContain("2027-spring");

        const addedRow = diff.other.terms
            .find((t) => t.term === "2027-spring")!
            .rows.find((r) => r.courseId.includes("201"));
        expect(addedRow?.diff).toBe("added");
    });
});
