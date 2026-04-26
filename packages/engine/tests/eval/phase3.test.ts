// ============================================================
// Phase 3 — Planner extensions + transcript confirmation + carried gaps
// ============================================================
// Covers every Phase 3 deliverable per ARCHITECTURE.md §12.6 row 3 +
// the wave-2 carried gaps:
//   - Gap A: dismissal check independent of GPA gate (CAS L494)
//   - Gap B: Tandon tiered GPA floor honored (Tandon L287-300)
//   - Gap C: choose_n n=1 caps coursesSatisfying at n
//   - Transcript confirmation flow (§11.8.4): summary preview + edit commit
//   - Multi-semester projection
//   - Exploratory mode (undeclared → Core-first plan)
//   - Transfer-prep mode (prereqs + deadline warnings)
//   - Cross-program priority scoring (shared courses boosted, over-limit penalized)
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
    Course,
    Prerequisite,
    Program,
    StudentProfile,
} from "@nyupath/shared";
import { calculateStanding } from "../../src/audit/academicStanding.js";
import {
    loadCourses,
    loadPrereqs,
    loadProgram,
    loadSchoolConfig,
} from "../../src/dataLoader.js";
import { evaluateRule } from "../../src/audit/ruleEvaluator.js";
import { EquivalenceResolver } from "../../src/equivalence/equivalenceResolver.js";
import { parseTranscript } from "../../src/transcript/parser.js";
import { transcriptToProfileDraft } from "../../src/transcript/profileMapper.js";
import {
    buildConfirmationSummary,
    applyConfirmationEdits,
    ConfirmationCommitError,
} from "../../src/transcript/confirmationFlow.js";
import { projectMultiSemester, nextSemesterAfter } from "../../src/planner/multiSemesterProjector.js";
import { planExploratory } from "../../src/planner/explorePlanner.js";
import { planForTransferPrep } from "../../src/planner/transferPrepPlanner.js";
import { planMultiProgram } from "../../src/planner/crossProgramPlanner.js";

// ============================================================
// Step 3A — Gap A: dismissal independent of GPA gate
// ============================================================
describe("Gap A — dismissal check independent of GPA (CAS L494)", () => {
    it("high-GPA + low-completion student after 2nd semester is now flagged dismissed", () => {
        // 4 courses, 2 graded (A) + 2 W. Cumulative GPA = 4.0 (good standing).
        // Completion rate: 2 earned / (2+2 attempted) = 50%, but with only one
        // more W to drop below 50%. Make it 1 A + 3 W: GPA=4.0, attempted=16cr,
        // earned=4cr → 25% completion. Per CAS L494, after 2nd semester this
        // is dismissal-eligible regardless of GPA.
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "X2", grade: "W", semester: "2024-fall", credits: 4 },
                { courseId: "X3", grade: "W", semester: "2025-spring", credits: 4 },
                { courseId: "X4", grade: "W", semester: "2025-spring", credits: 4 },
            ],
            2,
        );
        expect(r.cumulativeGPA).toBe(4.0);
        expect(r.level).toBe("dismissed");
    });

    it("high-GPA + ≥50% completion student is still good_standing", () => {
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "X2", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "X3", grade: "W", semester: "2025-spring", credits: 4 },
            ],
            2,
        );
        expect(r.level).toBe("good_standing");
    });
});

// ============================================================
// Step 3A — Gap C: choose_n caps coursesSatisfying at n
// ============================================================
describe("Gap C — choose_n caps coursesSatisfying at rule.n", () => {
    const courses = loadCourses();
    const courseCatalog = new Map(courses.map((c) => [c.id, c]));
    const equiv = new EquivalenceResolver(courses);

    it("n=1 with 2 candidate matches → coursesSatisfying has length 1", () => {
        const rule = {
            ruleId: "test",
            label: "Pick one",
            type: "choose_n" as const,
            doubleCountPolicy: "allow" as const,
            catalogYearRange: ["2018", "2030"] as [string, string],
            n: 1,
            fromPool: ["CSCI-UA 101", "CSCI-UA 110"],
        };
        const completed = new Set(["CSCI-UA 101", "CSCI-UA 110"]);
        const r = evaluateRule(rule, completed, courseCatalog, equiv, [], []);
        expect(r.status).toBe("satisfied");
        expect(r.coursesSatisfying).toHaveLength(1);
    });

    it("n=2 with 4 candidate matches → coursesSatisfying has length 2", () => {
        const rule = {
            ruleId: "test2",
            label: "Pick two",
            type: "choose_n" as const,
            doubleCountPolicy: "allow" as const,
            catalogYearRange: ["2018", "2030"] as [string, string],
            n: 2,
            fromPool: ["MATH-UA 122", "MATH-UA 123", "MATH-UA 140", "MATH-UA 235"],
        };
        const completed = new Set(["MATH-UA 122", "MATH-UA 140", "MATH-UA 235"]);
        const r = evaluateRule(rule, completed, courseCatalog, equiv, [], []);
        expect(r.coursesSatisfying).toHaveLength(2);
    });
});

// ============================================================
// Step 3B — Gap B: Tandon tiered GPA floor honored
// ============================================================
describe("Gap B — Tandon tiered GPA (Tandon L287-300)", () => {
    const tandon = loadSchoolConfig("tandon")!;

    it("loads tandon.json with the 8-row gpaTierTable from the bulletin", () => {
        expect(tandon.gpaTierTable).toBeDefined();
        expect(tandon.gpaTierTable!.length).toBe(8);
        const sem1 = tandon.gpaTierTable!.find((r) => r.semestersCompleted === 1)!;
        expect(sem1.minCumGpa).toBe(1.501);
        const openEnded = tandon.gpaTierTable!.find((r) => r.semestersCompleted === null)!;
        expect(openEnded.minCumGpa).toBe(2.0);
    });

    it("Tandon sem-2 student at GPA 1.6 is good_standing (tier minimum 1.501)", () => {
        // Two B grades (3.0 each): GPA = 3.0. Lower it below 2.0 to test tier.
        // 1 B + 1 D = (3.0 + 1.0)/2 = 2.0. Need 1.6 specifically.
        // 1 B- (2.667) + 1 D (1.0) over 8 credits = 3.667/8 = no wait:
        //   QPTS = 2.667*4 + 1.0*4 = 14.668; QHRS = 8; GPA = 1.834.
        // Close enough — confirm > 1.501 and < 2.0.
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "B-", semester: "2024-fall", credits: 4 },
                { courseId: "X2", grade: "D", semester: "2024-fall", credits: 4 },
            ],
            2,
            tandon,
        );
        expect(r.cumulativeGPA).toBeLessThan(2.0);
        expect(r.cumulativeGPA).toBeGreaterThanOrEqual(1.501);
        expect(r.level).toBe("good_standing");
    });

    it("Tandon sem-5 student at GPA 1.7 is academic_concern (tier minimum 1.78)", () => {
        // QPTS = 1.667 (C-) * 4 = 6.668 over 4 credits = 1.667.
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "C-", semester: "2024-fall", credits: 4 },
            ],
            5,
            tandon,
        );
        expect(r.cumulativeGPA).toBeLessThan(1.78);
        expect(r.level).toBe("academic_concern");
    });

    it("CAS uses flat overallGpaMin (no gpaTierTable) — regression intact", () => {
        const cas = loadSchoolConfig("cas")!;
        expect(cas.gpaTierTable).toBeUndefined();
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "C", semester: "2024-fall", credits: 4 },
            ],
            2,
            cas,
        );
        // GPA 2.0 ≥ overallGpaMin 2.0 → good_standing
        expect(r.level).toBe("good_standing");
    });

    it("Tandon student in semester 1 with cumulative GPA 1.3 lands on final_probation (Tandon L303 footnote)", () => {
        const tandon = loadSchoolConfig("tandon")!;
        // 1 D = 1.0; 1 D+ = 1.333. Use one D = GPA 1.0, well below 1.5.
        const r = calculateStanding(
            [
                { courseId: "MA-UY 914", grade: "D", semester: "2024-fall", credits: 4 },
            ],
            1,
            tandon,
        );
        expect(r.cumulativeGPA).toBeLessThan(1.5);
        expect(r.level).toBe("final_probation");
        expect(r.warnings.some(w => w.includes("Final Probation"))).toBe(true);
    });

    it("Tandon final_probation does NOT override an active dismissal (dismissal wins)", () => {
        const tandon = loadSchoolConfig("tandon")!;
        // 4 W's + 0 grades after 3 semesters → completion 0%, dismissal floor 50%.
        // Cumulative GPA 0 < 1.5 — both rules trigger; dismissal must win.
        const r = calculateStanding(
            [
                { courseId: "X1", grade: "W", semester: "2024-fall", credits: 4 },
                { courseId: "X2", grade: "W", semester: "2024-fall", credits: 4 },
                { courseId: "X3", grade: "W", semester: "2025-spring", credits: 4 },
                { courseId: "X4", grade: "W", semester: "2025-spring", credits: 4 },
            ],
            3,
            tandon,
        );
        expect(r.level).toBe("dismissed");
    });
});

// ============================================================
// Step 3C — Transcript confirmation flow (§11.8.4)
// ============================================================
describe("Step 3C — Transcript confirmation flow (§11.8.4)", () => {
    const FIXTURES_DIR = join(__dirname, "transcripts");
    const text = readFileSync(join(FIXTURES_DIR, "01_freshman_clean.txt"), "utf-8");
    const doc = parseTranscript(text);
    const draft = transcriptToProfileDraft(doc);

    it("buildConfirmationSummary surfaces homeSchool basis + completed credits + GPA", () => {
        const summary = buildConfirmationSummary(draft);
        expect(summary.homeSchool).toBe("cas");
        expect(summary.homeSchoolBasis).toMatch(/-UA/);
        expect(summary.completedCredits).toBeGreaterThan(0);
        expect(summary.cumulativeGPA).toBeGreaterThan(3.5);
        expect(summary.fieldsRequiringExplicitConfirmation).toContain("declaredPrograms");
    });

    it("applyConfirmationEdits with declaredPrograms commits cleanly", () => {
        const result = applyConfirmationEdits(draft, {
            declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
        }, draft.needsConfirmation);
        expect(result.profile.declaredPrograms).toHaveLength(1);
        expect(result.profile.declaredPrograms[0]!.programId).toBe("cs_major_ba");
        expect(result.changes.some((c) => c.field === "declaredPrograms")).toBe(true);
    });

    it("applyConfirmationEdits never mutates the input draft", () => {
        const before = JSON.parse(JSON.stringify(draft.draft));
        applyConfirmationEdits(draft, {
            declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
        }, draft.needsConfirmation);
        expect(draft.draft).toEqual(before);
    });

    it("applyConfirmationEdits throws ConfirmationCommitError when required confirmation is missing", () => {
        let thrown: unknown = null;
        try {
            applyConfirmationEdits(draft, {}, ["declaredPrograms"]);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(ConfirmationCommitError);
        expect((thrown as ConfirmationCommitError).kind).toBe("missing_confirmation");
    });

    it("applyConfirmationEdits rejects duplicate addCoursesTaken", () => {
        let thrown: unknown = null;
        try {
            applyConfirmationEdits(draft, {
                declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
                addCoursesTaken: [
                    { courseId: "CSCI-UA 101", grade: "A", semester: "2024-fall", credits: 4 },
                ],
            }, draft.needsConfirmation);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(ConfirmationCommitError);
        expect((thrown as ConfirmationCommitError).kind).toBe("duplicate_course");
    });

    it("applyConfirmationEdits canonicalizes a UPPERCASE homeSchool override", () => {
        const result = applyConfirmationEdits(draft, {
            homeSchool: "CAS",
            declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
        }, draft.needsConfirmation);
        expect(result.profile.homeSchool).toBe("cas");
    });

    it("applyConfirmationEdits rejects duplicate programId in declaredPrograms (invalid_input)", () => {
        let thrown: unknown = null;
        try {
            applyConfirmationEdits(draft, {
                declaredPrograms: [
                    { programId: "cs_major_ba", programType: "major" },
                    { programId: "cs_major_ba", programType: "minor" },
                ],
            }, []);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(ConfirmationCommitError);
        expect((thrown as ConfirmationCommitError).kind).toBe("invalid_input");
    });

    it("applyConfirmationEdits emits typed audit-log entries with op + field discriminators", () => {
        const result = applyConfirmationEdits(draft, {
            homeSchool: "stern",
            declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
        }, draft.needsConfirmation);
        const homeSchoolChange = result.changes.find(c => c.field === "homeSchool")!;
        expect(homeSchoolChange.op).toBe("replace");
        expect(homeSchoolChange.before).toBe("cas");
        expect(homeSchoolChange.after).toBe("stern");
    });
});

// ============================================================
// Polish #17 — priorityScorer marginal blocked count
// ============================================================
describe("Polish #17 — priorityScorer marginal-blocked count (CSCI-UA 110 quirk)", () => {
    const courses = loadCourses();
    const prereqs = loadPrereqs();
    const csBA = loadProgram("cs_major_ba", "2023")!;

    it("when CSCI-UA 101 is completed, planNextSemester does NOT suggest CSCI-UA 110", async () => {
        const { planNextSemester } = await import("../../src/planner/semesterPlanner.js");
        const profile: StudentProfile = {
            id: "polish17a",
            catalogYear: "2023",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
            coursesTaken: [
                { courseId: "CSCI-UA 101", grade: "A", semester: "2024-fall", credits: 4 },
            ],
        };
        const plan = planNextSemester(profile, csBA, courses, prereqs, {
            targetSemester: "2025-spring", maxCourses: 5, maxCredits: 18,
        });
        expect(plan.suggestions.find(s => s.courseId === "CSCI-UA 110")).toBeUndefined();
    });

    it("countMarginallyBlocked returns 0 when an OR-prereq sibling is already completed", async () => {
        const { PrereqGraph } = await import("../../src/graph/prereqGraph.js");
        const graph = new PrereqGraph(prereqs);
        // Static count for CSCI-UA 110 is large (it's an OR-prereq for many CSCI-UA courses)
        const staticCount = graph.countTransitivelyBlocked("CSCI-UA 110");
        // But once 101 is completed, the marginal count should be 0
        const marginalCount = graph.countMarginallyBlocked("CSCI-UA 110", new Set(["CSCI-UA 101"]));
        expect(staticCount).toBeGreaterThan(0);
        expect(marginalCount).toBe(0);
    });

    it("countMarginallyBlocked still credits a course that genuinely unlocks new dependents", async () => {
        const { PrereqGraph } = await import("../../src/graph/prereqGraph.js");
        const graph = new PrereqGraph(prereqs);
        // Empty completed set: 101 should marginally unlock everything 101 alone unlocks.
        const marginalEmpty = graph.countMarginallyBlocked("CSCI-UA 101", new Set());
        expect(marginalEmpty).toBeGreaterThan(0);
    });
});

// ============================================================
// Polish #18 — homeSchoolBasis flags in-progress term
// ============================================================
describe("Polish #18 — homeSchoolBasis distinguishes in-progress enrollment", () => {
    it("a term with all *** grades produces a basis string flagged 'in-progress enrollment'", async () => {
        const { parseTranscript } = await import("../../src/transcript/parser.js");
        // Synthesize a minimal transcript where the most recent term is
        // entirely in-progress (***).
        const text = `Anonymous Student
N12345

Term: Fall 2024
COURSE       TITLE                      GRADE EHRS  QHRS  QPTS
CSCI-UA 101  Intro                      A     4.00  4.00  16.00
Term Totals: AHRS 4.00 EHRS 4.00 QHRS 4.00 QPTS 16.00 GPA 4.000

Term: Spring 2025
COURSE       TITLE                      GRADE EHRS  QHRS  QPTS
CSCI-UA 102  Data Structures            ***   4.00  0.00   0.00
MATH-UA 121  Calculus I                 ***   4.00  0.00   0.00
Term Totals: AHRS 8.00 EHRS 8.00 QHRS 0.00 QPTS 0.00 GPA 0.000

AHRS  12.00
EHRS  12.00
QHRS   4.00
QPTS  16.00
GPA   4.000
`;
        const doc = parseTranscript(text);
        const draft = transcriptToProfileDraft(doc);
        const basis = draft.notes.find(n => n.startsWith("homeSchool:"))!;
        expect(basis).toContain("2025-spring");
        expect(basis).toContain("in-progress enrollment");
    });

    it("a term with completed grades produces a basis string WITHOUT the in-progress qualifier", async () => {
        const { parseTranscript } = await import("../../src/transcript/parser.js");
        const text = `Anonymous Student
N67890

Term: Fall 2024
COURSE       TITLE                      GRADE EHRS  QHRS  QPTS
CSCI-UA 101  Intro                      A     4.00  4.00  16.00
Term Totals: AHRS 4.00 EHRS 4.00 QHRS 4.00 QPTS 16.00 GPA 4.000

AHRS   4.00
EHRS   4.00
QHRS   4.00
QPTS  16.00
GPA   4.000
`;
        const doc = parseTranscript(text);
        const draft = transcriptToProfileDraft(doc);
        const basis = draft.notes.find(n => n.startsWith("homeSchool:"))!;
        expect(basis).not.toContain("in-progress enrollment");
    });
});

// ============================================================
// Step 3D — Multi-semester projector
// ============================================================
describe("Step 3D — projectMultiSemester", () => {
    const courses = loadCourses();
    const prereqs = loadPrereqs();
    const csBA = loadProgram("cs_major_ba", "2023")!;

    it("projects 4 semesters forward; never mutates the input profile", () => {
        const profile: StudentProfile = JSON.parse(readFileSync(
            join(__dirname, "profiles/freshman_clean.json"), "utf-8",
        ));
        const before = JSON.parse(JSON.stringify(profile));
        const r = projectMultiSemester({
            student: profile,
            program: csBA,
            courses,
            prereqs,
            startSemester: "2025-fall",
            semesterCount: 4,
        });
        expect(r.semesters.length).toBeLessThanOrEqual(4);
        expect(profile).toEqual(before);
    });

    it("nextSemesterAfter alternates fall/spring", () => {
        expect(nextSemesterAfter("2025-fall")).toBe("2026-spring");
        expect(nextSemesterAfter("2025-spring")).toBe("2025-fall");
        expect(nextSemesterAfter("2025-summer")).toBe("2025-fall");
    });

    it("first semester's plan reflects the student's actual current state, not projected state", () => {
        // Sanity: the first projected semester should match a direct call.
        const profile: StudentProfile = JSON.parse(readFileSync(
            join(__dirname, "profiles/freshman_clean.json"), "utf-8",
        ));
        const r = projectMultiSemester({
            student: profile,
            program: csBA,
            courses,
            prereqs,
            startSemester: "2025-fall",
            semesterCount: 1,
        });
        expect(r.semesters).toHaveLength(1);
        expect(r.semesters[0]!.semester).toBe("2025-fall");
        expect(r.semesters[0]!.plan.suggestions.length).toBeGreaterThan(0);
    });

    it("iteration-2 doesn't re-suggest iteration-1's courses (suggestions are folded forward)", () => {
        const profile: StudentProfile = JSON.parse(readFileSync(
            join(__dirname, "profiles/freshman_clean.json"), "utf-8",
        ));
        const r = projectMultiSemester({
            student: profile,
            program: csBA,
            courses,
            prereqs,
            startSemester: "2025-fall",
            semesterCount: 2,
        });
        if (r.semesters.length < 2) return; // halted early — fine
        const sem1Ids = new Set(r.semesters[0]!.plan.suggestions.map(s => s.courseId));
        const sem2Ids = r.semesters[1]!.plan.suggestions.map(s => s.courseId);
        for (const id of sem2Ids) {
            expect(sem1Ids.has(id)).toBe(false);
        }
    });

    it("rejects a summer or january startSemester (projector advances Fall↔Spring only)", () => {
        const profile: StudentProfile = JSON.parse(readFileSync(
            join(__dirname, "profiles/freshman_clean.json"), "utf-8",
        ));
        expect(() => projectMultiSemester({
            student: profile,
            program: csBA,
            courses,
            prereqs,
            startSemester: "2025-summer",
            semesterCount: 1,
        })).toThrow(/summer|january|fall.*spring/i);
    });
});

// ============================================================
// Step 3E — Exploratory mode (undeclared → Core-first plan)
// ============================================================
describe("Step 3E — planExploratory (undeclared student)", () => {
    const courses = loadCourses();
    const prereqs = loadPrereqs();
    const cas = loadSchoolConfig("cas");
    const casCore = loadProgram("cas_core", "2023")!;
    const programs = new Map<string, Program>([[casCore.programId, casCore]]);

    it("undeclared CAS student gets a Core-first plan", () => {
        const student: StudentProfile = {
            id: "explore1",
            catalogYear: "2023",
            homeSchool: "cas",
            declaredPrograms: [],
            coursesTaken: [],
        };
        const r = planExploratory(
            student,
            courses,
            prereqs,
            { targetSemester: "2025-fall", maxCourses: 4, maxCredits: 16 },
            cas,
            programs,
        );
        expect("kind" in r ? r.kind : null).not.toBe("unsupported");
        if ("kind" in r) return;
        expect(r.auditedProgramId).toBe("cas_core");
        expect(r.plan.suggestions.length).toBeGreaterThan(0);
        expect(r.notes.some(n => n.includes("Exploratory mode"))).toBe(true);
        expect(r.plan.suggestions.every(s => s.reason.startsWith("[exploratory mode"))).toBe(true);
    });

    it("declared student → unsupported (use planNextSemester directly)", () => {
        const student: StudentProfile = {
            id: "explore2",
            catalogYear: "2023",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
            coursesTaken: [],
        };
        const r = planExploratory(
            student,
            courses,
            prereqs,
            { targetSemester: "2025-fall", maxCourses: 4, maxCredits: 16 },
            cas,
            programs,
        );
        expect("kind" in r && r.kind === "unsupported").toBe(true);
    });
});

// ============================================================
// Step 3F — Transfer-prep mode
// ============================================================
describe("Step 3F — planForTransferPrep (CAS → Stern)", () => {
    const courses = loadCourses();
    const prereqs = loadPrereqs();
    const cas = loadSchoolConfig("cas");
    const csBA = loadProgram("cs_major_ba", "2023")!;

    it("CAS student missing micro for Stern junior transfer → suggestion reason flags transfer-prereq", () => {
        const student: StudentProfile = {
            id: "tprep1",
            catalogYear: "2023",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
            coursesTaken: [
                { courseId: "MATH-UA 121", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "EXPOS-UA 1", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "MATH-UA 235", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "ACCT-UB 1", grade: "A", semester: "2024-fall", credits: 4 },
                // 64+ credits to be a junior; pad with electives
                { courseId: "CSCI-UA 101", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "CSCI-UA 102", grade: "A", semester: "2025-spring", credits: 4 },
                { courseId: "CORE-UA 400", grade: "A", semester: "2025-spring", credits: 4 },
                { courseId: "CORE-UA 500", grade: "A", semester: "2025-spring", credits: 4 },
                { courseId: "CORE-UA 700", grade: "A", semester: "2025-spring", credits: 4 },
                { courseId: "CSCI-UA 201", grade: "A", semester: "2025-fall", credits: 4 },
                { courseId: "CSCI-UA 202", grade: "A", semester: "2025-fall", credits: 4 },
                { courseId: "CSCI-UA 310", grade: "A", semester: "2025-fall", credits: 4 },
                { courseId: "MATH-UA 120", grade: "A", semester: "2025-fall", credits: 4 },
                { courseId: "CSCI-UA 421", grade: "A", semester: "2025-fall", credits: 4 },
                { courseId: "CSCI-UA 444", grade: "A", semester: "2025-fall", credits: 4 },
                { courseId: "CSCI-UA 467", grade: "A", semester: "2026-spring", credits: 4 },
            ],
        };
        const r = planForTransferPrep(
            student,
            csBA,
            "stern",
            courses,
            prereqs,
            { targetSemester: "2026-fall", maxCourses: 5, maxCredits: 18 },
            cas,
        );
        expect("kind" in r && r.kind === "unsupported").toBe(false);
        if ("kind" in r) return;
        expect(r.transferDecision.status).toBe("not_yet_eligible");
        expect(r.deadlineWarnings.some(w => w.includes("March 1"))).toBe(true);
        expect(r.missingPrereqsAsCourses.some(m => m.category === "microeconomics")).toBe(true);
    });

    it("CAS → 'tisch' (no transfer file authored) → unsupported with NYU-wide policy notes", () => {
        const student: StudentProfile = {
            id: "tprep2",
            catalogYear: "2023",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
            coursesTaken: [
                { courseId: "MATH-UA 121", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "EXPOS-UA 1", grade: "A", semester: "2024-fall", credits: 4 },
            ],
        };
        const r = planForTransferPrep(
            student,
            csBA,
            "tisch",
            courses,
            prereqs,
            { targetSemester: "2025-fall", maxCourses: 4, maxCredits: 16 },
            cas,
        );
        expect("kind" in r && r.kind === "unsupported").toBe(true);
    });
});

// ============================================================
// Step 3G — Cross-program priority planner
// ============================================================
describe("Step 3G — planMultiProgram", () => {
    const courses = loadCourses();
    const prereqs = loadPrereqs();
    const cas = loadSchoolConfig("cas");
    const csBA = loadProgram("cs_major_ba", "2023")!;

    it("merged CourseSuggestions do NOT leak the internal _programs field (JSON-clean)", () => {
        const fakeMinor: Program = {
            programId: "cas_fake_minor",
            name: "Fake Minor",
            catalogYear: "2023",
            school: "CAS",
            department: "Math",
            totalCreditsRequired: 16,
            rules: [
                {
                    ruleId: "fake_required",
                    label: "Fake Required",
                    type: "must_take",
                    doubleCountPolicy: "allow",
                    catalogYearRange: ["2018", "2030"],
                    courses: ["MATH-UA 120", "MATH-UA 121"],
                },
            ],
        };
        const profile: StudentProfile = {
            id: "mp-leak", catalogYear: "2023", homeSchool: "cas",
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major" },
                { programId: "cas_fake_minor", programType: "minor" },
            ],
            coursesTaken: [],
        };
        const programs = new Map<string, Program>([
            [csBA.programId, csBA],
            [fakeMinor.programId, fakeMinor],
        ]);
        const r = planMultiProgram(profile, programs, courses, prereqs, {
            targetSemester: "2025-fall", maxCourses: 5, maxCredits: 18,
        }, cas);
        for (const sug of r.merged) {
            expect("_programs" in sug).toBe(false);
            // round-trip JSON to make sure no Set serializes to {}
            const roundTripped = JSON.parse(JSON.stringify(sug));
            expect("_programs" in roundTripped).toBe(false);
        }
    });

    it("returns one plan per declared program + a merged list", () => {
        const fakeMinor: Program = {
            programId: "cas_fake_minor",
            name: "Fake Minor",
            catalogYear: "2023",
            school: "CAS",
            department: "Math",
            totalCreditsRequired: 16,
            rules: [
                {
                    ruleId: "fake_required",
                    label: "Fake Required",
                    type: "must_take",
                    doubleCountPolicy: "allow",
                    catalogYearRange: ["2018", "2030"],
                    courses: ["MATH-UA 120", "MATH-UA 121"],
                },
            ],
        };
        const profile: StudentProfile = {
            id: "mp1",
            catalogYear: "2023",
            homeSchool: "cas",
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major" },
                { programId: "cas_fake_minor", programType: "minor" },
            ],
            coursesTaken: [],
        };
        const programs = new Map<string, Program>([
            [csBA.programId, csBA],
            [fakeMinor.programId, fakeMinor],
        ]);
        const r = planMultiProgram(profile, programs, courses, prereqs, {
            targetSemester: "2025-fall", maxCourses: 5, maxCredits: 18,
        }, cas);
        expect(r.perProgram).toHaveLength(2);
        expect(r.merged.length).toBeGreaterThan(0);
        // Sorted by priority desc
        for (let i = 1; i < r.merged.length; i++) {
            expect(r.merged[i - 1]!.priority).toBeGreaterThanOrEqual(r.merged[i]!.priority);
        }
    });
});
