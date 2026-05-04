// ============================================================
// Phase 16 Task C — groupCoursesByTerm unit tests
// ============================================================
// Covers the five scenarios called out in the Task 16.C plan:
//   (a) history-only profile
//   (b) history + IP + future plan
//   (c) TE extraction into priorCredits
//   (d) deduplication when a term appears in both history AND
//       forwardSchedule.semesters
//   (e) chronological ordering across years
// ============================================================

import { describe, expect, it } from "vitest";
import type {
    StudentProfile,
    ForwardSchedule,
    ForwardSemester,
    ScheduleSlot,
} from "@nyupath/shared";
import type { DegreeProgressReport, DPRCourseRow } from "@nyupath/engine";
import { groupCoursesByTerm, compareTerms } from "../lib/groupCoursesByTerm";

// ---- helpers -----------------------------------------------------

function mkProfile(overrides: Partial<StudentProfile> = {}): StudentProfile {
    return {
        id: "test-student",
        catalogYear: "2024-2025",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
        coursesTaken: [],
        flags: [],
        ...overrides,
    };
}

function mkSemester(overrides: Partial<ForwardSemester> & { term: string }): ForwardSemester {
    return {
        term: overrides.term,
        locked: overrides.locked ?? false,
        slots: overrides.slots ?? [],
        plannedCredits: overrides.plannedCredits ?? 0,
        notes: overrides.notes ?? [],
        loadRationale: overrides.loadRationale ?? {
            // LoadRationale shape varies; sidebar never reads its body
            // for our purposes, so pass a minimal object cast through.
        } as unknown as ForwardSemester["loadRationale"],
    };
}

function mkSchedule(semesters: ForwardSemester[]): ForwardSchedule {
    return {
        studentId: "test-student",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: null,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters,
        dprCourseHistoryHash: "hash",
        computedAt: 1700000000000,
        feasibility: { feasible: true, constraintViolations: [] } as unknown as ForwardSchedule["feasibility"],
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
}

function mkSpecificSlot(courseId: string, credits = 4): ScheduleSlot {
    // The full ScheduleSlotSpecificPlanned shape carries a dozen
    // discriminated-union fields the helper never reads (rationale,
    // flexibility, downstreamImpact, …). Build a minimal shape and
    // cast through `unknown` — the helper only branches on `kind` and
    // copies the slot through to the consumer.
    return {
        kind: "specific_planned",
        courseId,
        title: courseId,
        credits,
        satisfiesRules: [],
        reason: "test",
        rationale: {},
        flexibility: {},
        downstreamImpact: {},
        workloadTier: "medium",
        workloadWeight: 1,
        bindingState: "bound",
        confidence: "high",
        isCriticalPath: false,
    } as unknown as ScheduleSlot;
}

function mkRow(overrides: Partial<DPRCourseRow> & { term: string; subject: string; catalogNbr: string }): DPRCourseRow {
    return {
        term: overrides.term,
        subject: overrides.subject,
        catalogNbr: overrides.catalogNbr,
        courseTitle: overrides.courseTitle ?? `${overrides.subject} ${overrides.catalogNbr}`,
        grade: overrides.grade ?? "A",
        units: overrides.units ?? 4,
        type: overrides.type ?? "EN",
    };
}

function mkDpr(rows: DPRCourseRow[]): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-04-27T00:00:00Z",
            sourceFingerprint: "sha256:test",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        header: { studentName: "Test Student", preparedDate: "04/27/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: null,
            creditsUsed: null,
            cumulativeGpa: null,
            cumulativeGpaRequired: null,
            residencyRequired: null,
            residencyUsed: null,
            passFailUsedUnits: null,
            passFailCapUnits: null,
            outsideHomeUsedUnits: null,
            outsideHomeCapUnits: null,
            timeLimitYears: null,
        },
        requirementGroups: [],
        courseHistory: rows,
    };
}

// ---- tests -------------------------------------------------------

describe("groupCoursesByTerm — Phase 16 Task C", () => {
    it("(a) history-only profile groups completed courses by term", () => {
        const student = mkProfile({
            coursesTaken: [
                { courseId: "CSCI-UA 101", grade: "A", semester: "2024 Fall", credits: 4 },
                { courseId: "MATH-UA 121", grade: "B+", semester: "2024 Fall", credits: 4 },
                { courseId: "PHYS-UA 11", grade: "A-", semester: "2025 Spring", credits: 4 },
            ],
        });
        const out = groupCoursesByTerm({ student, forwardSchedule: null });
        expect(out.priorCredits).toEqual([]);
        expect(out.terms).toHaveLength(2);
        expect(out.terms[0]!.term).toBe("2024 Fall");
        expect(out.terms[0]!.locked).toBe(true);
        expect(out.terms[0]!.slots).toHaveLength(2);
        expect(out.terms[0]!.slots[0]!.kind).toBe("completed");
        expect(out.terms[1]!.term).toBe("2025 Spring");
        expect(out.terms[1]!.slots).toHaveLength(1);
    });

    it("(b) history + IP + future plan renders all three buckets in order", () => {
        const student = mkProfile({
            coursesTaken: [
                { courseId: "CSCI-UA 101", grade: "A", semester: "2024 Fall", credits: 4 },
                // IP placeholder rows that buildStudentProfileFromDpr writes
                // with grade="C". These should be filtered out of history.
                { courseId: "CSCI-UA 102", grade: "C", semester: "2026 Spring", credits: 4 },
            ],
            currentSemester: {
                term: "2026 Spring",
                courses: [
                    { courseId: "CSCI-UA 102", title: "Data Structures", credits: 4 },
                ],
            },
        });
        const schedule = mkSchedule([
            mkSemester({
                term: "2026-fall",
                slots: [mkSpecificSlot("CSCI-UA 201")],
                plannedCredits: 4,
            }),
        ]);
        const out = groupCoursesByTerm({ student, forwardSchedule: schedule });
        expect(out.terms).toHaveLength(3);
        expect(out.terms[0]!.term).toBe("2024 Fall");
        expect(out.terms[0]!.locked).toBe(true);
        expect(out.terms[1]!.term).toBe("2026 Spring");
        expect(out.terms[1]!.locked).toBe(false);
        expect(out.terms[1]!.slots[0]!.kind).toBe("in_progress");
        expect(out.terms[2]!.term).toBe("2026-fall");
        expect(out.terms[2]!.slots[0]!.kind).toBe("specific_planned");
    });

    it("(c) extracts type=TE rows into priorCredits, including ELECTIVE→courseTitle fallback", () => {
        const dpr = mkDpr([
            mkRow({ term: "2024 Fall", subject: "CSCI-UA", catalogNbr: "101", grade: "TE", type: "TE", courseTitle: "Intro to Computer Sci" }),
            mkRow({ term: "2024 Fall", subject: "MATH-UA", catalogNbr: "121", grade: "TE", type: "TE", courseTitle: "Calculus I" }),
            mkRow({ term: "2024 Fall", subject: "ELECTIVE", catalogNbr: "CREDIT", grade: "TE", type: "TE", courseTitle: "Elective Credit UGRD" }),
            // EN row should NOT appear in priorCredits.
            mkRow({ term: "2024 Fall", subject: "WRIT-UA", catalogNbr: "100", grade: "A", type: "EN" }),
        ]);
        const out = groupCoursesByTerm({ student: null, forwardSchedule: null, dpr });
        expect(out.priorCredits).toHaveLength(3);
        expect(out.priorCredits[0]!.courseId).toBe("CSCI-UA 101");
        expect(out.priorCredits[0]!.credits).toBe(4);
        expect(out.priorCredits[1]!.courseId).toBe("MATH-UA 121");
        // ELECTIVE row falls back to courseTitle.
        expect(out.priorCredits[2]!.courseId).toBe("Elective Credit UGRD");
    });

    it("(d) de-duplicates when a term appears in both currentSemester AND forwardSchedule.semesters", () => {
        const student = mkProfile({
            currentSemester: {
                term: "2026-fall",
                courses: [{ courseId: "CSCI-UA 480", title: "Special Topics", credits: 4 }],
            },
        });
        const schedule = mkSchedule([
            // Forward planner emitted the immediate term too. The IP
            // rendering must win; the future-card duplicate is dropped.
            mkSemester({
                term: "2026-fall",
                slots: [mkSpecificSlot("CSCI-UA 480")],
            }),
            mkSemester({
                term: "2027-spring",
                slots: [mkSpecificSlot("CSCI-UA 490")],
            }),
        ]);
        const out = groupCoursesByTerm({ student, forwardSchedule: schedule });
        expect(out.terms).toHaveLength(2);
        expect(out.terms[0]!.term).toBe("2026-fall");
        expect(out.terms[0]!.slots[0]!.kind).toBe("in_progress");
        expect(out.terms[1]!.term).toBe("2027-spring");
        expect(out.terms[1]!.slots[0]!.kind).toBe("specific_planned");
    });

    it("(e) sorts terms chronologically across years and across DPR / planner shapes", () => {
        const student = mkProfile({
            coursesTaken: [
                { courseId: "X-100", grade: "A", semester: "2025 Fall", credits: 4 },
                { courseId: "X-200", grade: "A", semester: "2024 Spring", credits: 4 },
                { courseId: "X-300", grade: "A", semester: "2024 Fall", credits: 4 },
            ],
        });
        const schedule = mkSchedule([
            mkSemester({ term: "2026-spring", slots: [mkSpecificSlot("X-400")] }),
            mkSemester({ term: "2025-spring", slots: [mkSpecificSlot("X-150")] }),
        ]);
        const out = groupCoursesByTerm({ student, forwardSchedule: schedule });
        // Expected chronological order:
        //   2024 Spring → 2024 Fall → 2025-spring (planner) → 2025 Fall (DPR) → 2026-spring (planner)
        expect(out.terms.map((t) => t.term)).toEqual([
            "2024 Spring",
            "2024 Fall",
            "2025-spring",
            "2025 Fall",
            "2026-spring",
        ]);
    });

    it("compareTerms handles both 'YYYY Season' and 'YYYY-season' shapes", () => {
        expect(compareTerms("2024 Fall", "2025 Spring")).toBeLessThan(0);
        expect(compareTerms("2026-fall", "2026-spring")).toBeGreaterThan(0);
        expect(compareTerms("2025 Fall", "2025-fall")).toBe(0);
        expect(compareTerms("2024 Spr", "2024 Fall")).toBeLessThan(0);
    });
});
