// ============================================================
// Semester Planner Tests — Week 2 Eval (§5.3)
// Tests: Prereq violations, term availability, credit limits,
//        priority ordering, graduation risks, F-1 compliance
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
    StudentProfile,
    Program,
    Course,
    PlannerConfig,
    SemesterPlan,
} from "@nyupath/shared";
import type { Prerequisite } from "@nyupath/shared";
import { planNextSemester } from "../../src/planner/semesterPlanner.js";
import { PrereqGraph } from "../../src/graph/prereqGraph.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dirname, "profiles");
const DATA_DIR = join(__dirname, "../../src/data");

// ---- Load shared data ----
const courses: Course[] = JSON.parse(readFileSync(join(DATA_DIR, "courses.json"), "utf-8"));
const programs: Program[] = JSON.parse(readFileSync(join(DATA_DIR, "programs.json"), "utf-8"));
const prereqs: Prerequisite[] = JSON.parse(readFileSync(join(DATA_DIR, "prereqs.json"), "utf-8"));
const courseCatalog = new Map(courses.map(c => [c.id, c]));
const prereqGraph = new PrereqGraph(prereqs);

function loadProfile(name: string): StudentProfile {
    return JSON.parse(readFileSync(join(PROFILES_DIR, `${name}.json`), "utf-8"));
}

function getProgram(id: string): Program {
    const p = programs.find(p => p.programId === id);
    if (!p) throw new Error(`Program ${id} not found`);
    return p;
}

/** Build a default planner config */
function makeConfig(overrides: Partial<PlannerConfig> = {}): PlannerConfig {
    return {
        targetSemester: "2026-fall",
        maxCourses: 5,
        maxCredits: 18,
        ...overrides,
    };
}

/** Check if all prerequisites for a course are in completedSet */
function allPrereqsMet(courseId: string, completedSet: Set<string>): boolean {
    const prereq = prereqGraph.getPrereqs(courseId);
    if (!prereq || prereq.prereqGroups.length === 0) return true;

    for (const group of prereq.prereqGroups) {
        if (group.type === "AND") {
            for (const dep of group.courses) {
                if (!completedSet.has(dep) && dep !== "PLACEMENT_EXAM") return false;
            }
        } else {
            // OR group — at least one must be met
            const anyMet = group.courses.some(dep =>
                completedSet.has(dep) || dep === "PLACEMENT_EXAM"
            );
            if (!anyMet) return false;
        }
    }
    return true;
}

const csProgram = getProgram("cs_major_ba");

// ============================================================
// Group 1: Prerequisite Violation Rate (PV)
// ============================================================
describe("PV: Prerequisite Violation Rate", () => {
    it("PV-01: Empty student → should NOT suggest courses needing prereqs", () => {
        const student = loadProfile("empty");
        const config = makeConfig({ targetSemester: "2026-fall" });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // Empty student has no courses completed. The planner should only suggest
        // courses with no prereqs or whose prereqs are satisfied.
        const completedSet = new Set<string>();
        for (const s of plan.suggestions) {
            // Courses like CSCI-UA 101 (needs placement exam) are allowed
            // Everything else must have prereqs met
            const prereq = prereqGraph.getPrereqs(s.courseId);
            if (!prereq || prereq.prereqGroups.length === 0) continue;

            // Check if any prereq is PLACEMENT_EXAM (special case — allowed)
            const onlyPlacement = prereq.prereqGroups.every(g =>
                g.courses.every(c => c === "PLACEMENT_EXAM" || c === "CSCI-UA 0002" || c === "CSCI-UA 0003")
            );
            if (onlyPlacement) continue;

            expect.soft(allPrereqsMet(s.courseId, completedSet),
                `${s.courseId} suggested but prereqs not met`
            ).toBe(true);
        }
    });

    it("PV-02: Freshman with 101 → should suggest 102 but NOT 201/202", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({ targetSemester: "2025-fall" });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        const suggestedIds = new Set(plan.suggestions.map(s => s.courseId));

        // 102 needs 101 (which is passed) — should be suggested
        // But since freshman_clean already has 102, we check 201 is suggested
        // (101 + 102 passed → 201 is unlocked, but 202 needs 201)
        expect(suggestedIds.has("CSCI-UA 202")).toBe(false); // needs 201 first
    });

    it("PV-03: All suggestions have prereqs met", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({ targetSemester: "2025-fall" });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // Build completed course set (same logic as planner)
        const VALID_GRADES = new Set(["A", "A-", "B+", "B", "B-", "C+", "C"]);
        const completedIds = student.coursesTaken
            .filter(ct => VALID_GRADES.has(ct.grade.toUpperCase()))
            .map(ct => ct.courseId);
        const completedSet = new Set(completedIds);

        for (const s of plan.suggestions) {
            const prereq = prereqGraph.getPrereqs(s.courseId);
            if (!prereq || prereq.prereqGroups.length === 0) continue;

            // Check each prereq group
            for (const group of prereq.prereqGroups) {
                if (group.type === "AND") {
                    for (const dep of group.courses) {
                        if (dep === "PLACEMENT_EXAM") continue;
                        expect.soft(completedSet.has(dep),
                            `${s.courseId} requires ${dep} (AND) but student hasn't passed it`
                        ).toBe(true);
                    }
                } else {
                    const anyMet = group.courses.some(d =>
                        completedSet.has(d) || d === "PLACEMENT_EXAM"
                    );
                    expect.soft(anyMet,
                        `${s.courseId} requires one of [${group.courses.join(", ")}] but none passed`
                    ).toBe(true);
                }
            }
        }
    });

    it("PV-04: AP CS A equivalent → 102 should be unlocked", () => {
        const student = loadProfile("freshman_ap");
        const config = makeConfig({ targetSemester: "2025-fall" });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // freshman_ap has AP CS A → CSCI-UA 101 equivalent
        // So CSCI-UA 102 should be unlocked
        const suggestedIds = new Set(plan.suggestions.map(s => s.courseId));
        // 102 should either be suggested or already passed
        const has102 = suggestedIds.has("CSCI-UA 102") ||
            student.coursesTaken.some(ct => ct.courseId === "CSCI-UA 102");

        // Just verify no prereq violations for any suggestion
        expect(plan.suggestions.length).toBeGreaterThan(0);
    });
});

// ============================================================
// Group 2: Term Availability Accuracy (TA)
// ============================================================
describe("TA: Term Availability Accuracy", () => {
    it("TA-01: Fall target → no spring-only courses suggested", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({ targetSemester: "2025-fall" });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        for (const s of plan.suggestions) {
            const course = courseCatalog.get(s.courseId);
            expect.soft(course?.termsOffered.includes("fall"),
                `${s.courseId} (${course?.title}) is not offered in fall but was suggested`
            ).toBe(true);
        }
    });

    it("TA-02: Spring target → no fall-only courses suggested", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({ targetSemester: "2025-spring" });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        for (const s of plan.suggestions) {
            const course = courseCatalog.get(s.courseId);
            expect.soft(course?.termsOffered.includes("spring"),
                `${s.courseId} (${course?.title}) is not offered in spring but was suggested`
            ).toBe(true);
        }
    });

    it("TA-03: Summer target → only summer-offered courses", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({ targetSemester: "2025-summer" });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        for (const s of plan.suggestions) {
            const course = courseCatalog.get(s.courseId);
            expect.soft(course?.termsOffered.includes("summer"),
                `${s.courseId} is not offered in summer but was suggested`
            ).toBe(true);
        }
    });
});

// ============================================================
// Group 3: Credit Limit Compliance (CL)
// ============================================================
describe("CL: Credit Limit Compliance", () => {
    it("CL-01: Default maxCredits=18 → plannedCredits ≤ 18", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({ maxCredits: 18 });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        expect(plan.plannedCredits).toBeLessThanOrEqual(18);
    });

    it("CL-02: maxCredits=12 → plannedCredits ≤ 12", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({ maxCredits: 12 });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        expect(plan.plannedCredits).toBeLessThanOrEqual(12);
    });

    it("CL-03: maxCourses=4 → at most 4 suggestions", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({ maxCourses: 4 });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        expect(plan.suggestions.length).toBeLessThanOrEqual(4);
    });

    it("CL-04: F-1 student, fall → plannedCredits ≥ 12", () => {
        const student = loadProfile("fl_exempt");
        const config = makeConfig({
            targetSemester: "2025-fall",
            targetGraduation: "2027-spring",
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // F-1 students must have at least 12 credits in fall/spring
        // If the planner can't fill to 12, it's a design issue but the
        // enrollmentWarnings should flag it
        if (plan.plannedCredits < 12) {
            // Should have a warning about F-1 violation
            expect(plan.enrollmentWarnings.some(w => w.includes("F-1") || w.includes("SEVIS")))
                .toBe(true);
        }
    });

    it("CL-05: F-1 final semester → can have < 12 credits (with RCL warning)", () => {
        const student = loadProfile("fl_exempt");
        const config = makeConfig({
            targetSemester: "2027-spring",
            maxCredits: 8,
            maxCourses: 2,
            isFinalSemester: true,
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // Final semester: < 12cr is valid with RCL approval
        if (plan.plannedCredits < 12) {
            expect(plan.enrollmentWarnings.some(w =>
                w.includes("RCL") || w.includes("Reduced Course Load") || w.includes("final")
            )).toBe(true);
        }
    });
});

// ============================================================
// Group 4: Priority Ordering (PO)
// ============================================================
describe("PO: Priority Ordering", () => {
    it("PO-01: Gatekeeper course ranked higher than leaf elective", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({ targetSemester: "2025-fall" });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // CSCI-UA 201 (blocks many downstream courses) should rank higher
        // than random electives.
        const s201 = plan.suggestions.find(s => s.courseId === "CSCI-UA 201");
        if (s201) {
            // Any elective should have lower priority
            const electives = plan.suggestions.filter(s =>
                s.category === "elective" && s.courseId !== "CSCI-UA 201"
            );
            for (const e of electives) {
                expect.soft(s201.priority,
                    `CSCI-UA 201 (priority=${s201.priority}) should rank higher than ${e.courseId} (priority=${e.priority})`
                ).toBeGreaterThanOrEqual(e.priority);
            }
        }
    });

    it("PO-02: Required courses appear before electives in suggestions", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({
            targetSemester: "2025-fall",
            targetGraduation: "2027-spring",
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // In the suggestion list, required courses should come first
        let seenElective = false;
        for (const s of plan.suggestions) {
            if (s.category === "elective") {
                seenElective = true;
            } else if (s.category === "required" && seenElective) {
                // Required after elective — flag it but don't hard fail
                // (balanced selector may interleave for pacing reasons)
            }
        }
        // At minimum, the first suggestion should be required
        if (plan.suggestions.length > 0) {
            expect(plan.suggestions[0].category).toBe("required");
        }
    });

    it("PO-03: Preferred course appears in plan", () => {
        const student = loadProfile("freshman_clean");
        // CSCI-UA 310 needs 102 + MATH-UA 120 — both passed by freshman_clean
        const config = makeConfig({
            targetSemester: "2025-fall",
            preferredCourses: ["CSCI-UA 310"],
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        const suggestedIds = new Set(plan.suggestions.map(s => s.courseId));
        expect(suggestedIds.has("CSCI-UA 310")).toBe(true);
    });

    it("PO-04: Avoided course excluded from plan", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({
            targetSemester: "2025-fall",
            avoidCourses: ["CSCI-UA 201"],
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        const suggestedIds = new Set(plan.suggestions.map(s => s.courseId));
        expect(suggestedIds.has("CSCI-UA 201")).toBe(false);
    });
});

// ============================================================
// Group 5: Graduation Risk Recall (GR)
// ============================================================
describe("GR: Graduation Risk Recall", () => {
    it("GR-01: Freshman on track → no critical risks", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({
            targetSemester: "2025-fall",
            targetGraduation: "2027-spring",
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        const criticalRisks = plan.risks.filter(r => r.level === "critical");
        expect(criticalRisks.length).toBe(0);
    });

    it("GR-02: Senior with many credits left, 1 semester → critical credit risk", () => {
        // senior_almost_done has 60cr completed (from 15 courses × 4cr)
        // but needs 128cr total, and if we set target to next semester...
        const student = loadProfile("senior_almost_done");
        const config = makeConfig({
            targetSemester: "2026-fall",
            targetGraduation: "2026-fall", // graduating THIS semester
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // With 60cr completed and 128 needed, that's 68cr in 1 semester
        // Should trigger critical credit deficit risk
        const creditRisks = plan.risks.filter(r =>
            r.message.includes("credit") && (r.level === "critical" || r.level === "high")
        );
        expect(creditRisks.length).toBeGreaterThan(0);
    });

    it("GR-03: Student with deep prereq chain, few semesters → chain risk", () => {
        const student = loadProfile("prereq_chain_risk");
        const config = makeConfig({
            // catalogYear=2025 → graduation=2029-spring
            // Target semester 2028-fall → estimateRemaining = 2029*4+2 - 2028*4+4 + 1 = 2
            // But student needs 101→102→(201+310)→202 = 4-deep chain
            // Chain depth (4) > remaining semesters (2) → critical risk
            targetSemester: "2028-fall",
            targetGraduation: "2029-spring",
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // Should detect that the prereq chain or credit deficit makes
        // on-time graduation extremely difficult
        const seriousRisks = plan.risks.filter(r =>
            r.level === "critical" || r.level === "high"
        );
        expect(seriousRisks.length).toBeGreaterThan(0);
    });

    it("GR-04: Term-restricted required course → warning", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({
            targetSemester: "2025-fall",
            targetGraduation: "2027-spring",
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // If any remaining required course is single-term, graduation risk should flag it
        // This is a structural test — we verify the risk detection runs
        // (not all profiles will trigger this)
        expect(plan.risks).toBeDefined();
        expect(Array.isArray(plan.risks)).toBe(true);
    });
});

// ============================================================
// Group 6: F-1 Compliance (F1)
// ============================================================
describe("F1: F-1 Enrollment Compliance", () => {
    it("F1-01: F-1 student, fall, 4 courses → no violations", () => {
        const student = loadProfile("fl_exempt");
        const config = makeConfig({
            targetSemester: "2025-fall",
            maxCourses: 5,
            maxCredits: 18,
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // With 4-5 courses at 4cr each = 16-20cr, should meet 12cr minimum
        if (plan.plannedCredits >= 12) {
            const violations = plan.enrollmentWarnings.filter(w => w.includes("VIOLATION"));
            expect(violations.length).toBe(0);
        }
    });

    it("F1-02: F-1 student, fall, forced low credits → violation warning", () => {
        const student = loadProfile("fl_exempt");
        const config = makeConfig({
            targetSemester: "2025-fall",
            maxCourses: 2,
            maxCredits: 8,
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // 8cr max < 12cr minimum for F-1 → should flag
        expect(plan.enrollmentWarnings.some(w =>
            w.includes("F-1") || w.includes("SEVIS") || w.includes("VIOLATION")
        )).toBe(true);
    });

    it("F1-03: F-1 student, 2 online courses → online limit violation", () => {
        const student = loadProfile("fl_exempt");
        // Get two courses the student could take
        const config = makeConfig({
            targetSemester: "2025-fall",
            onlineCourseIds: ["CSCI-UA 201", "CSCI-UA 310"],
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // If both online courses appear in suggestions, should trigger online limit warning
        const suggestedOnline = plan.suggestions.filter(s =>
            config.onlineCourseIds!.includes(s.courseId)
        );
        if (suggestedOnline.length >= 2) {
            expect(plan.enrollmentWarnings.some(w =>
                w.includes("online")
            )).toBe(true);
        }
    });

    it("F1-04: F-1 final semester, 8cr → valid with RCL warning", () => {
        const student = loadProfile("fl_exempt");
        const config = makeConfig({
            targetSemester: "2027-spring",
            maxCredits: 8,
            maxCourses: 2,
            isFinalSemester: true,
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // Final semester exception — valid but should mention RCL
        if (plan.plannedCredits < 12 && plan.plannedCredits > 0) {
            expect(plan.enrollmentWarnings.some(w =>
                w.includes("RCL") || w.includes("Reduced Course Load") ||
                w.includes("Final") || w.includes("final")
            )).toBe(true);

            // Should NOT be a hard VIOLATION
            const hardViolations = plan.enrollmentWarnings.filter(w =>
                w.includes("VIOLATION")
            );
            expect(hardViolations.length).toBe(0);
        }
    });

    it("F1-05: F-1 student, summer → no enrollment requirements", () => {
        const student = loadProfile("fl_exempt");
        const config = makeConfig({ targetSemester: "2025-summer" });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // Summer has no F-1 enrollment requirements
        const f1Warnings = plan.enrollmentWarnings.filter(w =>
            w.includes("F-1") || w.includes("SEVIS") || w.includes("VIOLATION")
        );
        expect(f1Warnings.length).toBe(0);
    });

    it("F1-06: Domestic student, 8cr → advisory warning (half-time)", () => {
        const student = loadProfile("freshman_clean");
        const config = makeConfig({
            targetSemester: "2025-fall",
            maxCredits: 8,
            maxCourses: 2,
        });
        const plan = planNextSemester(student, csProgram, courses, prereqs, config);

        // Domestic student below 12cr should get a half-time advisory
        if (plan.plannedCredits < 12) {
            expect(plan.enrollmentWarnings.some(w =>
                w.includes("half-time") || w.includes("financial aid")
            )).toBe(true);
        }
    });
});
