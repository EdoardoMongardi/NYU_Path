/**
 * T2b — add-a-term relax for a too-short DERIVED graduation horizon.
 *
 * The planning engine must NEVER return false-infeasible when the graduation
 * term was DERIVED from credits (no student-stated target) and the horizon is
 * structurally too short to accommodate a deep prereq chain.
 *
 * Fixture design (3-deep chain — fits within MAX_HORIZON_RELAX_TERMS=2):
 *   - 3-deep prereq chain: A → B → C (C requires B, B requires A)
 *   - Each course is 4 credits (3 courses × 4 = 12 credits total)
 *   - Student has 116 credits earned, needs 12 more (grad min 128)
 *
 * Wall-clock derivation (today = June 2026 = Summer):
 *   - inferCurrentTerm → "2026-summer"
 *   - deriveGraduationTerm("2026-summer", 116, 128, 16):
 *       semestersNeeded = ceil(12/16) = 1
 *       step 1 from summer → fall → "2026-fall"
 *   - derived graduation = "2026-fall" (only 1 main term: [2026-fall])
 *
 * Without relax: the solver cannot place A, B, C in strictly sequential order
 * within 1 main term — they become PLACEHOLDERS, and the validator's
 * requirementGroupsSatisfied axis fails → state = "infeasible-draft".
 *
 * After relax 1: graduation = "2027-spring" (2 main terms: [2026-fall, 2027-spring])
 *   A=2026-fall, B=2027-spring → C still needs a term strictly AFTER 2027-spring
 *   → state = "infeasible-draft" (still 1 more relax needed).
 *
 * After relax 2: graduation = "2027-fall" (3 main terms: [2026-fall, 2027-spring, 2027-fall])
 *   A=2026-fall, B=2027-spring, C=2027-fall → all requirements satisfied
 *   → state = "valid-clean" or "valid-with-trade-offs".
 *
 * Negative case (hard target):
 *   - Same fixture BUT session.graduationTarget = "Fall 2026" (stated HARD goal).
 *   - buildForwardSchedule must NOT extend → returns state="infeasible-draft" with
 *     graduationTerm="2026-fall".
 */

import { describe, it, expect } from "vitest";
import { buildForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import { buildSolverInputWithRules } from "../../src/agent/forwardSchedule/buildSolverInput.js";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import { finalizeForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import type { ToolSession } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";

// ---------------------------------------------------------------------------
// Shared fixture helpers (mirrored from forwardScheduleBuild.test.ts)
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
 * Build a DPR with:
 *   - creditsUsed = 116  (needs 12 more for grad min of 128)
 *   - 3 unmet requirement groups (one per course in the 3-deep chain A, B, C)
 *   - Each requirement's statusText encodes the course ID for extraction.
 *
 * creditsNeeded = 12, creditTargetPerSemester = 16
 * → semestersNeeded = ceil(12/16) = 1
 * With wall-clock June 2026 → currentTerm = "2026-summer"
 * → deriveGraduationTerm("2026-summer", 116, 128, 16) = "2026-fall" (1 main term)
 */
function makeChainDpr(): DegreeProgressReport {
    const makeGroup = (rgId: string, rId: string, title: string, courseId: string) => ({
        rgId,
        title,
        status: "not_satisfied" as const,
        statusText: `Complete ${courseId}`,
        children: [
            {
                rId,
                title,
                status: "not_satisfied" as const,
                statusText: `Complete ${courseId}`,
                counter: { kind: "units" as const, required: 4, used: 0, needed: 4 },
                coursesUsed: [],
            },
        ],
    });

    return {
        _meta: makeMeta(),
        header: { studentName: "Chain Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 116,      // needs 12 more; 3 courses × 4 = 12
            cumulativeGpa: 3.2,
            cumulativeGpaRequired: 2.0,
            residencyRequired: null,
            residencyUsed: null,
            passFailUsedUnits: 0,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [
            makeGroup("RG-A", "rA", "Chain Course A", "CHAIN-UA 1"),
            makeGroup("RG-B", "rB", "Chain Course B", "CHAIN-UA 2"),
            makeGroup("RG-C", "rC", "Chain Course C", "CHAIN-UA 3"),
        ],
        courseHistory: [],
    };
}

/**
 * Build a minimal ToolSession for the integration path through buildForwardSchedule.
 *
 * Key: NO graduationTarget → term is DERIVED.
 * The wall-clock (June 2026 = summer) gives currentTerm = "2026-summer",
 * derived graduation = "2026-fall" (1 main term).
 * After 2 relaxes → "2027-fall" (3 main terms): A=2026-fall, B=2027-spring, C=2027-fall.
 */
function makeChainSession(): ToolSession {
    return {
        student: {
            id: "chain-student",
            catalogYear: "2024",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "general_studies", programType: "Major" }],
            coursesTaken: [],
            visaStatus: undefined,
            // No graduationTarget field → derived
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
            residency: { minCredits: null, note: null },
        },
        // Prereqs: B needs A, C needs B
        prereqs: [
            { course: "CHAIN-UA 1", prereqGroups: [], coreqs: [] },
            { course: "CHAIN-UA 2", prereqGroups: [{ type: "AND", courses: ["CHAIN-UA 1"], requiresPetition: false }], coreqs: [] },
            { course: "CHAIN-UA 3", prereqGroups: [{ type: "AND", courses: ["CHAIN-UA 2"], requiresPetition: false }], coreqs: [] },
        ],
        // Course catalog: all 3 courses, 4 credits each
        courses: [
            { id: "CHAIN-UA 1", title: "Chain A", credits: 4 },
            { id: "CHAIN-UA 2", title: "Chain B", credits: 4 },
            { id: "CHAIN-UA 3", title: "Chain C", credits: 4 },
        ],
        // No graduationTarget → term will be derived
    };
}

// ---------------------------------------------------------------------------
// BASELINE: verify the derived single-term window IS infeasible for the chain
// ---------------------------------------------------------------------------

describe("relaxAddTerm — baseline: 1-term derived window cannot place the 3-deep chain", () => {
    it("buildForwardSchedule with graduationTermOverride=2026-fall (1 main term) yields infeasible-draft", () => {
        const dpr = makeChainDpr();
        const session = makeChainSession();
        // Force a 1-term window: only 2026-fall. A 3-deep sequential chain
        // requires 3 strictly-separate terms → infeasible in 1 term.
        const result = buildForwardSchedule({
            session,
            dpr,
            graduationTermOverride: "2026-fall",
        });
        // The validator should flag this as infeasible (requirements not bound as
        // specific_planned slots — they become unbound placeholders).
        expect(result.state).toBe("infeasible-draft");
    });

    it("buildSolverInputWithRules with graduationTermOverride=2026-fall yields a DERIVED=false SolverInput", () => {
        const dpr = makeChainDpr();
        const session = makeChainSession();
        const { solverInput } = buildSolverInputWithRules(session, dpr, { graduationTermOverride: "2026-fall" });
        // Overrides are not derived → wasDerived must be false (no relax applies).
        expect(solverInput.graduationTermWasDerived).toBe(false);
        expect(solverInput.graduationTerm).toBe("2026-fall");
    });

    it("the solver-only path (no validator) for the 1-term window yields infeasible or unbound requirements", () => {
        // Build a minimal SolverInput directly with explicit catalog so we can
        // call solveForwardSchedule and see the raw solver output.
        const prereqs = new Map<string, import("@nyupath/shared").PrereqGroup[]>([
            ["CHAIN-UA 2", [{ type: "AND", courses: ["CHAIN-UA 1"], requiresPetition: false }]],
            ["CHAIN-UA 3", [{ type: "AND", courses: ["CHAIN-UA 2"], requiresPetition: false }]],
        ]);
        const courseCatalog = new Map([
            ["CHAIN-UA 1", { title: "Chain A", credits: 4 }],
            ["CHAIN-UA 2", { title: "Chain B", credits: 4 }],
            ["CHAIN-UA 3", { title: "Chain C", credits: 4 }],
        ]);
        const dpr = makeChainDpr();
        const input: SolverInput = {
            studentId: "t", homeSchoolId: "cas", visaStatus: undefined,
            coursesTaken: new Set(), coursesInProgress: new Map(),
            currentTerm: "2026-fall", graduationTerm: "2026-fall",
            creditTargetPerSemester: 16, f1Floor: null, domesticPartTimeFloor: 8, creditCeiling: 18,
            graduationCreditMinimum: 128, creditsEarned: 116,
            passFailCap: 32, passFailUsed: 0, onlineCreditCap: null, onlineCreditsUsed: 0,
            outsideHomeCreditCap: null, outsideHomeCreditsUsed: 0,
            cumulativeGpa: 3.2, majorGpa: null, graduationGpaFloor: 2.0, majorGpaFloor: null,
            unmetRequirements: [
                { rId: "rA", title: "Chain Course A", category: "general", credits: 4, candidateCourses: ["CHAIN-UA 1"] },
                { rId: "rB", title: "Chain Course B", category: "general", credits: 4, candidateCourses: ["CHAIN-UA 2"] },
                { rId: "rC", title: "Chain Course C", category: "general", credits: 4, candidateCourses: ["CHAIN-UA 3"] },
            ],
            prereqs, offerings: new Map(), offeringConfidence: new Map(), courseCatalog,
            dprCourseHistoryHash: "test-hash",
            dpr,
            programRules: {
                majorRuleKinds: new Map(), schoolCoreRuleIds: new Set(),
                generalCategoryRuleIds: new Set(["rA", "rB", "rC"]),
                residencyMinCredits: null, majorCreditMinimum: null, upperLevelMinCredits: null,
            },
            warnings: [],
        };
        const out = solveForwardSchedule(input);
        // With only 1 main term, the 3-deep chain requirements become unbound placeholders.
        // Either the solver returns infeasible OR it returns a plan where some requirements
        // are placeholders (not bound as specific_planned). In either case the plan is not
        // fully satisfying.
        const allBound = out.semesters.every(sem =>
            sem.slots.filter(sl => sl.kind === "specific_planned").every(sl => sl.satisfiesRules.length > 0)
        );
        const hasUnboundChainSlots = out.semesters.some(sem =>
            sem.slots.some(sl => sl.kind === "placeholder")
        );
        // Either infeasible OR has placeholder/unbound slots (chain not fully placed)
        const planIsProblematic = !out.feasibility.feasible || hasUnboundChainSlots;
        expect(planIsProblematic).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// POSITIVE case: buildForwardSchedule with DERIVED term → relax adds terms
// ---------------------------------------------------------------------------

describe("relaxAddTerm — buildForwardSchedule extends a too-short derived horizon", () => {
    it("returns a valid (non-infeasible-draft) schedule when the chain cannot fit in the derived window", () => {
        const dpr = makeChainDpr();
        const session = makeChainSession();

        // No graduationTarget, no override → term is DERIVED (wall-clock June 2026 →
        // "2026-fall"). The relax loop in build.ts detects infeasibility and extends.
        const result = buildForwardSchedule({ session, dpr });

        // The relax loop should have extended to "2027-fall" (3 main terms), where
        // A=2026-fall, B=2027-spring, C=2027-fall can all be placed in order.
        expect(result.state).toMatch(/^valid/);
    });

    it("the relaxed schedule has a graduationTerm LATER than the naive derived 1-term window (2026-fall)", () => {
        const dpr = makeChainDpr();
        const session = makeChainSession();
        const result = buildForwardSchedule({ session, dpr });

        // With June 2026 wall clock, the naively derived term is "2026-fall".
        // After relax it should be "2027-spring" or "2027-fall" (at least 1 step further).
        const naiveTerm = "2026-fall";
        const relaxedTerm = result.graduationTerm;

        const termYear = (t: string) => parseInt(t.split("-")[0]!, 10);
        const termSeasonRank = (t: string) => ({ spring: 0, summer: 1, fall: 2, january: 3 }[t.split("-")[1]!] ?? 0);
        const termOrd = (t: string) => termYear(t) * 4 + termSeasonRank(t);

        expect(termOrd(relaxedTerm)).toBeGreaterThan(termOrd(naiveTerm));
    });

    it("the relaxed schedule has chain courses placed in prereq order (if placed as bound slots)", () => {
        const dpr = makeChainDpr();
        const session = makeChainSession();
        const result = buildForwardSchedule({ session, dpr });

        // Collect placement terms for bound (specific_planned) course slots
        const termOf = new Map<string, string>();
        for (const sem of result.semesters) {
            for (const slot of sem.slots) {
                if (slot.kind === "specific_planned" && slot.courseId) {
                    termOf.set(slot.courseId, sem.term);
                }
            }
        }

        // Assert prereq order using a proper term ordinal (string comparison is wrong:
        // "2027-fall" < "2027-spring" alphabetically but fall comes AFTER spring).
        const termYear = (t: string) => parseInt(t.split("-")[0]!, 10);
        const termSeasonRank = (t: string) => ({ spring: 0, summer: 1, fall: 2, january: 3 }[t.split("-")[1]!] ?? 0);
        const termOrd = (t: string) => termYear(t) * 4 + termSeasonRank(t);

        const tA = termOf.get("CHAIN-UA 1");
        const tB = termOf.get("CHAIN-UA 2");
        const tC = termOf.get("CHAIN-UA 3");

        // Assert prereq order for any chain courses that ARE placed as bound slots
        if (tA && tB) {
            expect(termOrd(tA) < termOrd(tB)).toBe(true);  // A strictly before B
        }
        if (tB && tC) {
            expect(termOrd(tB) < termOrd(tC)).toBe(true);  // B strictly before C
        }
    });

    it("feasibility.feasible is true after relax", () => {
        const dpr = makeChainDpr();
        const session = makeChainSession();
        const result = buildForwardSchedule({ session, dpr });
        expect(result.feasibility.feasible).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// NEGATIVE case: buildForwardSchedule with a HARD stated target is NOT extended
// ---------------------------------------------------------------------------

describe("relaxAddTerm — NEGATIVE: hard stated graduationTarget is never silently extended", () => {
    it("returns a schedule with the stated graduationTerm when session.graduationTarget is set", () => {
        const dpr = makeChainDpr();
        // Hard target = "Fall 2026": the chain can't fit, but we must NOT silently extend.
        const sessionWithHardTarget: ToolSession = {
            ...makeChainSession(),
            graduationTarget: "Fall 2026",
        };

        const result = buildForwardSchedule({ session: sessionWithHardTarget, dpr });

        // The schedule's graduationTerm must equal the stated hard target exactly.
        expect(result.graduationTerm).toBe("2026-fall");
    });

    it("returns infeasible-draft when a hard target too-short term is given", () => {
        const dpr = makeChainDpr();
        const sessionWithHardTarget: ToolSession = {
            ...makeChainSession(),
            graduationTarget: "Fall 2026",
        };

        const result = buildForwardSchedule({ session: sessionWithHardTarget, dpr });

        // The plan is structurally infeasible at "2026-fall" → must be infeasible-draft.
        expect(result.state).toBe("infeasible-draft");
    });

    it("does not extend when graduationTermOverride (explicit) is the too-short term", () => {
        const dpr = makeChainDpr();
        const session = makeChainSession();

        // An explicit override acts like a hard target: no relax.
        const result = buildForwardSchedule({
            session,
            dpr,
            graduationTermOverride: "2026-fall",
        });

        // Must stay at the overridden term — no silent extension.
        expect(result.graduationTerm).toBe("2026-fall");
        expect(result.state).toBe("infeasible-draft");
    });
});

// ---------------------------------------------------------------------------
// DERIVED flag: buildSolverInputWithRules sets graduationTermWasDerived correctly
// ---------------------------------------------------------------------------

describe("relaxAddTerm — graduationTermWasDerived flag", () => {
    it("is true when no graduationTarget and no override", () => {
        const dpr = makeChainDpr();
        const session = makeChainSession();
        const { solverInput } = buildSolverInputWithRules(session, dpr, {});
        expect(solverInput.graduationTermWasDerived).toBe(true);
    });

    it("is false when graduationTermOverride is provided", () => {
        const dpr = makeChainDpr();
        const session = makeChainSession();
        const { solverInput } = buildSolverInputWithRules(session, dpr, { graduationTermOverride: "2028-spring" });
        expect(solverInput.graduationTermWasDerived).toBe(false);
    });

    it("is false when session.graduationTarget is set", () => {
        const dpr = makeChainDpr();
        const session: ToolSession = {
            ...makeChainSession(),
            graduationTarget: "Spring 2028",
        };
        const { solverInput } = buildSolverInputWithRules(session, dpr, {});
        expect(solverInput.graduationTermWasDerived).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ROUND-TRIP: verify the relax loop terminates and respects MAX_HORIZON_RELAX_TERMS
// ---------------------------------------------------------------------------

describe("relaxAddTerm — relax loop termination", () => {
    it("terminates (does not loop infinitely) even when chain exceeds all relax budget", () => {
        const dpr = makeChainDpr();
        const session = makeChainSession();
        // This just verifies the call completes without hanging.
        const result = buildForwardSchedule({ session, dpr });
        expect(typeof result.graduationTerm).toBe("string");
    });

    it("nextMainTermOrNull correctly steps spring→fall and fall→spring", async () => {
        const { nextMainTermOrNull } = await import("../../src/agent/forwardSchedule/solverHelpers.js");
        expect(nextMainTermOrNull("2026-spring")).toBe("2026-fall");
        expect(nextMainTermOrNull("2026-fall")).toBe("2027-spring");
        expect(nextMainTermOrNull("2027-spring")).toBe("2027-fall");
        expect(nextMainTermOrNull("2026-summer")).toBeNull();  // non-main term → null
        expect(nextMainTermOrNull("bad-term")).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// OVER-EXTEND GUARD: an infeasibility that MORE TERMS cannot fix (here, a
// requirement whose only course is not in the catalog → an unbindable
// placeholder → validator-infeasible) must NOT push the graduation term out.
// The relax loop tries extending (because the horizon was DERIVED), but since no
// extension achieves feasibility, build.ts returns the ORIGINAL derived-horizon
// schedule — same grad term the credit pace derived, not a needlessly-later one.
// ---------------------------------------------------------------------------

describe("relaxAddTerm — does not extend the grad term when more terms cannot fix it", () => {
    /** Derived horizon (no graduationTarget); one unmet requirement for a course that is
     *  NOT in the session catalog → empty candidates → unbound placeholder → the validator's
     *  requirementGroupsSatisfied fails. Adding terms cannot bind a non-existent course. */
    function makeUnbindableDpr(): DegreeProgressReport {
        return {
            _meta: makeMeta(),
            header: { studentName: "Unbindable Student", preparedDate: "01/01/2026" },
            programs: [],
            advisorNotations: [],
            cumulative: {
                creditsRequired: 128,
                creditsUsed: 124, // needs 4 → derived ~1 main term
                cumulativeGpa: 3.2,
                cumulativeGpaRequired: 2.0,
                residencyRequired: null,
                residencyUsed: null,
                passFailUsedUnits: 0,
                passFailCapUnits: 32,
                outsideHomeUsedUnits: 0,
                outsideHomeCapUnits: 16,
                timeLimitYears: 8,
            },
            requirementGroups: [
                {
                    rgId: "RG-X",
                    title: "Missing Course Requirement",
                    status: "not_satisfied" as const,
                    statusText: "Complete MISSING-UA 99",
                    children: [
                        {
                            rId: "rX",
                            title: "Missing Course Requirement",
                            status: "not_satisfied" as const,
                            statusText: "Complete MISSING-UA 99",
                            counter: { kind: "units" as const, required: 4, used: 0, needed: 4 },
                            coursesUsed: [],
                        },
                    ],
                },
            ],
            courseHistory: [],
        };
    }

    function makeUnbindableSession(): ToolSession {
        return {
            student: {
                id: "unbindable-student",
                catalogYear: "2024",
                homeSchool: "cas",
                declaredPrograms: [{ programId: "general_studies", programType: "Major" }],
                coursesTaken: [],
                visaStatus: undefined,
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
                residency: { minCredits: null, note: null },
            },
            prereqs: [],
            courses: [], // MISSING-UA 99 deliberately absent → unbindable
        };
    }

    it("returns the original derived grad term (no useless extension) on an unfixable-by-time infeasibility", () => {
        const dpr = makeUnbindableDpr();
        const session = makeUnbindableSession();

        // The term the credit pace derives, computed independently (wall-clock robust).
        const { solverInput: derivedInput } = buildSolverInputWithRules(session, dpr, {});
        const derivedTerm = derivedInput.graduationTerm;
        expect(derivedInput.graduationTermWasDerived).toBe(true);

        const result = buildForwardSchedule({ session, dpr });

        // Still infeasible per the AUTHORITATIVE validator state (the unbound requirement
        // fails requirementGroupsSatisfied). NOTE: result.feasibility.feasible — the SOLVER's
        // flag — is `true` here (credit-fill alone satisfies the solver's credit-minimum), which
        // is exactly why the relax loop must gate on the VALIDATOR verdict, not this flag.
        expect(result.state).toBe("infeasible-draft");
        // AND the grad term was NOT pushed past the derived one — the unhelpful relax (which the
        // validator-gated loop DID attempt) is not "stuck"; build.ts returns the original.
        expect(result.graduationTerm).toBe(derivedTerm);
    });
});
