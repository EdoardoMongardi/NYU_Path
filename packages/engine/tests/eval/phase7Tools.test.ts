// ============================================================
// Phase 7-A P-3 — get_academic_standing + search_courses tests
// ============================================================

import { describe, expect, it } from "vitest";
import {
    getAcademicStandingTool,
    searchCoursesTool,
    type ToolSession,
} from "../../src/agent/index.js";
import type { StudentProfile } from "@nyupath/shared";

const ctx = (session: ToolSession) => ({ signal: new AbortController().signal, session });

const STUDENT: StudentProfile = {
    id: "u1",
    catalogYear: "2025-2026",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
    coursesTaken: [
        { courseId: "CSCI-UA 101", grade: "A",  semester: "2023-fall",   credits: 4 },
        { courseId: "MATH-UA 121", grade: "A-", semester: "2023-fall",   credits: 4 },
        { courseId: "CSCI-UA 102", grade: "B+", semester: "2024-spring", credits: 4 },
    ],
    visaStatus: "domestic",
};

// ----------------------------------------------------------------
// get_academic_standing
// ----------------------------------------------------------------

describe("get_academic_standing tool (Phase 7-A P-3)", () => {
    it("returns cumulative GPA + standing level + warnings", async () => {
        const session: ToolSession = { student: STUDENT };
        const out = await getAcademicStandingTool.call({}, ctx(session)) as {
            cumulativeGPA: number;
            level: string;
            inGoodStanding: boolean;
            completionRate: number;
        };
        // 3 courses (A, A-, B+) → ((4 + 3.667 + 3.333) / 3) ≈ 3.667
        expect(out.cumulativeGPA).toBeGreaterThan(3.5);
        expect(out.cumulativeGPA).toBeLessThan(3.8);
        expect(out.inGoodStanding).toBe(true);
        expect(out.level).toBe("good_standing");
    });

    it("rejects when no student profile loaded", async () => {
        const v = await getAcademicStandingTool.validateInput!({}, ctx({}));
        expect(v.ok).toBe(false);
        if (v.ok) return;
        expect(v.userMessage).toMatch(/no student profile/i);
    });

    it("summarizeResult includes the GPA + standing level + completion rate", async () => {
        const session: ToolSession = { student: STUDENT };
        const out = await getAcademicStandingTool.call({}, ctx(session));
        const summary = getAcademicStandingTool.summarizeResult(out);
        expect(summary).toMatch(/STANDING:/);
        expect(summary).toMatch(/cumulative GPA/);
        expect(summary).toMatch(/completion rate/i);
    });
});

// ----------------------------------------------------------------
// search_courses
// ----------------------------------------------------------------

describe("search_courses tool (Phase 7-A P-3)", () => {
    const catalog = [
        { courseId: "CSCI-UA 101", title: "Intro to Computer Science", credits: 4 },
        { courseId: "CSCI-UA 480", title: "Special Topics: Machine Learning", credits: 4 },
        { courseId: "DS-UA 100", title: "Intro to Data Science", credits: 4 },
        { courseId: "ECON-UA 1", title: "Macroeconomics", credits: 4 },
    ];

    it("matches by title keyword (case-insensitive)", async () => {
        const session = { student: STUDENT, courseCatalog: catalog } as unknown as ToolSession;
        const out = await searchCoursesTool.call(
            { query: "machine learning" },
            ctx(session),
        ) as { matches: Array<{ courseId: string }> };
        expect(out.matches).toHaveLength(1);
        expect(out.matches[0]!.courseId).toBe("CSCI-UA 480");
    });

    it("filters by departmentPrefix", async () => {
        const session = { student: STUDENT, courseCatalog: catalog } as unknown as ToolSession;
        const out = await searchCoursesTool.call(
            { query: "intro", departmentPrefix: "CSCI-UA" },
            ctx(session),
        ) as { matches: Array<{ courseId: string }> };
        expect(out.matches).toHaveLength(1);
        expect(out.matches[0]!.courseId).toBe("CSCI-UA 101");
    });

    it("respects the limit", async () => {
        const big = Array.from({ length: 50 }, (_, i) => ({
            courseId: `CSCI-UA ${100 + i}`,
            title: `Topic ${i}`,
        }));
        const session = { student: STUDENT, courseCatalog: big } as unknown as ToolSession;
        const out = await searchCoursesTool.call(
            { query: "topic", limit: 5 },
            ctx(session),
        ) as { totalReturned: number };
        expect(out.totalReturned).toBe(5);
    });

    it("supports session.searchCoursesFn injection (live FOSE swap)", async () => {
        const session = {
            student: STUDENT,
            searchCoursesFn: async (q: string) => [{ courseId: "stub", title: q, credits: 4 }],
        } as unknown as ToolSession;
        const out = await searchCoursesTool.call(
            { query: "anything" },
            ctx(session),
        ) as { matches: Array<{ courseId: string; title: string }> };
        expect(out.matches[0]!.courseId).toBe("stub");
        expect(out.matches[0]!.title).toBe("anything");
    });

    it("rejects too-short queries via Zod (.min(2))", () => {
        const r = searchCoursesTool.inputSchema.safeParse({ query: "x" });
        expect(r.success).toBe(false);
    });
});
