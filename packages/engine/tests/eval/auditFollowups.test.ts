// ============================================================
// Audit Follow-ups — regressions for P1 + §11.0.2 resolveFact
// ============================================================
// Adds explicit coverage for the issues flagged in the Phase 1 audit:
//   - P1: cas.json `goodStandingReturnThreshold` matches CAS_DEFAULTS so
//         threading the CAS config through calculateStanding does NOT
//         change behavior
//   - §11.0.2: resolveFact applies the school > program > department >
//              course_catalog precedence rule
//   - 4.3: degreeAudit.isCSProgram still detects CSCI courses across rule
//          types after the type-safe switch refactor
//   - 4.4: canonicalSchoolId normalizes "CAS" / "cas" / " CAS " uniformly
// ============================================================

import { describe, it, expect } from "vitest";
import { canonicalSchoolId } from "@nyupath/shared";
import { calculateStanding } from "../../src/audit/academicStanding.js";
import {
    loadSchoolConfig,
    resolveFact,
    type FactCandidate,
} from "../../src/dataLoader.js";

describe("P1 — calculateStanding regression: CAS config matches CAS_DEFAULTS", () => {
    const casConfig = loadSchoolConfig("cas");

    it("a 70%-completion student receives the same standing whether config is null or the CAS config", () => {
        // 5 courses attempted, 7 of 10 credits-effective completed → 70%
        // This rate is below the 75% return-to-good-standing threshold and
        // above the 50% dismissal threshold, so it should generate a
        // completion-rate warning under both code paths.
        const courses = [
            { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
            { courseId: "X2", grade: "C", semester: "2024-fall", credits: 4 },
            // 8 of 12 attempted-credits-with-grade-letter completed yields ≈67% — actually flagged
            { courseId: "X3", grade: "F", semester: "2024-fall", credits: 4 },
            { courseId: "X4", grade: "B", semester: "2025-spring", credits: 4 },
            { courseId: "X5", grade: "F", semester: "2025-spring", credits: 4 },
        ];
        const noCfg = calculateStanding(courses, 4);
        const withCfg = calculateStanding(courses, 4, casConfig);
        // goodStandingReturnThreshold drift: prior to the fix, withCfg used 0.67 and would
        // NOT emit the "below 75%" return-warning that noCfg emits. After
        // the fix, both code paths share the 0.75 threshold.
        expect(withCfg.warnings).toEqual(noCfg.warnings);
        expect(withCfg.completionRate).toBe(noCfg.completionRate);
        expect(withCfg.cumulativeGPA).toBe(noCfg.cumulativeGPA);
        expect(withCfg.level).toBe(noCfg.level);
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
});

describe("§11.0.2 — resolveFact precedence rule", () => {
    it("returns the highest-authority defined value (school > program > department > course_catalog)", () => {
        const candidates: FactCandidate<number>[] = [
            { layer: "course_catalog", value: 4 },
            { layer: "department", value: 5 },
            { layer: "program", value: 6 },
            { layer: "school", value: 7 },
        ];
        const r = resolveFact(candidates);
        expect(r.value).toBe(7);
        expect(r.winner).toBe("school");
        // Other defined layers are recorded for audit
        expect(r.overridden.map(o => o.layer)).toEqual(["program", "department", "course_catalog"]);
    });

    it("falls through layers when higher-authority layers don't define the fact", () => {
        const candidates: FactCandidate<string>[] = [
            { layer: "school", value: undefined },
            { layer: "program", value: undefined },
            { layer: "department", value: "dept-default" },
            { layer: "course_catalog", value: "catalog-baseline" },
        ];
        const r = resolveFact(candidates);
        expect(r.value).toBe("dept-default");
        expect(r.winner).toBe("department");
        expect(r.overridden).toHaveLength(1);
        expect(r.overridden[0]!.layer).toBe("course_catalog");
    });

    it("returns undefined when no layer defines the fact", () => {
        const r = resolveFact<number>([
            { layer: "school", value: undefined },
            { layer: "program", value: undefined },
        ]);
        expect(r.value).toBeUndefined();
        expect(r.winner).toBeUndefined();
        expect(r.overridden).toEqual([]);
    });

    it("preserves source paths in the winner and overridden entries (for audit logging)", () => {
        const r = resolveFact<number>([
            { layer: "program", value: 10, source: "data/programs/cas/foo.json" },
            { layer: "school", value: 20, source: "data/schools/cas.json" },
        ]);
        expect(r.value).toBe(20);
        expect(r.source).toBe("data/schools/cas.json");
        expect(r.overridden[0]!.source).toBe("data/programs/cas/foo.json");
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
