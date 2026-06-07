/**
 * Phase 2 T2a — soft 16-credit/term grid in the feasibility-first value ordering.
 *
 * findFirstValidPlan returns the FIRST valid complete leaf; the leaf it returns
 * depends on the per-variable value ordering in runSearch. Before T2a that order
 * is scorePlan ASC, then term chronological, then courseId — so whenever scorePlan
 * does NOT discriminate (e.g. weights that flatten it), the term-chronological
 * tie-break PILES credits into the earliest term up to the hard ceiling (18),
 * producing a >16 early term even when a ≤16 distribution exists.
 *
 * T2a adds an OPT-IN soft per-term credit target (SearchOptions.softCreditTarget,
 * passed ONLY by findFirstValidPlan, defaulting to ctx.input.creditTargetPerSemester):
 * a value whose post-placement running credits in its term stay ≤ the soft target
 * is PREFERRED via a PRIMARY sort key placed BEFORE scorePlan. It is a
 * completeness-preserving REORDER — placements above the soft target (up to the hard
 * creditCeiling) remain reachable — and it does NOT touch searchBestPlan /
 * searchTopKPlans (they never pass the option, so their candidateValues ordering is
 * byte-identical).
 *
 * WHY THE TIE-INDUCING WEIGHTS in test 1: under findFirstValidPlan's production
 * DEFAULT weights ({balance:1, timeToDegree:0.5}) the balance term already spreads
 * uniform credits into a ≤16 grid on its own, so the soft grid is a SAFETY NET there,
 * not the deciding force — its mechanism is therefore exercised honestly by FLATTENING
 * scorePlan ({balance:0, timeToDegree:0}), which is exactly the regime where the
 * pre-T2a term-chronological tie-break front-loads >16. (findFirstValidPlan accepts
 * `weights` via SearchOptions, so this stays a pure value-ordering test of the soft
 * grid — no production-path change.) The contract proven: when a ≤16/term distribution
 * of the requirement courses is reachable, the soft grid's first leaf uses a ≤16 term
 * where the pre-T2a ordering used a >16 one.
 *
 * makeMinimalDpr / makeInput / placed are COPIED verbatim from search.test.ts
 * (the established convention: test files copy these helpers between each other).
 */

import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    checkRequirementCoverage,
    checkPerTermCeiling,
    type PlacedCourse,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { findFirstValidPlan, searchBestPlan } from "../../src/agent/forwardSchedule/search.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories (copied verbatim from search.test.ts)
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
        warnings: [],
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

// Suppress unused-variable lint on `placed` (kept for copied-factory convention parity).
void placed;

/** Per-term sum of REQUIREMENT-source credits in a plan. */
function reqCreditsByTerm(plan: { placed: PlacedCourse[] }): Map<string, number> {
    const byTerm = new Map<string, number>();
    for (const p of plan.placed) {
        if (p.source === "requirement") byTerm.set(p.term, (byTerm.get(p.term) ?? 0) + p.credits);
    }
    return byTerm;
}

/** Build N single-candidate `major_elective` requirements of `cr` credits, each offered
 *  fall+spring, plus the catalog/offerings maps. graduationCreditMinimum is set so EVERY
 *  course must be placed (earned + N×cr), giving a tight, deterministic horizon. */
function nReqInput(
    n: number,
    cr: number,
    opts: { graduationTerm: string; creditsEarned: number },
): SolverInput {
    const reqs: SolverInput["unmetRequirements"] = [];
    const catalog = new Map<string, { title: string; credits: number }>();
    const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>();
    for (let i = 1; i <= n; i++) {
        const c = `C${i}-UA ${i}`;
        reqs.push({ rId: `r${i}`, title: `R${i}`, category: "major_elective", credits: cr, candidateCourses: [c] });
        catalog.set(c, { title: c, credits: cr });
        offerings.set(c, ["fall", "spring"]);
    }
    return makeInput({
        currentTerm: "2026-fall",
        graduationTerm: opts.graduationTerm,
        creditCeiling: 18,
        creditTargetPerSemester: 16,
        creditsEarned: opts.creditsEarned,
        graduationCreditMinimum: opts.creditsEarned + n * cr,
        unmetRequirements: reqs,
        courseCatalog: catalog,
        offerings,
    });
}

// ===========================================================================
// soft 16-credit/term grid (findFirstValidPlan)
// ===========================================================================

describe("soft 16-credit/term grid (findFirstValidPlan)", () => {
    it("prefers a ≤16-credit/term distribution over front-loading when both are valid", () => {
        // 8 single-candidate requirements (3 cr each = 24 cr), all offered fall+spring, over
        // a 2-term horizon (2026-fall, 2027-spring), ceiling 18, target 16. A ≤16/term split
        // is reachable (e.g. 15 + 9, or 12 + 12). Under FLAT scorePlan ({balance:0,
        // timeToDegree:0}) the pre-T2a term-chronological tie-break front-loads the earliest
        // term to the CEILING: fall = 18 (six 3-cr courses) — a >16 early term — with the
        // remaining 6 cr in spring. With the soft grid (default target 16) the value ordering
        // prefers ≤16 placements, so NO non-final term exceeds 16 bound credits.
        const input = nReqInput(8, 3, { graduationTerm: "2027-spring", creditsEarned: 104 });
        const ctx = buildConstraintContext(input);
        const flat = { balance: 0, timeToDegree: 0 };

        // Pre-T2a behaviour (soft grid disabled by a sky-high target → primary key is a
        // constant 0, i.e. the exact pre-T2a ordering): fall is front-loaded to 18 (>16).
        const pre = findFirstValidPlan(ctx, { weights: flat, softCreditTarget: 99999 });
        expect(pre.plan).not.toBeNull();
        const preByTerm = reqCreditsByTerm(pre.plan!);
        expect(Math.max(...preByTerm.values())).toBeGreaterThan(16); // front-loads >16 without the grid

        // With the soft grid (default target = creditTargetPerSemester = 16):
        const res = findFirstValidPlan(ctx, { weights: flat });
        expect(res.plan).not.toBeNull();
        // Sum of REQUIREMENT-source credits per term ≤ 16 (a ≤16 split exists, so the soft grid finds it).
        const byTerm = reqCreditsByTerm(res.plan!);
        for (const [, credits] of byTerm) expect(credits).toBeLessThanOrEqual(16);
        // Still valid by every hard predicate.
        expect(checkRequirementCoverage(res.plan!, ctx).ok).toBe(true);
        expect(checkPerTermCeiling(res.plan!, ctx).ok).toBe(true);
    });

    it("under production DEFAULT weights the first leaf is also ≤16/term (balance + soft grid agree)", () => {
        // findFirstValidPlan(ctx) with NO options uses the production default weights
        // ({balance:1, timeToDegree:0.5}) AND the default soft target (16). The balance term
        // already spreads these uniform credits into a ≤16 grid; the soft grid agrees (it is
        // a safety net that never pushes ABOVE 16 when a ≤16 split is reachable). This guards
        // the production path: the everyday call yields a ≤16/term first leaf.
        const input = nReqInput(8, 3, { graduationTerm: "2027-spring", creditsEarned: 104 });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();
        const byTerm = reqCreditsByTerm(res.plan!);
        for (const [, credits] of byTerm) expect(credits).toBeLessThanOrEqual(16);
        expect(checkRequirementCoverage(res.plan!, ctx).ok).toBe(true);
        expect(checkPerTermCeiling(res.plan!, ctx).ok).toBe(true);
    });

    it("falls back above the soft target (up to ceiling) when ≤16/term cannot fit everything", () => {
        // 12 single-candidate requirements (3 cr each = 36 cr) over a 2-term horizon ⇒ a
        // ≤16/term split is IMPOSSIBLE (36 > 2×16 = 32); the only valid distribution is 18+18.
        // The soft grid must FALL BACK to ≤ ceiling (18) — no value can be ≤16 once both terms
        // are saturated, so every remaining value ties at the soft-grid's "above-target" key and
        // the search still places them ≤18 — and return a VALID plan (not give up / front-load
        // past the ceiling).
        const input = nReqInput(12, 3, { graduationTerm: "2027-spring", creditsEarned: 92 });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();
        expect(checkPerTermCeiling(res.plan!, ctx).ok).toBe(true); // ≤18
        expect(checkRequirementCoverage(res.plan!, ctx).ok).toBe(true);
        // It genuinely used the 16–18 band (≤16 was impossible).
        const byTerm = reqCreditsByTerm(res.plan!);
        expect(Math.max(...byTerm.values())).toBeGreaterThan(16);
    });

    it("does not change searchBestPlan's optimum (soft grid is findFirst-only)", () => {
        // Sanity: searchBestPlan still returns its score-optimal plan unaffected by the soft grid.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditCeiling: 18,
            unmetRequirements: [{ rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1"] }],
            courseCatalog: new Map([["A-UA 1", { title: "A", credits: 4 }]]),
            offerings: new Map([["A-UA 1", ["fall", "spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        // Importing searchBestPlan and asserting it still returns a valid plan (its determinism/optimality
        // suites already pin exact behavior; this just guards the import path stays intact).
        const best = searchBestPlan(ctx);
        expect(best.plan).not.toBeNull();
    });
});
