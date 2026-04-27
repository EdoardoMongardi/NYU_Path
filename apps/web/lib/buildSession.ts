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
import type { DegreeProgressReport, DPRCourseRow } from "@nyupath/engine";

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

// ============================================================
// DPR-driven session builder (Phase 7-E W2.4)
// ============================================================
// Produces a `StudentProfile` from the parsed Albert DPR. This
// is the post-pivot canonical onboarding path; the transcript
// builder above is the fallback when DPR is unavailable.
//
// Key differences from buildStudentProfileV2:
//   - declaredPrograms come from the DPR's Programs table (not
//     hardcoded to cs_major_ba)
//   - homeSchool is derived from the program label (e.g.,
//     "UA-Coll of Arts & Sci" → "cas")
//   - catalogYear comes from the major's "Requirement Term"
//     (e.g., "Fall 2024" → "2024-2025")
//   - coursesTaken comes from the DPR's Course History block,
//     which is more authoritative than the transcript (DPR includes
//     repeats, equivalences, and audit-relevant type tagging)
//   - currentSemester is reconstructed from courses with type=IP
//
// Cardinal Rule §2.1: every field traces back to a DPR field; no
// LLM synthesis. The DPR is the source of truth for all numerical
// claims the agent surfaces.

export interface BuildSessionFromDprOptions {
    /** Override visa status (DPR doesn't expose this). */
    visaStatus?: "f1" | "domestic";
    /** Override catalogYear (defaults to derived from major's term). */
    catalogYearOverride?: string;
    /** Override declaredPrograms (defaults to derived from DPR programs table). */
    declaredProgramsOverride?: ProgramDeclaration[];
    /** Override homeSchool (defaults to derived from CAS/Tisch/Tandon/etc. label). */
    homeSchoolOverride?: string;
}

export function buildStudentProfileFromDpr(
    report: DegreeProgressReport,
    opts: BuildSessionFromDprOptions = {},
): StudentProfile {
    // 1. Course history → CourseTaken[]. Filter out info-only rows
    //    (type=EN with grade=null but no IP designation isn't expected,
    //    but we guard against it). Skip the synthetic ELECTIVE CREDIT
    //    rows because they have no real course id the engine can use.
    const coursesTaken: CourseTaken[] = [];
    const pendingCourses: Array<{ courseId: string; title: string; credits: number }> = [];
    let currentTerm: string | undefined;

    for (const row of report.courseHistory) {
        if (row.subject === "ELECTIVE") continue; // synthetic transfer-credit row, no audit value
        const courseId = `${row.subject} ${row.catalogNbr}`.replace(/\s+/g, " ").trim();
        const grade = row.grade ?? (row.type === "IP" ? "C" : "P");
        coursesTaken.push({
            courseId,
            grade,
            semester: row.term,
            credits: row.units,
        });
        if (row.type === "IP") {
            pendingCourses.push({
                courseId,
                title: row.courseTitle,
                credits: row.units,
            });
            // Pick the latest IP term as currentSemester.
            if (!currentTerm || compareTerms(row.term, currentTerm) > 0) {
                currentTerm = row.term;
            }
        }
    }

    // 2. Declared programs from DPR Programs table (filter to Major /
    //    Minor / Concentration types — skip the Career + Program rows
    //    which are administrative).
    const declaredPrograms = opts.declaredProgramsOverride ?? deriveDeclaredPrograms(report);

    // 3. Home school heuristic: scan program labels for known school
    //    indicators. Falls back to "cas" since cohort A is CAS-first.
    const homeSchool = opts.homeSchoolOverride ?? deriveHomeSchool(report);

    // 4. Catalog year from the major's requirement term.
    const catalogYear = opts.catalogYearOverride ?? deriveCatalogYear(report);

    // 5. Transfer credits aggregate from rows with type=TE.
    const transferRows = report.courseHistory.filter((r) => r.type === "TE");
    const genericTransferCredits = transferRows.reduce((sum, r) => sum + r.units, 0);

    return {
        id: deriveStudentId(report),
        catalogYear,
        homeSchool,
        declaredPrograms,
        coursesTaken,
        genericTransferCredits,
        flags: [],
        visaStatus: opts.visaStatus ?? "domestic",
        currentSemester: pendingCourses.length > 0
            ? {
                term: currentTerm ?? "current",
                courses: pendingCourses,
            }
            : undefined,
    };
}

// ---- helpers ----

/** Heuristic ranking of two term strings ("2026 Fall" > "2026 Spr" > "2025 Fall"). */
function compareTerms(a: string, b: string): number {
    const SEASON_ORDER: Record<string, number> = {
        Spr: 1, Spring: 1, Summer: 2, Fall: 3, "J-Term": 0, January: 0,
    };
    const [yearA, seasonA] = a.split(" ");
    const [yearB, seasonB] = b.split(" ");
    const yA = parseInt(yearA ?? "0", 10);
    const yB = parseInt(yearB ?? "0", 10);
    if (yA !== yB) return yA - yB;
    return (SEASON_ORDER[seasonA ?? ""] ?? 0) - (SEASON_ORDER[seasonB ?? ""] ?? 0);
}

function deriveDeclaredPrograms(report: DegreeProgressReport): ProgramDeclaration[] {
    const out: ProgramDeclaration[] = [];
    for (const p of report.programs) {
        const t = p.programType.toLowerCase();
        if (t.includes("major")) {
            out.push({ programId: programIdFromLabel(p.label), programType: "major" });
        } else if (t.includes("minor")) {
            out.push({ programId: programIdFromLabel(p.label), programType: "minor" });
        } else if (t.includes("concentration")) {
            out.push({ programId: programIdFromLabel(p.label), programType: "concentration" });
        }
    }
    // Fallback when Programs table doesn't list a Major (rare):
    // emit a generic placeholder so downstream tools see at least
    // one declared program.
    if (out.length === 0) {
        out.push({ programId: "unknown_major", programType: "major" });
    }
    return out;
}

function deriveHomeSchool(report: DegreeProgressReport): string {
    const programLabels = report.programs.map((p) => p.label.toLowerCase()).join(" ");
    // Order matters: Steinhardt's published name includes "...the Arts",
    // so a naive "arts" substring on Tisch would false-positive on
    // Steinhardt students. Match Steinhardt first; tighten Tisch to
    // the literal school name ("tisch") only.
    if (programLabels.includes("steinhardt")) return "steinhardt";
    if (programLabels.includes("tisch")) return "tisch";
    if (programLabels.includes("arts & sci") || programLabels.includes("ua-coll")) return "cas";
    if (programLabels.includes("tandon") || programLabels.includes("engineering")) return "tandon";
    if (programLabels.includes("stern") || programLabels.includes("business")) return "stern";
    if (programLabels.includes("gallatin") || programLabels.includes("individualized")) return "gallatin";
    if (programLabels.includes("liberal studies")) return "liberal_studies";
    if (programLabels.includes("sps") || programLabels.includes("professional studies")) return "sps";
    return "cas"; // safe default for cohort A
}

function deriveCatalogYear(report: DegreeProgressReport): string {
    // Find the Major's requirement term first.
    const major = report.programs.find((p) => p.programType.toLowerCase().includes("major"));
    const fallbackTerm = report.programs[0]?.requirementTerm ?? "";
    const term = major?.requirementTerm ?? fallbackTerm;
    const m = term.match(/(\d{4})/);
    if (!m) return "2025-2026";
    const startYear = parseInt(m[1]!, 10);
    return `${startYear}-${startYear + 1}`;
}

function deriveStudentId(report: DegreeProgressReport): string {
    // PeopleSoft N-numbers aren't in the DPR header (the SAA_STD_DS
    // PDF carries them on the planner-form page only). Use a slugified
    // student name as the local id; auth replaces this with the JWT
    // subject when W12 lands.
    return report.header.studentName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function programIdFromLabel(label: string): string {
    // "Computer Science/Math" → "computer_science_math"
    return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
