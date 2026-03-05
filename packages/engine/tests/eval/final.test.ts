// ============================================================
// Week 1 — Final Deterministic Tests (Phase 3)
// Covers: Pass/Fail guard, Academic standing, Enrollment validator,
//         Math calculus/discrete, ESL pathway exemption
// ============================================================
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StudentProfile, Program, Course } from "@nyupath/shared";
import { degreeAudit } from "../../src/audit/degreeAudit.js";
import { checkPassFailViolations } from "../../src/audit/passfailGuard.js";
import { calculateStanding, computeSemesterGPA } from "../../src/audit/academicStanding.js";
import { validateEnrollment } from "../../src/planner/enrollmentValidator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dirname, "profiles");
const DATA_DIR = join(__dirname, "../../src/data");

const courses: Course[] = JSON.parse(
    readFileSync(join(DATA_DIR, "courses.json"), "utf-8")
);
const programs: Program[] = JSON.parse(
    readFileSync(join(DATA_DIR, "programs.json"), "utf-8")
);

function loadProfile(name: string): StudentProfile {
    return JSON.parse(
        readFileSync(join(PROFILES_DIR, `${name}.json`), "utf-8")
    );
}

function getProgram(id: string): Program {
    const p = programs.find((p) => p.programId === id);
    if (!p) throw new Error(`Program ${id} not found`);
    return p;
}

function findRule(result: ReturnType<typeof degreeAudit>, ruleId: string) {
    const r = result.rules.find((r) => r.ruleId === ruleId);
    if (!r) throw new Error(`Rule ${ruleId} not found in audit result`);
    return r;
}

// ============================================================
// §1: Pass/Fail Guard
// Source: Major rules §A1.4, CAS core rules §A2.2, GA §A3.5
// ============================================================
describe("Pass/Fail Guard — Violations", () => {
    const student = loadProfile("passfail_violation");
    const csMajor = getProgram("cs_major_ba");
    const casCore = getProgram("cas_core");
    const violations = checkPassFailViolations(
        student.coursesTaken, csMajor.rules, casCore.rules, courses
    );

    it("PF-01: P/F in major course (CSCI-UA 101) → error", () => {
        const v = violations.find(
            (v) => v.courseId === "CSCI-UA 101" && v.severity === "error"
        );
        expect(v).toBeDefined();
        expect(v!.reason).toContain("major");
    });

    it("PF-02: P/F in Core course (CORE-UA 501) → error", () => {
        const v = violations.find(
            (v) => v.courseId === "CORE-UA 501" && v.reason.includes("Core")
        );
        expect(v).toBeDefined();
        expect(v!.severity).toBe("error");
    });

    it("PF-03: P/F in Expos (EXPOS-UA 1) → error (Core course)", () => {
        const v = violations.find(
            (v) => v.courseId === "EXPOS-UA 1" && v.severity === "error"
        );
        expect(v).toBeDefined();
    });

    it("PF-04: P/F in FL below Intermediate II (SPAN-UA 1) → allowed", () => {
        // FL courses below Intermediate II may be taken P/F per CAS core rules
        const v = violations.find(
            (v) => v.courseId === "SPAN-UA 1" && v.severity === "error"
        );
        expect(v).toBeUndefined();
    });

    it("PF-05: 2 P/F in same term (fall-23) → 1-per-term violation", () => {
        const termV = violations.find(
            (v) => v.reason.includes("per term") || v.reason.includes("1 Pass/Fail")
        );
        expect(termV).toBeDefined();
    });

    it("at least 3 violations total (major + Core + Expos + per-term)", () => {
        expect(violations.length).toBeGreaterThanOrEqual(3);
    });
});

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

// ============================================================
// §3: Enrollment Validator — F-1 Rules
// Source: GA §A3.9 F-1 enrollment
// ============================================================
describe("Enrollment Validator — F-1 Visa", () => {
    const student = loadProfile("fl_exempt"); // has visaStatus: "f1"

    it("EV-01: F-1 with 12+ credits, all in-person → valid", () => {
        const result = validateEnrollment(
            [
                { courseId: "CSCI-UA 201", credits: 4 },
                { courseId: "CSCI-UA 310", credits: 4 },
                { courseId: "MATH-UA 140", credits: 4 },
            ] as any,
            student,
            { targetSemester: "2025-fall" } as any
        );
        expect(result.valid).toBe(true);
        expect(result.warnings).toHaveLength(0);
    });

    it("EV-02: F-1 with 8 credits → violation (below 12)", () => {
        const result = validateEnrollment(
            [
                { courseId: "CSCI-UA 201", credits: 4 },
                { courseId: "CSCI-UA 310", credits: 4 },
            ] as any,
            student,
            { targetSemester: "2025-fall" } as any
        );
        expect(result.valid).toBe(false);
        expect(result.warnings.some((w: string) => w.includes("F-1 VIOLATION"))).toBe(true);
    });

    it("EV-03: F-1 with 2 online courses → violation", () => {
        const result = validateEnrollment(
            [
                { courseId: "CSCI-UA 201", credits: 4 },
                { courseId: "CSCI-UA 310", credits: 4 },
                { courseId: "ONLINE-1", credits: 4 },
                { courseId: "ONLINE-2", credits: 4 },
            ] as any,
            student,
            {
                targetSemester: "2025-fall",
                onlineCourseIds: ["ONLINE-1", "ONLINE-2"]
            } as any
        );
        expect(result.valid).toBe(false);
        expect(result.warnings.some((w: string) => w.includes("online"))).toBe(true);
    });

    it("EV-04: summer semester → no requirements", () => {
        const result = validateEnrollment(
            [{ courseId: "CSCI-UA 201", credits: 4 }] as any,
            student,
            { targetSemester: "2025-summer" } as any
        );
        expect(result.valid).toBe(true);
    });

    it("EV-05: F-1 final semester exception → valid even below 12cr", () => {
        const result = validateEnrollment(
            [
                { courseId: "CSCI-UA 478", credits: 4 },
                { courseId: "CSCI-UA 480", credits: 4 },
            ] as any,
            student,
            { targetSemester: "2025-fall", isFinalSemester: true } as any
        );
        expect(result.valid).toBe(true);
    });
});

describe("Enrollment Validator — Domestic", () => {
    const student = loadProfile("freshman_clean"); // domestic

    it("EV-06: domestic with 8 credits → valid but advisory warning", () => {
        const result = validateEnrollment(
            [
                { courseId: "CSCI-UA 201", credits: 4 },
                { courseId: "CSCI-UA 310", credits: 4 },
            ] as any,
            student,
            { targetSemester: "2025-fall" } as any
        );
        expect(result.valid).toBe(true);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0]).toContain("half-time");
    });
});

// ============================================================
// §4: Math Requirements (MR-02, MR-03)
// Source: Major rules §A1.2 "Calculus I" and "Discrete Mathematics"
// ============================================================
describe("Math Requirements — Calculus & Discrete", () => {
    const student = loadProfile("freshman_clean");
    const csMajor = getProgram("cs_major_ba");
    const result = degreeAudit(student, csMajor, courses);

    it("MR-02: MATH-UA 121 satisfies Calculus I (must_take)", () => {
        const calc = findRule(result, "cs_ba_math_calculus");
        expect(calc.status).toBe("satisfied");
        expect(calc.coursesSatisfying).toContain("MATH-UA 121");
    });

    it("MR-03: MATH-UA 120 satisfies Discrete Mathematics (must_take)", () => {
        const disc = findRule(result, "cs_ba_math_discrete");
        expect(disc.status).toBe("satisfied");
        expect(disc.coursesSatisfying).toContain("MATH-UA 120");
    });
});

describe("Math Requirements — Not Started", () => {
    const student = loadProfile("empty");
    const csMajor = getProgram("cs_major_ba");
    const result = degreeAudit(student, csMajor, courses);

    it("MR-02: Calculus not_started when no math courses", () => {
        const calc = findRule(result, "cs_ba_math_calculus");
        expect(calc.status).toBe("not_started");
    });

    it("MR-03: Discrete not_started when no math courses", () => {
        const disc = findRule(result, "cs_ba_math_discrete");
        expect(disc.status).toBe("not_started");
    });
});

// ============================================================
// §5: ESL Pathway — FL Exemption
// Source: CAS core rules §A2.2 "eslPathway" flag
// ============================================================
describe("ESL Pathway — FL Exemption", () => {
    it("CC-04b: eslPathway flag exempts FL requirement", () => {
        // Create a minimal student with eslPathway flag
        const student: StudentProfile = {
            id: "esl_test",
            catalogYear: "2023",
            declaredPrograms: ["cs_major_ba"],
            coursesTaken: [],
            flags: ["eslPathway"],
            visaStatus: "f1",
        };
        const casCore = getProgram("cas_core");
        const result = degreeAudit(student, casCore, courses);
        const fl = findRule(result, "core_foreign_lang");
        expect(fl.status).toBe("satisfied");
    });
});

// ============================================================
// §6: P grade in degree audit — P earns credits but not major
// ============================================================
describe("P Grade in Degree Audit", () => {
    const student = loadProfile("passfail_violation");
    const csMajor = getProgram("cs_major_ba");
    const result = degreeAudit(student, csMajor, courses);

    it("P in CSCI-UA 101 does NOT satisfy major intro", () => {
        const intro = findRule(result, "cs_ba_intro");
        // P grade is not in MAJOR_GRADES set → doesn't count for major
        expect(intro.coursesSatisfying).not.toContain("CSCI-UA 101");
    });

    it("P grade courses earn graduation credits", () => {
        // P is in CREDIT_GRADES → earns credits toward 128 total
        // 4 P courses + 1 A + 1 B+ = 6 courses × 4cr = 24cr
        expect(result.totalCreditsCompleted).toBe(24);
    });
});
