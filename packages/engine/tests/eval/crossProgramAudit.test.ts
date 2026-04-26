// ============================================================
// Cross-Program Audit — Group 4 tests (Phase 1 §11.2 doubleCounting)
// ============================================================
// Exercises the multi-program audit using a synthetic "Math minor"
// fixture that intentionally shares MATH-UA 120 and MATH-UA 121 with
// the existing CS BA program (both required by `cs_ba_math_*` rules).
//
// No bulletin dependency — the math-minor fixture is fabricated for
// this test only. Uses the real `data/schools/cas.json` SchoolConfig.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Program, Rule, StudentProfile } from "@nyupath/shared";
import {
    loadCourses,
    loadProgram,
    loadSchoolConfig,
} from "../../src/dataLoader.js";
import { crossProgramAudit } from "../../src/audit/crossProgramAudit.js";
import { degreeAudit } from "../../src/audit/degreeAudit.js";

// ---- fixtures ----

const PROFILE_DIR = join(__dirname, "profiles");
function loadProfile(name: string): StudentProfile {
    const raw = readFileSync(join(PROFILE_DIR, `${name}.json`), "utf-8");
    return JSON.parse(raw) as StudentProfile;
}

/**
 * Synthetic Math minor — must_take MATH-UA 120 + MATH-UA 121 so it
 * deliberately overlaps with CS BA's math-prereq rules. Catalog year
 * matches the existing CS BA fixture (2023) for compatibility with the
 * test profiles.
 */
const MATH_MINOR: Program = {
    programId: "cas_math_minor",
    name: "Mathematics Minor (test fixture)",
    catalogYear: "2023",
    school: "CAS",
    department: "Mathematics",
    totalCreditsRequired: 16,
    rules: [
        {
            ruleId: "math_minor_required",
            label: "Math Minor Required",
            type: "must_take",
            doubleCountPolicy: "allow",
            catalogYearRange: ["2018", "2030"],
            courses: ["MATH-UA 120", "MATH-UA 121"],
        } as Rule,
        {
            ruleId: "math_minor_electives",
            label: "Math Minor Electives",
            type: "choose_n",
            doubleCountPolicy: "allow",
            catalogYearRange: ["2018", "2030"],
            n: 2,
            fromPool: ["MATH-UA 122", "MATH-UA 123", "MATH-UA 140", "MATH-UA 235"],
        } as Rule,
    ],
};

// ============================================================
// Group 4 — multi-program planner / cross-program audit
// ============================================================
describe("crossProgramAudit — multi-program audit (CS BA + Math minor)", () => {
    const courses = loadCourses();
    const csConfig = loadSchoolConfig("cas");
    const csBA = loadProgram("cs_major_ba", "2023")!;
    const programs = new Map<string, Program>([
        [csBA.programId, csBA],
        [MATH_MINOR.programId, MATH_MINOR],
    ]);

    it("runs degreeAudit per declared program and returns one entry each", () => {
        const profile = loadProfile("senior_almost_done");
        const student: StudentProfile = {
            ...profile,
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major" },
                { programId: "cas_math_minor", programType: "minor" },
            ],
        };

        const result = crossProgramAudit(student, programs, courses, csConfig);
        expect(result.programs).toHaveLength(2);
        expect(result.programs.map(p => p.declaration.programId)).toEqual([
            "cs_major_ba",
            "cas_math_minor",
        ]);
        // Each entry's audit is shaped like a normal AuditResult
        expect(result.programs[0]!.audit.studentId).toBe(student.id);
        expect(result.programs[0]!.audit.programId).toBe("cs_major_ba");
    });

    it("identifies courses shared across two programs", () => {
        const profile = loadProfile("senior_almost_done");
        const student: StudentProfile = {
            ...profile,
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major" },
                { programId: "cas_math_minor", programType: "minor" },
            ],
        };

        const result = crossProgramAudit(student, programs, courses, csConfig);
        const sharedIds = result.sharedCourses.map(s => s.courseId).sort();
        expect(sharedIds).toContain("MATH-UA 120");
        expect(sharedIds).toContain("MATH-UA 121");
        // Each shared course is associated with both program ids
        for (const sc of result.sharedCourses) {
            expect(sc.programIds).toContain("cs_major_ba");
            expect(sc.programIds).toContain("cas_math_minor");
        }
    });

    it("CAS major↔minor limit is 2; sharing exactly 2 courses produces no warning", () => {
        // freshman_clean has only MATH-UA 120 + MATH-UA 121 — exactly 2
        // shared math courses with the minor's must_take rule, no electives.
        const profile = loadProfile("freshman_clean");
        const student: StudentProfile = {
            ...profile,
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major" },
                { programId: "cas_math_minor", programType: "minor" },
            ],
        };
        const result = crossProgramAudit(student, programs, courses, csConfig);
        const overflow = result.warnings.filter(w => w.kind === "exceeds_pair_limit");
        expect(overflow).toEqual([]);
        // sanity: the two math courses are still detected as shared
        const sharedMath = result.sharedCourses.filter(s => s.courseId.startsWith("MATH-UA"));
        expect(sharedMath).toHaveLength(2);
    });

    it("senior_almost_done shares exactly 2 math courses (must_take 120 + 121) — at the major↔minor limit, no overflow", () => {
        // Phase 3 Gap C: the Math minor's choose_n (n=2) electives rule
        // matches MATH-UA 122 + 140 from the senior's coursework, but those
        // courses are NOT in CS BA's rule set, so they don't appear in the
        // cross-program shared list. Only the must_take 120 + 121 are shared.
        // (Pre-Gap-C, choose_n over-populated `coursesSatisfying` and this
        // test asserted a buggy 4-shared state. Now corrected.)
        const profile = loadProfile("senior_almost_done");
        const student: StudentProfile = {
            ...profile,
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major" },
                { programId: "cas_math_minor", programType: "minor" },
            ],
        };
        const result = crossProgramAudit(student, programs, courses, csConfig);
        expect(result.sharedCourses.map(s => s.courseId).sort()).toEqual(["MATH-UA 120", "MATH-UA 121"]);
        const overflow = result.warnings.filter(w => w.kind === "exceeds_pair_limit");
        expect(overflow).toEqual([]);
    });

    it("Tightening doubleCounting.defaultMajorToMinor to 1 produces an exceeds_pair_limit warning", () => {
        const profile = loadProfile("senior_almost_done");
        const student: StudentProfile = {
            ...profile,
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major" },
                { programId: "cas_math_minor", programType: "minor" },
            ],
        };
        const tightConfig = {
            ...csConfig!,
            doubleCounting: {
                ...csConfig!.doubleCounting!,
                defaultMajorToMinor: 1,
            },
        };
        const result = crossProgramAudit(student, programs, courses, tightConfig);
        const overflow = result.warnings.filter(w => w.kind === "exceeds_pair_limit");
        expect(overflow.length).toBeGreaterThan(0);
        expect(overflow[0]!.programIds).toContain("cs_major_ba");
        expect(overflow[0]!.programIds).toContain("cas_math_minor");
    });

    it("noTripleCounting flags a course shared across 3 programs", () => {
        // Build a 3-program scenario by adding a fake "math-applied minor" that
        // also requires MATH-UA 120
        const APPLIED_MATH: Program = {
            ...MATH_MINOR,
            programId: "cas_applied_math_minor",
            name: "Applied Math Minor (fixture)",
            rules: [
                {
                    ruleId: "applied_math_required",
                    label: "Applied Math Required",
                    type: "must_take",
                    doubleCountPolicy: "allow",
                    catalogYearRange: ["2018", "2030"],
                    courses: ["MATH-UA 120"],
                } as Rule,
            ],
        };
        const programs3 = new Map(programs);
        programs3.set(APPLIED_MATH.programId, APPLIED_MATH);

        const profile = loadProfile("senior_almost_done");
        const student: StudentProfile = {
            ...profile,
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major" },
                { programId: "cas_math_minor", programType: "minor" },
                { programId: "cas_applied_math_minor", programType: "minor" },
            ],
        };

        const result = crossProgramAudit(student, programs3, courses, csConfig);
        const triple = result.warnings.filter(w => w.kind === "triple_count");
        expect(triple.length).toBeGreaterThan(0);
        expect(triple.some(w => w.courseId === "MATH-UA 120")).toBe(true);
    });

    it("with no SchoolConfig (null), no double-count or triple-count warnings are emitted", () => {
        const profile = loadProfile("senior_almost_done");
        const student: StudentProfile = {
            ...profile,
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major" },
                { programId: "cas_math_minor", programType: "minor" },
            ],
        };
        const result = crossProgramAudit(student, programs, courses, null);
        expect(result.warnings).toEqual([]);
        // sharedCourses are still detected — only the policy enforcement is silent
        expect(result.sharedCourses.length).toBeGreaterThan(0);
    });

    it("skips unknown program ids without throwing", () => {
        const profile = loadProfile("freshman_clean");
        const student: StudentProfile = {
            ...profile,
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major" },
                { programId: "nonexistent_program", programType: "minor" },
            ],
        };
        const result = crossProgramAudit(student, programs, courses, csConfig);
        expect(result.programs).toHaveLength(1);
        expect(result.programs[0]!.declaration.programId).toBe("cs_major_ba");
    });

    it("regression: a single-program audit through crossProgramAudit matches a direct degreeAudit", () => {
        const profile = loadProfile("senior_almost_done");
        const direct = degreeAudit(profile, csBA, courses, csConfig);
        const cross = crossProgramAudit(profile, programs, courses, csConfig);
        const csEntry = cross.programs.find(p => p.declaration.programId === "cs_major_ba");
        expect(csEntry).toBeDefined();
        expect(csEntry!.audit.overallStatus).toBe(direct.overallStatus);
        expect(csEntry!.audit.totalCreditsCompleted).toBe(direct.totalCreditsCompleted);
        expect(csEntry!.audit.rules.length).toBe(direct.rules.length);
    });
});
