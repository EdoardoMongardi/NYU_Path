// ============================================================
// buildSession
// ============================================================
// Builds the canonical `StudentProfile` the agent loop consumes from
// the parsed Albert Degree Progress Report (DPR). DPR-only: the legacy
// unofficial-transcript builder has been removed — the DPR is the sole
// onboarding artifact and carries everything the transcript did plus
// declared programs and NYU's pre-computed audit.
// ============================================================

import type {
    StudentProfile,
    CourseTaken,
    ProgramDeclaration,
} from "@nyupath/shared";
import type { DegreeProgressReport, DPRCourseRow } from "@nyupath/engine";

// ============================================================
// DPR-driven session builder (Phase 7-E W2.4)
// ============================================================
// Produces a `StudentProfile` from the parsed Albert DPR. This is the
// only onboarding path.
//
// What the DPR provides:
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
    /**
     * Override student.id (the canonical identifier used as a Postgres FK
     * across `students`, `forward_schedules`, `schedule_preferences`,
     * `chat_messages`, `audit_log`, and `session_summaries`).
     *
     * MUST be set to the auth-session subject (`auth.sub`) when the user
     * is logged in. When omitted, the legacy slugified-name fallback
     * (`deriveStudentId(report)`) runs — but that diverges from the auth
     * studentId and silently splits persistence across two phantom
     * student rows. The May 2026 post-mortem traced the "schedule
     * disappears on refresh" bug to exactly this divergence.
     */
    studentIdOverride?: string;
}

export function buildStudentProfileFromDpr(
    report: DegreeProgressReport,
    opts: BuildSessionFromDprOptions = {},
): StudentProfile {
    // 1. Course history → CourseTaken[]. Filter out info-only rows
    //    (type=EN with grade=null but no IP designation isn't expected,
    //    but we guard against it). Skip the synthetic ELECTIVE CREDIT
    //    rows because they have no real course id the engine can use.
    //
    // FIX (May 2026 post-mortem): the prior loop pushed EVERY IP row into
    // `pendingCourses` regardless of term, then picked the latest IP term
    // as `currentSemester.term`. When a student is mid-Spring with Fall
    // pre-registered, the DPR carries IP rows for BOTH terms — so
    // `currentSemester.courses` ended up mixing 4 Spring IP rows with 3
    // Fall IP rows, and the agent surfaced "7 courses for Fall 2026."
    // We now collect IP rows into a per-term map first, pick the latest
    // term, and only THEN populate `pendingCourses` from that single
    // term's rows.
    const coursesTaken: CourseTaken[] = [];
    const ipRowsByTerm: Record<string, Array<{ courseId: string; title: string; credits: number }>> = {};

    for (const row of report.courseHistory) {
        if (row.subject === "ELECTIVE") continue; // synthetic transfer-credit row, no audit value
        const courseId = `${row.subject} ${row.catalogNbr}`.replace(/\s+/g, " ").trim();
        const isIP = row.type === "IP";
        coursesTaken.push({
            courseId,
            grade: row.grade ?? null,
            semester: row.term,
            credits: row.units,
            ...(isIP ? { isInProgress: true } : {}),
            ...(row.repeatCode ? { repeatCode: row.repeatCode } : {}),
        });
        if (isIP) {
            (ipRowsByTerm[row.term] ??= []).push({
                courseId,
                title: row.courseTitle,
                credits: row.units,
            });
        }
    }

    // Pick the latest IP term as `currentSemester.term`; populate
    // `pendingCourses` ONLY from that term's IP rows.
    let currentTerm: string | undefined;
    for (const term of Object.keys(ipRowsByTerm)) {
        if (!currentTerm || compareTerms(term, currentTerm) > 0) currentTerm = term;
    }
    const pendingCourses = currentTerm ? ipRowsByTerm[currentTerm] ?? [] : [];

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
        id: opts.studentIdOverride ?? deriveStudentId(report),
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
        // DPR-3: carry adviser waivers onto the profile so the agent can
        // quote them verbatim and planning tools can factor them in.
        // Map explicitly to shed the nominal DPRAdvisorNotation type.
        ...(report.advisorNotations.length > 0
            ? {
                advisorNotations: report.advisorNotations.map((n) => ({
                    requestId: n.requestId,
                    note: n.note,
                    advisor: n.advisor,
                    date: n.date,
                })),
            }
            : {}),
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

/**
 * The PRE-FALLBACK declared-program classification rule — the single
 * source of truth for "what counts as a declared program in a DPR."
 *
 * Scans the DPR Programs table and maps each Major / Minor / Concentration
 * row onto a `ProgramDeclaration` (skipping the administrative Career +
 * Program rows). Returns the genuine, UN-padded set: when the DPR lists no
 * Major/Minor/Concentration row this returns `[]` — the true "undeclared"
 * state.
 *
 * IMPORTANT — this deliberately does NOT append the `unknown_major`
 * fallback. Two callers need different things from the SAME rule:
 *   • `deriveDeclaredPrograms` (engine/session path) wraps this and appends
 *     the `unknown_major` placeholder when it returns empty, so downstream
 *     tools always see at least one declared program.
 *   • The wizard's undeclared-detection (OnboardingWizard.tsx) needs the
 *     RAW pre-fallback result — the `unknown_major` padding would make
 *     `isUndeclared` ALWAYS false and kill the intended-major preview
 *     feature. It calls THIS function so there is one classification rule,
 *     not a hand-rolled second copy.
 */
export function deriveDeclaredProgramsFromDpr(
    report: DegreeProgressReport,
): ProgramDeclaration[] {
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
    return out;
}

function deriveDeclaredPrograms(report: DegreeProgressReport): ProgramDeclaration[] {
    const out = deriveDeclaredProgramsFromDpr(report);
    // Fallback when Programs table doesn't list a Major (rare):
    // emit a generic placeholder so downstream tools see at least
    // one declared program. (The wizard deliberately does NOT use this
    // padded path — see deriveDeclaredProgramsFromDpr's docstring.)
    if (out.length === 0) {
        out.push({ programId: "unknown_major", programType: "major" });
    }
    return out;
}

/**
 * Derive the student's home school from the DPR's program labels.
 *
 * Returns a confident school CODE when a label matches a known school
 * indicator, else the school-agnostic sentinel `"unknown"`.
 *
 * EXPORTED (F2): this return value is the AUTHORITY SIGNAL for the
 * DPR-derived-field rule. A confident value means "the DPR deterministically
 * shows the home school" → it is READ-ONLY (the wizard renders it without an
 * editable picker; the v2 route ignores a `body.homeSchool` override). Only
 * `"unknown"` ("the DPR can't show it") lets the student pick a home school.
 */
export function deriveHomeSchool(report: DegreeProgressReport): string {
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
    // CAS-1 (Task 1.5) — no school indicator matched. Degrade to the
    // school-agnostic value "unknown" (DPR-only caps; no school-specific
    // requirement rules applied) rather than silently claiming this is a CAS
    // student. The home school MUST be confirmed at onboarding via
    // homeSchoolOverride; until then the planner operates in school-agnostic
    // mode (schoolConfig === null → falls back to schoolDefaults constants).
    console.warn(
        "[buildSession] deriveHomeSchool: no school indicator matched the DPR program " +
        `labels (${programLabels.slice(0, 120)}); degrading to school-agnostic NYU ` +
        "(DPR-only caps). Home school should be confirmed at onboarding via homeSchoolOverride.",
    );
    return "unknown";
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
