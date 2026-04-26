// ============================================================
// Transcript Confirmation Flow (Phase 3 §11.8.4)
// ============================================================
// Deterministic two-step confirmation per architecture §11.8.4:
//
//   Step 1 — Summary preview: derive a typed summary block from the
//            ProfileDraft. This is what the chat layer renders to the
//            student verbatim. NO LLM rephrasing in this module.
//
//   Step 2 — Field-level edit: callers (the chat tool) hand-pick which
//            fields to edit. This module exposes `applyConfirmationEdits`
//            which takes a typed mutation set, validates it, and returns
//            a new (committed) StudentProfile + an audit log of what
//            changed. NEVER mutates the input draft in place.
//
// NEVER falls back to LLM parsing on any failure.
// ============================================================

import type {
    CourseTaken,
    ProgramDeclaration,
    StudentProfile,
} from "@nyupath/shared";
import { canonicalSchoolId } from "@nyupath/shared";
import type { ProfileDraft } from "./profileMapper.js";

// ---- Step 1: Summary Preview ----

export interface ConfirmationSummary {
    homeSchool: string;
    /** "From -UA suffix dominance in 2024-fall" — verbatim from profileMapper notes */
    homeSchoolBasis: string;
    catalogYear: string;
    earlierProgram?: string;
    completedCredits: number;
    /** Attempted credits (W/I/NR included) — calls out the SAP gap */
    attemptedCredits: number;
    cumulativeGPA: number;
    inProgressCount: number;
    inProgressCourses: Array<{ courseId: string; title: string; credits: number }>;
    examCreditsApplied: number;
    examCreditList: Array<{ source: string; credits: number; nyuEquivalent?: string }>;
    declaredProgramsCount: number;
    /** Fields the user must explicitly confirm before commit (e.g., declaredPrograms) */
    fieldsRequiringExplicitConfirmation: Array<keyof StudentProfile>;
    /** Inference notes from the profileMapper (one per inference made) */
    inferenceNotes: string[];
}

/**
 * Produce a Step-1 summary block. Pure: same input → same output, no
 * LLM call, no time- or env-dependent fields.
 */
export function buildConfirmationSummary(draft: ProfileDraft): ConfirmationSummary {
    const profile = draft.draft;

    let attempted = 0;
    let completed = 0;
    let qpts = 0;
    let qhrs = 0;
    const GRADE_POINTS: Record<string, number> = {
        "A": 4.0, "A-": 3.667,
        "B+": 3.333, "B": 3.0, "B-": 2.667,
        "C+": 2.333, "C": 2.0, "C-": 1.667,
        "D+": 1.333, "D": 1.0,
        "F": 0.0,
    };
    const PASSING = new Set(["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "P"]);
    for (const ct of profile.coursesTaken) {
        const grade = ct.grade.toUpperCase();
        const credits = ct.credits ?? 4;
        if (grade === "TR") continue;
        attempted += credits;
        if (PASSING.has(grade)) completed += credits;
        if (grade in GRADE_POINTS) {
            qpts += GRADE_POINTS[grade]! * credits;
            qhrs += credits;
        }
    }
    const cumulativeGPA = qhrs > 0 ? Math.round((qpts / qhrs) * 1000) / 1000 : 0;

    const homeSchoolNote = draft.notes.find((n) => n.startsWith("homeSchool:"))
        ?? `homeSchool: ${profile.homeSchool} (no inference note)`;

    const transitionNote = draft.notes.find((n) => n.startsWith("Detected home-school transition"));
    const earlierMatch = transitionNote?.match(/transition at .+?: (\S+) →/);
    const earlierProgram = earlierMatch ? earlierMatch[1] : undefined;

    const inProgress = profile.currentSemester?.courses ?? [];

    return {
        homeSchool: profile.homeSchool,
        homeSchoolBasis: homeSchoolNote,
        catalogYear: profile.catalogYear,
        earlierProgram,
        completedCredits: completed,
        attemptedCredits: attempted,
        cumulativeGPA,
        inProgressCount: inProgress.length,
        inProgressCourses: inProgress.map((c) => ({
            courseId: c.courseId, title: c.title, credits: c.credits,
        })),
        examCreditsApplied: (profile.transferCourses ?? []).reduce((s, t) => s + t.credits, 0),
        examCreditList: (profile.transferCourses ?? []).map((t) => ({
            source: t.source, credits: t.credits, nyuEquivalent: t.nyuEquivalent,
        })),
        declaredProgramsCount: profile.declaredPrograms.length,
        fieldsRequiringExplicitConfirmation: draft.needsConfirmation,
        inferenceNotes: draft.notes,
    };
}

// ---- Step 2: Field-level edit ----

export interface ConfirmationEdits {
    homeSchool?: string;
    catalogYear?: string;
    declaredPrograms?: ProgramDeclaration[];
    visaStatus?: "f1" | "domestic" | "other";
    /** Append additional courses (e.g., to correct OCR mishaps) */
    addCoursesTaken?: CourseTaken[];
    /** Remove courses by id+semester (e.g., a duplicated row) */
    removeCoursesTaken?: Array<{ courseId: string; semester: string }>;
}

export interface AuditLogEntry {
    /** What changed about the field */
    op: "replace" | "add" | "remove";
    /** The StudentProfile field name (or "coursesTaken" for add/remove) */
    field: string;
    /** Pre-edit value (null when op === "add") */
    before: unknown;
    /** Post-edit value (null when op === "remove") */
    after: unknown;
}

export interface CommitResult {
    /** New committed profile — never the same reference as the input */
    profile: StudentProfile;
    /** What actually changed, for the chat layer to echo back to the user */
    changes: AuditLogEntry[];
    /** Field IDs from the draft's needsConfirmation that are STILL outstanding */
    stillNeedsConfirmation: Array<keyof StudentProfile>;
}

export class ConfirmationCommitError extends Error {
    public readonly kind: "duplicate_course" | "unknown_field" | "missing_confirmation" | "invalid_input";
    public readonly detail?: string;
    constructor(kind: ConfirmationCommitError["kind"], detail?: string) {
        super(`ConfirmationCommitError[${kind}]${detail ? ": " + detail : ""}`);
        this.name = "ConfirmationCommitError";
        this.kind = kind;
        this.detail = detail;
    }
}

/**
 * Apply edits to the draft and produce a committed StudentProfile + audit
 * log. Throws ConfirmationCommitError on validation failure.
 *
 * `requireConfirmationFor` is the set of fields that MUST be explicitly
 * supplied in `edits` before the commit succeeds — typically the draft's
 * `needsConfirmation` array. This prevents committing a profile while
 * known-uncertain fields are still un-touched.
 */
export function applyConfirmationEdits(
    draft: ProfileDraft,
    edits: ConfirmationEdits,
    /**
     * REQUIRED — fields that must be explicitly supplied in `edits` before
     * commit. Callers should typically pass `draft.needsConfirmation`. The
     * default (`[]`) is intentionally NOT provided so the caller can't
     * silently commit a profile while uncertain fields remain unset.
     */
    requireConfirmationFor: Array<keyof StudentProfile>,
): CommitResult {
    const before = draft.draft;
    const changes: AuditLogEntry[] = [];

    // Validate: required-confirmation fields must be set in edits OR
    // already non-default in the draft.
    const stillNeedsConfirmation: Array<keyof StudentProfile> = [];
    for (const field of requireConfirmationFor) {
        const provided = field in edits && (edits as Record<string, unknown>)[field] !== undefined;
        if (!provided && isFieldUnset(before, field)) {
            stillNeedsConfirmation.push(field);
        }
    }
    if (stillNeedsConfirmation.length > 0) {
        throw new ConfirmationCommitError(
            "missing_confirmation",
            `Fields still need confirmation: ${stillNeedsConfirmation.join(", ")}`,
        );
    }

    // Deep-copy to ensure no mutation of the input
    const next: StudentProfile = JSON.parse(JSON.stringify(before));

    if (edits.homeSchool !== undefined) {
        const canonical = canonicalSchoolId(edits.homeSchool);
        if (next.homeSchool !== canonical) {
            changes.push({ op: "replace", field: "homeSchool", before: next.homeSchool, after: canonical });
            next.homeSchool = canonical;
        }
    }
    if (edits.catalogYear !== undefined && edits.catalogYear !== next.catalogYear) {
        changes.push({ op: "replace", field: "catalogYear", before: next.catalogYear, after: edits.catalogYear });
        next.catalogYear = edits.catalogYear;
    }
    if (edits.declaredPrograms !== undefined) {
        // Replace the whole array — declarations are typically all or nothing
        const seenIds = new Set<string>();
        for (const d of edits.declaredPrograms) {
            if (seenIds.has(d.programId)) {
                throw new ConfirmationCommitError(
                    "invalid_input",
                    `Duplicate programId in declaredPrograms: ${d.programId}`,
                );
            }
            seenIds.add(d.programId);
        }
        changes.push({
            op: "replace",
            field: "declaredPrograms",
            before: next.declaredPrograms,
            after: edits.declaredPrograms,
        });
        next.declaredPrograms = edits.declaredPrograms;
    }
    if (edits.visaStatus !== undefined && edits.visaStatus !== next.visaStatus) {
        changes.push({ op: "replace", field: "visaStatus", before: next.visaStatus, after: edits.visaStatus });
        next.visaStatus = edits.visaStatus;
    }
    if (edits.addCoursesTaken?.length) {
        const existingKeys = new Set(
            next.coursesTaken.map((c) => `${c.courseId}@@${c.semester}`),
        );
        for (const c of edits.addCoursesTaken) {
            const key = `${c.courseId}@@${c.semester}`;
            if (existingKeys.has(key)) {
                throw new ConfirmationCommitError(
                    "duplicate_course",
                    `Cannot add ${c.courseId} in ${c.semester}: already present in coursesTaken`,
                );
            }
            existingKeys.add(key);
            next.coursesTaken.push(c);
            changes.push({ op: "add", field: "coursesTaken", before: null, after: c });
        }
    }
    if (edits.removeCoursesTaken?.length) {
        for (const target of edits.removeCoursesTaken) {
            const idx = next.coursesTaken.findIndex(
                (c) => c.courseId === target.courseId && c.semester === target.semester,
            );
            if (idx === -1) {
                throw new ConfirmationCommitError(
                    "invalid_input",
                    `Cannot remove ${target.courseId} in ${target.semester}: not present in coursesTaken`,
                );
            }
            const removed = next.coursesTaken.splice(idx, 1)[0];
            changes.push({ op: "remove", field: "coursesTaken", before: removed, after: null });
        }
    }

    return {
        profile: next,
        changes,
        stillNeedsConfirmation: [],
    };
}

function isFieldUnset(p: StudentProfile, field: keyof StudentProfile): boolean {
    const v = (p as unknown as Record<string, unknown>)[field as string];
    if (v === undefined || v === null) return true;
    if (Array.isArray(v) && v.length === 0) return true;
    if (typeof v === "string" && v === "") return true;
    return false;
}
