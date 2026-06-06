/**
 * Phase 2 P2.8 / PLAN-5 (structural) — opt-in summer / J-term enumeration as
 * OPTIONAL terms.
 *
 * Six behaviour layers (TDD-first):
 *   1. Enumerator: enumerateTerms honors the flags + chronological order; the
 *      no-flag call equals enumerateMainTerms; isOptionalTerm classifies seasons.
 *   2. Context honors the flags: buildConstraintContext threads
 *      preferences.includeSummer / includeJTerm into ctx.futureTerms.
 *   3. Search places into summer ONLY when opted in (the headline): a
 *      summer-only requirement is unsatisfiable opt-OUT, covered opt-IN.
 *   4. Optional terms are exempt from the F-1 / part-time floor (checkPerTermFloor).
 *   5. Free-fill does NOT pad optional terms (materializePlan).
 *   6. Balance excludes optional terms (scorePlan).
 *
 * Reuses the makeInput / placed / buildConstraintContext helpers (mirrored from
 * constraintModel.test.ts).
 */

import { describe, it, expect } from "vitest";
import {
    enumerateTerms,
    enumerateMainTerms,
    isOptionalTerm,
} from "../../src/agent/forwardSchedule/solverHelpers.js";
import {
    buildConstraintContext,
    checkPerTermFloor,
    scorePlan,
    type PartialPlan,
    type PlacedCourse,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { searchBestPlan } from "../../src/agent/forwardSchedule/search.js";
import { materializePlan } from "../../src/agent/forwardSchedule/materializePlan.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories (mirror constraintModel.test.ts)
// ---------------------------------------------------------------------------

function makeMinimalDpr(
    overrides: Partial<DegreeProgressReport> = {},
): DegreeProgressReport {
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

// ===========================================================================
// 1. Enumerator + isOptionalTerm
// ===========================================================================

describe("enumerateTerms / isOptionalTerm", () => {
    it("no flags === enumerateMainTerms (fall/spring only)", () => {
        const main = enumerateMainTerms("2026-spring", "2027-fall");
        expect(enumerateTerms("2026-spring", "2027-fall")).toEqual(main);
        // Sanity: only fall/spring present.
        expect(main).toEqual(["2026-spring", "2026-fall", "2027-spring", "2027-fall"]);
        for (const t of enumerateTerms("2026-spring", "2027-fall")) {
            expect(isOptionalTerm(t)).toBe(false);
        }
    });

    it("empty-args parity holds for a fall-start window too", () => {
        expect(enumerateTerms("2026-fall", "2027-spring")).toEqual(
            enumerateMainTerms("2026-fall", "2027-spring"),
        );
    });

    it("{ includeSummer: true } inserts summer term(s) in chronological position", () => {
        const terms = enumerateTerms("2026-spring", "2027-fall", { includeSummer: true });
        // summer sits between spring and fall of each year (within range).
        expect(terms).toEqual([
            "2026-spring",
            "2026-summer",
            "2026-fall",
            "2027-spring",
            "2027-summer",
            "2027-fall",
        ]);
        // J-term must NOT appear (only summer requested).
        expect(terms.some(t => t.endsWith("-january"))).toBe(false);
    });

    it("{ includeJTerm: true } inserts january in chronological position", () => {
        const terms = enumerateTerms("2026-spring", "2027-fall", { includeJTerm: true });
        // january sits AFTER fall (SEASON_RANK january = 3, after fall = 2). The
        // window ends at 2027-fall, so 2027-january (a LATER ordinal) is out of range.
        expect(terms).toEqual([
            "2026-spring",
            "2026-fall",
            "2026-january",
            "2027-spring",
            "2027-fall",
        ]);
        expect(terms.some(t => t.endsWith("-summer"))).toBe(false);
    });

    it("both flags → all four seasons in chronological order", () => {
        const terms = enumerateTerms("2026-spring", "2026-fall", {
            includeSummer: true,
            includeJTerm: true,
        });
        // spring(0) → summer(1) → fall(2) within 2026; january(3) of 2026 is AFTER fall
        // but within the window's last ordinal? "2026-fall" ord = 2026*4+2. january 2026
        // ord = 2026*4+3 > end → excluded. So january does NOT appear here.
        expect(terms).toEqual(["2026-spring", "2026-summer", "2026-fall"]);
    });

    it("both flags including the january after the end-fall when range extends", () => {
        const terms = enumerateTerms("2026-fall", "2027-fall", {
            includeSummer: true,
            includeJTerm: true,
        });
        expect(terms).toEqual([
            "2026-fall",
            "2026-january",
            "2027-spring",
            "2027-summer",
            "2027-fall",
        ]);
    });

    it("isOptionalTerm true for summer/january, false for fall/spring", () => {
        expect(isOptionalTerm("2026-summer")).toBe(true);
        expect(isOptionalTerm("2027-january")).toBe(true);
        expect(isOptionalTerm("2026-fall")).toBe(false);
        expect(isOptionalTerm("2026-spring")).toBe(false);
    });
});

// ===========================================================================
// 2. Context honors the flags
// ===========================================================================

describe("buildConstraintContext honors includeSummer / includeJTerm", () => {
    it("includeSummer:true → ctx.futureTerms contains a *-summer term", () => {
        const ctx = buildConstraintContext(
            makeInput({
                currentTerm: "2026-spring",
                graduationTerm: "2027-spring",
                preferences: { includeSummer: true },
            }),
        );
        expect(ctx.futureTerms.some(t => t.endsWith("-summer"))).toBe(true);
    });

    it("no flag → ctx.futureTerms has no summer term", () => {
        const ctx = buildConstraintContext(
            makeInput({ currentTerm: "2026-spring", graduationTerm: "2027-spring" }),
        );
        expect(ctx.futureTerms.some(t => t.endsWith("-summer"))).toBe(false);
        expect(ctx.futureTerms.some(t => t.endsWith("-january"))).toBe(false);
    });

    it("includeJTerm:true → ctx.futureTerms contains a *-january term", () => {
        const ctx = buildConstraintContext(
            makeInput({
                currentTerm: "2026-fall",
                graduationTerm: "2027-fall",
                preferences: { includeJTerm: true },
            }),
        );
        expect(ctx.futureTerms.some(t => t.endsWith("-january"))).toBe(true);
    });
});

// ===========================================================================
// 3. Search places into summer ONLY when opted in (the headline)
// ===========================================================================

describe("search places summer-only requirement ONLY when opted in", () => {
    // A single requirement whose ONLY candidate is offered ONLY in summer.
    function summerOnlyInput(prefs?: { includeSummer?: boolean }): SolverInput {
        return makeInput({
            currentTerm: "2026-spring",
            graduationTerm: "2027-spring",
            // Low minimum so coverage (not credit count) is the binding axis.
            graduationCreditMinimum: 100,
            creditsEarned: 100,
            unmetRequirements: [
                {
                    rId: "R-SUM",
                    title: "Summer-only Seminar",
                    category: "elective",
                    credits: 4,
                    candidateCourses: ["SUM-UA 1"],
                },
            ],
            offerings: new Map([["SUM-UA 1", ["summer"]]]),
            courseCatalog: new Map([["SUM-UA 1", { title: "Summer Seminar", credits: 4 }]]),
            offeringConfidence: new Map([["SUM-UA 1", "historically_full"]]),
            ...(prefs ? { preferences: prefs } : {}),
        });
    }

    it("opt-OUT: requirement is unsatisfiable (no legal term)", () => {
        const ctx = buildConstraintContext(summerOnlyInput());
        const res = searchBestPlan(ctx);
        // Either no plan at all, or a plan that cannot cover R-SUM.
        const coversRSum =
            res.plan != null &&
            res.plan.placed.some(p => p.satisfiesRId === "R-SUM");
        expect(coversRSum).toBe(false);
        // And the requirement is reported unsatisfiable when no plan exists.
        if (res.plan === null) {
            expect(res.unsatisfiable).toContain("R-SUM");
        }
    });

    it("opt-IN: search places it in a summer term and the plan covers it", () => {
        const ctx = buildConstraintContext(summerOnlyInput({ includeSummer: true }));
        const res = searchBestPlan(ctx);
        expect(res.plan).not.toBeNull();
        const slot = res.plan!.placed.find(p => p.satisfiesRId === "R-SUM");
        expect(slot).toBeDefined();
        expect(slot!.courseId).toBe("SUM-UA 1");
        expect(isOptionalTerm(slot!.term)).toBe(true);
        expect(slot!.term.endsWith("-summer")).toBe(true);
    });
});

// ===========================================================================
// 4. Optional terms exempt from the F-1 floor
// ===========================================================================

describe("checkPerTermFloor exempts optional terms", () => {
    it("4-credit SUMMER term (F-1, floor 12) → OK (no credit_floor)", () => {
        const ctx = buildConstraintContext(
            makeInput({
                currentTerm: "2026-spring",
                graduationTerm: "2027-spring",
                preferences: { includeSummer: true },
            }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "X-UA 1", term: "2026-summer", credits: 4 })],
        };
        const r = checkPerTermFloor(plan, ctx);
        expect(r.ok).toBe(true);
        expect(r.violations.some(v => v.kind === "credit_floor")).toBe(false);
    });

    it("CONTRAST: the same 4 credits in a FALL term → credit_floor violation", () => {
        const ctx = buildConstraintContext(
            makeInput({ currentTerm: "2026-spring", graduationTerm: "2027-spring" }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "X-UA 1", term: "2026-fall", credits: 4 })],
        };
        const r = checkPerTermFloor(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations.some(v => v.kind === "credit_floor")).toBe(true);
    });

    it("J-term below floor is also exempt", () => {
        const ctx = buildConstraintContext(
            makeInput({
                currentTerm: "2026-fall",
                graduationTerm: "2027-fall",
                preferences: { includeJTerm: true },
            }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "X-UA 1", term: "2026-january", credits: 2 })],
        };
        expect(checkPerTermFloor(plan, ctx).ok).toBe(true);
    });
});

// ===========================================================================
// 5. Free-fill does NOT pad optional terms
// ===========================================================================

describe("materializePlan does not pad optional terms", () => {
    it("summer term carries only the placed credits (not the target)", () => {
        const input = makeInput({
            currentTerm: "2026-spring",
            graduationTerm: "2027-spring",
            creditTargetPerSemester: 16,
            preferences: { includeSummer: true },
            courseCatalog: new Map([["SUM-UA 1", { title: "Summer Seminar", credits: 4 }]]),
            offeringConfidence: new Map([["SUM-UA 1", "historically_full"]]),
        });
        const ctx = buildConstraintContext(input);
        const plan: PartialPlan = {
            placed: [
                placed({
                    courseId: "SUM-UA 1",
                    term: "2026-summer",
                    credits: 4,
                    source: "requirement",
                    satisfiesRId: null,
                }),
            ],
        };
        const out = materializePlan(plan, ctx);
        const summerSem = out.semesters.find(s => s.term === "2026-summer");
        expect(summerSem).toBeDefined();
        // NOT padded toward the 16-credit target — only the placed 4 credits.
        expect(summerSem!.plannedCredits).toBe(4);

        // Sanity contrast: a fall term in the SAME plan IS padded.
        const fallSem = out.semesters.find(s => s.term === "2026-fall");
        expect(fallSem).toBeDefined();
        expect(fallSem!.plannedCredits).toBe(16);
    });

    it("CONTRAST: the identical single course in a FALL term IS padded toward the target", () => {
        const input = makeInput({
            currentTerm: "2026-spring",
            graduationTerm: "2027-spring",
            creditTargetPerSemester: 16,
            courseCatalog: new Map([["FALL-UA 1", { title: "Fall Seminar", credits: 4 }]]),
            offeringConfidence: new Map([["FALL-UA 1", "historically_full"]]),
        });
        const ctx = buildConstraintContext(input);
        const plan: PartialPlan = {
            placed: [
                placed({
                    courseId: "FALL-UA 1",
                    term: "2026-fall",
                    credits: 4,
                    source: "requirement",
                    satisfiesRId: null,
                }),
            ],
        };
        const out = materializePlan(plan, ctx);
        const fallSem = out.semesters.find(s => s.term === "2026-fall");
        expect(fallSem).toBeDefined();
        expect(fallSem!.plannedCredits).toBe(16);
    });

    it("an optional term below the floor is NOT flagged credit_floor by materialize", () => {
        const input = makeInput({
            currentTerm: "2026-spring",
            graduationTerm: "2027-spring",
            preferences: { includeSummer: true },
            courseCatalog: new Map([["SUM-UA 1", { title: "Summer Seminar", credits: 4 }]]),
            offeringConfidence: new Map([["SUM-UA 1", "historically_full"]]),
        });
        const ctx = buildConstraintContext(input);
        const plan: PartialPlan = {
            placed: [
                placed({
                    courseId: "SUM-UA 1",
                    term: "2026-summer",
                    credits: 4,
                    source: "requirement",
                }),
            ],
        };
        const out = materializePlan(plan, ctx);
        const summerFloorViolation = out.feasibility.constraintViolations.some(
            v => v.kind === "credit_floor" && v.term === "2026-summer",
        );
        expect(summerFloorViolation).toBe(false);
    });
});

// ===========================================================================
// 6. Balance excludes optional terms
// ===========================================================================

describe("scorePlan balance component excludes optional terms", () => {
    it("balance contribution is identical with vs without an empty summer term", () => {
        // Identical fall/spring placements; the ONLY difference between the two
        // contexts is includeSummer (and therefore an extra empty summer term in
        // ctx.futureTerms). With weights.timeToDegree = 0, score === balance only.
        const fallSpringPlaced: PlacedCourse[] = [
            placed({ courseId: "A-UA 1", term: "2026-fall", credits: 8, workloadWeight: 1.0 }),
            placed({ courseId: "B-UA 1", term: "2027-spring", credits: 8, workloadWeight: 1.0 }),
        ];
        const plan: PartialPlan = { placed: fallSpringPlaced };

        const baseInput = {
            currentTerm: "2026-spring" as const,
            graduationTerm: "2027-spring" as const,
        };
        const ctxNoSummer = buildConstraintContext(makeInput(baseInput));
        const ctxWithSummer = buildConstraintContext(
            makeInput({ ...baseInput, preferences: { includeSummer: true } }),
        );

        // Sanity: the summer context really did enumerate a summer term.
        expect(ctxWithSummer.futureTerms.some(t => t.endsWith("-summer"))).toBe(true);
        expect(ctxNoSummer.futureTerms.some(t => t.endsWith("-summer"))).toBe(false);

        const balanceOnly = { balance: 1, timeToDegree: 0 };
        const scoreNoSummer = scorePlan(plan, ctxNoSummer, balanceOnly);
        const scoreWithSummer = scorePlan(plan, ctxWithSummer, balanceOnly);

        expect(scoreWithSummer).toBe(scoreNoSummer);
    });

    it("a lightly-loaded summer term does NOT change the balance component", () => {
        // Same fall/spring; the summer-context plan additionally places a light
        // summer course. The balance proxies must ignore the summer term entirely,
        // so its presence/credits must not move the balance score.
        const fallSpring: PlacedCourse[] = [
            placed({ courseId: "A-UA 1", term: "2026-fall", credits: 8, workloadWeight: 1.0 }),
            placed({ courseId: "B-UA 1", term: "2027-spring", credits: 8, workloadWeight: 1.0 }),
        ];

        const ctxWithSummer = buildConstraintContext(
            makeInput({
                currentTerm: "2026-spring",
                graduationTerm: "2027-spring",
                preferences: { includeSummer: true },
            }),
        );

        const balanceOnly = { balance: 1, timeToDegree: 0 };
        const planNoSummerCourse: PartialPlan = { placed: fallSpring };
        const planWithSummerCourse: PartialPlan = {
            placed: [
                ...fallSpring,
                placed({ courseId: "S-UA 1", term: "2026-summer", credits: 6, workloadWeight: 1.0 }),
            ],
        };

        const scoreA = scorePlan(planNoSummerCourse, ctxWithSummer, balanceOnly);
        const scoreB = scorePlan(planWithSummerCourse, ctxWithSummer, balanceOnly);
        expect(scoreB).toBe(scoreA);
    });

    it("timeToDegree STILL counts optional terms (summer can lower it)", () => {
        // creditsEarned 120, need 128 → 8 more. Place those 8 in the FIRST optional
        // term (summer) — the running total reaches the minimum at the summer index,
        // EARLIER than if those credits sat in a later fall/spring. Lower index ⇒
        // lower timeToDegree cost. This proves optional terms remain in the
        // timeToDegree walk even though they're excluded from balance.
        const ctx = buildConstraintContext(
            makeInput({
                currentTerm: "2026-spring",
                graduationTerm: "2027-spring",
                graduationCreditMinimum: 128,
                creditsEarned: 120,
                preferences: { includeSummer: true },
            }),
        );
        // futureTerms (includeSummer): spring26, summer26, fall26, spring27, (summer27?)
        const summerIdx = ctx.futureTerms.indexOf("2026-summer");
        const fallIdx = ctx.futureTerms.indexOf("2026-fall");
        expect(summerIdx).toBeGreaterThanOrEqual(0);
        expect(fallIdx).toBeGreaterThan(summerIdx);

        const timeOnly = { balance: 0, timeToDegree: 1 };
        const planSummer: PartialPlan = {
            placed: [placed({ courseId: "S-UA 1", term: "2026-summer", credits: 8 })],
        };
        const planFall: PartialPlan = {
            placed: [placed({ courseId: "F-UA 1", term: "2026-fall", credits: 8 })],
        };
        // Reaching the minimum in summer (earlier index) costs strictly less.
        expect(scorePlan(planSummer, ctx, timeOnly)).toBeLessThan(
            scorePlan(planFall, ctx, timeOnly),
        );
    });
});
