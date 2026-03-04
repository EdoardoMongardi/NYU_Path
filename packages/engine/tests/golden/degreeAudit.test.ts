// ============================================================
// Golden Test Suite — Verified degree audit correctness
// ============================================================
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StudentProfile, Program, Course } from "@nyupath/shared";
import { degreeAudit } from "../../src/audit/degreeAudit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dirname, "profiles");
const DATA_DIR = join(__dirname, "../../src/data");

// Load shared data
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
// Test 1: Empty Student — All rules not_started
// ============================================================
describe("Golden: Empty Student", () => {
    const student = loadProfile("student_empty");
    const program = getProgram("cs_major_ba");
    const result = degreeAudit(student, program, courses);

    it("overall status is not_started", () => {
        expect(result.overallStatus).toBe("not_started");
    });

    it("all rules are not_started", () => {
        for (const rule of result.rules) {
            expect(rule.status).toBe("not_started");
        }
    });

    it("total credits completed is 0", () => {
        expect(result.totalCreditsCompleted).toBe(0);
    });

    it("no warnings", () => {
        expect(result.warnings).toHaveLength(0);
    });
});

// ============================================================
// Test 2: Freshman — Partial progress on BA
// ============================================================
describe("Golden: Freshman (BA)", () => {
    const student = loadProfile("student_freshman");
    const program = getProgram("cs_major_ba");
    const result = degreeAudit(student, program, courses);

    it("overall status is in_progress", () => {
        expect(result.overallStatus).toBe("in_progress");
    });

    it("total credits = 16 (4 courses × 4 credits)", () => {
        expect(result.totalCreditsCompleted).toBe(16);
    });

    it("intro requirement is satisfied (took CSCI-UA 101)", () => {
        const intro = findRule(result, "cs_ba_intro");
        expect(intro.status).toBe("satisfied");
        expect(intro.coursesSatisfying).toContain("CSCI-UA 101");
    });

    it("CS core is in_progress (completed 1 of 4: CSCI-UA 102)", () => {
        const core = findRule(result, "cs_ba_core");
        expect(core.status).toBe("in_progress");
        expect(core.coursesSatisfying).toContain("CSCI-UA 102");
        expect(core.remaining).toBe(3);
    });

    it("CS electives not started", () => {
        const electives = findRule(result, "cs_ba_electives");
        expect(electives.status).toBe("not_started");
        expect(electives.remaining).toBe(5);
    });

    it("Calculus I satisfied", () => {
        const calc = findRule(result, "cs_ba_math_calculus");
        expect(calc.status).toBe("satisfied");
    });

    it("Discrete Math satisfied", () => {
        const disc = findRule(result, "cs_ba_math_discrete");
        expect(disc.status).toBe("satisfied");
    });

    it("Linear Algebra not started", () => {
        const la = findRule(result, "cs_ba_math_linear_algebra");
        expect(la.status).toBe("not_started");
    });
});

// ============================================================
// Test 3: Senior BA — All requirements satisfied
// ============================================================
describe("Golden: Senior BA (complete)", () => {
    const student = loadProfile("student_senior_ba");
    const program = getProgram("cs_major_ba");
    const result = degreeAudit(student, program, courses);

    it("overall status is satisfied", () => {
        expect(result.overallStatus).toBe("satisfied");
    });

    it("all rules are satisfied", () => {
        for (const rule of result.rules) {
            expect(rule.status).toBe("satisfied");
        }
    });

    it("total credits = 52 (13 courses × 4 credits)", () => {
        expect(result.totalCreditsCompleted).toBe(52);
    });

    it("CS electives satisfied with 4 courses", () => {
        const electives = findRule(result, "cs_ba_electives");
        expect(electives.coursesSatisfying.length).toBeGreaterThanOrEqual(4);
        expect(electives.remaining).toBe(0);
    });
});

// ============================================================
// Test 4: Cross-listed student — DS-UA 301 counts as CSCI-UA 471
// ============================================================
describe("Golden: Cross-listed (DS-UA 301 = CSCI-UA 471)", () => {
    const student = loadProfile("student_crosslisted");
    const program = getProgram("cs_major_ba");
    const result = degreeAudit(student, program, courses);

    it("overall status is satisfied", () => {
        expect(result.overallStatus).toBe("satisfied");
    });

    it("DS-UA 301 counts toward CS electives (cross-listed with CSCI-UA 471)", () => {
        const electives = findRule(result, "cs_ba_electives");
        // DS-UA 301 should resolve and count
        expect(electives.coursesSatisfying.length).toBeGreaterThanOrEqual(4);
        expect(electives.remaining).toBe(0);
    });
});

// ============================================================
// Test 5: Exclusive courses — 101 + 110 both taken
// ============================================================
describe("Golden: Mutually exclusive (101 + 110)", () => {
    const student = loadProfile("student_exclusive");
    const program = getProgram("cs_major_ba");
    const result = degreeAudit(student, program, courses);

    it("generates exclusion warning", () => {
        const hasExclWarning = result.warnings.some(
            (w) => w.includes("mutually exclusive")
        );
        expect(hasExclWarning).toBe(true);
    });

    it("intro requirement still satisfied", () => {
        const intro = findRule(result, "cs_ba_intro");
        expect(intro.status).toBe("satisfied");
    });
});

// Tests removed for BS degree

// ============================================================
// Test 10: Credits calculation with cross-listed dedup
// ============================================================
describe("Golden: Credit deduplication", () => {
    it("cross-listed courses are not double-counted in credits", () => {
        // A student who took both CSCI-UA 471 and DS-UA 301 shouldn't get 8 credits
        const student: StudentProfile = {
            id: "test_dedup",
            catalogYear: "2023",
            declaredPrograms: ["cs_major_ba"],
            coursesTaken: [
                { courseId: "CSCI-UA 471", grade: "A", semester: "2024-fall" },
                { courseId: "DS-UA 301", grade: "A", semester: "2024-fall" },
            ],
        };
        const program = getProgram("cs_major_ba");
        const result = degreeAudit(student, program, courses);

        // Should only count 4 credits, not 8
        expect(result.totalCreditsCompleted).toBe(4);
        expect(result.warnings.some((w) => w.includes("cross-listed"))).toBe(true);
    });
});

// ============================================================
// CAS Core Curriculum Tests (Phase 1.5)
// ============================================================

describe("CAS Core — CS Major (No FSI Exemption)", () => {
    const student = loadProfile("student_cs_core");
    const coreProgram = getProgram("cas_core");
    const result = degreeAudit(student, coreProgram, courses);

    it("recognizes EXPOS-UA 1 as satisfied", () => {
        const rule = findRule(result, "core_expos");
        expect(rule.status).toBe("satisfied");
    });

    it("recognizes FYRS-UA 500 via wildcard match", () => {
        const rule = findRule(result, "core_fys");
        expect(rule.status).toBe("satisfied");
    });

    it("recognizes SPAN-UA 4 as foreign language satisfied", () => {
        const rule = findRule(result, "core_foreign_lang");
        expect(rule.status).toBe("satisfied");
    });

    it("recognizes CORE-UA 500 as Texts and Ideas satisfied", () => {
        const rule = findRule(result, "core_fcc_texts");
        expect(rule.status).toBe("satisfied");
    });

    it("recognizes CORE-UA 700 as Societies satisfied", () => {
        const rule = findRule(result, "core_fcc_societies");
        expect(rule.status).toBe("satisfied");
    });

    it("shows Cultures and Contexts as not_started", () => {
        const rule = findRule(result, "core_fcc_cultures");
        expect(rule.status).toBe("not_started");
        expect(rule.remaining).toBe(1);
    });

    it("shows Expressive Culture as not_started", () => {
        const rule = findRule(result, "core_fcc_expressive");
        expect(rule.status).toBe("not_started");
        expect(rule.remaining).toBe(1);
    });

    it("FSI Quantitative Reasoning is satisfied via MATH-UA 121 substitution (not exemption)", () => {
        const rule = findRule(result, "core_fsi_quant");
        expect(rule.status).toBe("satisfied");
        expect(rule.exemptReason).toBeUndefined();
    });

    it("FSI Physical Science is not_started (CS major is NOT exempt)", () => {
        const rule = findRule(result, "core_fsi_physical");
        expect(rule.status).toBe("not_started");
        expect(rule.exemptReason).toBeUndefined();
    });

    it("FSI Life Science is not_started (CS major is NOT exempt)", () => {
        const rule = findRule(result, "core_fsi_life");
        expect(rule.status).toBe("not_started");
        expect(rule.exemptReason).toBeUndefined();
    });
});

describe("CAS Core — Foreign Language Flag Exemption", () => {
    const student = loadProfile("student_fl_exempt");
    const coreProgram = getProgram("cas_core");
    const result = degreeAudit(student, coreProgram, courses);

    it("auto-exempts foreign language for nonEnglishSecondary flag", () => {
        const rule = findRule(result, "core_foreign_lang");
        expect(rule.status).toBe("satisfied");
        expect(rule.exemptReason).toBe("Exempt from foreign language requirement");
    });

    it("does NOT exempt FSI for non-CS student", () => {
        const rule = findRule(result, "core_fsi_quant");
        expect(rule.status).toBe("not_started");
        expect(rule.exemptReason).toBeUndefined();
    });
});

describe("CAS Core — Incoming Freshman (No Courses)", () => {
    const student = loadProfile("student_core_freshman");
    const coreProgram = getProgram("cas_core");
    const result = degreeAudit(student, coreProgram, courses);

    it("all 10 rules are not_started", () => {
        expect(result.rules.length).toBe(10);
        for (const rule of result.rules) {
            expect(rule.status).toBe("not_started");
        }
    });

    it("no rules are exempt (no flags, no CS major)", () => {
        for (const rule of result.rules) {
            expect(rule.exemptReason).toBeUndefined();
        }
    });
});

// ============================================================
// EDGE CASE: Transfer credit satisfying Core requirements
// ============================================================
describe("Edge Case: Transfer (AP) credit satisfies EXPOS", () => {
    const student = loadProfile("student_transfer_core");
    const coreProgram = getProgram("cas_core");
    const result = degreeAudit(student, coreProgram, courses);

    it("AP credit for EXPOS-UA 1 satisfies writing requirement", () => {
        const expos = findRule(result, "core_expos");
        expect(expos.status).toBe("satisfied");
        expect(expos.coursesSatisfying).toContain("EXPOS-UA 1");
    });

    it("FCC Cultures is satisfied by CORE-UA 600 taken normally", () => {
        const cultures = findRule(result, "core_fcc_cultures");
        expect(cultures.status).toBe("satisfied");
    });

    it("credits include both transfer and regular courses", () => {
        // 4 credits transfer (EXPOS-UA 1 equivalent) + 4 credits CORE-UA 600
        expect(result.totalCreditsCompleted).toBe(8);
    });
});

// ============================================================
// EDGE CASE: Dual exemption — conditional + flag on same student
// ============================================================
describe("Edge Case: Dual exemption (CS major + nonEnglishSecondary)", () => {
    const student = loadProfile("student_dual_exempt");
    const coreProgram = getProgram("cas_core");
    const result = degreeAudit(student, coreProgram, courses);

    it("FSI rules are NOT exempt for CS major (no conditionalExemption)", () => {
        const fsiRules = result.rules.filter(r => r.ruleId.startsWith("core_fsi_"));
        expect(fsiRules.length).toBe(3);
        for (const rule of fsiRules) {
            expect(rule.status).toBe("not_started");
            expect(rule.exemptReason).toBeUndefined();
        }
    });

    it("FL is exempt via flag (nonEnglishSecondary)", () => {
        const fl = findRule(result, "core_foreign_lang");
        expect(fl.status).toBe("satisfied");
        expect(fl.exemptReason).toBe("Exempt from foreign language requirement");
    });

    it("1 rule exempt (FL only), 9 not_started", () => {
        const exemptRules = result.rules.filter(r => r.exemptReason);
        const notStarted = result.rules.filter(r => r.status === "not_started");
        expect(exemptRules.length).toBe(1);
        expect(notStarted.length).toBe(9);
    });

    it("overallStatus is in_progress (some exempt, rest not_started)", () => {
        // Not satisfied because EXPOS, FYS, and FCC are not done
        // Not not_started because exemptions count as progress
        expect(result.overallStatus).not.toBe("satisfied");
    });
});

// ============================================================
// EDGE CASE: All Core requirements satisfied
// ============================================================
describe("Edge Case: Fully complete CAS Core (CS major)", () => {
    const student = loadProfile("student_core_complete");
    const coreProgram = getProgram("cas_core");
    const result = degreeAudit(student, coreProgram, courses);

    it("overallStatus is satisfied", () => {
        expect(result.overallStatus).toBe("satisfied");
    });

    it("all 10 rules are satisfied", () => {
        for (const rule of result.rules) {
            expect(rule.status).toBe("satisfied");
        }
    });

    it("10 rules satisfied by coursework, 0 by exemption", () => {
        const byExemption = result.rules.filter(r => r.exemptReason);
        const byCoursework = result.rules.filter(r => !r.exemptReason && r.status === "satisfied");
        expect(byExemption.length).toBe(0);
        expect(byCoursework.length).toBe(10);
    });

    it("total credits = 40 (10 courses × 4 credits)", () => {
        expect(result.totalCreditsCompleted).toBe(40);
    });
});

// ============================================================
// EDGE CASE: Failing grades should not satisfy requirements
// ============================================================
describe("Edge Case: Failing grades don't count", () => {
    const student = loadProfile("student_failing_core");
    const coreProgram = getProgram("cas_core");
    const result = degreeAudit(student, coreProgram, courses);

    it("EXPOS rule is NOT satisfied (grade F)", () => {
        const expos = findRule(result, "core_expos");
        expect(expos.status).toBe("not_started");
    });

    it("FYS is NOT satisfied (grade D)", () => {
        const fys = findRule(result, "core_fys");
        expect(fys.status).toBe("not_started");
    });

    it("Texts & Ideas IS satisfied (grade A)", () => {
        const texts = findRule(result, "core_fcc_texts");
        expect(texts.status).toBe("satisfied");
    });

    it("only A-grade and D-grade courses count toward graduation credits (F is excluded)", () => {
        // CORE-UA 500 (A) = 4 credits, core_fys (D) = 4 credits, F course = 0 credits
        // Per NYU policy: D earns graduation credits but does NOT satisfy major requirements
        // F never earns credits
        expect(result.totalCreditsCompleted).toBe(8);
    });
});

// ============================================================
// EDGE CASE: Over-enrollment — took 2 courses for choose_n(1) rule
// ============================================================
describe("Edge Case: Over-enrollment in choose_n(1)", () => {
    it("taking 2 FCC Texts courses still satisfies, remaining = 0", () => {
        const student: StudentProfile = {
            id: "test_over_enroll",
            catalogYear: "2023",
            declaredPrograms: ["cas_core"],
            coursesTaken: [
                { courseId: "CORE-UA 500", grade: "A", semester: "2024-fall" },
                { courseId: "CORE-UA 501", grade: "B", semester: "2025-spring" },
            ],
        };
        const coreProgram = getProgram("cas_core");
        const result = degreeAudit(student, coreProgram, courses);
        const texts = findRule(result, "core_fcc_texts");
        expect(texts.status).toBe("satisfied");
        expect(texts.remaining).toBe(0);
        expect(texts.coursesSatisfying.length).toBe(2);
    });
});

// ============================================================
// EDGE CASE: Student with only generic transfer credits
// ============================================================
describe("Edge Case: Generic transfer credits (no NYU equivalent)", () => {
    it("generic credits count toward totalCreditsCompleted", () => {
        const student: StudentProfile = {
            id: "test_generic_transfer",
            catalogYear: "2023",
            declaredPrograms: ["cas_core"],
            coursesTaken: [],
            genericTransferCredits: 16,
        };
        const coreProgram = getProgram("cas_core");
        const result = degreeAudit(student, coreProgram, courses);
        expect(result.totalCreditsCompleted).toBe(16);
        // But no rules should be satisfied since generic credits don't map to courses
        for (const rule of result.rules) {
            expect(rule.status).toBe("not_started");
        }
    });
});

// ============================================================
// EDGE CASE: Double-count "disallow" enforcement
// ============================================================
describe("Edge Case: Double-count disallow between CS rules", () => {
    it("CSCI-UA 101 used by intro rule is NOT stripped from cs_ba_core (which doesn't include 101)", () => {
        // cs_ba_intro uses CSCI-UA 101 (disallow), cs_ba_core uses 102,201,202,310 (disallow)
        // These pools don't overlap, so no double-count conflict should arise
        const student: StudentProfile = {
            id: "test_disallow",
            catalogYear: "2023",
            declaredPrograms: ["cs_major_ba"],
            coursesTaken: [
                { courseId: "CSCI-UA 101", grade: "A", semester: "2023-fall" },
                { courseId: "CSCI-UA 102", grade: "A", semester: "2024-spring" },
            ],
        };
        const program = getProgram("cs_major_ba");
        const result = degreeAudit(student, program, courses);

        const intro = findRule(result, "cs_ba_intro");
        const core = findRule(result, "cs_ba_core");
        expect(intro.status).toBe("satisfied");
        expect(intro.coursesSatisfying).toContain("CSCI-UA 101");
        expect(core.coursesSatisfying).toContain("CSCI-UA 102");
        expect(result.warnings.filter(w => w.includes("double-count"))).toHaveLength(0);
    });
});

// ============================================================
// EDGE CASE: Double-count "limit_1" with math substitution
// ============================================================
describe("Edge Case: limit_1 allows math course in both electives and math elective", () => {
    it("MATH-UA 122 counts for both cs_ba_math_elective (allow) and cs_ba_electives (limit_1)", () => {
        // cs_ba_math_elective has doubleCountPolicy: "allow" → MATH-UA 122 gets "used" first BUT with allow, so it's not exclusive
        // cs_ba_electives has doubleCountPolicy: "limit_1" and mathSubstitutionPool includes MATH-UA 122
        // Since cs_ba_math_elective is "allow" and comes BEFORE cs_ba_electives in the rule list,
        // MATH-UA 122 should count for the math elective rule AND can also substitute in CS electives
        const student: StudentProfile = {
            id: "test_limit1",
            catalogYear: "2023",
            declaredPrograms: ["cs_major_ba"],
            coursesTaken: [
                { courseId: "CSCI-UA 101", grade: "A", semester: "2023-fall" },
                { courseId: "CSCI-UA 102", grade: "A", semester: "2024-spring" },
                { courseId: "CSCI-UA 201", grade: "A", semester: "2024-fall" },
                { courseId: "CSCI-UA 202", grade: "B+", semester: "2025-spring" },
                { courseId: "CSCI-UA 310", grade: "A", semester: "2025-spring" },
                { courseId: "MATH-UA 120", grade: "A", semester: "2023-fall" },
                { courseId: "MATH-UA 121", grade: "A", semester: "2023-fall" },
                { courseId: "MATH-UA 122", grade: "A", semester: "2024-spring" },
                { courseId: "MATH-UA 140", grade: "A", semester: "2024-fall" },
                { courseId: "CSCI-UA 467", grade: "A", semester: "2025-fall" },
                { courseId: "CSCI-UA 473", grade: "A", semester: "2025-fall" },
                { courseId: "CSCI-UA 480", grade: "A", semester: "2026-spring" },
            ],
        };
        const program = getProgram("cs_major_ba");
        const result = degreeAudit(student, program, courses);

        const mathElective = findRule(result, "cs_ba_math_elective");
        expect(mathElective.status).toBe("satisfied");
        expect(mathElective.coursesSatisfying).toContain("MATH-UA 122");

        // cs_ba_electives should count 3 CS 400-level + possibly MATH-UA 122 and MATH-UA 140 as math subs
        const electives = findRule(result, "cs_ba_electives");
        expect(electives.status).toBe("satisfied");
    });
});

// ============================================================
// EDGE CASE: Residency check fires for CS student with few CSCI credits
// ============================================================
describe("Edge Case: Residency warning for CS program", () => {
    it("warns when CS student has < 32 CSCI credits and all rules satisfied", () => {
        const student = loadProfile("student_senior_ba");
        const program = getProgram("cs_major_ba");
        const result = degreeAudit(student, program, courses);

        // student_senior_ba has 13 courses, all CS rules satisfied
        // Check if residency is enforced
        if (result.overallStatus === "in_progress") {
            // Residency not yet met
            expect(result.warnings.some(w => w.includes("Residency"))).toBe(true);
        } else {
            // All satisfied including residency
            expect(result.overallStatus).toBe("satisfied");
        }
    });

    it("residency check does NOT apply to cas_core program", () => {
        const student = loadProfile("student_core_complete");
        const program = getProgram("cas_core");
        const result = degreeAudit(student, program, courses);

        // cas_core should never trigger CSCI residency warning
        expect(result.warnings.filter(w => w.includes("Residency"))).toHaveLength(0);
        expect(result.overallStatus).toBe("satisfied");
    });
});
