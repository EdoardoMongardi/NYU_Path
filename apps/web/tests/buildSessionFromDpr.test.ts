// ============================================================
// Phase 7-E W2.4 — buildStudentProfileFromDpr unit tests
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr } from "@nyupath/engine";
import { buildStudentProfileFromDpr } from "../lib/buildSession";

const FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);

function loadDpr() {
    const r = parseDpr(FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("parse failed");
    return r.report;
}

describe("buildStudentProfileFromDpr (Phase 7-E W2.4)", () => {
    it("derives studentId from the DPR header student name", () => {
        const p = buildStudentProfileFromDpr(loadDpr());
        expect(p.id).toBe("sample_student");
    });

    it("derives homeSchool=cas from a UA-Coll of Arts & Sci program label", () => {
        const p = buildStudentProfileFromDpr(loadDpr());
        expect(p.homeSchool).toBe("cas");
    });

    it("derives catalogYear from the major's requirement term (Fall 2024 → 2024-2025)", () => {
        const p = buildStudentProfileFromDpr(loadDpr());
        expect(p.catalogYear).toBe("2024-2025");
    });

    it("emits one ProgramDeclaration for the declared major", () => {
        const p = buildStudentProfileFromDpr(loadDpr());
        const majors = p.declaredPrograms.filter((d) => d.programType === "major");
        expect(majors).toHaveLength(1);
        expect(majors[0]!.programId).toBe("computer_science_math");
    });

    it("populates coursesTaken from the DPR Course History", () => {
        const p = buildStudentProfileFromDpr(loadDpr());
        // ELECTIVE CREDIT row is filtered out (no audit value).
        expect(p.coursesTaken.length).toBeGreaterThan(30);
        // Standard EN row preserved.
        const csci102 = p.coursesTaken.find((c) => c.courseId === "CSCI-UA 102");
        expect(csci102).toBeDefined();
        expect(csci102!.grade).toBe("B");
        expect(csci102!.credits).toBe(4);

        // TE (transfer credit) row preserved with grade=TE.
        const calc1 = p.coursesTaken.find((c) => c.courseId === "MATH-UA 121");
        expect(calc1?.grade).toBe("TE");

        // IP row preserved with grade=C (assumed-passing fallback for current term).
        const ml = p.coursesTaken.find((c) => c.courseId === "CSCI-UA 473");
        expect(ml?.grade).toBe("C");
    });

    it("aggregates transfer credits via genericTransferCredits", () => {
        const p = buildStudentProfileFromDpr(loadDpr());
        // Sample fixture has 8 TE rows × 4 credits each = 32 credits.
        expect(p.genericTransferCredits).toBeGreaterThanOrEqual(28);
    });

    it("populates currentSemester with IP courses, picking the latest term", () => {
        const p = buildStudentProfileFromDpr(loadDpr());
        expect(p.currentSemester).toBeDefined();
        // The fixture has Fall 2026 IP courses (latest); currentSemester
        // should pick that term.
        expect(p.currentSemester!.term).toBe("2026 Fall");
        const codes = p.currentSemester!.courses.map((c) => c.courseId);
        expect(codes).toContain("MATH-UA 251");
        expect(codes).toContain("MATH-UA 343");
    });

    // Regression test for the May 2026 post-mortem "7 courses for Fall
    // 2026" bug: when the DPR carries IP rows for BOTH the in-progress
    // term AND the pre-registered next term, `currentSemester.courses`
    // must list ONLY the rows whose term matches `currentSemester.term`.
    // The old loop pushed every IP row into `pendingCourses` regardless,
    // so a student mid-Spring with Fall pre-registered ended up with a
    // 7-course `currentSemester` mixing both terms — and the agent
    // surfaced "you have 7 courses for Fall 2026."
    it("does NOT mix IP rows from earlier terms into currentSemester", () => {
        const p = buildStudentProfileFromDpr(loadDpr());
        const fixtureTerm = p.currentSemester!.term;
        // Sanity: the SAA_STD_DS fixture has IP rows in both Spring 2026
        // (4 rows) and Fall 2026 (3 rows). Per latest-term selection,
        // currentSemester.term should be "2026 Fall" with 3 courses.
        expect(fixtureTerm).toBe("2026 Fall");
        expect(p.currentSemester!.courses).toHaveLength(3);
        const codes = p.currentSemester!.courses.map((c) => c.courseId);
        // Spring 2026 IP rows that must NOT appear here.
        expect(codes).not.toContain("CSCI-UA 4");
        expect(codes).not.toContain("CSCI-UA 473");
        expect(codes).not.toContain("MATH-UA 334");
        expect(codes).not.toContain("MPAJZ-UE 71");
        // Fall 2026 IP rows that MUST appear.
        expect(codes).toContain("CORE-UA 700");
        expect(codes).toContain("MATH-UA 251");
        expect(codes).toContain("MATH-UA 343");
    });

    it("coursesTaken still includes EVERY IP row across all terms (audit needs them)", () => {
        const p = buildStudentProfileFromDpr(loadDpr());
        const ipCodes = p.coursesTaken
            .filter((c) => c.semester.includes("2026"))
            .map((c) => c.courseId);
        // All 7 IP rows from 2026 Spr + 2026 Fall must remain in
        // coursesTaken so the audit / prereq checker can see them.
        expect(ipCodes).toContain("CSCI-UA 4");
        expect(ipCodes).toContain("CSCI-UA 473");
        expect(ipCodes).toContain("MATH-UA 334");
        expect(ipCodes).toContain("MPAJZ-UE 71");
        expect(ipCodes).toContain("CORE-UA 700");
        expect(ipCodes).toContain("MATH-UA 251");
        expect(ipCodes).toContain("MATH-UA 343");
    });

    it("respects opts.visaStatus override", () => {
        const p = buildStudentProfileFromDpr(loadDpr(), { visaStatus: "f1" });
        expect(p.visaStatus).toBe("f1");
    });

    it("respects opts.declaredProgramsOverride", () => {
        const p = buildStudentProfileFromDpr(loadDpr(), {
            declaredProgramsOverride: [{ programId: "test_override", programType: "major" }],
        });
        expect(p.declaredPrograms[0]!.programId).toBe("test_override");
    });
});
