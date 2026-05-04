/**
 * Phase 14 Task 6 — bind_free_elective tool tests.
 *
 * Test contract (8 cases + isReadOnly assertion):
 *  1. Easy course bind → no warning, balance "negligible" or "improved"
 *  2. W-suffix course → mild warning
 *  3. Advanced capstone (≥3 prereq groups, ≥4000 course#) → strong warning
 *  4. Invalid courseId → reject with unknown_course
 *  5. Course not offered in slot's term → offering_mismatch
 *  6. Prereqs not satisfied → prereq_unsatisfied
 *  7. Duplicate (already bound elsewhere) → duplicate_courseId
 *  8. isReadOnly:true assertion
 */

import { describe, it, expect } from "vitest";
import { bindFreeElectiveTool } from "../../src/agent/tools/bindFreeElective.js";
import type { ToolSession, ToolUseContext } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type {
    ForwardSchedule,
    Course,
    Prerequisite,
    ScheduleSlotPlaceholder,
    ScheduleSlotSpecificPlanned,
    ForwardSemester,
    SlotRationale,
    SlotFlexibility,
    DownstreamImpact,
} from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:test",
        sourcePdfPageCount: 1,
        parseDurationMs: 0,
        warnings: [],
    };
}

function makeDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 96,
            cumulativeGpa: 3.4,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 4,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [],
        ...overrides,
    };
}

const baseRationale: SlotRationale = {
    satisfiesRequirements: [],
    termConstraints: [],
    consideredAlternatives: [],
    decisionsApplied: [],
};

const baseFlexibility: SlotFlexibility = {
    earliestPossibleTerm: "2026-fall",
    latestPossibleTerm: "2027-spring",
    alternativeCourses: [],
};

const baseDownstream: DownstreamImpact = {
    courseIds: [],
    graduationDelay: 0,
};

/** A minimal free-credit placeholder slot (no poolBinding). */
function makeFreeSlot(overrides: Partial<ScheduleSlotPlaceholder> = {}): ScheduleSlotPlaceholder {
    return {
        kind: "placeholder",
        category: "Free Elective",
        credits: 4,
        satisfiesRules: [],
        optional: true,
        reason: "Free elective credit placeholder",
        rationale: baseRationale,
        flexibility: baseFlexibility,
        downstreamImpact: baseDownstream,
        workloadTier: "free-elective",
        workloadWeight: 0.3,    // Decision #37 default
        bindingState: "placeholder-pending",
        placeholderId: "free-slot-1",
        confidence: "high",
        isCriticalPath: false,
        ...overrides,
    };
}

function makeSemesterWithFreeSlot(
    term: string,
    slotOverrides: Partial<ScheduleSlotPlaceholder> = {},
): ForwardSemester {
    return {
        term,
        locked: false,
        slots: [makeFreeSlot(slotOverrides)],
        plannedCredits: 4,
        notes: [],
        loadRationale: {
            loadStyle: "balanced",
            hardCount: 0,
            easyCount: 1,
            weightedCredits: 0.3,
            note: "free elective placeholder",
        },
    };
}

function makeSemesterWithBoundCourse(term: string, courseId: string): ForwardSemester {
    const slot: ScheduleSlotSpecificPlanned = {
        kind: "specific_planned",
        courseId,
        title: "Already Bound Course",
        credits: 4,
        satisfiesRules: [],
        reason: "bound",
        rationale: baseRationale,
        flexibility: baseFlexibility,
        downstreamImpact: baseDownstream,
        workloadTier: "free-elective",
        workloadWeight: 0.5,
        bindingState: "bound",
        confidence: "high",
        isCriticalPath: false,
    };
    return {
        term,
        locked: false,
        slots: [slot],
        plannedCredits: 4,
        notes: [],
        loadRationale: {
            loadStyle: "balanced",
            hardCount: 0,
            easyCount: 1,
            weightedCredits: 0.5,
            note: "bound",
        },
    };
}

function makeSchedule(overrides: Partial<ForwardSchedule> = {}): ForwardSchedule {
    return {
        studentId: "test-student",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        // creditsUsed in DPR = 96 + 4 planned = 100.
        // Set minimum to 100 so the validator doesn't fail on "total credits" axis
        // when testing binding logic (not credit-minimum logic).
        graduationCreditMinimum: 100,
        degreeCreditsMet: true,
        semesters: [makeSemesterWithFreeSlot("2026-fall")],
        dprCourseHistoryHash: "test-hash",
        computedAt: Date.now(),
        feasibility: {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
        ...overrides,
    };
}

/** Easy 2000-level course offered fall + spring. */
const easyCourse: Course = {
    id: "HUMA-UA 1000",
    title: "Introduction to Humanities",
    credits: 4,
    departments: ["HUMA-UA"],
    crossListed: [],
    exclusions: [],
    termsOffered: ["fall", "spring"],
    catalogYearsActive: ["2020-2021", "2027-2028"],
};

/** W-suffix course (writing intensive). */
const writingCourse: Course = {
    id: "ENGL-UA 1200W",
    title: "Advanced Composition",
    credits: 4,
    departments: ["ENGL-UA"],
    crossListed: [],
    exclusions: [],
    termsOffered: ["fall", "spring"],
    catalogYearsActive: ["2020-2021", "2027-2028"],
};

/** Advanced capstone: ≥4000 course number, will have ≥3 prereq groups. */
const capstoneCourse: Course = {
    id: "CSCI-UA 4998",
    title: "Undergraduate Research Capstone",
    credits: 4,
    departments: ["CSCI-UA"],
    crossListed: [],
    exclusions: [],
    termsOffered: ["fall", "spring"],
    catalogYearsActive: ["2020-2021", "2027-2028"],
};

/** Course only offered in spring (not fall). */
const springOnlyCourse: Course = {
    id: "BIOL-UA 2200",
    title: "Spring Biology",
    credits: 4,
    departments: ["BIOL-UA"],
    crossListed: [],
    exclusions: [],
    termsOffered: ["spring"],
    catalogYearsActive: ["2020-2021", "2027-2028"],
};

/** Course with prereq: CSCI-UA 101 must be taken first. */
const prereqCourse: Course = {
    id: "CSCI-UA 201",
    title: "Computer Systems Organization",
    credits: 4,
    departments: ["CSCI-UA"],
    crossListed: [],
    exclusions: [],
    termsOffered: ["fall", "spring"],
    catalogYearsActive: ["2020-2021", "2027-2028"],
};

const prereqEntry: Prerequisite = {
    course: "CSCI-UA 201",
    prereqGroups: [
        { type: "AND", courses: ["CSCI-UA 101"] },
    ],
    coreqs: [],
};

const capstonePrerqEntry: Prerequisite = {
    course: "CSCI-UA 4998",
    prereqGroups: [
        { type: "AND", courses: ["CSCI-UA 101"] },
        { type: "AND", courses: ["CSCI-UA 201"] },
        { type: "AND", courses: ["CSCI-UA 310"] },
    ],
    coreqs: [],
};

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
    return {
        student: {
            id: "test-student",
            catalogYear: "2024",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "major" }],
            coursesTaken: [],
            visaStatus: "domestic",
        },
        schoolConfig: {
            schoolId: "cas",
            name: "College of Arts and Science",
            degreeType: "BA",
            courseSuffix: ["-UA"],
            totalCreditsRequired: 128,
            overallGpaMin: 2.0,
            acceptsTransferCredit: true,
            maxCreditsPerSemester: 18,
            f1FullTimeMinCredits: 12,
            residency: { minCredits: 64, note: null },
        },
        degreeProgressReport: makeDpr(),
        forwardSchedule: makeSchedule(),
        courses: [easyCourse, writingCourse, capstoneCourse, springOnlyCourse, prereqCourse],
        prereqs: [prereqEntry, capstonePrerqEntry],
        ...overrides,
    };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return { signal: new AbortController().signal, session };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Case 8: isReadOnly assertion (test it first so registration errors surface early)
describe("bind_free_elective — isReadOnly contract", () => {
    it("isReadOnly is true", () => {
        expect(bindFreeElectiveTool.isReadOnly).toBe(true);
    });
});

// Case 1: Easy course bind → no warning
describe("bind_free_elective — easy course bind", () => {
    it("returns feasible=true, warningLevel=none for a simple elective", async () => {
        const session = makeSession();
        const output = await bindFreeElectiveTool.call(
            { slotId: "free-slot-1", courseId: "HUMA-UA 1000" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(true);
        expect(output.warningLevel).toBe("none");
        expect(output.conflicts).toBeUndefined();
        expect(output.diff.added).toHaveLength(1);
        expect(output.diff.removed).toHaveLength(1);
        // Balance impact on an empty semesters plan should be negligible
        expect(output.consequences.some((c) => /balance/i.test(c))).toBe(true);
    });
});

// Case 2: W-suffix course → mild warning (weight delta from W modifier +0.2)
describe("bind_free_elective — W-suffix course triggers mild warning", () => {
    it("returns warningLevel=mild for a writing-intensive course", async () => {
        const session = makeSession();
        const output = await bindFreeElectiveTool.call(
            { slotId: "free-slot-1", courseId: "ENGL-UA 1200W" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(true);
        // W modifier = +0.2 from base 0.5 (free-elective) → weight 0.7 vs slot weight 0.3
        // Delta = 0.4 > 0.2 → mild
        expect(output.warningLevel).toBe("mild");
    });
});

// Case 3: Advanced capstone → mild/strong warning (≥4000 course number + ≥3 prereq groups)
// Prerequisites are satisfied via DPR requirementGroups.coursesUsed for this test.
describe("bind_free_elective — advanced capstone triggers mild or strong warning", () => {
    it("returns warningLevel=mild or strong for a capstone course with high weight", async () => {
        // Prereqs satisfied via requirementGroups.coursesUsed (Step 1 of isPrereqSatisfied).
        // This is the DPR-canonical path: registrar recorded the course in coursesUsed[].
        const dpr = makeDpr({
            requirementGroups: [
                {
                    rId: "R-CSCI101",
                    title: "Intro to CS",
                    type: "must_take" as const,
                    status: "complete" as const,
                    required: 1,
                    completed: 1,
                    coursesUsed: [
                        { subject: "CSCI-UA", catalogNbr: "101", term: "2024 Fall", grade: "A", type: "EN" as const, units: 4 },
                    ],
                    children: [],
                },
                {
                    rId: "R-CSCI201",
                    title: "Systems Org",
                    type: "must_take" as const,
                    status: "complete" as const,
                    required: 1,
                    completed: 1,
                    coursesUsed: [
                        { subject: "CSCI-UA", catalogNbr: "201", term: "2025 Spr", grade: "A", type: "EN" as const, units: 4 },
                    ],
                    children: [],
                },
                {
                    rId: "R-CSCI310",
                    title: "Basic Algorithms",
                    type: "must_take" as const,
                    status: "complete" as const,
                    required: 1,
                    completed: 1,
                    coursesUsed: [
                        { subject: "CSCI-UA", catalogNbr: "310", term: "2025 Fall", grade: "B+", type: "EN" as const, units: 4 },
                    ],
                    children: [],
                },
            ],
        });
        const session = makeSession({ degreeProgressReport: dpr });
        const output = await bindFreeElectiveTool.call(
            { slotId: "free-slot-1", courseId: "CSCI-UA 4998" },
            makeCtx(session),
        );
        // Weight = free-elective base (0.5) + advanced-level (+0.2) + capstone/3-groups (+0.2) = 0.9
        // Delta vs slot weight (0.3) = 0.6 > 0.2 → at least mild warning
        expect(output.feasible).toBe(true);
        expect(["mild", "strong"]).toContain(output.warningLevel);
        expect(output.warningLevel).not.toBe("none");
    });
});

// Case 4: Invalid courseId → unknown_course
describe("bind_free_elective — invalid courseId", () => {
    it("returns feasible=false with conflict kind=unknown_course", async () => {
        const session = makeSession();
        const output = await bindFreeElectiveTool.call(
            { slotId: "free-slot-1", courseId: "NONEXISTENT-UA 9999" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts).toBeDefined();
        expect(output.conflicts!.some((c) => c.kind === "unknown_course")).toBe(true);
        expect(output.warningLevel).toBe("strong");
    });
});

// Case 5: Course not offered in slot's term → offering_mismatch
describe("bind_free_elective — course not offered in slot term", () => {
    it("returns feasible=false with conflict kind=offering_mismatch", async () => {
        // Free slot is in "2026-fall"; springOnlyCourse only offered in spring
        const session = makeSession();
        const output = await bindFreeElectiveTool.call(
            { slotId: "free-slot-1", courseId: "BIOL-UA 2200" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "offering_mismatch")).toBe(true);
        expect(output.warningLevel).toBe("strong");
    });
});

// Case 6: Prereqs not satisfied → prereq_unsatisfied
describe("bind_free_elective — prereqs not satisfied", () => {
    it("returns feasible=false with conflict kind=prereq_unsatisfied", async () => {
        // prereqCourse (CSCI-UA 201) requires CSCI-UA 101, which student has NOT taken
        const session = makeSession({
            degreeProgressReport: makeDpr(), // empty courseHistory → CSCI-UA 101 not satisfied
        });
        const output = await bindFreeElectiveTool.call(
            { slotId: "free-slot-1", courseId: "CSCI-UA 201" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "prereq_unsatisfied")).toBe(true);
        expect(output.warningLevel).toBe("strong");
    });
});

// Case 7: Duplicate — course already bound elsewhere → duplicate_courseId
describe("bind_free_elective — course already bound elsewhere", () => {
    it("returns feasible=false with conflict kind=duplicate_courseId", async () => {
        // Schedule has HUMA-UA 1000 already bound in 2026-spring
        const schedule = makeSchedule({
            semesters: [
                makeSemesterWithFreeSlot("2026-fall"),
                makeSemesterWithBoundCourse("2026-spring", "HUMA-UA 1000"),
            ],
        });
        const session = makeSession({ forwardSchedule: schedule });
        const output = await bindFreeElectiveTool.call(
            { slotId: "free-slot-1", courseId: "HUMA-UA 1000" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "duplicate_courseId")).toBe(true);
        expect(output.warningLevel).toBe("strong");
    });
});

// Additional: slot not found
describe("bind_free_elective — non-existent slot", () => {
    it("returns feasible=false with conflict kind=unknown_slot", async () => {
        const session = makeSession();
        const output = await bindFreeElectiveTool.call(
            { slotId: "nonexistent-slot-999", courseId: "HUMA-UA 1000" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "unknown_slot")).toBe(true);
    });
});

// Additional: pool slot cannot be bound via bind_free_elective
describe("bind_free_elective — pool slot rejected (wrong kind)", () => {
    it("returns feasible=false with conflict kind=wrong_slot_kind when slot has poolBinding", async () => {
        const poolSlot: ScheduleSlotPlaceholder = {
            ...makeFreeSlot({ placeholderId: "pool-slot-1" }),
            poolBinding: {
                poolId: "CS_POOL",
                candidates: ["CSCI-UA 480"],
                satisfiesRule: "CS_ELECTIVE_RULE",
            },
        };
        const schedule = makeSchedule({
            semesters: [{
                term: "2026-fall",
                locked: false,
                slots: [poolSlot],
                plannedCredits: 4,
                notes: [],
                loadRationale: {
                    loadStyle: "balanced",
                    hardCount: 0,
                    easyCount: 1,
                    weightedCredits: 0.3,
                    note: "pool",
                },
            }],
        });
        const session = makeSession({ forwardSchedule: schedule });
        const output = await bindFreeElectiveTool.call(
            { slotId: "pool-slot-1", courseId: "HUMA-UA 1000" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "wrong_slot_kind")).toBe(true);
    });
});

// Verify validateInput rejects when no forwardSchedule
describe("bind_free_elective — validateInput rejects without forwardSchedule", () => {
    it("returns ok:false when no forwardSchedule", async () => {
        const session = makeSession({ forwardSchedule: undefined });
        const result = await bindFreeElectiveTool.validateInput!(
            { slotId: "free-slot-1", courseId: "HUMA-UA 1000" },
            makeCtx(session),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.userMessage).toMatch(/no forward plan/i);
    });
});
