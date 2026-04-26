// ============================================================
// profileMapper — TranscriptDocument → StudentProfile draft (§11.8)
// ============================================================
// Pure mapping. The two-step user confirmation flow (§11.8.4) lives in
// the chat layer; this module emits a `ProfileDraft` ready for the
// confirmation UI. Never writes to a live profile directly.
// ============================================================

import type {
    CourseTaken,
    ProgramDeclaration,
    StudentProfile,
    TransferCredit,
} from "@nyupath/shared";
import { canonicalSchoolId } from "@nyupath/shared";
import type { TranscriptDocument } from "./types.js";

export interface ProfileDraft {
    /** A draft StudentProfile derived from the transcript. Caller MUST
     *  surface it to the user via the §11.8.4 confirmation flow before
     *  persisting. */
    draft: StudentProfile;
    /** Inference notes — e.g., "homeSchool: cas (inferred from -UA dominance from Fall 2024 onward)" */
    notes: string[];
    /** Fields the inference is uncertain about — caller should preselect them in the edit form */
    needsConfirmation: Array<keyof StudentProfile>;
}

export interface MapperOptions {
    /** Override the inferred home school */
    homeSchoolOverride?: string;
    /** Override declared programs */
    declaredProgramsOverride?: ProgramDeclaration[];
    /** F-1 visa status, when known */
    visaStatus?: "f1" | "domestic" | "other";
}

const SUFFIX_TO_SCHOOL: Record<string, string> = {
    "-UA": "cas",
    "-UB": "stern",
    "-UY": "tandon",
    "-UE": "steinhardt",
    "-UT": "tisch",
    "-UN": "nursing",
    "-UF": "liberal_studies",
    "-UG": "gallatin",
    "-UC": "sps",
    "-CE": "sps",
};

export function transcriptToProfileDraft(
    doc: TranscriptDocument,
    options?: MapperOptions,
): ProfileDraft {
    const notes: string[] = [];
    const needsConfirmation: Array<keyof StudentProfile> = [];

    const coursesTaken: CourseTaken[] = [];
    for (const term of doc.terms) {
        for (const c of term.courses) {
            // Skip in-progress courses for coursesTaken — surfaced separately
            if (c.grade === "***") continue;
            // Use EHRS for graded letter rows; for W/I/NR (ehrs=0) fall back
            // to qhrs or 4 — the absent transcript-level "credits attempted"
            // is reconstructed downstream by academicStanding's I/NR/W rule.
            const credits = c.ehrs > 0 ? c.ehrs : (c.qhrs > 0 ? c.qhrs : 4);
            coursesTaken.push({
                courseId: c.courseId,
                grade: c.grade,
                semester: term.semester,
                credits,
            });
        }
    }

    const transferCourses: TransferCredit[] = doc.examCredits.map((ec) => ({
        source: ec.source,
        scoreOrGrade: ec.scoreOrGrade,
        credits: ec.credits,
        nyuEquivalent: ec.nyuEquivalent,
    }));

    // Home-school inference — pick the dominant suffix across the most
    // recent term that has any -U* courses.
    const inferredHomeSchool = options?.homeSchoolOverride
        ?? inferHomeSchool(doc, notes, needsConfirmation);

    // Catalog year — calendar year of the EARLIEST term, the standard
    // matriculation-year convention. (Catalog-year format is "YYYY"-only
    // here to match Phase 1 fixtures; Phase 0's _meta uses YYYY-YYYY
    // for data files.)
    const catalogYear = doc.terms[0]?.semester.split("-")[0] ?? "2024";

    // In-progress block surfaces *** courses for prereq risk analysis
    const currentSemester = doc.inProgress.length
        ? {
            term: doc.terms[doc.terms.length - 1]!.semester,
            courses: doc.inProgress.map((c) => ({
                courseId: c.courseId,
                title: c.title,
                // Row-level AHRS isn't tracked at v1; ehrs reflects intended
                // credit for in-progress rows in the canonical transcript layout.
                credits: c.ehrs,
            })),
        }
        : undefined;

    // The transcript doesn't tell us declared programs. Surface this as
    // requiring confirmation rather than guessing.
    const declaredPrograms = options?.declaredProgramsOverride ?? [];
    if (!options?.declaredProgramsOverride) {
        notes.push("declaredPrograms is empty — the transcript doesn't enumerate them. Confirm with the student.");
        needsConfirmation.push("declaredPrograms");
    }

    const draft: StudentProfile = {
        id: doc.header.studentId ?? "transcript_draft",
        catalogYear,
        homeSchool: canonicalSchoolId(inferredHomeSchool),
        declaredPrograms,
        coursesTaken,
        transferCourses: transferCourses.length > 0 ? transferCourses : undefined,
        ...(currentSemester ? { currentSemester } : {}),
        ...(options?.visaStatus ? { visaStatus: options.visaStatus } : {}),
    };

    if (doc.schoolTransition) {
        notes.push(
            `Detected home-school transition at ${doc.schoolTransition.fromSemester}: ` +
            `${doc.schoolTransition.previousSuffixes.join(",")} → ${doc.schoolTransition.newSuffixes.join(",")}.`,
        );
    }

    return { draft, notes, needsConfirmation };
}

// ---- helpers ----

function inferHomeSchool(
    doc: TranscriptDocument,
    notes: string[],
    needsConfirmation: Array<keyof StudentProfile>,
): string {
    const counts = new Map<string, number>();
    // Walk most-recent term backwards looking for the dominant -U* suffix
    for (let i = doc.terms.length - 1; i >= 0; i--) {
        const term = doc.terms[i]!;
        counts.clear();
        for (const c of term.courses) {
            const m = c.courseId.match(/-(U[ABDEFGHNTY]|CE)\b/);
            if (!m) continue;
            const suffix = `-${m[1]}`;
            counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
        }
        if (counts.size > 0) {
            const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
            const school = SUFFIX_TO_SCHOOL[dominant[0]] ?? "unknown";
            if (school === "unknown") {
                notes.push(`Could not map suffix ${dominant[0]} to a known NYU school — will need confirmation.`);
                needsConfirmation.push("homeSchool");
            } else {
                notes.push(
                    `homeSchool: ${school} (inferred from ${dominant[0]} dominance in ${term.semester}).`,
                );
            }
            return school;
        }
    }
    needsConfirmation.push("homeSchool");
    notes.push("Could not infer home school from any term's course suffixes — confirmation required.");
    return "unknown";
}
