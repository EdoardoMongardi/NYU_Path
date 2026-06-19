/**
 * Plan 37 Task J2 — a pool-slot / free-elective binding must SURVIVE
 * confirm_plan_change.
 *
 * Background: J1 made bind_pool_slot / bind_free_elective accept the infeasible
 * DRAFT plan so a student can repair an infeasible plan by binding a course.
 * But the commit path (propose → confirm) historically DROPPED the binding: the
 * `bindPoolSlot` / `bindFreeElective` PlanMutations were explicit NO-OPs in
 * `applyMutationsToPreferences`, so the re-solve never saw the chosen course and
 * the requirement leaf stayed unsatisfied.
 *
 * J2 routes the binding through the `pin` mechanism: a `bindPoolSlot(slotId,
 * courseId)` / `bindFreeElective(slotId, courseId)` mutation is translated, at
 * the propose/confirm boundary where the active plan is in hand, into a
 * `pin(courseId, slotTerm)`. The solver's pin-coverage pass then sets the pin's
 * `satisfiesRId` to the requirement whose candidates include the bound course,
 * so the bound course is PLACED in the slot's term AND the leaf is satisfied.
 *
 * END-TO-END assertion (the thing a student feels): start from an infeasible
 * draft plan that has a resolvable pool placeholder for an unmet requirement
 * leaf, bind the candidate, confirm, and assert the committed plan PLACES the
 * bound course in that term and the leaf is satisfied (validator passes).
 */

import { describe, it, expect } from "vitest";
import { confirmPlanChangeTool } from "../../src/agent/tools/confirmPlanChange.js";
import { proposePlanChangeTool } from "../../src/agent/tools/proposePlanChange.js";
import { applyMutationsToPreferences } from "../../src/agent/forwardSchedule/planChangeHelpers.js";
import type { ToolSession, ToolUseContext } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type {
    Course,
    ForwardSchedule,
    PoolBinding,
    ScheduleSlotPlaceholder,
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

/**
 * A DPR with a single UNMET requirement leaf ("Capstone") with TWO candidate
 * courses (CSCI-UA 480 / CSCI-UA 490, parsed out of statusText by
 * extractCandidatesAndPool). creditsUsed=124 so a single 4-credit placement
 * reaches the 128 minimum — the ONLY thing standing between this plan and
 * validity is covering R100/1 with EITHER candidate.
 *
 * TWO candidates is the discriminator: absent the student's binding the solver
 * is free to auto-place EITHER course to cover the leaf, so the test must bind
 * the NON-default candidate (CSCI-UA 490) and prove THAT one lands — which can
 * only happen if the binding actually steers the re-solve (i.e. it stuck).
 */
function makeDprWithUnmetLeaf(): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 124,
            cumulativeGpa: 3.4,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 0,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [
            {
                rgId: "RG1",
                title: "CS Core",
                status: "not_satisfied",
                statusText: "Not Satisfied",
                children: [
                    {
                        rId: "R100/1",
                        title: "Capstone",
                        status: "not_satisfied",
                        statusText: "Not Satisfied. Choose CSCI-UA 480 or CSCI-UA 490.",
                        coursesUsed: [],
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        counter: { kind: "units", required: 4, used: 0 } as any,
                    },
                ],
            },
        ],
        courseHistory: [],
    };
}

const baseRationale: SlotRationale = {
    satisfiesRequirements: ["R100/1"],
    termConstraints: [],
    consideredAlternatives: [],
    decisionsApplied: [],
};

const baseFlexibility: SlotFlexibility = {
    earliestPossibleTerm: "2026-fall",
    latestPossibleTerm: "2026-fall",
    alternativeCourses: [],
};

const baseDownstream: DownstreamImpact = {
    courseIds: [],
    graduationDelay: 0,
};

const capstonePool: PoolBinding = {
    poolId: "CAPSTONE_POOL",
    candidates: ["CSCI-UA 480", "CSCI-UA 490"],
    satisfiesRule: "R100/1",
};

/** A requirement-pool placeholder slot for the Capstone leaf. */
function makePoolSlot(placeholderId: string): ScheduleSlotPlaceholder {
    return {
        kind: "placeholder",
        category: "Capstone",
        credits: 4,
        satisfiesRules: ["R100/1"],
        optional: false,
        reason: "Capstone pool slot",
        rationale: baseRationale,
        flexibility: baseFlexibility,
        downstreamImpact: baseDownstream,
        workloadTier: "major-elective",
        workloadWeight: 1.0,
        bindingState: "placeholder-pending",
        placeholderId,
        poolBinding: capstonePool,
        confidence: "high",
        isCriticalPath: false,
    };
}

/** A free-credit placeholder (no poolBinding) for the bind_free_elective path. */
function makeFreeCreditSlot(placeholderId: string): ScheduleSlotPlaceholder {
    return {
        kind: "placeholder",
        category: "Free Elective",
        credits: 4,
        satisfiesRules: [],
        optional: true,
        reason: "Free credit slot",
        rationale: { ...baseRationale, satisfiesRequirements: [] },
        flexibility: baseFlexibility,
        downstreamImpact: baseDownstream,
        workloadTier: "free-elective",
        workloadWeight: 0.3,
        bindingState: "placeholder-pending",
        placeholderId,
        confidence: "high",
        isCriticalPath: false,
        // NO poolBinding
    };
}

/**
 * An INFEASIBLE draft plan: a single future term with an unbound placeholder
 * for the unmet Capstone leaf. Because the leaf is uncovered, the 7-axis
 * validator's requirementGroupsSatisfied axis fails → infeasible-draft.
 */
function makeDraftPlan(slot: ScheduleSlotPlaceholder): ForwardSchedule {
    return {
        studentId: "test-student",
        homeSchoolId: "cas",
        graduationTerm: "2026-fall",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        // 124 used + 4 planned = 128 = minimum (so credits are NOT the blocker;
        // the uncovered Capstone leaf is the only thing keeping this infeasible).
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters: [
            {
                term: "2026-fall",
                locked: false,
                slots: [slot],
                plannedCredits: 4,
                notes: [],
                loadRationale: {
                    loadStyle: "balanced",
                    hardCount: 1,
                    easyCount: 0,
                    weightedCredits: 1.0,
                    note: "",
                },
            },
        ],
        dprCourseHistoryHash: "test-hash",
        computedAt: Date.now(),
        feasibility: {
            feasible: false,
            infeasibilityReason: "Capstone (R100/1) is unbound",
            constraintViolations: [
                { kind: "requirement_unmet", detail: "R100/1 has no bound course" },
            ],
            placementRationale: {},
        },
        state: "infeasible-draft",
        balanceScore: 0,
        assumptions: [],
    };
}

const cs480: Course = {
    id: "CSCI-UA 480",
    title: "Capstone Project",
    credits: 4,
    departments: ["CSCI-UA"],
    crossListed: [],
    exclusions: [],
    termsOffered: ["fall", "spring"],
    catalogYearsActive: ["2020-2021", "2027-2028"],
};

const cs490: Course = {
    id: "CSCI-UA 490",
    title: "Capstone Project (alternative)",
    credits: 4,
    departments: ["CSCI-UA"],
    crossListed: [],
    exclusions: [],
    termsOffered: ["fall", "spring"],
    catalogYearsActive: ["2020-2021", "2027-2028"],
};

function makeSession(slot: ScheduleSlotPlaceholder): ToolSession {
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
        degreeProgressReport: makeDprWithUnmetLeaf(),
        // INFEASIBLE draft — no forwardSchedule (J1 path).
        studentDraftPlan: makeDraftPlan(slot),
        courses: [cs480, cs490],
        prereqs: [],
    };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return { signal: new AbortController().signal, session };
}

/** Pull the placed courseIds for a given term out of a committed schedule. */
function placedCourseIdsInTerm(schedule: ForwardSchedule, term: string): string[] {
    const sem = schedule.semesters.find(s => s.term === term);
    if (!sem) return [];
    const out: string[] = [];
    for (const s of sem.slots) {
        if (s.kind === "specific_planned") out.push(s.courseId);
    }
    return out;
}

// ---------------------------------------------------------------------------
// J2 — bind_pool_slot survives confirm
// ---------------------------------------------------------------------------

describe("J2 — bindPoolSlot survives confirm_plan_change (binding sticks)", () => {
    it("confirming a bindPoolSlot PLACES the bound course in the slot's term AND satisfies the leaf", async () => {
        const session = makeSession(makePoolSlot("pool-slot-1"));
        const ctx = makeCtx(session);

        // Sanity: the draft is the only plan and it is infeasible (leaf uncovered).
        expect(session.forwardSchedule).toBeUndefined();
        expect(session.studentDraftPlan).toBeDefined();

        // Bind the NON-default candidate (CSCI-UA 490). The leaf has TWO candidates,
        // so absent a binding the solver could cover R100/1 with EITHER — placing
        // 490 specifically can only happen if the binding steered the re-solve.
        const output = await confirmPlanChangeTool.call(
            { mutations: [{ kind: "bindPoolSlot", slotId: "pool-slot-1", courseId: "CSCI-UA 490" }] },
            ctx,
        );

        // The binding STUCK: the committed plan is valid and lives in forwardSchedule.
        expect(output.feasible).toBe(true);
        expect(output.storedIn).toBe("forwardSchedule");
        expect(session.forwardSchedule).toBeDefined();

        // The bound course (490) is PLACED in the slot's term (2026-fall), and the
        // OTHER candidate (480) is NOT — the student's specific choice was honored.
        const placed = placedCourseIdsInTerm(session.forwardSchedule!, "2026-fall");
        expect(placed).toContain("CSCI-UA 490");
        expect(placed).not.toContain("CSCI-UA 480");

        // The requirement leaf R100/1 is credited by the bound slot's satisfiesRules
        // (this is what makes requirementGroupsSatisfied pass).
        const fallSem = session.forwardSchedule!.semesters.find(s => s.term === "2026-fall")!;
        const boundSlot = fallSem.slots.find(
            s => s.kind === "specific_planned" && s.courseId === "CSCI-UA 490",
        );
        expect(boundSlot).toBeDefined();
        if (boundSlot && boundSlot.kind === "specific_planned") {
            expect(boundSlot.satisfiesRules).toContain("R100/1");
        }

        // The binding survived: the persisted preferences carry a pin so a future
        // re-solve keeps placing the bound course.
        expect(session.schedulePreferences?.pins ?? []).toEqual(
            expect.arrayContaining([{ courseId: "CSCI-UA 490", term: "2026-fall" }]),
        );
    });

    it("propose_plan_change PREVIEWS the same bound, feasible plan (no session write)", async () => {
        const session = makeSession(makePoolSlot("pool-slot-1"));
        const ctx = makeCtx(session);
        const draftBefore = session.studentDraftPlan;

        const output = await proposePlanChangeTool.call(
            { mutations: [{ kind: "bindPoolSlot", slotId: "pool-slot-1", courseId: "CSCI-UA 490" }] },
            ctx,
        );

        expect(output.feasible).toBe(true);
        const placed = placedCourseIdsInTerm(output.proposedSchedule!, "2026-fall");
        expect(placed).toContain("CSCI-UA 490");
        expect(placed).not.toContain("CSCI-UA 480");

        // Read-only: session untouched.
        expect(session.forwardSchedule).toBeUndefined();
        expect(session.studentDraftPlan).toBe(draftBefore);
        expect(session.schedulePreferences).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// J2 — bind_free_elective survives confirm
// ---------------------------------------------------------------------------

describe("J2 — bindFreeElective survives confirm_plan_change (binding sticks)", () => {
    it("confirming a bindFreeElective PLACES the bound course in the slot's term AND satisfies the leaf", async () => {
        // A free-credit slot has no poolBinding, but CSCI-UA 480 is still the
        // candidate for the unmet R100/1 leaf (via the DPR statusText). Pinning it
        // covers the leaf exactly as the pool path does.
        const session = makeSession(makeFreeCreditSlot("free-slot-1"));
        const ctx = makeCtx(session);

        const output = await confirmPlanChangeTool.call(
            { mutations: [{ kind: "bindFreeElective", slotId: "free-slot-1", courseId: "CSCI-UA 490" }] },
            ctx,
        );

        expect(output.feasible).toBe(true);
        expect(output.storedIn).toBe("forwardSchedule");

        const placed = placedCourseIdsInTerm(session.forwardSchedule!, "2026-fall");
        expect(placed).toContain("CSCI-UA 490");
        expect(placed).not.toContain("CSCI-UA 480");

        expect(session.schedulePreferences?.pins ?? []).toEqual(
            expect.arrayContaining([{ courseId: "CSCI-UA 490", term: "2026-fall" }]),
        );
    });
});

// ---------------------------------------------------------------------------
// J2 follow-up — DROPPING a bound course RELEASES it (no lingering pin)
// ---------------------------------------------------------------------------
//
// J2 made a bind translate to a pin(courseId, slotTerm, freeze:true) so the
// binding survives confirm. The INVERSE must work too: dropping a bound course
// (the slot-editor emits `exclude(courseId, term)`) must GENUINELY remove it.
//
// The bug this guards against: the solver's pin pass places every pin into the
// FIXED set UNCONDITIONALLY — it never consults the exclusion set. So a course
// that was bound (→ pin) and then dropped (→ exclude) would be re-placed by its
// lingering pin (the pin wins over the exclude), making the drop a silent
// no-op. The fix: an `exclude` releases any matching pin in
// applyMutationsToPreferences, so the dropped course is actually gone AND no
// dead/conflicting pin remains.

/**
 * A DPR whose degree credits are ALREADY met (128/128) with NO unmet leaf, so a
 * bound FREE elective is purely additive — dropping it keeps the plan feasible
 * (the bound course covers no required leaf). This isolates the "release"
 * behavior from any requirement-coverage side effect.
 */
function makeFeasibleDpr(): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 128,
            cumulativeGpa: 3.4,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 0,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],   // no unmet leaves — degree already complete
        courseHistory: [],
    };
}

/** A FEASIBLE base plan with one free-elective placeholder to bind into. */
function makeFeasiblePlan(slot: ScheduleSlotPlaceholder): ForwardSchedule {
    return {
        studentId: "test-student",
        homeSchoolId: "cas",
        graduationTerm: "2026-fall",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [
            {
                term: "2026-fall",
                locked: false,
                slots: [slot],
                plannedCredits: 4,
                notes: [],
                loadRationale: {
                    loadStyle: "balanced",
                    hardCount: 0,
                    easyCount: 1,
                    weightedCredits: 0.3,
                    note: "",
                },
            },
        ],
        dprCourseHistoryHash: "test-hash",
        computedAt: Date.now(),
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
}

function makeFeasibleSession(slot: ScheduleSlotPlaceholder): ToolSession {
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
        degreeProgressReport: makeFeasibleDpr(),
        // Already-feasible committed plan (the editor mounts on the committed plan).
        forwardSchedule: makeFeasiblePlan(slot),
        courses: [cs480, cs490],
        prereqs: [],
    };
}

function allPlacedCourseIds(schedule: ForwardSchedule): string[] {
    const out: string[] = [];
    for (const sem of schedule.semesters) {
        for (const s of sem.slots) {
            if (s.kind === "specific_planned") out.push(s.courseId);
        }
    }
    return out;
}

describe("J2 follow-up — dropping a bound course releases it (no lingering pin)", () => {
    it("bind → confirm (pin + placed), then DROP → confirm: course is gone AND the pin is released", async () => {
        const session = makeFeasibleSession(makeFreeCreditSlot("free-slot-1"));
        const ctx = makeCtx(session);

        // --- Bind CSCI-UA 490 into the free slot, confirm. ---
        const bindOut = await confirmPlanChangeTool.call(
            { mutations: [{ kind: "bindFreeElective", slotId: "free-slot-1", courseId: "CSCI-UA 490" }] },
            ctx,
        );
        expect(bindOut.feasible).toBe(true);
        expect(bindOut.storedIn).toBe("forwardSchedule");

        // The binding stuck: course placed + the pin persisted (J2 behavior).
        expect(allPlacedCourseIds(session.forwardSchedule!)).toContain("CSCI-UA 490");
        expect(session.schedulePreferences?.pins ?? []).toEqual(
            expect.arrayContaining([{ courseId: "CSCI-UA 490", term: "2026-fall" }]),
        );

        // --- DROP CSCI-UA 490 (the slot-editor's drop on a bound slot emits
        // exclude(courseId, term)), confirm. ---
        const dropOut = await confirmPlanChangeTool.call(
            { mutations: [{ kind: "exclude", courseId: "CSCI-UA 490", term: "2026-fall" }] },
            ctx,
        );

        // The drop keeps the plan feasible (the course covered no required leaf)
        // and commits to forwardSchedule.
        expect(dropOut.feasible).toBe(true);
        expect(dropOut.storedIn).toBe("forwardSchedule");

        // CORE ASSERTIONS — the course is GENUINELY released:
        //  (1) the committed plan no longer contains CSCI-UA 490, and
        //  (2) no dead pin lingers for it (without the fix the lingering pin
        //      would have re-placed the course, defeating the drop).
        expect(allPlacedCourseIds(session.forwardSchedule!)).not.toContain("CSCI-UA 490");
        const pinsAfter = session.schedulePreferences?.pins ?? [];
        expect(pinsAfter.find(p => p.courseId === "CSCI-UA 490")).toBeUndefined();

        // The exclusion DID land (the drop is recorded).
        const exclusionsAfter = session.schedulePreferences?.exclusions ?? [];
        expect(exclusionsAfter.find(e => e.courseId === "CSCI-UA 490")).toBeDefined();
    });

    it("a single-pass [pin, exclude] for the same course leaves no pin (exclude beats the pin)", () => {
        // Helper-level unit: the exclude case must STRIP a matching pin so the
        // pin can never out-vote the exclude in the solver's fixed set.
        const { prefs } = applyMutationsToPreferences(
            {},
            [
                { kind: "pin", courseId: "CSCI-UA 490", term: "2026-fall", freeze: true },
                { kind: "exclude", courseId: "CSCI-UA 490", term: "2026-fall" },
            ],
        );
        expect((prefs.pins ?? []).find(p => p.courseId === "CSCI-UA 490")).toBeUndefined();
        expect((prefs.exclusions ?? []).find(e => e.courseId === "CSCI-UA 490")).toBeDefined();
    });

    it("a GLOBAL exclude (no term) releases ALL pins for the course", () => {
        const { prefs } = applyMutationsToPreferences(
            { pins: [
                { courseId: "CSCI-UA 490", term: "2026-fall" },
                { courseId: "CSCI-UA 490", term: "2027-spring" },
                { courseId: "CSCI-UA 480", term: "2026-fall" },
            ] },
            [{ kind: "exclude", courseId: "CSCI-UA 490" }],
        );
        // Both 490 pins gone; the unrelated 480 pin survives.
        expect((prefs.pins ?? []).filter(p => p.courseId === "CSCI-UA 490")).toHaveLength(0);
        expect((prefs.pins ?? []).find(p => p.courseId === "CSCI-UA 480")).toBeDefined();
    });

    it("a TERM-SCOPED exclude releases ONLY the matching-term pin", () => {
        const { prefs } = applyMutationsToPreferences(
            { pins: [
                { courseId: "CSCI-UA 490", term: "2026-fall" },
                { courseId: "CSCI-UA 490", term: "2027-spring" },
            ] },
            [{ kind: "exclude", courseId: "CSCI-UA 490", term: "2026-fall" }],
        );
        const pins490 = (prefs.pins ?? []).filter(p => p.courseId === "CSCI-UA 490");
        expect(pins490).toHaveLength(1);
        expect(pins490[0]!.term).toBe("2027-spring");
    });
});
