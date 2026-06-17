// ============================================================
// Phase 7-E W2.4 — buildStudentProfileFromDpr unit tests
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DegreeProgressReport } from "@nyupath/engine";
import { parseDpr } from "@nyupath/engine";
import {
    buildStudentProfileFromDpr,
    deriveDeclaredProgramsFromDpr,
} from "../lib/buildSession";

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

        // IP row preserved with grade=null and isInProgress=true (DPR-2: no fabricated grade).
        const ml = p.coursesTaken.find((c) => c.courseId === "CSCI-UA 473");
        expect(ml?.grade).toBeNull();
        expect(ml?.isInProgress).toBe(true);
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

// ============================================================
// deriveDeclaredProgramsFromDpr — the SHARED pre-fallback classifier
// (FIX-2). Pins the INTENTIONAL divergence between the raw classifier
// the wizard reads (no padding → genuine "undeclared" survives) and the
// session-path `deriveDeclaredPrograms` (which appends an
// `unknown_major` placeholder so downstream tools always see ≥1
// program). Both must agree on the classification RULE; they diverge
// ONLY on the empty case, on purpose.
// ============================================================

/** Minimal report exercising only the `programs[]` surface the classifier reads. */
function reportWithPrograms(
    programs: Array<{ programType: string; label: string }>,
): DegreeProgressReport {
    return {
        header: { studentName: "Test Student" },
        programs: programs.map((p) => ({ ...p, requirementTerm: "Fall 2024" })),
        courseHistory: [],
        advisorNotations: [],
    } as unknown as DegreeProgressReport;
}

describe("deriveDeclaredProgramsFromDpr — shared classifier (pre-fallback)", () => {
    it("maps Major / Minor / Concentration rows, skipping administrative rows", () => {
        const out = deriveDeclaredProgramsFromDpr(
            reportWithPrograms([
                { programType: "Undergraduate Career", label: "UA-Coll of Arts & Sci" },
                { programType: "Program", label: "Computer Science" },
                { programType: "Major", label: "Computer Science/Math Major" },
                { programType: "Minor", label: "Mathematics Minor" },
            ]),
        );
        expect(out).toHaveLength(2);
        expect(out.map((d) => d.programType).sort()).toEqual(["major", "minor"]);
    });

    it("a DPR with NO Major/Minor/Concentration row → core returns [] (genuinely undeclared)", () => {
        const out = deriveDeclaredProgramsFromDpr(
            reportWithPrograms([
                { programType: "Undergraduate Career", label: "UA-Coll of Arts & Sci" },
                { programType: "Program", label: "Liberal Studies Core" },
            ]),
        );
        // The wizard reads THIS raw result — empty means truly undeclared.
        expect(out).toEqual([]);
    });

    it("deriveDeclaredPrograms (session path) pads the SAME empty case with unknown_major", () => {
        // Same no-declared-program DPR, but driven through the public
        // builder: the session path MUST still emit the unknown_major
        // placeholder (output UNCHANGED for its callers). This pins the
        // intentional divergence from the raw classifier above.
        const report = reportWithPrograms([
            { programType: "Undergraduate Career", label: "UA-Coll of Arts & Sci" },
            { programType: "Program", label: "Liberal Studies Core" },
        ]);
        const profile = buildStudentProfileFromDpr(report);
        expect(profile.declaredPrograms).toEqual([
            { programId: "unknown_major", programType: "major" },
        ]);
    });
});
