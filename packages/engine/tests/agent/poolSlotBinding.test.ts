/**
 * Phase 14 Task 6 — bind_pool_slot tool tests.
 *
 * Test contract (5+ cases + isReadOnly assertion):
 *  1. courseId in pool candidates + valid prereqs → success
 *  2. courseId NOT in poolBinding.candidates → not_in_pool_candidates
 *  3. Binding violates choose_n constraint (other pool slots exhausted) → pool_constraint_violation
 *  4. Invalid courseId / non-existent slot / wrong slot kind → appropriate rejections
 *  5. isReadOnly:true assertion
 *  + prereqs_unsatisfied, offering_mismatch, duplicate_courseId
 */

import { describe, it, expect } from "vitest";
import { bindPoolSlotTool } from "../../src/agent/tools/bindPoolSlot.js";
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
    PoolBinding,
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
    satisfiesRequirements: ["CS_ELECTIVE_CHOOSE_2"],
    termConstraints: [],
    consideredAlternatives: [],
    decisionsApplied: [],
};

const baseFlexibility: SlotFlexibility = {
    earliestPossibleTerm: "2026-fall",
    latestPossibleTerm: "2027-spring",
    alternativeCourses: ["CSCI-UA 480", "CSCI-UA 490", "CSCI-UA 476"],
};

const baseDownstream: DownstreamImpact = {
    courseIds: [],
    graduationDelay: 0,
};

const csPoolBinding: PoolBinding = {
    poolId: "CS_ELECTIVE_POOL",
    candidates: ["CSCI-UA 480", "CSCI-UA 490", "CSCI-UA 476"],
    satisfiesRule: "CS_ELECTIVE_CHOOSE_2",
};

/** A minimal requirement-pool placeholder slot. */
function makePoolSlot(
    placeholderId: string,
    overrides: Partial<ScheduleSlotPlaceholder> = {},
): ScheduleSlotPlaceholder {
    return {
        kind: "placeholder",
        category: "CS Elective",
        credits: 4,
        satisfiesRules: ["CS_ELECTIVE_CHOOSE_2"],
        optional: false,
        reason: "CS elective pool slot",
        rationale: baseRationale,
        flexibility: baseFlexibility,
        downstreamImpact: baseDownstream,
        workloadTier: "major-elective",
        workloadWeight: 1.0,
        bindingState: "placeholder-pending",
        placeholderId,
        poolBinding: csPoolBinding,
        confidence: "high",
        isCriticalPath: false,
        ...overrides,
    };
}

function makePoolSemester(term: string, placeholderId: string): ForwardSemester {
    return {
        term,
        locked: false,
        slots: [makePoolSlot(placeholderId)],
        plannedCredits: 4,
        notes: [],
        loadRationale: {
            loadStyle: "balanced",
            hardCount: 1,
            easyCount: 0,
            weightedCredits: 1.0,
            note: "pool slot",
        },
    };
}

function makeTwoPoolSemestersWithSingleCandidateOverlap(): ForwardSemester[] {
    // Two pool slots from the same poolId, but the candidates lists are
    // arranged so that if we bind CSCI-UA 480 to slot-1, slot-2 still has
    // CSCI-UA 490 and CSCI-UA 476 left → constraint is OK.
    return [
        {
            term: "2026-fall",
            locked: false,
            slots: [makePoolSlot("pool-slot-1")],
            plannedCredits: 4,
            notes: [],
            loadRationale: { loadStyle: "balanced", hardCount: 1, easyCount: 0, weightedCredits: 1.0, note: "" },
        },
        {
            term: "2027-spring",
            locked: false,
            slots: [makePoolSlot("pool-slot-2")],
            plannedCredits: 4,
            notes: [],
            loadRationale: { loadStyle: "balanced", hardCount: 1, easyCount: 0, weightedCredits: 1.0, note: "" },
        },
    ];
}

function makeSingleCandidatePoolSemester(term: string, placeholderId: string, candidate: string): ForwardSemester {
    // Pool slot with only one candidate (for choose_n violation tests)
    return {
        term,
        locked: false,
        slots: [makePoolSlot(placeholderId, {
            poolBinding: {
                ...csPoolBinding,
                candidates: [candidate],
            },
        })],
        plannedCredits: 4,
        notes: [],
        loadRationale: { loadStyle: "balanced", hardCount: 1, easyCount: 0, weightedCredits: 1.0, note: "" },
    };
}

function makeBoundSemester(term: string, courseId: string): ForwardSemester {
    const slot: ScheduleSlotSpecificPlanned = {
        kind: "specific_planned",
        courseId,
        title: "Already Bound",
        credits: 4,
        satisfiesRules: ["CS_ELECTIVE_CHOOSE_2"],
        reason: "bound",
        rationale: baseRationale,
        flexibility: baseFlexibility,
        downstreamImpact: baseDownstream,
        workloadTier: "major-elective",
        workloadWeight: 1.0,
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
        loadRationale: { loadStyle: "balanced", hardCount: 1, easyCount: 0, weightedCredits: 1.0, note: "" },
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
        // Set minimum to 100 so the validator doesn't fail on "total credits" axis.
        graduationCreditMinimum: 100,
        degreeCreditsMet: true,
        semesters: [makePoolSemester("2026-fall", "pool-slot-1")],
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

// Courses
const cs480: Course = {
    id: "CSCI-UA 480",
    title: "Topics in Computer Science",
    credits: 4,
    departments: ["CSCI-UA"],
    crossListed: [],
    exclusions: [],
    termsOffered: ["fall", "spring"],
    catalogYearsActive: ["2020-2021", "2027-2028"],
};

const cs490: Course = {
    id: "CSCI-UA 490",
    title: "Special Topics",
    credits: 4,
    departments: ["CSCI-UA"],
    crossListed: [],
    exclusions: [],
    termsOffered: ["fall", "spring"],
    catalogYearsActive: ["2020-2021", "2027-2028"],
};

const cs476: Course = {
    id: "CSCI-UA 476",
    title: "Computer Theory",
    credits: 4,
    departments: ["CSCI-UA"],
    crossListed: [],
    exclusions: [],
    termsOffered: ["fall", "spring"],
    catalogYearsActive: ["2020-2021", "2027-2028"],
};

/** Course only offered in spring. */
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

/** Course with prereq (CSCI-UA 101). */
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
    prereqGroups: [{ type: "AND", courses: ["CSCI-UA 101"] }],
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
        courses: [cs480, cs490, cs476, springOnlyCourse, prereqCourse],
        prereqs: [prereqEntry],
        ...overrides,
    };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return { signal: new AbortController().signal, session };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Case 5: isReadOnly assertion
describe("bind_pool_slot — isReadOnly contract", () => {
    it("isReadOnly is true", () => {
        expect(bindPoolSlotTool.isReadOnly).toBe(true);
    });
});

// Case 1: courseId in pool candidates + valid prereqs → success
describe("bind_pool_slot — success: courseId in candidates", () => {
    it("returns feasible=true, warningLevel assigned when binding a valid candidate", async () => {
        const session = makeSession();
        const output = await bindPoolSlotTool.call(
            { slotId: "pool-slot-1", courseId: "CSCI-UA 480" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(true);
        expect(["none", "mild", "strong"]).toContain(output.warningLevel);
        expect(output.diff.added).toHaveLength(1);
        expect(output.diff.added[0]!.slot.kind).toBe("specific_planned");
        if (output.diff.added[0]!.slot.kind === "specific_planned") {
            expect(output.diff.added[0]!.slot.courseId).toBe("CSCI-UA 480");
        }
        expect(output.diff.removed).toHaveLength(1);
        expect(output.conflicts).toBeUndefined();
    });
});

// Case 2: courseId NOT in poolBinding.candidates → not_in_pool_candidates
describe("bind_pool_slot — courseId not in candidates", () => {
    it("returns feasible=false with conflict kind=not_in_pool_candidates", async () => {
        const session = makeSession();
        const output = await bindPoolSlotTool.call(
            { slotId: "pool-slot-1", courseId: "CSCI-UA 999" },  // NOT in pool
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "not_in_pool_candidates")).toBe(true);
        expect(output.warningLevel).toBe("strong");
    });
});

// Case 3: Binding violates choose_n constraint
describe("bind_pool_slot — pool_constraint_violation", () => {
    it("returns feasible=false with conflict kind=pool_constraint_violation when other slots exhausted", async () => {
        // Two pool slots with same poolId but overlapping single candidates:
        // slot-1: candidates = ["CSCI-UA 480"]
        // slot-2: candidates = ["CSCI-UA 480"]  (same single candidate)
        // Binding CSCI-UA 480 to slot-1 leaves slot-2 with no candidates.
        const schedule = makeSchedule({
            semesters: [
                makeSingleCandidatePoolSemester("2026-fall", "pool-slot-1", "CSCI-UA 480"),
                makeSingleCandidatePoolSemester("2027-spring", "pool-slot-2", "CSCI-UA 480"),
            ],
        });
        const session = makeSession({ forwardSchedule: schedule });
        const output = await bindPoolSlotTool.call(
            { slotId: "pool-slot-1", courseId: "CSCI-UA 480" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "pool_constraint_violation")).toBe(true);
        expect(output.warningLevel).toBe("strong");
    });

    it("succeeds when binding does NOT exhaust other pool slots", async () => {
        // Two pool slots with full candidate lists — binding 480 to slot-1 leaves
        // slot-2 with [490, 476] remaining → constraint OK
        const schedule = makeSchedule({
            semesters: makeTwoPoolSemestersWithSingleCandidateOverlap(),
        });
        const session = makeSession({ forwardSchedule: schedule });
        const output = await bindPoolSlotTool.call(
            { slotId: "pool-slot-1", courseId: "CSCI-UA 480" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(true);
        expect(output.conflicts?.some((c) => c.kind === "pool_constraint_violation")).toBeFalsy();
    });
});

// Case 4a: Invalid courseId (not in catalog)
describe("bind_pool_slot — invalid courseId", () => {
    it("returns feasible=false with conflict kind=unknown_course after candidates check passes", async () => {
        // Add "CSCI-UA 999" to the candidates but NOT to the courses catalog
        const schedule = makeSchedule({
            semesters: [{
                term: "2026-fall",
                locked: false,
                slots: [makePoolSlot("pool-slot-1", {
                    poolBinding: { ...csPoolBinding, candidates: ["CSCI-UA 999"] },
                })],
                plannedCredits: 4,
                notes: [],
                loadRationale: { loadStyle: "balanced", hardCount: 1, easyCount: 0, weightedCredits: 1.0, note: "" },
            }],
        });
        const session = makeSession({ forwardSchedule: schedule });
        const output = await bindPoolSlotTool.call(
            { slotId: "pool-slot-1", courseId: "CSCI-UA 999" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "unknown_course")).toBe(true);
    });
});

// Case 4b: Non-existent slot
describe("bind_pool_slot — non-existent slot", () => {
    it("returns feasible=false with conflict kind=unknown_slot", async () => {
        const session = makeSession();
        const output = await bindPoolSlotTool.call(
            { slotId: "does-not-exist-99", courseId: "CSCI-UA 480" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "unknown_slot")).toBe(true);
    });
});

// Case 4c: Wrong slot kind (free-credit slot has no poolBinding)
describe("bind_pool_slot — wrong slot kind (no poolBinding)", () => {
    it("returns feasible=false with conflict kind=wrong_slot_kind for a free-credit slot", async () => {
        // A free-credit slot (no poolBinding)
        const freeSched = makeSchedule({
            semesters: [{
                term: "2026-fall",
                locked: false,
                slots: [{
                    kind: "placeholder",
                    category: "Free Elective",
                    credits: 4,
                    satisfiesRules: [],
                    optional: true,
                    reason: "Free credit",
                    rationale: baseRationale,
                    flexibility: baseFlexibility,
                    downstreamImpact: baseDownstream,
                    workloadTier: "free-elective",
                    workloadWeight: 0.3,
                    bindingState: "placeholder-pending",
                    placeholderId: "free-credit-slot-1",
                    confidence: "high",
                    isCriticalPath: false,
                    // NO poolBinding
                } as ScheduleSlotPlaceholder],
                plannedCredits: 4,
                notes: [],
                loadRationale: { loadStyle: "balanced", hardCount: 0, easyCount: 1, weightedCredits: 0.3, note: "" },
            }],
        });
        const session = makeSession({ forwardSchedule: freeSched });
        const output = await bindPoolSlotTool.call(
            { slotId: "free-credit-slot-1", courseId: "CSCI-UA 480" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "wrong_slot_kind")).toBe(true);
    });
});

// Offering mismatch within a pool
describe("bind_pool_slot — offering_mismatch", () => {
    it("returns feasible=false when course is not offered in slot term", async () => {
        // Add springOnlyCourse to pool candidates, but slot is in fall
        const schedule = makeSchedule({
            semesters: [{
                term: "2026-fall",
                locked: false,
                slots: [makePoolSlot("pool-slot-1", {
                    poolBinding: {
                        ...csPoolBinding,
                        candidates: ["BIOL-UA 2200"],
                    },
                })],
                plannedCredits: 4,
                notes: [],
                loadRationale: { loadStyle: "balanced", hardCount: 1, easyCount: 0, weightedCredits: 1.0, note: "" },
            }],
        });
        const session = makeSession({ forwardSchedule: schedule });
        const output = await bindPoolSlotTool.call(
            { slotId: "pool-slot-1", courseId: "BIOL-UA 2200" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "offering_mismatch")).toBe(true);
    });
});

// Prereqs not satisfied
describe("bind_pool_slot — prereqs not satisfied", () => {
    it("returns feasible=false with conflict kind=prereq_unsatisfied", async () => {
        // CSCI-UA 201 requires CSCI-UA 101 — not in DPR
        const schedule = makeSchedule({
            semesters: [{
                term: "2026-fall",
                locked: false,
                slots: [makePoolSlot("pool-slot-1", {
                    poolBinding: {
                        ...csPoolBinding,
                        candidates: ["CSCI-UA 201"],
                    },
                })],
                plannedCredits: 4,
                notes: [],
                loadRationale: { loadStyle: "balanced", hardCount: 1, easyCount: 0, weightedCredits: 1.0, note: "" },
            }],
        });
        const session = makeSession({
            forwardSchedule: schedule,
            degreeProgressReport: makeDpr(), // empty — CSCI-UA 101 not satisfied
        });
        const output = await bindPoolSlotTool.call(
            { slotId: "pool-slot-1", courseId: "CSCI-UA 201" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "prereq_unsatisfied")).toBe(true);
    });
});

// Duplicate course already bound elsewhere
describe("bind_pool_slot — duplicate_courseId", () => {
    it("returns feasible=false when course already bound in the schedule", async () => {
        const schedule = makeSchedule({
            semesters: [
                makePoolSemester("2026-fall", "pool-slot-1"),
                makeBoundSemester("2026-spring", "CSCI-UA 480"),
            ],
        });
        const session = makeSession({ forwardSchedule: schedule });
        const output = await bindPoolSlotTool.call(
            { slotId: "pool-slot-1", courseId: "CSCI-UA 480" },
            makeCtx(session),
        );
        expect(output.feasible).toBe(false);
        expect(output.conflicts!.some((c) => c.kind === "duplicate_courseId")).toBe(true);
    });
});

// validateInput rejects when no forwardSchedule
describe("bind_pool_slot — validateInput rejects without forwardSchedule", () => {
    it("returns ok:false when no forwardSchedule", async () => {
        const session = makeSession({ forwardSchedule: undefined });
        const result = await bindPoolSlotTool.validateInput!(
            { slotId: "pool-slot-1", courseId: "CSCI-UA 480" },
            makeCtx(session),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.userMessage).toMatch(/no forward plan/i);
    });
});
