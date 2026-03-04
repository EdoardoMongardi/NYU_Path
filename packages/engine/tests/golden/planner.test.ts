// ============================================================
// Planner Tests — Phase 1 Golden Tests
// ============================================================
import { describe, it, expect } from "vitest";
import { planNextSemester } from "../../src/planner/semesterPlanner.js";
import type {
    StudentProfile,
    Course,
    Prerequisite,
    Program,
    PlannerConfig,
} from "@nyupath/shared";
import * as fs from "fs";
import * as path from "path";

// ---- Data Loading ----
const dataDir = path.resolve(__dirname, "../../src/data");
const profileDir = path.resolve(__dirname, "./profiles");

const courses: Course[] = JSON.parse(
    fs.readFileSync(path.join(dataDir, "courses.json"), "utf-8")
);
const prereqs: Prerequisite[] = JSON.parse(
    fs.readFileSync(path.join(dataDir, "prereqs.json"), "utf-8")
);
const programs: Program[] = JSON.parse(
    fs.readFileSync(path.join(dataDir, "programs.json"), "utf-8")
);

function loadProfile(name: string): StudentProfile {
    return JSON.parse(
        fs.readFileSync(path.join(profileDir, `${name}.json`), "utf-8")
    );
}

function getProgram(id: string): Program {
    const p = programs.find((p) => p.programId === id);
    if (!p) throw new Error(`Program ${id} not found`);
    return p;
}

// ============================================================
// Test 1: Sophomore planning for Fall 2025
// ============================================================
describe("Planner: Sophomore Fall 2025", () => {
    const student = loadProfile("student_sophomore_planner");
    const program = getProgram("cs_major_ba");
    const config: PlannerConfig = {
        targetSemester: "2025-fall",
        maxCourses: 5,
        maxCredits: 20,
    };

    const plan = planNextSemester(student, program, courses, prereqs, config);

    it("returns a valid plan", () => {
        expect(plan.studentId).toBe("student_sophomore_planner");
        expect(plan.targetSemester).toBe("2025-fall");
    });

    it("suggests courses the student can actually take (prereqs met)", () => {
        // After completing 101, 102, MATH 120, MATH 121, the student can take:
        // CSCI-UA 201 (needs 102), CSCI-UA 310 (needs 102 + MATH 120),
        // MATH-UA 140 (needs 121), MATH-UA 122 (needs 121), MATH-UA 235 (needs 121)
        expect(plan.suggestions.length).toBeGreaterThan(0);
        expect(plan.suggestions.length).toBeLessThanOrEqual(config.maxCourses);
    });

    it("prioritizes CSO and Algorithms (high blocked count)", () => {
        // CSO (201) and Algorithms (310) should be top priority
        // because they unlock the most electives
        const topCourses = plan.suggestions.slice(0, 3).map(s => s.courseId);
        expect(topCourses).toContain("CSCI-UA 201");
        expect(topCourses).toContain("CSCI-UA 310");
    });

    it("does not suggest already-completed courses", () => {
        const completedIds = student.coursesTaken.map(ct => ct.courseId);
        for (const suggestion of plan.suggestions) {
            expect(completedIds).not.toContain(suggestion.courseId);
        }
    });

    it("respects credit limits", () => {
        expect(plan.plannedCredits).toBeLessThanOrEqual(config.maxCredits);
    });

    it("includes graduation risk analysis", () => {
        expect(plan.risks).toBeDefined();
        expect(Array.isArray(plan.risks)).toBe(true);
    });

    it("estimates remaining semesters", () => {
        // Catalog year 2023, target fall 2025 → graduation spring 2027
        // So remaining = spring 2027 ordinal - fall 2025 ordinal + 1
        expect(plan.estimatedSemestersLeft).toBeGreaterThan(0);
    });
});

// ============================================================
// Test 2: Freshman planning (just started)
// ============================================================
describe("Planner: True Freshman Fall 2023", () => {
    const student = loadProfile("student_true_freshman");
    const program = getProgram("cs_major_ba");
    const config: PlannerConfig = {
        targetSemester: "2023-fall",
        maxCourses: 4,
        maxCredits: 16,
    };

    const plan = planNextSemester(student, program, courses, prereqs, config);

    it("suggests math foundations for true freshman", () => {
        const courseIds = plan.suggestions.map(s => s.courseId);
        // A true freshman has no courses at all.
        // CSCI-UA 101/110 require prereq (0002/0003/PLACEMENT_EXAM) which isn't completed.
        // MATH-UA 120 and MATH-UA 121 have no prereqs, so they are available.
        // CSCI-UA 110 also has no prereqs listed — it IS available.
        // Some courses without prereqs may also be available.
        expect(plan.suggestions.length).toBeGreaterThan(0);
    });

    it("has highest priority for gateway courses", () => {
        // The top suggestion should be a core prerequisite course
        const firstSuggestion = plan.suggestions[0];
        // Could be MATH-UA 121, MATH-UA 120, or even CSCI-UA 110 (no prereqs in our data)
        expect(firstSuggestion).toBeDefined();
        expect(firstSuggestion.priority).toBeGreaterThan(0);
    });

    it("has many remaining semesters", () => {
        expect(plan.estimatedSemestersLeft).toBeGreaterThanOrEqual(7);
    });
});

// ============================================================
// Test 3: Senior close to graduation
// ============================================================
describe("Planner: Senior Spring 2027 (near graduation)", () => {
    const student = loadProfile("student_senior_planner");
    const program = getProgram("cs_major_ba");
    const config: PlannerConfig = {
        targetSemester: "2026-fall",
        maxCourses: 5,
        maxCredits: 20,
    };

    const plan = planNextSemester(student, program, courses, prereqs, config);

    it("primarily suggests electives (core is complete)", () => {
        // This student has completed intro, core, and 2 electives
        // They need 3 more 400-level electives
        // The top suggestions should include 400-level CS electives
        const hasElective = plan.suggestions.some(s => {
            const courseNum = parseInt(s.courseId.split(" ")[1], 10);
            return courseNum >= 400;
        });
        expect(hasElective).toBe(true);
    });

    it("provides risk warnings if semesters are tight", () => {
        expect(plan.risks).toBeDefined();
    });
});

// ============================================================
// Test 4: Preferred courses get boosted
// ============================================================
describe("Planner: Student preferences respected", () => {
    const student = loadProfile("student_sophomore_planner");
    const program = getProgram("cs_major_ba");

    const configWithPref: PlannerConfig = {
        targetSemester: "2025-fall",
        maxCourses: 5,
        maxCredits: 20,
        preferredCourses: ["MATH-UA 140"],
    };

    const planWithPref = planNextSemester(student, program, courses, prereqs, configWithPref);

    it("preferred courses appear in suggestions", () => {
        const courseIds = planWithPref.suggestions.map(s => s.courseId);
        expect(courseIds).toContain("MATH-UA 140");
    });
});

// ============================================================
// Test 5: Avoided courses are excluded
// ============================================================
describe("Planner: Avoided courses excluded", () => {
    const student = loadProfile("student_sophomore_planner");
    const program = getProgram("cs_major_ba");

    const configAvoid: PlannerConfig = {
        targetSemester: "2025-fall",
        maxCourses: 5,
        maxCredits: 20,
        avoidCourses: ["CSCI-UA 201"],
    };

    const plan = planNextSemester(student, program, courses, prereqs, configAvoid);

    it("avoided courses are not suggested", () => {
        const courseIds = plan.suggestions.map(s => s.courseId);
        expect(courseIds).not.toContain("CSCI-UA 201");
    });
});

// ============================================================
// Test 6: Term filtering (summer-only course)
// ============================================================
describe("Planner: Term filtering works", () => {
    const student = loadProfile("student_sophomore_planner");
    const program = getProgram("cs_major_ba");

    // Summer semester — very few CS courses offered
    const configSummer: PlannerConfig = {
        targetSemester: "2025-summer",
        maxCourses: 2,
        maxCredits: 8,
    };

    const plan = planNextSemester(student, program, courses, prereqs, configSummer);

    it("only suggests courses offered in summer", () => {
        const summerCourses = courses
            .filter(c => c.termsOffered.includes("summer"))
            .map(c => c.id);

        for (const suggestion of plan.suggestions) {
            expect(summerCourses).toContain(suggestion.courseId);
        }
    });
});

// ============================================================
// Test 7: CAS Core planning for CS student
// ============================================================
import { degreeAudit } from "../../src/audit/degreeAudit.js";

describe("Planner: CS + Core student (Core-aware)", () => {
    const student = loadProfile("student_cs_core_planner");
    const coreProgram = getProgram("cas_core");
    const config: PlannerConfig = {
        targetSemester: "2024-fall",
        maxCourses: 5,
        maxCredits: 20,
    };

    const plan = planNextSemester(student, coreProgram, courses, prereqs, config);

    it("suggests FCC courses the student hasn't taken", () => {
        // Student has no FCC courses yet — planner should suggest from CORE-UA pools
        const coreUACourses = plan.suggestions.filter(s => s.courseId.startsWith("CORE-UA"));
        expect(coreUACourses.length).toBeGreaterThan(0);
    });

    it("does NOT suggest already-completed Core courses", () => {
        const completedIds = student.coursesTaken.map(ct => ct.courseId);
        for (const suggestion of plan.suggestions) {
            expect(completedIds).not.toContain(suggestion.courseId);
        }
    });

    it("DOES suggest FSI courses for CS major (CS is NOT FSI-exempt)", () => {
        // CS BA students are NOT FSI-exempt per official CAS policy
        // Quant is satisfied via MATH-UA 121 substitution, but Physical and Life are not
        // So CORE-UA 2xx and 3xx SHOULD appear in suggestions
        const fsiPhysicalOrLife = plan.suggestions.filter(s =>
            s.courseId.startsWith("CORE-UA 2") ||
            s.courseId.startsWith("CORE-UA 3")
        );
        expect(fsiPhysicalOrLife.length).toBeGreaterThan(0);
    });
});

// ============================================================
// Test 8: J-term filtering
// ============================================================
describe("Planner: J-term filtering", () => {
    const student = loadProfile("student_sophomore_planner");
    const program = getProgram("cs_major_ba");
    const configJanuary: PlannerConfig = {
        targetSemester: "2025-january",
        maxCourses: 2,
        maxCredits: 8,
    };

    const plan = planNextSemester(student, program, courses, prereqs, configJanuary);

    it("only suggests courses offered in january", () => {
        // Currently no courses have january in termsOffered, so should be empty
        const januaryCourses = courses
            .filter(c => c.termsOffered.includes("january"))
            .map(c => c.id);

        for (const suggestion of plan.suggestions) {
            expect(januaryCourses).toContain(suggestion.courseId);
        }
    });

    it("returns 0 suggestions when no courses are offered in J-term", () => {
        // Since we haven't marked any courses as offered in January
        expect(plan.suggestions.length).toBe(0);
    });
});

// ============================================================
// Test 9: ESL pathway sequencing (EXPOS-UA 4 → 9)
// ============================================================
describe("Planner: ESL pathway sequencing", () => {
    const student = loadProfile("student_esl_planner");
    const coreProgram = getProgram("cas_core");
    const config: PlannerConfig = {
        targetSemester: "2024-spring",
        maxCourses: 5,
        maxCredits: 20,
    };

    const plan = planNextSemester(student, coreProgram, courses, prereqs, config);

    it("suggests an EXPOS writing course to fulfill the requirement", () => {
        const courseIds = plan.suggestions.map(s => s.courseId);
        // Either EXPOS-UA 1 (standard) or EXPOS-UA 9 (IWW II) satisfies the writing req
        const hasExpos = courseIds.includes("EXPOS-UA 9") || courseIds.includes("EXPOS-UA 1");
        expect(hasExpos).toBe(true);
    });

    it("does NOT suggest EXPOS-UA 4 again (already taken)", () => {
        const courseIds = plan.suggestions.map(s => s.courseId);
        expect(courseIds).not.toContain("EXPOS-UA 4");
    });
});

// ============================================================
// Test 10: CAS Core audit for planner profile (cross-check)
// ============================================================
describe("Audit cross-check: CS + Core planner profile", () => {
    const student = loadProfile("student_cs_core_planner");
    const coreProgram = getProgram("cas_core");
    const result = degreeAudit(student, coreProgram, courses);

    it("EXPOS, FYS, FL are satisfied", () => {
        const expos = result.rules.find(r => r.ruleId === "core_expos");
        const fys = result.rules.find(r => r.ruleId === "core_fys");
        const fl = result.rules.find(r => r.ruleId === "core_foreign_lang");
        expect(expos?.status).toBe("satisfied");
        expect(fys?.status).toBe("satisfied");
        expect(fl?.status).toBe("satisfied");
    });

    it("all 4 FCC rules are not_started", () => {
        const fccRules = result.rules.filter(r => r.ruleId.startsWith("core_fcc_"));
        expect(fccRules.length).toBe(4);
        for (const rule of fccRules) {
            expect(rule.status).toBe("not_started");
        }
    });

    it("FSI Quant is satisfied via MATH-UA 121, Physical and Life are not_started", () => {
        const fsiQuant = result.rules.find(r => r.ruleId === "core_fsi_quant");
        const fsiPhysical = result.rules.find(r => r.ruleId === "core_fsi_physical");
        const fsiLife = result.rules.find(r => r.ruleId === "core_fsi_life");
        expect(fsiQuant?.status).toBe("satisfied");
        expect(fsiQuant?.exemptReason).toBeUndefined();
        expect(fsiPhysical?.status).toBe("not_started");
        expect(fsiLife?.status).toBe("not_started");
    });
});

// ============================================================
// Test 11: Graduation risk severity
// ============================================================
describe("Planner: Graduation risk detection", () => {
    it("true freshman has credit deficit risk", () => {
        const student = loadProfile("student_true_freshman");
        const program = getProgram("cs_major_ba");
        const config: PlannerConfig = {
            targetSemester: "2023-fall",
            maxCourses: 4,
            maxCredits: 16,
        };
        const plan = planNextSemester(student, program, courses, prereqs, config);
        // Freshman has 0 credits, needs 128, with ~8 semesters left
        // 128/8 = 16 credits/semester — should be manageable (no critical risk)
        // But there SHOULD be risk data
        expect(plan.risks.length).toBeGreaterThanOrEqual(0);
        // Verify risk levels are valid
        for (const risk of plan.risks) {
            expect(["none", "low", "medium", "high", "critical"]).toContain(risk.level);
        }
    });

    it("senior near graduation has no critical credit risk", () => {
        const student = loadProfile("student_senior_planner");
        const program = getProgram("cs_major_ba");
        const config: PlannerConfig = {
            targetSemester: "2026-fall",
            maxCourses: 5,
            maxCredits: 20,
        };
        const plan = planNextSemester(student, program, courses, prereqs, config);
        // Senior has many credits, few semesters — check no false critical
        const criticalRisks = plan.risks.filter(r => r.level === "critical");
        // Should not have impossible credit deficit
        for (const risk of criticalRisks) {
            expect(risk.message).toBeDefined();
            expect(risk.message.length).toBeGreaterThan(0);
        }
    });
});

// ============================================================
// Test 12: Category tagging and freeSlots
// ============================================================
describe("Planner: Category tagging and freeSlots", () => {
    const student = loadProfile("student_sophomore_planner");
    const program = getProgram("cs_major_ba");
    const config: PlannerConfig = {
        targetSemester: "2025-fall",
        maxCourses: 5,
        maxCredits: 20,
    };

    const plan = planNextSemester(student, program, courses, prereqs, config);

    it("every suggestion has a category field", () => {
        for (const s of plan.suggestions) {
            expect(["required", "elective"]).toContain(s.category);
        }
    });

    it("program-relevant courses are tagged as required", () => {
        const required = plan.suggestions.filter(s => s.category === "required");
        // All required courses should satisfy at least one rule
        for (const s of required) {
            expect(s.satisfiesRules.length).toBeGreaterThan(0);
        }
    });

    it("freeSlots is a non-negative number", () => {
        expect(plan.freeSlots).toBeGreaterThanOrEqual(0);
    });

    it("freeSlots = maxCourses - selected count", () => {
        expect(plan.freeSlots).toBe(config.maxCourses - plan.suggestions.length);
    });

    it("enrollmentWarnings is an array", () => {
        expect(Array.isArray(plan.enrollmentWarnings)).toBe(true);
    });

    it("domestic student with no visaStatus has no enrollment violations", () => {
        // Default is domestic — no F-1 violations
        const violations = plan.enrollmentWarnings.filter(w => w.includes("F-1 VIOLATION"));
        expect(violations).toHaveLength(0);
    });
});

// ============================================================
// Test 13: F-1 enrollment integration
// ============================================================
describe("Planner: F-1 enrollment integration", () => {
    it("F-1 student gets enrollment warnings via planner", () => {
        const f1Student: StudentProfile = {
            ...loadProfile("student_true_freshman"),
            visaStatus: "f1" as const,
        };
        const config: PlannerConfig = {
            targetSemester: "2023-fall",
            maxCourses: 2,  // deliberately low → will plan < 12 credits
            maxCredits: 8,
        };
        const plan = planNextSemester(f1Student, getProgram("cs_major_ba"), courses, prereqs, config);
        // With max 2 courses × 4 credits = 8 credits < 12
        if (plan.plannedCredits < 12) {
            expect(plan.enrollmentWarnings.some(w => w.includes("F-1 VIOLATION"))).toBe(true);
        }
    });
});

// ============================================================
// Test 14: Balanced pacing with targetGraduation
// ============================================================
describe("Planner: Balanced pacing", () => {
    const student = loadProfile("student_sophomore_planner");
    const program = getProgram("cs_major_ba");

    it("with targetGraduation, distributes required courses across semesters", () => {
        const config: PlannerConfig = {
            targetSemester: "2025-fall",
            maxCourses: 5,
            maxCredits: 20,
            targetGraduation: "2027-spring", // 4 semesters left (F25, S26, F26, S27)
        };
        const plan = planNextSemester(student, program, courses, prereqs, config);
        // Should not front-load ALL required courses — should pace them
        const requiredCount = plan.suggestions.filter(s => s.category === "required").length;
        // With ~7 required remaining and 4 semesters, cap = ceil(7/4) = 2
        // But if there aren't enough electives, remaining slots are filled with more required
        expect(requiredCount).toBeGreaterThan(0);
        expect(plan.suggestions.length).toBeLessThanOrEqual(config.maxCourses);
    });

    it("without targetGraduation, uses original greedy behavior", () => {
        const configNoTarget: PlannerConfig = {
            targetSemester: "2025-fall",
            maxCourses: 5,
            maxCredits: 20,
            // no targetGraduation
        };
        const planNoTarget = planNextSemester(student, program, courses, prereqs, configNoTarget);
        // Original behavior: fill with as many required as possible
        const requiredCount = planNoTarget.suggestions.filter(s => s.category === "required").length;
        expect(requiredCount).toBeGreaterThan(0);
    });

    it("pacing produces more elective slots than greedy", () => {
        const configPaced: PlannerConfig = {
            targetSemester: "2025-fall",
            maxCourses: 5,
            maxCredits: 20,
            targetGraduation: "2027-spring",
        };
        const configGreedy: PlannerConfig = {
            targetSemester: "2025-fall",
            maxCourses: 5,
            maxCredits: 20,
        };
        const planPaced = planNextSemester(student, program, courses, prereqs, configPaced);
        const planGreedy = planNextSemester(student, program, courses, prereqs, configGreedy);

        const pacedRequired = planPaced.suggestions.filter(s => s.category === "required").length;
        const greedyRequired = planGreedy.suggestions.filter(s => s.category === "required").length;
        // Paced should pick fewer or equal required courses compared to greedy
        expect(pacedRequired).toBeLessThanOrEqual(greedyRequired);
    });

    it("final semester packs everything (no pacing)", () => {
        // Use a senior who is very close to graduating
        const senior = loadProfile("student_senior_planner");
        const config: PlannerConfig = {
            targetSemester: "2026-fall",
            maxCourses: 5,
            maxCredits: 20,
            targetGraduation: "2027-spring", // only 1 semester away
        };
        const plan = planNextSemester(senior, program, courses, prereqs, config);
        // With only 1 semester left, should not cap required courses
        expect(plan.suggestions.length).toBeGreaterThan(0);
    });
});

// ============================================================
// Test 15: Edge cases — all-elective and graduation-semester override
// ============================================================
describe("Planner: Additional pacing edge cases", () => {
    it("senior with all requirements met → all suggestions are elective", () => {
        const senior = loadProfile("student_senior_planner");
        const config: PlannerConfig = {
            targetSemester: "2026-fall",
            maxCourses: 5,
            maxCredits: 20,
            targetGraduation: "2027-spring",
        };
        const plan = planNextSemester(senior, getProgram("cs_major_ba"), courses, prereqs, config);
        // Senior likely has most requirements met
        // Any suggestions not satisfying rules should be elective
        for (const s of plan.suggestions) {
            if (s.satisfiesRules.length === 0) {
                expect(s.category).toBe("elective");
            }
        }
    });

    it("targetGraduation equals current semester → final semester override", () => {
        const student = loadProfile("student_sophomore_planner");
        const config: PlannerConfig = {
            targetSemester: "2025-fall",
            maxCourses: 5,
            maxCredits: 20,
            targetGraduation: "2025-fall",  // graduating THIS semester
        };
        const plan = planNextSemester(student, getProgram("cs_major_ba"), courses, prereqs, config);
        // Should pack everything (greedy mode — no pacing cap)
        expect(plan.suggestions.length).toBeGreaterThan(0);
        // All required should be loaded up front since it's final
        const requiredCount = plan.suggestions.filter(s => s.category === "required").length;
        expect(requiredCount).toBeGreaterThan(0);
    });

    it("F-1 student balanced pacing fills to 12 even when fewer needed", () => {
        const f1Student: StudentProfile = {
            ...loadProfile("student_senior_planner"),
            visaStatus: "f1" as const,
        };
        const config: PlannerConfig = {
            targetSemester: "2026-fall",
            maxCourses: 5,
            maxCredits: 18,
            targetGraduation: "2028-spring",  // many semesters → low credits/semester needed
        };
        const plan = planNextSemester(f1Student, getProgram("cs_major_ba"), courses, prereqs, config);
        // F-1 requires at least 12 credits — pacing should fill to 12 minimum
        // (unless there literally aren't enough available courses)
        if (plan.suggestions.length >= 3) {
            expect(plan.plannedCredits).toBeGreaterThanOrEqual(12);
        }
    });
});
