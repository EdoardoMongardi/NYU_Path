// ============================================================
// Audit Follow-ups — regressions for P1 + canonicalSchoolId
// ============================================================
// Adds explicit coverage for the issues flagged in the Phase 1 audit:
//   - P1: credit-completion-rate standing is per-school — the completion-rate
//         warning is gated on a school's completionRatePolicy (CAS publishes
//         one; the null-config path does not), not a universal CAS default
//   - 4.4: canonicalSchoolId normalizes "CAS" / "cas" / " CAS " uniformly
// ============================================================

import { describe, it, expect } from "vitest";
import { canonicalSchoolId } from "@nyupath/shared";
import { calculateStanding } from "../../src/audit/academicStanding.js";
import { loadSchoolConfig } from "../../src/dataLoader.js";

describe("P1 — calculateStanding: completion-rate standing is per-school", () => {
    const casConfig = loadSchoolConfig("cas");

    it("a sub-75% student is flagged on the CAS config but not when no school policy applies", () => {
        // 5 courses: A, C, F, B, F → 12 of 20 attempted credits completed (60%),
        // cumulative GPA 1.8. 60% is below CAS's 75% pace floor and above its
        // 50% dismissal floor. The completion math + GPA + overall level are
        // identical regardless of config; only the completion-rate WARNING is
        // gated on a school that publishes a completionRatePolicy (CAS does;
        // the null-config path has no policy → no completion warning).
        const courses = [
            { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
            { courseId: "X2", grade: "C", semester: "2024-fall", credits: 4 },
            { courseId: "X3", grade: "F", semester: "2024-fall", credits: 4 },
            { courseId: "X4", grade: "B", semester: "2025-spring", credits: 4 },
            { courseId: "X5", grade: "F", semester: "2025-spring", credits: 4 },
        ];
        const noCfg = calculateStanding(courses, 4);
        const withCfg = calculateStanding(courses, 4, casConfig);
        // Pure facts are config-independent.
        expect(withCfg.completionRate).toBe(noCfg.completionRate);
        expect(withCfg.cumulativeGPA).toBe(noCfg.cumulativeGPA);
        expect(withCfg.level).toBe(noCfg.level);
        // The completion-rate warning is CAS-policy-driven, not universal.
        const isCompletionWarning = (w: string) => w.toLowerCase().includes("completion");
        expect(withCfg.warnings.some(isCompletionWarning)).toBe(true);
        expect(noCfg.warnings.some(isCompletionWarning)).toBe(false);
    });

    it("clean 100%-completion student is in good standing under both code paths", () => {
        const courses = [
            { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
            { courseId: "X2", grade: "B+", semester: "2025-spring", credits: 4 },
        ];
        const noCfg = calculateStanding(courses, 2);
        const withCfg = calculateStanding(courses, 2, casConfig);
        expect(noCfg.level).toBe("good_standing");
        expect(withCfg.level).toBe("good_standing");
        expect(withCfg.warnings).toEqual(noCfg.warnings);
    });

    it("uses the DPR-supplied required GPA as the flat floor (Step 8e)", () => {
        // B + C → cumulative GPA 2.5, 100% completion. schoolConfig no longer
        // carries overallGpaMin; the flat floor is the DPR's
        // cumulativeGpaRequired (4th arg). A tiered gpaTierTable still wins.
        const courses = [
            { courseId: "X1", grade: "B", semester: "2024-fall", credits: 4 },
            { courseId: "X2", grade: "C", semester: "2025-spring", credits: 4 },
        ];
        expect(calculateStanding(courses, 2, null, 2.0).cumulativeGPA).toBe(2.5);
        // Floor 3.0 (from the DPR) → 2.5 is below → academic_concern.
        expect(calculateStanding(courses, 2, null, 3.0).level).toBe("academic_concern");
        // Floor 2.0 → 2.5 is above → good standing.
        expect(calculateStanding(courses, 2, null, 2.0).level).toBe("good_standing");
    });
});

describe("4.4 — canonicalSchoolId normalizes case across the boundary", () => {
    it("Program.school 'CAS' === StudentProfile.homeSchool 'cas' after canonicalization", () => {
        expect(canonicalSchoolId("CAS")).toBe(canonicalSchoolId("cas"));
        expect(canonicalSchoolId("CAS")).toBe("cas");
    });

    it("trims whitespace", () => {
        expect(canonicalSchoolId("  Tandon  ")).toBe("tandon");
    });
});
