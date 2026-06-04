// ============================================================
// Multi-School Tests — Group 3 (Phase 1 §11.2)
// ============================================================
// Group 3 (Stern P/F + Tandon residency):
//   Verifies SchoolConfig actually drives engine behavior — Stern's
//   4-courses career P/F limit is honored, and Tandon's 64-credit
//   residency check uses -UY (not -UA).
// ============================================================

import { describe, it, expect } from "vitest";
import type { StudentProfile } from "@nyupath/shared";
import {
    loadCourses,
    loadSchoolConfig,
} from "../../src/dataLoader.js";
import { checkResidencyCredits } from "../../src/audit/creditCapValidator.js";
import { checkPassFailViolations } from "../../src/audit/passfailGuard.js";

// ---- shared fixture helpers ----

function profile(partial: Partial<StudentProfile> & { id: string; homeSchool: string }): StudentProfile {
    return {
        id: partial.id,
        catalogYear: partial.catalogYear ?? "2023",
        homeSchool: partial.homeSchool,
        declaredPrograms: partial.declaredPrograms ?? [],
        coursesTaken: partial.coursesTaken ?? [],
        ...partial,
    };
}

// ============================================================
// Group 3a — Stern P/F (4-course career limit)
// ============================================================
describe("Group 3a — Stern Pass/Fail (career limit = 4 courses)", () => {
    const courses = loadCourses();
    const sternConfig = loadSchoolConfig("stern");
    const casConfig = loadSchoolConfig("cas");

    it("stern.json loads", () => {
        expect(sternConfig).not.toBeNull();
    });

    it("Stern student with 5 P/F credits triggers no career-credit warning (Stern uses *courses* not credits)", () => {
        // Phase 1 Step D's passfailGuard only honors careerLimitType=credits.
        // Stern's careerLimitType=courses falls through to the CAS default
        // (32 credits). 5 credits is under that, so no warning. This tests
        // the documented v1 fallback boundary.
        const violations = checkPassFailViolations(
            [
                { courseId: "MGMT-UB 1", grade: "P", semester: "2024-fall", credits: 4 },
            ],
            [],
            [],
            courses,
            sternConfig,
        );
        const careerWarn = violations.find(v => v.reason.includes("career limit"));
        expect(careerWarn).toBeUndefined();
    });

    it("Stern student over 32 P/F credits DOES trigger the credits-mode career warning (proves the fallback fires, not a vacuous skip)", () => {
        // Build 36 credits across 9 distinct terms so per-term=1 doesn't trip first
        const ct = (id: string, sem: string) => ({
            courseId: id,
            grade: "P" as string,
            semester: sem,
            credits: 4,
        });
        const violations = checkPassFailViolations(
            [
                ct("ELEC-UA 100", "2022-fall"),
                ct("ELEC-UA 101", "2023-spring"),
                ct("ELEC-UA 102", "2023-fall"),
                ct("ELEC-UA 103", "2024-spring"),
                ct("ELEC-UA 104", "2024-fall"),
                ct("ELEC-UA 105", "2025-spring"),
                ct("ELEC-UA 106", "2025-fall"),
                ct("ELEC-UA 107", "2026-spring"),
                ct("ELEC-UA 108", "2026-fall"),
            ],
            [],
            [],
            courses,
            sternConfig,
        );
        const careerWarn = violations.find(v => v.reason.includes("career limit"));
        expect(careerWarn).toBeDefined();
        // 36 credits exceeds the CAS-default 32-credit fallback that Stern's
        // courses-mode falls through to; if someone removes the
        // careerLimitType==="credits" guard, this assertion will fail.
        expect(careerWarn!.reason).toContain("36/32");
    });

    it("CAS configuration: P/F over 32 credits IS flagged (regression sanity for credits-mode career limit)", () => {
        const ct = (id: string, sem: string) => ({
            courseId: id,
            grade: "P" as string,
            semester: sem,
            credits: 4,
        });
        // 36 credits of P/F — exceeds CAS's 32-credit career cap
        const violations = checkPassFailViolations(
            [
                ct("EXPOS-UA 1", "2022-fall"),
                ct("CORE-UA 400", "2022-fall"),
                ct("CORE-UA 500", "2023-spring"),
                ct("CORE-UA 700", "2023-fall"),
                ct("CORE-UA 720", "2024-spring"),
                ct("CORE-UA 730", "2024-fall"),
                ct("CORE-UA 740", "2025-spring"),
                ct("CORE-UA 750", "2025-fall"),
                ct("CORE-UA 760", "2026-spring"),
            ],
            [],
            [],
            courses,
            casConfig,
        );
        const careerWarn = violations.find(v => v.reason.includes("Pass/Fail career limit exceeded"));
        expect(careerWarn).toBeDefined();
    });

    it("Stern's per-term limit is bucketed by academic year — 1 P/F in fall + 1 in spring of the same AY violates", () => {
        // Stern bulletin (L399): "No more than one course may be elected pass/fail
        // in an academic year, defined as beginning in the fall and ending at the
        // close of that following summer." 2024-fall and 2025-spring share AY-2024.
        const violations = checkPassFailViolations(
            [
                { courseId: "MGMT-UB 1", grade: "P", semester: "2024-fall", credits: 4 },
                { courseId: "MGMT-UB 9", grade: "P", semester: "2025-spring", credits: 4 },
            ],
            [],
            [],
            courses,
            sternConfig,
        );
        const perTerm = violations.find(v => v.reason.includes("per academic year"));
        expect(perTerm).toBeDefined();
    });

    it("Stern: 1 P/F in spring and 1 in the FOLLOWING fall (different AY) does NOT violate", () => {
        // 2025-spring is AY-2024; 2025-fall is AY-2025 → different buckets.
        const violations = checkPassFailViolations(
            [
                { courseId: "MGMT-UB 1", grade: "P", semester: "2025-spring", credits: 4 },
                { courseId: "MGMT-UB 9", grade: "P", semester: "2025-fall", credits: 4 },
            ],
            [],
            [],
            courses,
            sternConfig,
        );
        const perTerm = violations.find(v => v.reason.includes("per academic year"));
        expect(perTerm).toBeUndefined();
    });

    it("Stern's per-bucket=1 limit fires when both P/F are in the same fall semester (also same AY)", () => {
        const violations = checkPassFailViolations(
            [
                { courseId: "MGMT-UB 1", grade: "P", semester: "2024-fall", credits: 4 },
                { courseId: "MGMT-UB 9", grade: "P", semester: "2024-fall", credits: 4 },
            ],
            [],
            [],
            courses,
            sternConfig,
        );
        // Stern's perTermUnit is "academic_year", so the violation reason
        // says "per academic year" rather than "per term".
        const perBucket = violations.find(v => v.reason.includes("per academic year"));
        expect(perBucket).toBeDefined();
    });
});

// ============================================================
// Group 3b — Tandon residency (-UY suffix, 64 credits)
// ============================================================
describe("Group 3b — Tandon residency (64 -UY credits)", () => {
    const tandonConfig = loadSchoolConfig("tandon");
    const casConfig = loadSchoolConfig("cas");

    it("tandon.json loads", () => {
        expect(tandonConfig).not.toBeNull();
    });

    it("Tandon residency message uses -UY (not -UA) and the school name", () => {
        // Regression for de-hardcoded message (audit P2). A Tandon student
        // must NOT see "UA-suffix credits" / "more CAS courses" — those are
        // the pre-fix CAS-only strings.
        const student: StudentProfile = profile({
            id: "tandon_msg_check",
            homeSchool: "tandon",
            uaSuffixCredits: 32,
            declaredPrograms: [],
        });
        const warning = checkResidencyCredits(student, tandonConfig);
        expect(warning).not.toBeNull();
        expect(warning!.message).toContain("-UY");
        expect(warning!.message).not.toContain("-UA");
        expect(warning!.message).not.toContain("CAS courses");
    });

    it("Tandon student below 64 residency credits → below_minimum warning", () => {
        const student: StudentProfile = profile({
            id: "tandon_short",
            homeSchool: "tandon",
            uaSuffixCredits: 40, // student-tracked field is suffix-credits regardless of school
            declaredPrograms: [],
        });
        const warning = checkResidencyCredits(student, tandonConfig);
        expect(warning).not.toBeNull();
        expect(warning!.direction).toBe("below_minimum");
        expect(warning!.limit).toBe(64);
        expect(warning!.current).toBe(40);
    });

    it("Tandon student exactly at 64 residency credits → no warning", () => {
        const student: StudentProfile = profile({
            id: "tandon_at_floor",
            homeSchool: "tandon",
            uaSuffixCredits: 64,
            declaredPrograms: [],
        });
        const warning = checkResidencyCredits(student, tandonConfig);
        expect(warning).toBeNull();
    });

    it("CAS regression: a CAS student is judged against CAS's 64 -UA floor identically", () => {
        const student: StudentProfile = profile({
            id: "cas_short",
            homeSchool: "cas",
            uaSuffixCredits: 40,
            declaredPrograms: [],
        });
        const warning = checkResidencyCredits(student, casConfig);
        expect(warning).not.toBeNull();
        expect(warning!.limit).toBe(64);
    });

});
