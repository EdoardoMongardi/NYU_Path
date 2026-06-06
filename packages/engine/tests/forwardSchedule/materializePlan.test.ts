/**
 * Phase 2 P2.2b — materializePlan tests (TDD-first).
 *
 * materializePlan turns a search result (a PartialPlan of chosen requirement /
 * pin / ip placements) into a full SolverOutput — rich specific_planned slots,
 * placeholder slots for uncovered requirements, free-elective fill to each
 * term's target, per-term visa notes + violations, Stage-8 global checks,
 * assumptions, balanceScore, coarse state, feasibility.
 *
 * Round-trip contract: searchBestPlan → materializePlan → wrap into a
 * ForwardSchedule → runGraduationPathValidator must report feasible.
 *
 * makeInput / placed / makeMinimalDpr are copied (minimal) from
 * constraintModel.test.ts / search.test.ts — these tests build a SolverInput
 * directly rather than from a real DPR fixture (the same self-contained pattern
 * the constraint-model + search tests use).
 */

import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    type ConstraintContext,
    type PartialPlan,
    type PlacedCourse,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { searchBestPlan } from "../../src/agent/forwardSchedule/search.js";
import { materializePlan } from "../../src/agent/forwardSchedule/materializePlan.js";
import {
    runGraduationPathValidator,
    type GraduationPathValidatorArgs,
} from "../../src/agent/forwardSchedule/graduationPathValidator.js";
import type { SolverInput, SolverOutput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories (copied from constraintModel.test.ts)
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

/** Convenience: build a single placed course with sensible defaults. */
function placed(p: Partial<PlacedCourse> & { courseId: string; term: string }): PlacedCourse {
    return {
        credits: 4,
        workloadTier: "free-elective",
        workloadWeight: 0.5,
        satisfiesRId: null,
        source: "free",
        ...p,
    };
}

/**
 * Wrap a SolverOutput into a ForwardSchedule for the validator — mirrors
 * build.ts's `initialSchedule` construction.
 */
function toForwardSchedule(input: SolverInput, out: SolverOutput): ForwardSchedule {
    const plannedCredits = out.semesters.reduce((s, sem) => s + sem.plannedCredits, 0);
    const degreeCreditsMet = input.creditsEarned + plannedCredits >= input.graduationCreditMinimum;
    return {
        studentId: input.studentId,
        homeSchoolId: input.homeSchoolId,
        graduationTerm: input.graduationTerm,
        creditTargetPerSemester: input.creditTargetPerSemester,
        f1Floor: input.f1Floor,
        domesticPartTimeFloor: input.domesticPartTimeFloor,
        graduationCreditMinimum: input.graduationCreditMinimum,
        degreeCreditsMet,
        semesters: out.semesters,
        dprCourseHistoryHash: input.dprCourseHistoryHash,
        computedAt: 0,
        feasibility: out.feasibility,
        state: out.state,
        balanceScore: out.balanceScore,
        assumptions: out.assumptions,
        ...(out.alternativeCandidates ? { alternativeCandidates: out.alternativeCandidates } : {}),
    };
}

/** Build the validator args from a SolverInput + ForwardSchedule (mirrors build.ts). */
function makeValidatorArgs(input: SolverInput, plan: ForwardSchedule): GraduationPathValidatorArgs {
    return {
        plan,
        dpr: input.dpr,
        programRules: {
            degreeCreditMinimum: input.graduationCreditMinimum,
            residencyMinCredits: input.programRules.residencyMinCredits,
            majorCreditMinimum: input.programRules.majorCreditMinimum,
            minorCreditMinimum: null,
            upperLevelMinCredits: input.programRules.upperLevelMinCredits,
            schoolCoreMinCredits: null,
            graduationTargetTerm: input.graduationTerm,
        },
    };
}

// A simple, fully-solvable CAS-style scenario: 100 earned, two required courses
// (4 cr each, offered fall+spring), F-1, two-term horizon. The materialiser
// fills to the 16-credit target with free electives, reaching 100 + 16 + 16 = 132.
function solvableInput(overrides: Partial<SolverInput> = {}): SolverInput {
    return makeInput({
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditsEarned: 100,
        graduationCreditMinimum: 128,
        unmetRequirements: [
            {
                rId: "r1",
                title: "Required Course One",
                category: "major_required",
                credits: 4,
                candidateCourses: ["REQ-UA 1"],
            },
            {
                rId: "r2",
                title: "Required Course Two",
                category: "major_required",
                credits: 4,
                candidateCourses: ["REQ-UA 2"],
            },
        ],
        courseCatalog: new Map([
            ["REQ-UA 1", { title: "Required Course One", credits: 4 }],
            ["REQ-UA 2", { title: "Required Course Two", credits: 4 }],
        ]),
        offerings: new Map([
            ["REQ-UA 1", ["fall", "spring"]],
            ["REQ-UA 2", ["fall", "spring"]],
        ]),
        offeringConfidence: new Map([
            ["REQ-UA 1", "historically_likely"],
            ["REQ-UA 2", "historically_likely"],
        ]),
        ...overrides,
    });
}

// ===========================================================================
// 1. Round-trip validity
// ===========================================================================

describe("materializePlan — round-trip validity", () => {
    it("search → materialize → validator reports feasible; specific_planned slots are fully rich", () => {
        const input = solvableInput();
        const ctx = buildConstraintContext(input);
        const search = searchBestPlan(ctx);
        expect(search.plan).not.toBeNull();

        const out = materializePlan(search.plan!, ctx);

        // The materialised plan is internally feasible (no Stage-8 violations).
        expect(out.feasibility.feasible).toBe(true);
        expect(out.feasibility.constraintViolations).toHaveLength(0);

        // Authoritative gate: wrap into a ForwardSchedule, run the validator.
        const fs = toForwardSchedule(input, out);
        const validator = runGraduationPathValidator(makeValidatorArgs(input, fs));
        expect(validator.feasible).toBe(true);

        // Every specific_planned slot satisfies a real requirement, is bound, and
        // carries a populated rationale / flexibility / downstreamImpact.
        const reqRIds = new Set(input.unmetRequirements.map(r => r.rId));
        const specificSlots = out.semesters.flatMap(s =>
            s.slots.filter(slot => slot.kind === "specific_planned"),
        );
        expect(specificSlots.length).toBeGreaterThan(0);
        for (const slot of specificSlots) {
            if (slot.kind !== "specific_planned") continue;
            expect(slot.bindingState).toBe("bound");
            // Non-empty satisfiesRules, each matching a known requirement.
            expect(slot.satisfiesRules.length).toBeGreaterThan(0);
            for (const rId of slot.satisfiesRules) expect(reqRIds.has(rId)).toBe(true);
            // Rich fields populated.
            expect(slot.rationale).toBeDefined();
            expect(slot.rationale.satisfiesRequirements).toEqual(slot.satisfiesRules);
            expect(Array.isArray(slot.rationale.termConstraints)).toBe(true);
            expect(slot.flexibility).toBeDefined();
            expect(slot.flexibility.earliestPossibleTerm).toBeTruthy();
            expect(slot.flexibility.latestPossibleTerm).toBeTruthy();
            expect(slot.downstreamImpact).toBeDefined();
            expect(Array.isArray(slot.downstreamImpact.courseIds)).toBe(true);
            expect(typeof slot.workloadWeight).toBe("number");
            expect(slot.reason).toMatch(/Required \(major_required\) placed in 20\d\d-(fall|spring)/);
        }

        // Both requirements are covered by a bound specific_planned slot.
        const coveredRIds = new Set(
            specificSlots.flatMap(s => (s.kind === "specific_planned" ? s.satisfiesRules : [])),
        );
        expect(coveredRIds.has("r1")).toBe(true);
        expect(coveredRIds.has("r2")).toBe(true);

        // The wrapped plan is in a clean / trade-off state, not infeasible.
        expect(out.state === "valid-clean" || out.state === "valid-with-trade-offs").toBe(true);
    });

    it("in_progress placements (source 'ip') become kind:'in_progress' slots in their term", () => {
        const input = solvableInput({
            // BASE-UA 1 is in progress in fall and is a prereq the search may rely on.
            coursesInProgress: new Map([["IPX-UA 5", { term: "2026-fall" }]]),
            courseCatalog: new Map([
                ["REQ-UA 1", { title: "Required Course One", credits: 4 }],
                ["REQ-UA 2", { title: "Required Course Two", credits: 4 }],
                ["IPX-UA 5", { title: "In Progress Five", credits: 4 }],
            ]),
        });
        const ctx = buildConstraintContext(input);
        const search = searchBestPlan(ctx);

        // Inject the IP placement as a fixed placement (build.ts/the wiring task
        // will supply these; here we add it directly to exercise the ip branch).
        const planWithIp: PartialPlan = {
            placed: [
                ...search.plan!.placed,
                placed({ courseId: "IPX-UA 5", term: "2026-fall", source: "ip", satisfiesRId: null }),
            ],
        };

        const out = materializePlan(planWithIp, ctx);
        const fallSem = out.semesters.find(s => s.term === "2026-fall")!;
        const ipSlot = fallSem.slots.find(s => s.kind === "in_progress");
        expect(ipSlot).toBeDefined();
        expect(ipSlot!.kind).toBe("in_progress");
        if (ipSlot!.kind === "in_progress") {
            expect(ipSlot!.courseId).toBe("IPX-UA 5");
            expect(ipSlot!.title).toBe("In Progress Five");
            expect(ipSlot!.credits).toBe(4);
        }
    });

    it("a prereq chain round-trips: BASE placed before ADV, prereqChain recorded, validator feasible", () => {
        // ADV-UA 2 requires BASE-UA 1. BASE offered fall, ADV offered spring →
        // the search routes BASE into 2026-fall and ADV into 2027-spring. The
        // materialised ADV slot records the prereq chain + D4-FuturePlacement.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditsEarned: 100,
            graduationCreditMinimum: 128,
            prereqs: new Map([["ADV-UA 2", [{ type: "AND", courses: ["BASE-UA 1"] }]]]),
            unmetRequirements: [
                {
                    rId: "rAdv",
                    title: "Advanced",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["ADV-UA 2"],
                },
                {
                    rId: "rBase",
                    title: "Base",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["BASE-UA 1"],
                },
            ],
            courseCatalog: new Map([
                ["ADV-UA 2", { title: "Advanced", credits: 4 }],
                ["BASE-UA 1", { title: "Base", credits: 4 }],
            ]),
            offerings: new Map([
                ["BASE-UA 1", ["fall"]],
                ["ADV-UA 2", ["spring"]],
            ]),
            offeringConfidence: new Map([
                ["BASE-UA 1", "historically_likely"],
                ["ADV-UA 2", "historically_likely"],
            ]),
        });
        const ctx = buildConstraintContext(input);
        const out = materializePlan(searchBestPlan(ctx).plan!, ctx);

        expect(out.feasibility.feasible).toBe(true);

        const slots = out.semesters.flatMap(s => s.slots.map(slot => ({ term: s.term, slot })));
        const base = slots.find(
            x => x.slot.kind === "specific_planned" && x.slot.courseId === "BASE-UA 1",
        )!;
        const adv = slots.find(
            x => x.slot.kind === "specific_planned" && x.slot.courseId === "ADV-UA 2",
        )!;
        expect(base.term).toBe("2026-fall");
        expect(adv.term).toBe("2027-spring");
        // ADV's rationale records the prereq chain (D4-FuturePlacement: BASE is a
        // planned future placement in an earlier term).
        if (adv.slot.kind === "specific_planned") {
            expect(adv.slot.rationale.decisionsApplied).toContain("D4-FuturePlacement");
            expect(adv.slot.rationale.termConstraints.some(tc => tc.kind === "prereqChain")).toBe(true);
            // BASE is a direct prereq of ADV → BASE is on the critical path / has a dependent.
            expect(adv.slot.satisfiesRules).toEqual(["rAdv"]);
        }
        if (base.slot.kind === "specific_planned") {
            // BASE has ADV as a dependent → downstreamImpact lists it.
            expect(base.slot.downstreamImpact.courseIds).toContain("ADV-UA 2");
        }

        // Authoritative gate passes.
        const fs = toForwardSchedule(input, out);
        expect(runGraduationPathValidator(makeValidatorArgs(input, fs)).feasible).toBe(true);
    });
});

// ===========================================================================
// 2. Free-fill meets target
// ===========================================================================

describe("materializePlan — free-elective fill meets target", () => {
    it("each term reaches its credit target and the total clears the graduation minimum", () => {
        const input = solvableInput();
        const ctx = buildConstraintContext(input);
        const out = materializePlan(searchBestPlan(ctx).plan!, ctx);

        // Each term hits the 16-credit target.
        for (const sem of out.semesters) {
            expect(sem.plannedCredits).toBe(input.creditTargetPerSemester);
        }

        // Total earned + planned clears the graduation minimum.
        const total =
            input.creditsEarned + out.semesters.reduce((s, sem) => s + sem.plannedCredits, 0);
        expect(total).toBeGreaterThanOrEqual(input.graduationCreditMinimum);

        // The free-elective fill produced placeholder slots with the expected shape.
        const freeSlots = out.semesters.flatMap(s =>
            s.slots.filter(
                slot => slot.kind === "placeholder" && slot.category === "Free elective",
            ),
        );
        expect(freeSlots.length).toBeGreaterThan(0);
        for (const slot of freeSlots) {
            if (slot.kind !== "placeholder") continue;
            expect(slot.workloadTier).toBe("free-elective");
            expect(slot.satisfiesRules).toEqual([]);
            expect(slot.bindingState).toBe("placeholder-deferred");
        }
    });

    it("honors a per-term creditTargetPerTerm override when filling", () => {
        const input = solvableInput({
            preferences: { creditTargetPerTerm: { "2027-spring": 12 } },
        });
        const ctx = buildConstraintContext(input);
        const out = materializePlan(searchBestPlan(ctx).plan!, ctx);

        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        expect(fall.plannedCredits).toBe(16); // default target
        expect(spring.plannedCredits).toBe(12); // overridden target
    });
});

// ===========================================================================
// 3. Placeholder for uncovered requirement
// ===========================================================================

describe("materializePlan — placeholder for uncovered requirement", () => {
    it("emits a kind:'placeholder' slot for a requirement whose only candidate is off-catalog", () => {
        // r1 is satisfiable (REQ-UA 1 in catalog); rGap's only candidate is NOT in
        // the catalog → buildRequirementVariables yields empty candidates → the
        // search cannot place it → materializePlan must emit a placeholder for rGap.
        //
        // The DPR's requirementGroups carries a matching `not_satisfied` leaf for
        // rGap (with no coursesUsed) so the authoritative validator axis 1 actually
        // sees the gap — an unbound placeholder does NOT satisfy it → infeasible.
        const dpr = makeMinimalDpr({
            requirementGroups: [
                {
                    rgId: "RGGAP",
                    title: "Gap Group",
                    status: "overall_not_satisfied",
                    statusText: "Overall Requirement Not Satisfied: Gap Group",
                    children: [
                        {
                            rId: "rGap",
                            title: "Unmappable Requirement",
                            status: "not_satisfied",
                            statusText: "Not Satisfied: Unmappable Requirement",
                            coursesUsed: [],
                        },
                    ],
                },
            ],
        });
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditsEarned: 100,
            graduationCreditMinimum: 128,
            dpr,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Satisfiable",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1"],
                },
                {
                    rId: "rGap",
                    title: "Unmappable Requirement",
                    category: "cas_core",
                    credits: 4,
                    candidateCourses: ["MISSING-UA 99"],
                },
            ],
            courseCatalog: new Map([["REQ-UA 1", { title: "Satisfiable", credits: 4 }]]),
            offerings: new Map([["REQ-UA 1", ["fall", "spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const out = materializePlan(searchBestPlan(ctx).plan!, ctx);

        // A placeholder slot carrying rGap appears.
        const allSlots = out.semesters.flatMap(s => s.slots);
        const gapPlaceholder = allSlots.find(
            s => s.kind === "placeholder" && s.satisfiesRules.includes("rGap"),
        );
        expect(gapPlaceholder).toBeDefined();
        if (gapPlaceholder && gapPlaceholder.kind === "placeholder") {
            expect(gapPlaceholder.placeholderId).toBe("REQ-rGap");
            expect(gapPlaceholder.category).toBe("Unmappable Requirement");
            expect(gapPlaceholder.credits).toBe(4);
            expect(gapPlaceholder.bindingState).toMatch(/placeholder-(pending|deferred)/);
            // isCriticalPath mirrors the greedy solver's rule exactly:
            // req.candidateCourses.length === 0. rGap has one (off-catalog)
            // candidate, so the raw list is length 1 → not critical-path.
            expect(gapPlaceholder.isCriticalPath).toBe(false);
            // The unbound placeholder carries rGap as a considered alternative.
            expect(
                gapPlaceholder.rationale.consideredAlternatives.map(a => a.courseId),
            ).toContain("MISSING-UA 99");
        }

        // r1 is still covered by a bound specific_planned slot (not a placeholder).
        const r1Specific = allSlots.find(
            s => s.kind === "specific_planned" && s.satisfiesRules.includes("r1"),
        );
        expect(r1Specific).toBeDefined();

        // Feasibility reflects the gap: the validator fails axis 1 (requirement
        // covered only by an UNBOUND placeholder does not satisfy it).
        const fs = toForwardSchedule(input, out);
        const validator = runGraduationPathValidator(makeValidatorArgs(input, fs));
        expect(validator.feasible).toBe(false);
        expect(validator.axisResults.requirementGroupsSatisfied.status).toBe("fail");
    });

    it("a requirement with NO candidate courses gets a critical-path placeholder (isCriticalPath true)", () => {
        // candidateCourses: [] → the search never sees it; materializePlan emits a
        // placeholder whose isCriticalPath is true (it is the only satisfier).
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditsEarned: 100,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "rOpen",
                    title: "Any Free Elective",
                    category: "free_elective",
                    credits: 4,
                    candidateCourses: [],
                },
            ],
            courseCatalog: new Map(),
            offerings: new Map(),
        });
        const ctx = buildConstraintContext(input);
        const out = materializePlan(searchBestPlan(ctx).plan!, ctx);

        const placeholder = out.semesters
            .flatMap(s => s.slots)
            .find(s => s.kind === "placeholder" && s.satisfiesRules.includes("rOpen"));
        expect(placeholder).toBeDefined();
        if (placeholder && placeholder.kind === "placeholder") {
            expect(placeholder.placeholderId).toBe("REQ-rOpen");
            expect(placeholder.isCriticalPath).toBe(true);
            expect(placeholder.rationale.consideredAlternatives).toEqual([]);
        }
    });
});

// ===========================================================================
// 4. Determinism
// ===========================================================================

describe("materializePlan — determinism", () => {
    it("same plan + ctx → identical SolverOutput (deep-equal semesters + everything else)", () => {
        const input = solvableInput();
        const ctx = buildConstraintContext(input);
        const plan = searchBestPlan(ctx).plan!;

        const out1 = materializePlan(plan, ctx);
        const out2 = materializePlan(plan, ctx);

        expect(out1.semesters).toEqual(out2.semesters);
        expect(out1.feasibility).toEqual(out2.feasibility);
        expect(out1.balanceScore).toBe(out2.balanceScore);
        expect(out1.assumptions).toEqual(out2.assumptions);
        expect(out1.state).toBe(out2.state);
    });

    it("alternativeCandidates is left undefined (real top-K is a later task)", () => {
        const input = solvableInput();
        const ctx = buildConstraintContext(input);
        const out = materializePlan(searchBestPlan(ctx).plan!, ctx);
        expect(out.alternativeCandidates).toBeUndefined();
    });
});
