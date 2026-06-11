/**
 * ============================================================================
 * E2E PIN — synthetic non-CAS DPR through classify → solve → validate
 * ============================================================================
 *
 * ⚠️  SYNTHETIC PIN, NOT A REAL-DATA VALIDATION. There is no real non-CAS DPR
 *     in the repo, and `Docs/core_philosophy.md` #2 forbids fabricating
 *     unverifiable "real" data. So this test starts from a CONSTRUCTED
 *     `DegreeProgressReport` object (see tests/fixtures/dpr_nonCas_synthetic.ts)
 *     — NYU Shanghai / Computer Science, with deliberately non-CAS rgId/rId
 *     values — and runs it through the engine pipeline.
 *
 * `parseDpr` IS INTENTIONALLY SKIPPED. We cannot honestly fabricate a real
 *     non-CAS DPR *text* to parse, so the pin begins from the structured object
 *     (which we control and validate against the Zod schema).
 *
 * WHAT THIS PINS — the requirement-kind classifier's CAS coupling.
 *     `classifyRequirementKind` keys its school-core / general-elective
 *     detection on CAS-specific rgId families (RG5004…RG31395) and the
 *     R1142/* major family. The synthetic DPR uses NONE of those, forcing the
 *     classifier's fallback paths. This test asserts the whole pipeline does
 *     NOT silently CAS-crash on a non-CAS hierarchy.
 *
 * WHAT COUNTS AS PASS vs FAIL here:
 *     - PASS: classifier returns a Map (every leaf gets *some* kind via the
 *       fallback) AND buildForwardSchedule SCHEDULES THE NON-CAS PLAN
 *       END-TO-END — a VALID state (valid-clean or valid-with-trade-offs) with
 *       a non-empty schedule in which the major-required leaf SR7001/10 is
 *       covered by a `specific_planned` slot binding CSCI-SHU 210 (i.e. the
 *       forward-planner actually places the real course, not a placeholder).
 *     - FAIL: a thrown error (silent CAS crash), an infeasible-draft, OR a
 *       schedule that covers the major-required leaf only with a placeholder.
 *
 * CORRECTED TRUTH (2026-06-11) — the non-CAS plan SCHEDULES END-TO-END.
 *     Earlier versions of this header recorded an "honest infeasible-draft" as
 *     the non-CAS outcome and blamed a "residual downstream binding gate in the
 *     constraint-search / materialize stage." THAT FRAMING WAS WRONG. With a
 *     REALISTIC fixture the non-CAS plan reaches `valid-with-trade-offs` and
 *     all four -SHU requirement courses bind as `specific_planned`
 *     (CSCI-SHU 210 → SR7001/10, CSCI-SHU 350 → SR7001/20,
 *     CORE-SHU 100 → SR8001/10, HUMN-SHU 101 → SR9001/10), plus a few
 *     free-elective credit-fill placeholders.
 *
 *     The earlier infeasible-draft had NOTHING to do with a solver bug or any
 *     CAS coupling. Its real cause: the synthetic fixture left EVERY requirement
 *     leaf's `coursesUsed[]` empty. The prereq-satisfaction policy
 *     (src/dpr/prereqSatisfaction.ts, `isPrereqSatisfied` Step 1 / Step 4) is
 *     DELIBERATE: a completed passing course satisfies a prereq only if the
 *     registrar recorded it — i.e. it appears in some leaf's `coursesUsed[]`
 *     (`dpr-satisfiedBy`) OR there is an explicit `minGrades` entry; otherwise
 *     `fail-no-implicit-acceptance`. With every `coursesUsed[]` empty, the
 *     completed `CSCI-SHU 101` (grade A, type EN, in courseHistory) did NOT
 *     satisfy CSCI-SHU 210's prereq (AND[CSCI-SHU 101]), so CSCI-SHU 210 could
 *     not bind, the search exhausted, materialize emitted all-placeholders, and
 *     validator axis-1 failed → infeasible-draft. A REAL DPR records completed
 *     courses in `coursesUsed[]`; the fixture now models that (a SATISFIED leaf
 *     SR7001/05 whose `coursesUsed` carries CSCI-SHU 101), which flips the plan
 *     to valid-with-trade-offs. The fix was FIXTURE REALISM, not a solver
 *     change — no src/ file was touched.
 *
 * THE CLASSIFIER IS STILL CAS-COUPLED — that part is real and UNCHANGED.
 *     `classifyRequirementKind` resolves the major leaves via the non-CAS-safe
 *     declared-program path (SR7001/10 → major-required, SR7001/20 →
 *     major-elective) but falls back to "unknown" on the non-CAS core/elective
 *     leaves (SR8001/10, SR9001/10). That CAS coupling is genuine and remains
 *     pinned by test (a) below. The corrected point is that the CAS-coupled
 *     classifier does NOT block scheduling — the plan schedules end-to-end even
 *     with those leaves classified "unknown". REAL non-CAS DPR validation still
 *     remains PENDING a real fixture; this stays synthetic.
 * ============================================================================
 */

import { describe, it, expect } from "vitest";
import { buildForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import { buildSolverInputWithRules } from "../../src/agent/forwardSchedule/buildSolverInput.js";
import {
    runGraduationPathValidator,
    derivePlanStateFromValidator,
} from "../../src/agent/forwardSchedule/graduationPathValidator.js";
import { classifyRequirementKind } from "../../src/agent/forwardSchedule/requirementKind.js";
import { walkRequirements } from "../../src/dpr/schema.js";
import {
    makeNonCasShanghaiDpr,
    makeNonCasShanghaiSession,
} from "../fixtures/dpr_nonCas_synthetic.js";

const VALID_STATES = ["valid-clean", "valid-with-trade-offs"] as const;

describe("non-CAS synthetic DPR — classifier CAS-coupling pin", () => {
    // -----------------------------------------------------------------------
    // (a) Classifier pin: returns a Map without throwing; every leaf gets a
    //     kind via the fallback path (no silent crash on the non-CAS rgIds).
    // -----------------------------------------------------------------------
    it("classifyRequirementKind does NOT throw on non-CAS rgIds and maps every leaf", () => {
        const dpr = makeNonCasShanghaiDpr();
        const session = makeNonCasShanghaiSession();

        const kinds = classifyRequirementKind({
            groups: dpr.requirementGroups,
            declaredPrograms: session.student!.declaredPrograms,
        });

        expect(kinds).toBeInstanceOf(Map);

        // Every leaf requirement got SOME kind (fallback included: "unknown"
        // is a valid fallback outcome — the seam being pinned).
        const leaves = walkRequirements(dpr.requirementGroups);
        expect(leaves.length).toBeGreaterThan(0);
        for (const leaf of leaves) {
            expect(kinds.has(leaf.rId)).toBe(true);
            // Each kind is one of the known RequirementKind values.
            expect([
                "major-required",
                "major-elective",
                "school-core",
                "general-elective",
                "free-elective",
                "unknown",
            ]).toContain(kinds.get(leaf.rId));
        }

        // Sanity on the seam itself: the MAJOR group (title overlaps the
        // declared-program label) resolves via the non-CAS-safe declared-
        // program path — NOT via a CAS rgId. The major-required leaf must
        // therefore be classified as a major kind, proving the fallback path
        // is exercised (not the CAS rgId table).
        expect(kinds.get("SR7001/10")).toBe("major-required");
        expect(kinds.get("SR7001/20")).toBe("major-elective");
    });

    // -----------------------------------------------------------------------
    // (b) Full-pipeline END-TO-END pin: buildForwardSchedule SCHEDULES the
    //     non-CAS plan to a VALID state, with the major-required leaf SR7001/10
    //     covered by a `specific_planned` slot binding the real course
    //     CSCI-SHU 210 — proving the forward-planner works for non-CAS students
    //     (the CAS-coupled classifier does NOT block scheduling). No escape
    //     hatch: an infeasible-draft here is a REGRESSION, not an acceptable
    //     "honest infeasible".
    // -----------------------------------------------------------------------
    it("buildForwardSchedule schedules the non-CAS plan END-TO-END (valid state, CSCI-SHU 210 bound)", () => {
        const dpr = makeNonCasShanghaiDpr();
        const session = makeNonCasShanghaiSession();

        const schedule = buildForwardSchedule({ session, dpr });

        // Not a silent/undefined result.
        expect(schedule).toBeTruthy();
        expect(typeof schedule.state).toBe("string");
        expect(Array.isArray(schedule.semesters)).toBe(true);
        expect(schedule.feasibility).toBeTruthy();

        // END-TO-END: the plan reaches a VALID state — NOT infeasible-draft.
        // (The old "valid OR honest-infeasible-draft" escape hatch is removed:
        //  with a realistic fixture this schedules, so an infeasible-draft now
        //  signals a real regression.)
        expect(VALID_STATES as readonly string[]).toContain(schedule.state);
        expect(schedule.semesters.length).toBeGreaterThan(0);
        expect(schedule.feasibility.feasible).toBe(true);

        // The authoritative validator agrees the plan is feasible.
        const { validatorRules } = buildSolverInputWithRules(session, dpr);
        const validatorResult = runGraduationPathValidator({
            plan: schedule,
            dpr,
            programRules: validatorRules,
        });
        expect(validatorResult.feasible).toBe(true);
        expect(derivePlanStateFromValidator(validatorResult, schedule)).toBe(schedule.state);

        // Collect every specific_planned slot across all semesters.
        const specificPlanned = schedule.semesters
            .flatMap((s) => s.slots)
            .filter((slot) => slot.kind === "specific_planned");

        // The major-required leaf SR7001/10 is covered by a specific_planned
        // slot binding the REAL course CSCI-SHU 210 (NOT a placeholder). This
        // is the load-bearing proof that the non-CAS forward-planner schedules
        // the real major course end-to-end.
        const cs210Slot = specificPlanned.find(
            (slot) =>
                slot.courseId === "CSCI-SHU 210" &&
                slot.satisfiesRules.includes("SR7001/10"),
        );
        expect(cs210Slot).toBeTruthy();

        // All four -SHU requirement courses bind as specific_planned, each
        // covering its non-CAS leaf — including the SR8001/10 and SR9001/10
        // leaves the CAS-coupled classifier could only classify as "unknown".
        const boundFor = (courseId: string, rId: string): boolean =>
            specificPlanned.some(
                (slot) => slot.courseId === courseId && slot.satisfiesRules.includes(rId),
            );
        expect(boundFor("CSCI-SHU 210", "SR7001/10")).toBe(true);
        // SR7001/20 elective: either CSCI-SHU 350 or CSCI-SHU 360 satisfies it.
        expect(
            boundFor("CSCI-SHU 350", "SR7001/20") || boundFor("CSCI-SHU 360", "SR7001/20"),
        ).toBe(true);
        expect(boundFor("CORE-SHU 100", "SR8001/10")).toBe(true);
        expect(boundFor("HUMN-SHU 101", "SR9001/10")).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Structural guarantee: the fixture parses against the Zod schema (it
    // already calls .parse internally — this asserts construction never throws
    // and yields the expected shape).
    // -----------------------------------------------------------------------
    it("the synthetic DPR is structurally valid (Zod-parsed) and uses non-CAS rgIds", () => {
        const dpr = makeNonCasShanghaiDpr();
        // No CAS rgId family appears anywhere in the synthetic groups.
        const casRgIds = [
            "RG5004", "RG5007", "RG5393", "RG33308",
            "RG5002", "RG5005", "RG31394", "RG31395",
        ];
        const allRgIds = dpr.requirementGroups.map((g) => g.rgId);
        for (const cas of casRgIds) {
            expect(allRgIds).not.toContain(cas);
        }
        // No leaf rId is in the CAS R1142/* major family.
        const leaves = walkRequirements(dpr.requirementGroups);
        for (const leaf of leaves) {
            expect(leaf.rId.startsWith("R1142/")).toBe(false);
        }
    });
});
