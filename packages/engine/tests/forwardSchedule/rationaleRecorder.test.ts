/**
 * Phase 2 P2.5 — Per-slot rationale recorder tests (TDD-first).
 *
 * materializePlan's requirement-slot branch now records the search's REAL
 * reasoning per slot:
 *   1. consideredAlternatives — for each OTHER candidate of the requirement,
 *      a counterfactual swap (C→C′ in the chosen term) against the FINAL plan
 *      gives the concrete reason it lost: either the first hard-constraint
 *      violation's detail (offering / prereq / NOT / coreq / ceiling) or, when
 *      the swap is feasible, an objective comparison (alt-score vs chosen-score).
 *   2. termConstraints — restores the `coreqSameTerm` label when the placed
 *      course has an unmet coreq co-placed in the same term.
 *   3. flexibility — a REAL earliest/latest feasible-term window (offering +
 *      prereq-precedence bounded), not just futureTerms[0] / last.
 *
 * These let an advisor agent answer "why is X here / why not Y / why not term T"
 * from recorded data alone.
 *
 * Self-contained SolverInput fixtures (the same pattern as
 * materializePlan.test.ts / constraintModel.test.ts).
 */

import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    type ConstraintContext,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { searchBestPlan } from "../../src/agent/forwardSchedule/search.js";
import { materializePlan } from "../../src/agent/forwardSchedule/materializePlan.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { ScheduleSlotSpecificPlanned, PrereqGroup } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories (copied from materializePlan.test.ts)
// ---------------------------------------------------------------------------

function makeMinimalDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:test",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 100,
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

function makeInput(overrides: Partial<SolverInput> = {}): SolverInput {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        visaStatus: "f1",
        coursesTaken: new Set(),
        coursesInProgress: new Map(),
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        creditCeiling: 18,
        graduationCreditMinimum: 128,
        creditsEarned: 100,
        passFailCap: 32,
        passFailUsed: 4,
        onlineCreditCap: 16,
        onlineCreditsUsed: 0,
        outsideHomeCreditCap: 16,
        outsideHomeCreditsUsed: 0,
        cumulativeGpa: 3.4,
        majorGpa: 3.3,
        graduationGpaFloor: 2.0,
        majorGpaFloor: 2.0,
        unmetRequirements: [],
        prereqs: new Map(),
        offerings: new Map(),
        offeringConfidence: new Map(),
        courseCatalog: new Map(),
        dprCourseHistoryHash: "test-hash",
        dpr: makeMinimalDpr(),
        programRules: {
            majorRuleKinds: new Map(),
            schoolCoreRuleIds: new Set(),
            generalCategoryRuleIds: new Set(),
            residencyMinCredits: null,
            majorCreditMinimum: null,
            upperLevelMinCredits: null,
        },
        ...overrides,
    };
}

/** Find the bound specific_planned slot satisfying a given rId across all terms. */
function findReqSlot(
    out: ReturnType<typeof materializePlan>,
    rId: string,
): ScheduleSlotSpecificPlanned | undefined {
    for (const sem of out.semesters) {
        for (const slot of sem.slots) {
            if (slot.kind === "specific_planned" && slot.satisfiesRules.includes(rId)) {
                return slot;
            }
        }
    }
    return undefined;
}

// ===========================================================================
// 1. Hard-infeasible alternative → real constraint reason (offering)
// ===========================================================================

describe("rationale — consideredAlternatives carry the REAL rejection reason", () => {
    it("a non-chosen candidate that is not offered in the chosen term names the offering violation (not a generic string)", () => {
        // Single fall-only horizon. Requirement r1 has two candidates:
        //   REQ-UA 1  offered fall+spring   → placeable in 2026-fall (chosen)
        //   REQ-UA 2  offered SPRING only   → NOT placeable in 2026-fall
        // The search must pick REQ-UA 1. The chosen slot's consideredAlternatives
        // entry for REQ-UA 2 must name the offering reason from the counterfactual
        // swap REQ-UA 1 → REQ-UA 2 in 2026-fall.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2026-fall", // single-term horizon
            creditsEarned: 124,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Requirement One",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1", "REQ-UA 2"],
                },
            ],
            courseCatalog: new Map([
                ["REQ-UA 1", { title: "Course One", credits: 4 }],
                ["REQ-UA 2", { title: "Course Two", credits: 4 }],
            ]),
            offerings: new Map([
                ["REQ-UA 1", ["fall", "spring"]],
                ["REQ-UA 2", ["spring"]], // spring-only → infeasible in fall
            ]),
        });
        const ctx = buildConstraintContext(input);
        const plan = searchBestPlan(ctx).plan;
        expect(plan).not.toBeNull();
        const out = materializePlan(plan!, ctx);

        const slot = findReqSlot(out, "r1");
        expect(slot).toBeDefined();
        expect(slot!.courseId).toBe("REQ-UA 1"); // the only fall-placeable candidate

        const alt = slot!.rationale.consideredAlternatives.find(a => a.courseId === "REQ-UA 2");
        expect(alt).toBeDefined();
        // The REAL reason: REQ-UA 2 is not offered in fall. NOT the old generic.
        expect(alt!.rejectedBecause).not.toMatch(/search selected a different candidate/i);
        expect(alt!.rejectedBecause).toMatch(/not offered/i);
        expect(alt!.rejectedBecause).toMatch(/fall/i);
    });

    it("a non-chosen candidate whose prereq cannot precede it in the chosen term names the prereq violation", () => {
        // Single fall-only horizon. r1 candidates:
        //   REQ-UA 1  no prereq           → placeable in 2026-fall (chosen)
        //   REQ-UA 2  requires PRE-UA 9, which is neither taken/IP nor placeable
        //             in this 1-term plan → prereq unsatisfiable in 2026-fall.
        const prereqs = new Map<string, PrereqGroup[]>([
            ["REQ-UA 2", [{ type: "AND", courses: ["PRE-UA 9"] }]],
        ]);
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2026-fall",
            creditsEarned: 124,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Requirement One",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1", "REQ-UA 2"],
                },
            ],
            courseCatalog: new Map([
                ["REQ-UA 1", { title: "Course One", credits: 4 }],
                ["REQ-UA 2", { title: "Course Two", credits: 4 }],
            ]),
            offerings: new Map([
                ["REQ-UA 1", ["fall", "spring"]],
                ["REQ-UA 2", ["fall", "spring"]],
            ]),
            prereqs,
        });
        const ctx = buildConstraintContext(input);
        const plan = searchBestPlan(ctx).plan;
        expect(plan).not.toBeNull();
        const out = materializePlan(plan!, ctx);

        const slot = findReqSlot(out, "r1");
        expect(slot).toBeDefined();
        expect(slot!.courseId).toBe("REQ-UA 1");

        const alt = slot!.rationale.consideredAlternatives.find(a => a.courseId === "REQ-UA 2");
        expect(alt).toBeDefined();
        expect(alt!.rejectedBecause).not.toMatch(/search selected a different candidate/i);
        expect(alt!.rejectedBecause).toMatch(/[Pp]rereq/);
        expect(alt!.rejectedBecause).toContain("REQ-UA 2");
    });

    it("a non-viable candidate (off-catalog) is rejected as not-a-viable-candidate", () => {
        // r1 candidates: REQ-UA 1 (in catalog) + OFF-UA 99 (NOT in catalog).
        // The off-catalog candidate is never placeable; its rejection reason is
        // the viability message, not a counterfactual constraint detail.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2026-fall",
            creditsEarned: 124,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Requirement One",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1", "OFF-UA 99"],
                },
            ],
            courseCatalog: new Map([["REQ-UA 1", { title: "Course One", credits: 4 }]]),
            offerings: new Map([["REQ-UA 1", ["fall", "spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const plan = searchBestPlan(ctx).plan;
        expect(plan).not.toBeNull();
        const out = materializePlan(plan!, ctx);

        const slot = findReqSlot(out, "r1");
        expect(slot).toBeDefined();
        expect(slot!.courseId).toBe("REQ-UA 1");

        const alt = slot!.rationale.consideredAlternatives.find(a => a.courseId === "OFF-UA 99");
        expect(alt).toBeDefined();
        expect(alt!.rejectedBecause).toMatch(/not a viable candidate/i);
    });
});

// ===========================================================================
// 2. Higher-objective alternative → objective comparison reason
// ===========================================================================

describe("rationale — feasible-but-worse alternative names the objective comparison", () => {
    it("when both candidates are hard-feasible but one unbalances a term, the rejected one's reason cites both scores", () => {
        // Two requirements share term 2026-fall in a single-term horizon.
        //   r1 candidates: REQ-UA 1 (4cr) and REQ-UA 1B (8cr) — both offered
        //                  fall, both hard-feasible in 2026-fall.
        //   r2: REQ-UA 2 (4cr), single candidate, also in 2026-fall.
        // Need = 128 - 116 = 12 cr. Chosen plan {REQ-UA 1 (4) + REQ-UA 2 (4)} = 8
        // placed, + free fill to the 16 target → balanced. Swapping REQ-UA 1 →
        // REQ-UA 1B (8cr) puts 12 placed cr in the single term: still hard-feasible
        // (≤ ceiling 18), but it changes the balance/credit profile, so the trial
        // scores DIFFERENTLY from the chosen plan. The rejected entry must cite
        // the objective comparison (two numbers).
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2026-fall",
            creditsEarned: 116,
            graduationCreditMinimum: 128,
            creditTargetPerSemester: 16,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Requirement One",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1", "REQ-UA 1B"],
                },
                {
                    rId: "r2",
                    title: "Requirement Two",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 2"],
                },
            ],
            courseCatalog: new Map([
                ["REQ-UA 1", { title: "Course One", credits: 4 }],
                ["REQ-UA 1B", { title: "Course One-Big", credits: 8 }],
                ["REQ-UA 2", { title: "Course Two", credits: 4 }],
            ]),
            offerings: new Map([
                ["REQ-UA 1", ["fall", "spring"]],
                ["REQ-UA 1B", ["fall", "spring"]],
                ["REQ-UA 2", ["fall", "spring"]],
            ]),
        });
        const ctx = buildConstraintContext(input);
        const plan = searchBestPlan(ctx).plan;
        expect(plan).not.toBeNull();
        const out = materializePlan(plan!, ctx);

        const slot = findReqSlot(out, "r1");
        expect(slot).toBeDefined();

        // Whichever of the two r1 candidates was NOT chosen is the alternative.
        const otherId = slot!.courseId === "REQ-UA 1" ? "REQ-UA 1B" : "REQ-UA 1";
        const alt = slot!.rationale.consideredAlternatives.find(a => a.courseId === otherId);
        expect(alt).toBeDefined();
        // Feasible-but-worse: the reason names the objective comparison and both
        // numeric scores (formatted to 2 decimals).
        expect(alt!.rejectedBecause).not.toMatch(/search selected a different candidate/i);
        expect(alt!.rejectedBecause).toMatch(/objective/i);
        // Two decimal-formatted numbers present (e.g. "1.50 vs 0.00").
        const nums = alt!.rejectedBecause.match(/-?\d+\.\d{2}/g) ?? [];
        expect(nums.length).toBeGreaterThanOrEqual(2);
    });
});

// ===========================================================================
// 3. coreqSameTerm label restored
// ===========================================================================

describe("rationale — coreqSameTerm termConstraint label restored (P2.2c regression)", () => {
    it("a placed course with an unmet coreq co-placed in the same term gets a coreqSameTerm termConstraint", () => {
        // r1 → REQ-UA 1 has coreq LAB-UA 1. LAB-UA 1 satisfies r2 and (being the
        // sole candidate, same offerings) is co-placed in the SAME term. The
        // REQ-UA 1 slot's rationale.termConstraints must contain a coreqSameTerm
        // entry referencing the coreq.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditsEarned: 100,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Lecture",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1"],
                },
                {
                    rId: "r2",
                    title: "Lab",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["LAB-UA 1"],
                },
            ],
            courseCatalog: new Map([
                ["REQ-UA 1", { title: "Lecture", credits: 4 }],
                ["LAB-UA 1", { title: "Lab", credits: 4 }],
            ]),
            offerings: new Map([
                ["REQ-UA 1", ["fall", "spring"]],
                ["LAB-UA 1", ["fall", "spring"]],
            ]),
            coreqs: new Map([["REQ-UA 1", ["LAB-UA 1"]]]),
        });
        const ctx = buildConstraintContext(input);
        const plan = searchBestPlan(ctx).plan;
        expect(plan).not.toBeNull();
        const out = materializePlan(plan!, ctx);

        const lecture = findReqSlot(out, "r1");
        const lab = findReqSlot(out, "r2");
        expect(lecture).toBeDefined();
        expect(lab).toBeDefined();

        // Find the term the lecture is in, confirm the lab is co-placed there.
        const lectureTerm = out.semesters.find(s =>
            s.slots.some(sl => sl.kind === "specific_planned" && sl.courseId === "REQ-UA 1"),
        )?.term;
        const labTerm = out.semesters.find(s =>
            s.slots.some(sl => sl.kind === "specific_planned" && sl.courseId === "LAB-UA 1"),
        )?.term;
        expect(lectureTerm).toBeDefined();
        expect(labTerm).toBe(lectureTerm); // coreq must be same-term (else the plan would be invalid)

        const coreqConstraint = lecture!.rationale.termConstraints.find(
            tc => tc.kind === "coreqSameTerm",
        );
        expect(coreqConstraint).toBeDefined();
        expect(coreqConstraint!.detail).toContain("LAB-UA 1");
        expect(coreqConstraint!.detail).toContain("REQ-UA 1");
    });

    it("a placed course with NO unmet coreq gets NO coreqSameTerm constraint", () => {
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditsEarned: 100,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Standalone",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1"],
                },
            ],
            courseCatalog: new Map([["REQ-UA 1", { title: "Standalone", credits: 4 }]]),
            offerings: new Map([["REQ-UA 1", ["fall", "spring"]]]),
            // no coreqs
        });
        const ctx = buildConstraintContext(input);
        const plan = searchBestPlan(ctx).plan;
        const out = materializePlan(plan!, ctx);
        const slot = findReqSlot(out, "r1");
        expect(slot).toBeDefined();
        expect(
            slot!.rationale.termConstraints.some(tc => tc.kind === "coreqSameTerm"),
        ).toBe(false);
    });
});

// ===========================================================================
// 4. Real flexibility window (offering + prereq-precedence bounded)
// ===========================================================================

describe("rationale — flexibility is a REAL feasible-term window", () => {
    it("a course with a prereq placed earlier has earliestPossibleTerm no earlier than the prereq can precede it", () => {
        // Horizon 2026-fall, 2027-spring, 2027-fall.
        //   r0 → PRE-UA 1 (no prereq) — the prereq course; search places it.
        //   r1 → ADV-UA 1 requires PRE-UA 1; offered every term.
        // ADV-UA 1's earliest feasible term is the term STRICTLY AFTER PRE-UA 1's
        // placement (a prereq must precede). It must NOT be futureTerms[0] when
        // PRE-UA 1 lands in futureTerms[0].
        const prereqs = new Map<string, PrereqGroup[]>([
            ["ADV-UA 1", [{ type: "AND", courses: ["PRE-UA 1"] }]],
        ]);
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-fall",
            creditsEarned: 96,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r0",
                    title: "Prereq Course",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["PRE-UA 1"],
                },
                {
                    rId: "r1",
                    title: "Advanced Course",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["ADV-UA 1"],
                },
            ],
            courseCatalog: new Map([
                ["PRE-UA 1", { title: "Prereq Course", credits: 4 }],
                ["ADV-UA 1", { title: "Advanced Course", credits: 4 }],
            ]),
            offerings: new Map([
                ["PRE-UA 1", ["fall", "spring"]],
                ["ADV-UA 1", ["fall", "spring"]],
            ]),
            prereqs,
        });
        const ctx = buildConstraintContext(input);
        const futureTerms = ctx.futureTerms;
        expect(futureTerms[0]).toBe("2026-fall");
        const plan = searchBestPlan(ctx).plan;
        expect(plan).not.toBeNull();
        const out = materializePlan(plan!, ctx);

        const preTerm = plan!.placed.find(p => p.courseId === "PRE-UA 1")!.term;
        const adv = findReqSlot(out, "r1");
        expect(adv).toBeDefined();

        // earliestPossibleTerm must be strictly AFTER the prereq's placed term.
        const idxEarliest = futureTerms.indexOf(adv!.flexibility.earliestPossibleTerm);
        const idxPre = futureTerms.indexOf(preTerm);
        expect(idxEarliest).toBeGreaterThan(idxPre);
        // And specifically not the very first term (the prereq is in term 0).
        expect(adv!.flexibility.earliestPossibleTerm).not.toBe(futureTerms[0]);
    });

    it("a fall-only course has a fall latestPossibleTerm within the grad window (not the last future term when that is spring)", () => {
        // Horizon 2026-fall, 2027-spring, 2027-fall. A fall-only course's latest
        // feasible term is the LAST fall term in window (2027-fall here, which is
        // also the last term) — assert the latest is a fall term, and earliest is
        // also fall (it is not offered in spring). With a different shape where the
        // last term is spring, the latest must roll back to the prior fall.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2028-spring", // …2026-fall,2027-spring,2027-fall,2028-spring
            creditsEarned: 100,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Fall Only Course",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["FALL-UA 1"],
                },
            ],
            courseCatalog: new Map([["FALL-UA 1", { title: "Fall Only Course", credits: 4 }]]),
            offerings: new Map([["FALL-UA 1", ["fall"]]]), // fall-only
        });
        const ctx = buildConstraintContext(input);
        const futureTerms = ctx.futureTerms;
        // Sanity: last term is a spring (2028-spring), so a naive "last" would be wrong.
        expect(futureTerms[futureTerms.length - 1]).toBe("2028-spring");

        const plan = searchBestPlan(ctx).plan;
        const out = materializePlan(plan!, ctx);
        const slot = findReqSlot(out, "r1");
        expect(slot).toBeDefined();

        // latest must be a FALL term (2027-fall), NOT the spring last term.
        expect(slot!.flexibility.latestPossibleTerm).toMatch(/-fall$/);
        expect(slot!.flexibility.latestPossibleTerm).not.toBe("2028-spring");
        // earliest is also fall (no spring offering).
        expect(slot!.flexibility.earliestPossibleTerm).toMatch(/-fall$/);
    });
});

// ===========================================================================
// 5. End-to-end: "why X here / why not Y / why not term T" is answerable
// ===========================================================================

describe("rationale — an advisor agent can answer why-X / why-not-Y / why-not-term-T from one slot", () => {
    it("a placed slot records the requirement it satisfies, ≥1 concrete rejected alternative, and a real term window", () => {
        // Two candidates for r1: chosen REQ-UA 1 (offered fall+spring) vs the
        // spring-only REQ-UA 2 in a fall-only horizon — so there is a real
        // hard-infeasible alternative to read.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2026-fall",
            creditsEarned: 124,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Requirement One",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1", "REQ-UA 2"],
                },
            ],
            courseCatalog: new Map([
                ["REQ-UA 1", { title: "Course One", credits: 4 }],
                ["REQ-UA 2", { title: "Course Two", credits: 4 }],
            ]),
            offerings: new Map([
                ["REQ-UA 1", ["fall", "spring"]],
                ["REQ-UA 2", ["spring"]],
            ]),
        });
        const ctx = buildConstraintContext(input);
        const out = materializePlan(searchBestPlan(ctx).plan!, ctx);
        const slot = findReqSlot(out, "r1");
        expect(slot).toBeDefined();

        // (a) WHY is X here — which requirement it satisfies.
        expect(slot!.rationale.satisfiesRequirements).toContain("r1");

        // (b) WHY NOT Y — at least one rejected alternative with a concrete,
        // non-generic reason.
        expect(slot!.rationale.consideredAlternatives.length).toBeGreaterThan(0);
        for (const a of slot!.rationale.consideredAlternatives) {
            expect(a.rejectedBecause).not.toMatch(/search selected a different candidate/i);
            expect(a.rejectedBecause.length).toBeGreaterThan(0);
        }

        // (c) WHY NOT term T — the feasible window (real terms) is present.
        expect(slot!.flexibility.earliestPossibleTerm).toBeTruthy();
        expect(slot!.flexibility.latestPossibleTerm).toBeTruthy();
    });
});
