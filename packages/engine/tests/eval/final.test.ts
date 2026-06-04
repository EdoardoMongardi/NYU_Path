// ============================================================
// Week 1 — Final Deterministic Tests (Phase 3)
// Covers: Academic standing
// ============================================================
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StudentProfile } from "@nyupath/shared";
import { calculateStanding, computeSemesterGPA } from "../../src/audit/academicStanding.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dirname, "profiles");

function loadProfile(name: string): StudentProfile {
    return JSON.parse(
        readFileSync(join(PROFILES_DIR, `${name}.json`), "utf-8")
    );
}

// ============================================================
// §2: Academic Standing — GPA Calculation
// Source: GA §A3.8
// ============================================================
describe("Academic Standing — Low GPA", () => {
    const student = loadProfile("low_gpa");

    it("AS-01: cumulative GPA below 2.0 → not in good standing", () => {
        const standing = calculateStanding(student.coursesTaken);
        expect(standing.inGoodStanding).toBe(false);
        expect(standing.level).not.toBe("good_standing");
    });

    it("AS-02: GPA calculated correctly from grade points", () => {
        const standing = calculateStanding(student.coursesTaken);
        // Grades: D(1.0), D+(1.333), C-(1.667), F(0), D(1.0), C-(1.667), F(0)
        // Points: 4+5.332+6.668+0+4+6.668+0 = 26.668
        // Credits: 4+4+4+4+4+4+4 = 28
        // GPA: 26.668/28 ≈ 0.952
        expect(standing.cumulativeGPA).toBeLessThan(1.0);
        expect(standing.cumulativeGPA).toBeGreaterThan(0.5);
    });

    it("AS-03: F courses do NOT earn credits (completion rate < 100%)", () => {
        const standing = calculateStanding(student.coursesTaken);
        // 2 F courses out of 7 → completion = 5/7 ≈ 71.4%
        expect(standing.completionRate).toBeLessThan(1.0);
        expect(standing.completionRate).toBeCloseTo(5 / 7, 2);
    });

    it("AS-04: after 2 semesters with <50% completion → dismissal risk", () => {
        const standing = calculateStanding(student.coursesTaken, 2);
        // But completion is 5/7 ≈ 71.4%, which is > 50%, so no dismissal
        expect(standing.level).not.toBe("dismissed");
    });

    it("AS-05: semester GPA computable per term", () => {
        const fallGPA = computeSemesterGPA(student.coursesTaken, "2023-fall");
        // D(1.0) + D+(1.333) + C-(1.667) + F(0) = 3 * 4 = 16 credits
        // Points: 4+5.332+6.668+0 = 16.0
        // GPA: 16.0/16 = 1.0
        expect(fallGPA).toBeCloseTo(1.0, 2);
    });
});

describe("Academic Standing — Good Standing", () => {
    const student = loadProfile("freshman_clean");

    it("AS-06: good grades → in good standing", () => {
        const standing = calculateStanding(student.coursesTaken);
        expect(standing.inGoodStanding).toBe(true);
        expect(standing.level).toBe("good_standing");
    });

    it("AS-07: GPA well above 2.0", () => {
        const standing = calculateStanding(student.coursesTaken);
        expect(standing.cumulativeGPA).toBeGreaterThan(3.0);
    });

    it("AS-08: 100% completion rate (no F grades)", () => {
        const standing = calculateStanding(student.coursesTaken);
        expect(standing.completionRate).toBe(1.0);
    });
});

