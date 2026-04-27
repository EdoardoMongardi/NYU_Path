// ============================================================
// buildSession (Phase 6.1 WS2)
// ============================================================
// Converts the v2 chat-route request body into a typed `ToolSession`
// the agent loop can consume. Lives in apps/web/lib because the
// transcript-parser shape is web-specific (the engine's StudentProfile
// is canonical, but the parsedData → StudentProfile mapping has
// historically lived inside the chat route).
//
// Distinction from the legacy `buildStudentProfile` in
// apps/web/app/api/chat/route.ts: that function emits a profile with
// `declaredPrograms: ["cs_major_ba"]` (legacy string-array shape).
// The Phase-1+ engine expects `ProgramDeclaration[]`. This helper
// emits the canonical shape.
// ============================================================

import type {
    StudentProfile,
    CourseTaken,
    ProgramDeclaration,
} from "@nyupath/shared";

export interface TranscriptSemester {
    term: string;
    courses: Array<{ courseId: string; title: string; credits: number; grade: string }>;
}

export interface TranscriptData {
    name?: string;
    semesters?: TranscriptSemester[];
    currentSemester?: {
        term: string;
        courses: Array<{ courseId: string; title: string; credits: number }>;
    };
    testCredits?: Array<{ credits: number; component: string }>;
    declaredPrograms?: ProgramDeclaration[];
    homeSchool?: string;
}

/** Strip "CSCI-UA 0101" → "CSCI-UA 101" to match the engine catalog. */
function normalizeCourseId(id: string): string {
    return id.replace(/([A-Z]+-[A-Z]+\s*)0+(\d+)/, "$1$2");
}

/** Build a canonical StudentProfile from a parsed-transcript payload. */
export function buildStudentProfileV2(
    parsedData: TranscriptData,
    visaStatus?: string,
    catalogYearOverride?: string,
): StudentProfile {
    const coursesTaken: CourseTaken[] = [];
    for (const sem of parsedData.semesters ?? []) {
        for (const c of sem.courses) {
            coursesTaken.push({
                courseId: normalizeCourseId(c.courseId),
                grade: c.grade,
                semester: sem.term,
                credits: c.credits,
            });
        }
    }

    const pendingCourses: Array<{ courseId: string; title: string; credits: number }> = [];
    if (parsedData.currentSemester?.courses) {
        for (const c of parsedData.currentSemester.courses) {
            const normalizedId = normalizeCourseId(c.courseId);
            coursesTaken.push({
                courseId: normalizedId,
                grade: "C", // Assumed passing — satisfies major reqs + prereqs
                semester: parsedData.currentSemester.term ?? "current",
                credits: c.credits,
            });
            pendingCourses.push({ courseId: normalizedId, title: c.title, credits: c.credits });
        }
    }

    // P3 reviewer fix: emit a `YYYY-YYYY` range (matching the engine's
    // canonical catalogYear format used in school configs and the
    // override path) instead of a bare start year. The earliest
    // semester year defines the start of the range.
    const years = (parsedData.semesters ?? [])
        .map((s) => s.term.match(/(\d{4})/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => parseInt(m[1]!, 10));
    const catalogYear = catalogYearOverride
        ?? (years.length > 0
            ? `${Math.min(...years)}-${Math.min(...years) + 1}`
            : "2025-2026");

    const transferCourses = (parsedData.testCredits ?? []).map((tc) => ({
        source: `AP: ${tc.component}`,
        originalCourse: tc.component,
        credits: tc.credits,
    }));
    const genericTransferCredits = transferCourses.reduce((sum, tc) => sum + tc.credits, 0);

    // Default declared program (CS BA, CAS) is preserved from the
    // legacy route but emitted as a canonical `ProgramDeclaration[]`.
    const declaredPrograms: ProgramDeclaration[] = parsedData.declaredPrograms ?? [
        { programId: "cs_major_ba", programType: "major" },
    ];

    return {
        id: "web-user",
        catalogYear,
        homeSchool: parsedData.homeSchool ?? "cas",
        declaredPrograms,
        coursesTaken,
        genericTransferCredits,
        flags: [],
        visaStatus: visaStatus === "f1" ? "f1" : "domestic",
        currentSemester: pendingCourses.length > 0
            ? {
                term: parsedData.currentSemester?.term ?? "current",
                courses: pendingCourses,
            }
            : undefined,
    };
}
