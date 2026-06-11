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
 *       fallback) AND buildForwardSchedule returns a ForwardSchedule whose
 *       `.state` is EITHER a valid state with a non-empty schedule, OR an
 *       HONEST infeasible-draft / student-preferred-invalid-draft that carries
 *       a populated infeasibility / failing-axis report.
 *     - FAIL: a thrown error (silent CAS crash) OR an empty/undefined/garbage
 *       result with no explanation.
 *
 * An honest infeasible-draft is an ACCEPTABLE PASS — the point is "no silent
 *     CAS-coupling crash," not "the synthetic numbers happen to be feasible."
 *
 * OBSERVED BRANCH (recorded honestly, re-verified 2026-06-11 after the
 *     offerings gap-fill fix): this synthetic DPR STILL hits the HONEST
 *     INFEASIBLE-DRAFT branch. The classifier resolves the major leaves via
 *     the non-CAS-safe declared-program path (SR7001/10 → major-required,
 *     SR7001/20 → major-elective) and falls back to "unknown" on the non-CAS
 *     core/elective leaves (SR8001/10, SR9001/10) — the seam. The solver emits
 *     PLACEHOLDER slots and the authoritative validator's
 *     `requirementGroupsSatisfied` axis fails honestly: the major-required
 *     leaf SR7001/10 is covered only by a placeholder, not a specific course.
 *     That is a real, fully-explained binding constraint — exactly the
 *     acceptable honest-infeasible PASS, NOT a silent crash.
 *
 *     IMPORTANT — what the offerings gap-fill DID and DID NOT change. The
 *     earlier version of this header attributed the placeholder to the solver
 *     having NO offering rows for the -SHU courses (offering data was loaded
 *     only from the global catalog, never from session.courses). That offerings
 *     limitation IS NOW FIXED: buildSolverInput gap-fills offerings /
 *     offeringConfidence from session.courses[i].termsOffered for ids the
 *     global cache lacks (global authoritative; session fills gaps; tier
 *     "historically_likely"). The -SHU courses now carry real offering rows
 *     ("fall","spring"). VERIFIED: solverInput.offerings.has("CSCI-SHU 210")
 *     === true. But the branch is UNCHANGED — infeasible-draft both before and
 *     after the fix — because the offering domain stage already treated an
 *     ABSENT offering as "legal in any season", so missing offerings were never
 *     the gate for these courses. The remaining gate is a DISTINCT
 *     downstream binding limitation in the constraint-search / materialize
 *     stage (the search emits a placeholder for SR7001/10 even though
 *     CSCI-SHU 210 is catalog-present, offering-present, and its prereq
 *     CSCI-SHU 101 is in coursesTaken). That is a SEPARATE issue, NOT the
 *     offerings gap, and is out of scope for the offerings fix. A future fix to
 *     that binding gate (or a real non-CAS fixture) could flip this to the valid
 *     branch; the test accepts both.
 *
 * THIS TEST DOCUMENTS THE SEAM; IT DOES NOT FIX IT. The classifier is still
 *     CAS-coupled. REAL non-CAS DPR validation remains PENDING a real fixture.
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
const INFEASIBLE_STATES = ["infeasible-draft", "student-preferred-invalid-draft"] as const;
const ALL_STATES = [...VALID_STATES, ...INFEASIBLE_STATES];

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
    // (b) Full pipeline pin: buildForwardSchedule does NOT throw and returns a
    //     ForwardSchedule whose .state is a recognized state — EITHER a valid
    //     state with a non-empty schedule, OR an HONEST infeasible-draft that
    //     carries an infeasibility / failing-axis report.
    // -----------------------------------------------------------------------
    it("buildForwardSchedule produces a recognized state (valid OR honest infeasible-draft) — never a silent crash", () => {
        const dpr = makeNonCasShanghaiDpr();
        const session = makeNonCasShanghaiSession();

        const schedule = buildForwardSchedule({ session, dpr });

        // Not a silent/undefined result.
        expect(schedule).toBeTruthy();
        expect(typeof schedule.state).toBe("string");
        expect(ALL_STATES).toContain(schedule.state);
        expect(Array.isArray(schedule.semesters)).toBe(true);
        expect(schedule.feasibility).toBeTruthy();

        if ((VALID_STATES as readonly string[]).includes(schedule.state)) {
            // VALID branch: a real schedule with at least one planned semester.
            expect(schedule.semesters.length).toBeGreaterThan(0);
            expect(schedule.feasibility.feasible).toBe(true);
        } else {
            // HONEST INFEASIBLE branch: must carry a non-empty explanation.
            // We re-run the authoritative validator (rebuilding the same inputs
            // via buildSolverInputWithRules) to read the structured
            // infeasibilityReport + failing-axis info — the proof that the
            // plan failed HONESTLY rather than crashing or returning garbage.
            const { solverInput, validatorRules } = buildSolverInputWithRules(session, dpr);
            const validatorResult = runGraduationPathValidator({
                plan: schedule,
                dpr,
                programRules: validatorRules,
            });

            // The re-derived state must agree it is infeasible.
            expect(derivePlanStateFromValidator(validatorResult, schedule)).toBe(schedule.state);
            expect(validatorResult.feasible).toBe(false);

            // A populated infeasibility report with a non-empty conflictDetail.
            expect(validatorResult.infeasibilityReport).toBeTruthy();
            expect(validatorResult.infeasibilityReport!.conflictDetail.length).toBeGreaterThan(0);

            // At least one axis must have FAILED with a non-empty reason — the
            // honest binding-constraint signal (not a silent empty result).
            const failingAxes = Object.entries(validatorResult.axisResults).filter(
                ([, v]) => v.status === "fail",
            );
            expect(failingAxes.length).toBeGreaterThan(0);
            for (const [, v] of failingAxes) {
                expect(v.status).toBe("fail");
                if (v.status === "fail") {
                    expect(v.reason.length).toBeGreaterThan(0);
                }
            }

            // The solverInput must have actually carried the non-CAS unmet
            // requirements forward (proves the pipeline didn't drop them on the
            // floor before failing).
            expect(solverInput.unmetRequirements.length).toBeGreaterThan(0);
        }
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
