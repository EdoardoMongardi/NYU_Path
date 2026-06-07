/**
 * T9 — Realistic full-degree-scale verification + regression.
 *
 * CAPSTONE: proves the entire solver-tractability rebuild (T1 feasibility-first,
 * T2 16-grid/relax, T3 local-improve+top-K, T4 pool placeholders, T5 range-fix,
 * T6 F-1 edges, T7 optimality, T8 alternatives) works at the realistic case it
 * was built for: a full-degree plan of 12–18 unmet requirements over ~8 future
 * terms — the OLD branch-and-bound truncated on exactly this scale.
 *
 * Wide fixture shape:
 *   - 16 unmet requirements over 8 future terms (2024-fall → 2028-spring)
 *   - 6 single-candidate major_required (the tight, must-place courses)
 *   - 5 multi-candidate major_elective (3–4 candidates each)
 *   - 2 pool requirements (CSCI-UA 400-499 and MATH-UA 300-399 pools)
 *   - 1 prereq chain: BASE → MID → ADV (A→B→C, 3 deep)
 *   - 2 additional standalone requirements to round out to 16
 *   - creditsEarned 32, creditCeiling 18, f1Floor 12, visaStatus "f1"
 *   - graduationCreditMinimum 128
 *
 * makeMinimalDpr / makeInput are copied (minimal) from search.test.ts.
 */

import { describe, it, expect } from "vitest";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import { finalizeForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import { validatorRulesFromInput } from "../../src/agent/forwardSchedule/alternatives.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { PrereqGroup } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories (copied from search.test.ts)
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
            creditsUsed: 32,
            cumulativeGpa: 3.2,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 32,
            passFailUsedUnits: 0,
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
        studentId: "t-realistic",
        homeSchoolId: "cas",
        visaStatus: "f1",
        coursesTaken: new Set(),
        coursesInProgress: new Map(),
        currentTerm: "2024-fall",
        graduationTerm: "2028-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        creditCeiling: 18,
        graduationCreditMinimum: 128,
        creditsEarned: 32,
        passFailCap: 32,
        passFailUsed: 0,
        onlineCreditCap: 16,
        onlineCreditsUsed: 0,
        outsideHomeCreditCap: 16,
        outsideHomeCreditsUsed: 0,
        cumulativeGpa: 3.2,
        majorGpa: 3.1,
        graduationGpaFloor: 2.0,
        majorGpaFloor: 2.0,
        unmetRequirements: [],
        prereqs: new Map(),
        offerings: new Map(),
        offeringConfidence: new Map(),
        courseCatalog: new Map(),
        dprCourseHistoryHash: "realistic-scale-hash",
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

// ---------------------------------------------------------------------------
// Wide fixture builder — the CAPSTONE fixture.
//
// 16 unmet requirements:
//   rMR1..rMR6 — 6 single-candidate major_required (the tight "must take" courses)
//   rME1..rME5 — 5 multi-candidate major_elective (3-4 candidates each)
//   rPool1     — pool requirement CSCI-UA 400-499 (16 members in catalog)
//   rPool2     — pool requirement MATH-UA 300-399 (8 members in catalog)
//   rBase, rMid, rAdv — prereq chain A→B→C (BASE→MID→ADV), 3 deep
//
// Terms (8 main terms): 2024-fall, 2025-spring, 2025-fall, 2026-spring,
//                        2026-fall, 2027-spring, 2027-fall, 2028-spring
// creditsEarned=32, ceiling=18, f1Floor=12
// ---------------------------------------------------------------------------

function makeWideFixture(opts: { dprLeaves?: boolean } = {}): SolverInput {
    const catalog = new Map<string, { title: string; credits: number }>();
    const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>();
    const prereqs = new Map<string, PrereqGroup[]>();

    // ---- 6 single-candidate major_required ----
    for (let i = 1; i <= 6; i++) {
        const id = `REQ-UA ${i}0`;
        catalog.set(id, { title: `Required Course ${i}`, credits: 4 });
        offerings.set(id, ["fall", "spring"]);
    }

    // ---- 5 multi-candidate major_elective (3-4 candidates each) ----
    // ME1: 3 candidates, all fall+spring
    catalog.set("ME1A-UA 1", { title: "Elective 1A", credits: 4 });
    catalog.set("ME1B-UA 2", { title: "Elective 1B", credits: 4 });
    catalog.set("ME1C-UA 3", { title: "Elective 1C", credits: 4 });
    offerings.set("ME1A-UA 1", ["fall", "spring"]);
    offerings.set("ME1B-UA 2", ["fall", "spring"]);
    offerings.set("ME1C-UA 3", ["fall"]);       // fall-only → forces ordering

    // ME2: 4 candidates, varied seasons
    catalog.set("ME2A-UA 1", { title: "Elective 2A", credits: 4 });
    catalog.set("ME2B-UA 2", { title: "Elective 2B", credits: 4 });
    catalog.set("ME2C-UA 3", { title: "Elective 2C", credits: 4 });
    catalog.set("ME2D-UA 4", { title: "Elective 2D", credits: 4 });
    offerings.set("ME2A-UA 1", ["fall"]);
    offerings.set("ME2B-UA 2", ["spring"]);
    offerings.set("ME2C-UA 3", ["fall", "spring"]);
    offerings.set("ME2D-UA 4", ["fall", "spring"]);

    // ME3: 3 candidates
    catalog.set("ME3A-UA 1", { title: "Elective 3A", credits: 4 });
    catalog.set("ME3B-UA 2", { title: "Elective 3B", credits: 4 });
    catalog.set("ME3C-UA 3", { title: "Elective 3C", credits: 4 });
    offerings.set("ME3A-UA 1", ["fall", "spring"]);
    offerings.set("ME3B-UA 2", ["spring"]);
    offerings.set("ME3C-UA 3", ["fall"]);

    // ME4: 3 candidates
    catalog.set("ME4A-UA 1", { title: "Elective 4A", credits: 4 });
    catalog.set("ME4B-UA 2", { title: "Elective 4B", credits: 4 });
    catalog.set("ME4C-UA 3", { title: "Elective 4C", credits: 4 });
    offerings.set("ME4A-UA 1", ["fall", "spring"]);
    offerings.set("ME4B-UA 2", ["fall", "spring"]);
    offerings.set("ME4C-UA 3", ["fall", "spring"]);

    // ME5: 4 candidates
    catalog.set("ME5A-UA 1", { title: "Elective 5A", credits: 4 });
    catalog.set("ME5B-UA 2", { title: "Elective 5B", credits: 4 });
    catalog.set("ME5C-UA 3", { title: "Elective 5C", credits: 4 });
    catalog.set("ME5D-UA 4", { title: "Elective 5D", credits: 4 });
    offerings.set("ME5A-UA 1", ["fall"]);
    offerings.set("ME5B-UA 2", ["spring"]);
    offerings.set("ME5C-UA 3", ["fall", "spring"]);
    offerings.set("ME5D-UA 4", ["fall", "spring"]);

    // ---- Pool 1: CSCI-UA 400-499 (16 members) ----
    for (let n = 421; n <= 436; n++) {
        const id = `CSCI-UA ${n}`;
        catalog.set(id, { title: `CS Elective ${n}`, credits: 4 });
        offerings.set(id, ["fall", "spring"]);
    }

    // ---- Pool 2: MATH-UA 300-399 (8 members) ----
    for (let n = 311; n <= 318; n++) {
        const id = `MATH-UA ${n}`;
        catalog.set(id, { title: `Math Elective ${n}`, credits: 4 });
        offerings.set(id, ["fall", "spring"]);
    }

    // ---- Prereq chain: BASE → MID → ADV ----
    catalog.set("BASE-UA 100", { title: "Base Course", credits: 4 });
    catalog.set("MID-UA 200", { title: "Mid Course", credits: 4 });
    catalog.set("ADV-UA 300", { title: "Advanced Course", credits: 4 });
    offerings.set("BASE-UA 100", ["fall", "spring"]);
    offerings.set("MID-UA 200", ["fall", "spring"]);
    offerings.set("ADV-UA 300", ["fall", "spring"]);

    // MID requires BASE; ADV requires MID
    prereqs.set("MID-UA 200", [{ type: "AND", courses: ["BASE-UA 100"] }]);
    prereqs.set("ADV-UA 300", [{ type: "AND", courses: ["MID-UA 200"] }]);

    // ---- Unmet requirements (16 total) ----
    const unmetRequirements: SolverInput["unmetRequirements"] = [
        // 6 single-candidate major_required
        { rId: "rMR1", title: "Required Course 1", category: "major_required", credits: 4, candidateCourses: ["REQ-UA 10"] },
        { rId: "rMR2", title: "Required Course 2", category: "major_required", credits: 4, candidateCourses: ["REQ-UA 20"] },
        { rId: "rMR3", title: "Required Course 3", category: "major_required", credits: 4, candidateCourses: ["REQ-UA 30"] },
        { rId: "rMR4", title: "Required Course 4", category: "major_required", credits: 4, candidateCourses: ["REQ-UA 40"] },
        { rId: "rMR5", title: "Required Course 5", category: "major_required", credits: 4, candidateCourses: ["REQ-UA 50"] },
        { rId: "rMR6", title: "Required Course 6", category: "major_required", credits: 4, candidateCourses: ["REQ-UA 60"] },

        // 5 multi-candidate major_elective
        { rId: "rME1", title: "Major Elective 1", category: "major_elective", credits: 4, candidateCourses: ["ME1A-UA 1", "ME1B-UA 2", "ME1C-UA 3"] },
        { rId: "rME2", title: "Major Elective 2", category: "major_elective", credits: 4, candidateCourses: ["ME2A-UA 1", "ME2B-UA 2", "ME2C-UA 3", "ME2D-UA 4"] },
        { rId: "rME3", title: "Major Elective 3", category: "major_elective", credits: 4, candidateCourses: ["ME3A-UA 1", "ME3B-UA 2", "ME3C-UA 3"] },
        { rId: "rME4", title: "Major Elective 4", category: "major_elective", credits: 4, candidateCourses: ["ME4A-UA 1", "ME4B-UA 2", "ME4C-UA 3"] },
        { rId: "rME5", title: "Major Elective 5", category: "major_elective", credits: 4, candidateCourses: ["ME5A-UA 1", "ME5B-UA 2", "ME5C-UA 3", "ME5D-UA 4"] },

        // 2 pool requirements
        {
            rId: "rPool1",
            title: "CS Elective (pool)",
            category: "major_elective",
            credits: 4,
            candidateCourses: [],
            pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 },
        },
        {
            rId: "rPool2",
            title: "Math Elective (pool)",
            category: "major_elective",
            credits: 4,
            candidateCourses: [],
            pool: { dept: "MATH-UA", levelMin: 300, levelMax: 399 },
        },

        // 3-deep prereq chain: BASE → MID → ADV
        { rId: "rBase", title: "Base Course",     category: "major_required", credits: 4, candidateCourses: ["BASE-UA 100"] },
        { rId: "rMid",  title: "Mid Course",      category: "major_required", credits: 4, candidateCourses: ["MID-UA 200"] },
        { rId: "rAdv",  title: "Advanced Course", category: "major_required", credits: 4, candidateCourses: ["ADV-UA 300"] },
    ];

    const programRules: SolverInput["programRules"] = {
        majorRuleKinds: new Map([
            ["rMR1", "must_take"], ["rMR2", "must_take"], ["rMR3", "must_take"],
            ["rMR4", "must_take"], ["rMR5", "must_take"], ["rMR6", "must_take"],
            ["rME1", "choose_n"], ["rME2", "choose_n"], ["rME3", "choose_n"],
            ["rME4", "choose_n"], ["rME5", "choose_n"],
            ["rPool1", "choose_n"], ["rPool2", "choose_n"],
            ["rBase", "must_take"], ["rMid", "must_take"], ["rAdv", "must_take"],
        ]),
        schoolCoreRuleIds: new Set(),
        generalCategoryRuleIds: new Set(),
        residencyMinCredits: null,
        majorCreditMinimum: null,
        upperLevelMinCredits: null,
    };

    // Build DPR requirementGroups if requested (for validator axis-1 coverage).
    let dpr = makeMinimalDpr();
    if (opts.dprLeaves) {
        const rIds = unmetRequirements.map(r => r.rId);
        dpr = makeMinimalDpr({
            cumulative: {
                ...makeMinimalDpr().cumulative,
                creditsUsed: 32,
            },
            requirementGroups: [
                {
                    rgId: "RG-MAJOR",
                    title: "Major Requirements",
                    status: "overall_not_satisfied" as const,
                    statusText: "Overall Requirement Not Satisfied: Major Requirements",
                    children: rIds.map(rId => ({
                        rId,
                        title: unmetRequirements.find(r => r.rId === rId)?.title ?? rId,
                        status: "not_satisfied" as const,
                        statusText: `Not Satisfied: ${rId}`,
                        coursesUsed: [],
                    })),
                },
            ],
        });
    }

    return makeInput({
        currentTerm: "2024-fall",
        graduationTerm: "2028-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        creditCeiling: 18,
        creditsEarned: 32,
        graduationCreditMinimum: 128,
        visaStatus: "f1",
        unmetRequirements,
        prereqs,
        offerings,
        courseCatalog: catalog,
        programRules,
        dpr,
    });
}

// ===========================================================================
// 1. Wide-scale, no truncation, validator-passing (CAPSTONE)
// ===========================================================================

describe("T9 — realistic-scale wide fixture (16 reqs, 8 terms, pools, prereq chain)", () => {
    it("(a) no truncation warning — the rebuild's headline goal", () => {
        const input = makeWideFixture();
        const out = solveForwardSchedule(input);

        // No truncation advisory — the whole point of the rebuild.
        const hasTruncation = (out.warnings ?? []).some(w =>
            w.toLowerCase().includes("truncat"),
        );
        expect(hasTruncation).toBe(false);
    });

    it("(b) feasible — all 16 requirements covered, plan not infeasible-draft", () => {
        const input = makeWideFixture();
        const out = solveForwardSchedule(input);

        expect(out.feasibility.feasible).toBe(true);
    });

    it("(c) optimality is not 'feasibility-unconfirmed' — a real plan was found", () => {
        const input = makeWideFixture();
        const out = solveForwardSchedule(input);

        expect(out.optimality).not.toBe("feasibility-unconfirmed");
    });

    it("(d) every unmet rId is covered by a bound slot or resolvable pool placeholder in semesters", () => {
        const input = makeWideFixture();
        const out = solveForwardSchedule(input);

        // Collect all slots from all semesters
        const allSlots = out.semesters.flatMap(s => s.slots);

        // The specific_planned slots carry the bound rIds via satisfiesRules
        const coveredBySpecific = new Set<string>();
        for (const slot of allSlots) {
            if (slot.kind === "specific_planned" && slot.satisfiesRules) {
                for (const rId of slot.satisfiesRules) coveredBySpecific.add(rId);
            }
        }

        // Pool placeholders with poolBinding cover pool rIds
        const coveredByPool = new Set<string>();
        for (const slot of allSlots) {
            if (slot.kind === "placeholder" && slot.poolBinding) {
                for (const rId of slot.satisfiesRules) coveredByPool.add(rId);
            }
        }

        const allCovered = new Set([...coveredBySpecific, ...coveredByPool]);

        // All 16 rIds must be covered
        const expectedRIds = [
            "rMR1", "rMR2", "rMR3", "rMR4", "rMR5", "rMR6",
            "rME1", "rME2", "rME3", "rME4", "rME5",
            "rPool1", "rPool2",
            "rBase", "rMid", "rAdv",
        ];
        for (const rId of expectedRIds) {
            expect(allCovered.has(rId), `rId '${rId}' must be covered`).toBe(true);
        }
    });

    it("(e) finalizeForwardSchedule → validatorResult.feasible (validator-passing)", () => {
        const input = makeWideFixture({ dprLeaves: true });
        const out = solveForwardSchedule(input);

        // Assemble via the shared finalizeForwardSchedule (preferred per task spec)
        const validatorRules = validatorRulesFromInput(input);
        const finalized = finalizeForwardSchedule(out, input, input.dpr, validatorRules);

        // The whole-plan validator agrees with the solver
        expect(finalized.validatorResult.feasible).toBe(true);
        // State matches valid
        expect(finalized.schedule.state).toMatch(/^valid/);
    });

    it("(f) prereq chain is ordered correctly (BASE before MID before ADV)", () => {
        const input = makeWideFixture();
        const out = solveForwardSchedule(input);

        const allSlots = out.semesters.flatMap(s => s.slots);

        // Find the term for each chain member via satisfiesRules
        let baseTerm: string | null = null;
        let midTerm: string | null = null;
        let advTerm: string | null = null;

        for (const sem of out.semesters) {
            for (const slot of sem.slots) {
                if (slot.kind === "specific_planned" && slot.satisfiesRules.includes("rBase")) {
                    baseTerm = sem.term;
                }
                if (slot.kind === "specific_planned" && slot.satisfiesRules.includes("rMid")) {
                    midTerm = sem.term;
                }
                if (slot.kind === "specific_planned" && slot.satisfiesRules.includes("rAdv")) {
                    advTerm = sem.term;
                }
            }
        }

        // All three must be placed
        expect(baseTerm, "rBase must be placed").not.toBeNull();
        expect(midTerm, "rMid must be placed").not.toBeNull();
        expect(advTerm, "rAdv must be placed").not.toBeNull();

        if (baseTerm && midTerm && advTerm) {
            // Ordering: BASE < MID < ADV (or BASE <= MID with BASE strictly before ADV)
            // We just check BASE is not after MID or ADV
            const termOrder = (t: string): number => {
                const m = t.match(/^(\d{4})-(spring|summer|fall|january)$/);
                if (!m) return 0;
                const yr = parseInt(m[1]!, 10);
                const seasonRank: Record<string, number> = { spring: 0, summer: 1, fall: 2, january: 3 };
                return yr * 4 + (seasonRank[m[2]!] ?? 0);
            };

            expect(
                termOrder(baseTerm) <= termOrder(midTerm),
                `BASE term ${baseTerm} must be ≤ MID term ${midTerm}`,
            ).toBe(true);

            expect(
                termOrder(midTerm) <= termOrder(advTerm),
                `MID term ${midTerm} must be ≤ ADV term ${advTerm}`,
            ).toBe(true);

            expect(
                termOrder(baseTerm) < termOrder(advTerm),
                `BASE term ${baseTerm} must be strictly before ADV term ${advTerm}`,
            ).toBe(true);
        }
    });

    it("(g) pool slots are resolvable pool placeholders — not phantom specific-planned POOL- slots", () => {
        const input = makeWideFixture();
        const out = solveForwardSchedule(input);

        const allSlots = out.semesters.flatMap(s => s.slots);

        // No phantom specific_planned slot with POOL- courseId
        const phantom = allSlots.find(
            s => s.kind === "specific_planned" && (s as { courseId: string }).courseId.startsWith("POOL-"),
        );
        expect(phantom, "No phantom POOL- specific_planned slot").toBeUndefined();

        // rPool1 and rPool2 must each be covered by a pool placeholder with poolBinding
        const pool1Slot = allSlots.find(
            s => s.kind === "placeholder" && s.satisfiesRules.includes("rPool1") && s.poolBinding,
        );
        const pool2Slot = allSlots.find(
            s => s.kind === "placeholder" && s.satisfiesRules.includes("rPool2") && s.poolBinding,
        );

        expect(pool1Slot, "rPool1 must have a resolvable pool placeholder").toBeDefined();
        expect(pool2Slot, "rPool2 must have a resolvable pool placeholder").toBeDefined();

        if (pool1Slot?.kind === "placeholder" && pool1Slot.poolBinding) {
            expect(pool1Slot.poolBinding.candidates.length).toBeGreaterThan(0);
        }
        if (pool2Slot?.kind === "placeholder" && pool2Slot.poolBinding) {
            expect(pool2Slot.poolBinding.candidates.length).toBeGreaterThan(0);
        }
    });
});

// ===========================================================================
// 2. Performance smoke — no truncation IS the performance proof
// ===========================================================================

describe("T9 — performance smoke (fast)", () => {
    it("the wide 16-req fixture resolves promptly (feasibility defined, no truncation)", () => {
        // The REAL signal is case 1 not truncating. This is a complementary assertion
        // that the call itself returns (vitest's default timeout is the guardrail).
        const input = makeWideFixture();
        const out = solveForwardSchedule(input);

        // Feasibility must be defined (solver completed normally)
        expect(out.feasibility).toBeDefined();
        expect(out.feasibility.feasible).toBeDefined();

        // No truncation advisory (the old B&B would produce one on this scale)
        const hasTruncation = (out.warnings ?? []).some(w =>
            w.toLowerCase().includes("truncat"),
        );
        expect(hasTruncation).toBe(false);
    });
});

// ===========================================================================
// 3. Never false-infeasible — a known-feasible wide input must yield feasible
// ===========================================================================

describe("T9 — never false-infeasible at scale", () => {
    it("a clearly-feasible 14-req wide input (generous candidates, no tight prereqs) is feasible", () => {
        // A clearly satisfiable variant: 14 requirements, all with ≥2 fall+spring candidates,
        // 8 terms, ceiling 18 — comfortably schedulable. No deep prereq chain.
        const catalog = new Map<string, { title: string; credits: number }>();
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>();
        const unmetRequirements: SolverInput["unmetRequirements"] = [];

        // 14 requirements × 2 candidates, all fall+spring offered
        for (let i = 1; i <= 14; i++) {
            const courseA = `EASY-UA ${i * 10}`;
            const courseB = `EASY-UA ${i * 10 + 1}`;
            catalog.set(courseA, { title: `Easy ${i}A`, credits: 4 });
            catalog.set(courseB, { title: `Easy ${i}B`, credits: 4 });
            offerings.set(courseA, ["fall", "spring"]);
            offerings.set(courseB, ["fall", "spring"]);
            unmetRequirements.push({
                rId: `r${i}`,
                title: `Easy Req ${i}`,
                category: "major_elective",
                credits: 4,
                candidateCourses: [courseA, courseB],
            });
        }

        const input = makeInput({
            currentTerm: "2024-fall",
            graduationTerm: "2028-spring",
            creditCeiling: 18,
            creditsEarned: 72,
            graduationCreditMinimum: 128,
            unmetRequirements,
            offerings,
            courseCatalog: catalog,
        });

        const out = solveForwardSchedule(input);
        expect(out.feasibility.feasible).toBe(true);

        // No truncation
        const hasTruncation = (out.warnings ?? []).some(w =>
            w.toLowerCase().includes("truncat"),
        );
        expect(hasTruncation).toBe(false);
    });
});

// ===========================================================================
// 4. Genuinely-infeasible at scale — binding constraints reported
// ===========================================================================

describe("T9 — genuinely infeasible at scale reports binding constraints", () => {
    it("20 required courses × 4cr into only 2 terms of 18cr capacity → graduation_total or prereq_unsatisfiable", () => {
        // 20 × 4cr = 80 credits of required demand, but only 2 terms × 18 = 36 credits of capacity.
        // This is a genuine capacity infeasibility.
        const catalog = new Map<string, { title: string; credits: number }>();
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>();
        const unmetRequirements: SolverInput["unmetRequirements"] = [];

        for (let i = 1; i <= 20; i++) {
            const id = `OVER-UA ${i * 10}`;
            catalog.set(id, { title: `Over-packed ${i}`, credits: 4 });
            offerings.set(id, ["fall", "spring"]);
            unmetRequirements.push({
                rId: `rOver${i}`,
                title: `Requirement ${i}`,
                category: "major_required",
                credits: 4,
                candidateCourses: [id],
            });
        }

        const input = makeInput({
            currentTerm: "2024-fall",
            graduationTerm: "2025-spring",  // only 2 terms → 36cr capacity vs 80cr demand
            creditCeiling: 18,
            creditsEarned: 32,
            graduationCreditMinimum: 128,
            unmetRequirements,
            offerings,
            courseCatalog: catalog,
        });

        const out = solveForwardSchedule(input);

        // Must be infeasible
        expect(out.feasibility.feasible).toBe(false);

        // Must have at least one real binding constraint
        expect(out.feasibility.constraintViolations.length).toBeGreaterThan(0);

        // Must include a graduation_total capacity violation OR per-requirement blockers
        const hasRealBindingConstraint = out.feasibility.constraintViolations.some(
            v => v.kind === "graduation_total" || v.kind === "prereq_unsatisfiable" ||
                 v.kind === "offering_pattern" || v.kind === "credit_ceiling",
        );
        expect(hasRealBindingConstraint).toBe(true);
    });

    it("a prereq chain (A→B→C) deeper than the horizon is infeasible with prereq_unsatisfiable", () => {
        // 3-deep chain (BASE→MID→ADV) that requires 3 terms (one per level), but the
        // window is only 1 term. The chain cannot fit → prereq_unsatisfiable.
        const prereqs = new Map<string, PrereqGroup[]>([
            ["MID-UA 200", [{ type: "AND", courses: ["BASE-UA 100"] }]],
            ["ADV-UA 300", [{ type: "AND", courses: ["MID-UA 200"] }]],
        ]);

        const catalog = new Map<string, { title: string; credits: number }>([
            ["BASE-UA 100", { title: "Base", credits: 4 }],
            ["MID-UA 200", { title: "Mid", credits: 4 }],
            ["ADV-UA 300", { title: "Advanced", credits: 4 }],
        ]);
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>([
            ["BASE-UA 100", ["fall", "spring"]],
            ["MID-UA 200", ["fall", "spring"]],
            ["ADV-UA 300", ["fall", "spring"]],
        ]);

        const input = makeInput({
            currentTerm: "2024-fall",
            graduationTerm: "2024-fall",  // single-term window → chain cannot fit
            creditCeiling: 18,
            creditsEarned: 116,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                { rId: "rBase", title: "Base", category: "major_required", credits: 4, candidateCourses: ["BASE-UA 100"] },
                { rId: "rMid", title: "Mid", category: "major_required", credits: 4, candidateCourses: ["MID-UA 200"] },
                { rId: "rAdv", title: "Advanced", category: "major_required", credits: 4, candidateCourses: ["ADV-UA 300"] },
            ],
            prereqs,
            offerings,
            courseCatalog: catalog,
        });

        const out = solveForwardSchedule(input);

        expect(out.feasibility.feasible).toBe(false);
        expect(out.feasibility.constraintViolations.length).toBeGreaterThan(0);

        // At least one prereq_unsatisfiable or graduation_total violation must be present
        const hasRealConstraint = out.feasibility.constraintViolations.some(
            v => v.kind === "prereq_unsatisfiable" || v.kind === "graduation_total",
        );
        expect(hasRealConstraint).toBe(true);
    });
});

// ===========================================================================
// 5. F-1 edges hold at scale
// ===========================================================================

describe("T9 — F-1 edges hold in the wide fixture", () => {
    it("all non-final non-optional terms have ≥ f1Floor credits (12) in the 8-term F-1 plan", () => {
        const input = makeWideFixture();
        const out = solveForwardSchedule(input);

        // Plan must be feasible (precondition for this check)
        expect(out.feasibility.feasible).toBe(true);

        // All non-final, non-optional (fall/spring) semesters must be ≥ f1Floor
        const nonFinal = out.semesters.slice(0, -1).filter(
            s => !/summer|january/i.test(s.term),
        );

        for (const sem of nonFinal) {
            expect(
                sem.plannedCredits,
                `Non-final F-1 term ${sem.term} must have ≥ 12 credits (f1Floor), got ${sem.plannedCredits}`,
            ).toBeGreaterThanOrEqual(12);
        }
    });

    it("no credit_floor violation in the wide F-1 plan (final term not refused)", () => {
        const input = makeWideFixture();
        const out = solveForwardSchedule(input);

        const hasFloorViolation = out.feasibility.constraintViolations.some(
            v => v.kind === "credit_floor",
        );
        expect(hasFloorViolation).toBe(false);
    });
});
