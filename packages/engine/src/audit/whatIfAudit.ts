// ============================================================
// whatIfAudit — Hypothetical Program Comparison
// ============================================================
// Phase 2 deliverable per ARCHITECTURE.md §7.2.
//
// Pure read-only function: clones the student profile in memory,
// substitutes a hypothetical program list, runs `crossProgramAudit`
// against the hypothetical declarations, and (optionally) compares
// with the current declared programs. Never mutates the input
// StudentProfile.
//
// Default ProgramType for hypothetical entries is "major" — callers
// may pass an explicit ProgramDeclaration[] when proposing a mix
// (e.g., a major + minor combo).
// ============================================================

import type {
    Course,
    Program,
    ProgramDeclaration,
    SchoolConfig,
    StudentProfile,
} from "@nyupath/shared";
import {
    crossProgramAudit,
    type CrossProgramAuditResult,
    type ProgramAuditEntry,
} from "./crossProgramAudit.js";

export interface WhatIfComparison {
    /** Courses already taken that satisfy a rule in the hypothetical audit */
    coursesTransferred: number;
    /** Net change in remaining requirements vs current */
    additionalRequirementsRemaining: number;
    /** Programs in current that are NOT in hypothetical (would be dropped) */
    droppedPrograms: string[];
    /** Programs in hypothetical that are NOT in current (would be added) */
    addedPrograms: string[];
    /** Course IDs satisfying rules in BOTH audits */
    sharedRequirementCourses: string[];
}

export interface WhatIfResult {
    /** The audit run on the hypothetical declarations */
    hypothetical: CrossProgramAuditResult;
    /** Audit run on the original declarations (omitted when no compare) */
    current?: CrossProgramAuditResult;
    /** Diff between hypothetical and current (when both ran) */
    comparison?: WhatIfComparison;
    /** Sanity warnings, e.g. unknown program ids encountered */
    warnings: string[];
}

/**
 * Run a hypothetical audit. Does NOT touch the input profile.
 *
 * @param student            the read-only profile
 * @param hypothetical       list of hypothetical program declarations
 *                           (string[] is also accepted as shorthand for majors)
 * @param programs           resolved Program objects, keyed by programId
 * @param courses            course catalog
 * @param schoolConfig       student's home-school config (drives audit semantics)
 * @param compareWithCurrent when true, also runs the current declarations
 *                           and produces a `comparison` block
 */
export function whatIfAudit(
    student: StudentProfile,
    hypothetical: ProgramDeclaration[] | string[],
    programs: Map<string, Program>,
    courses: Course[],
    schoolConfig: SchoolConfig | null = null,
    compareWithCurrent: boolean = true,
): WhatIfResult {
    const warnings: string[] = [];

    const hypoDeclarations: ProgramDeclaration[] = (hypothetical as Array<string | ProgramDeclaration>)
        .map((entry) =>
            typeof entry === "string"
                ? { programId: entry, programType: "major" as const }
                : entry,
        );

    // Validate hypothetical program ids exist
    for (const decl of hypoDeclarations) {
        if (!programs.has(decl.programId)) {
            warnings.push(
                `Program "${decl.programId}" not found in catalog; it will be skipped in the audit.`,
            );
        }
    }

    const hypoStudent: StudentProfile = {
        ...student,
        declaredPrograms: hypoDeclarations,
    };

    const hypothetical_audit = crossProgramAudit(hypoStudent, programs, courses, schoolConfig);

    if (!compareWithCurrent || student.declaredPrograms.length === 0) {
        return {
            hypothetical: hypothetical_audit,
            warnings,
        };
    }

    const current_audit = crossProgramAudit(student, programs, courses, schoolConfig);
    const comparison = computeComparison(current_audit, hypothetical_audit);

    return {
        hypothetical: hypothetical_audit,
        current: current_audit,
        comparison,
        warnings,
    };
}

// ---- helpers ----

function computeComparison(
    current: CrossProgramAuditResult,
    hypothetical: CrossProgramAuditResult,
): WhatIfComparison {
    const currentIds = new Set(current.programs.map((p) => p.declaration.programId));
    const hypoIds = new Set(hypothetical.programs.map((p) => p.declaration.programId));

    const droppedPrograms = [...currentIds].filter((id) => !hypoIds.has(id));
    const addedPrograms = [...hypoIds].filter((id) => !currentIds.has(id));

    const currentSatisfying = collectSatisfyingCourses(current.programs);
    const hypoSatisfying = collectSatisfyingCourses(hypothetical.programs);

    const sharedRequirementCourses = [...hypoSatisfying].filter((id) => currentSatisfying.has(id));

    const currentRemaining = sumRemaining(current.programs);
    const hypoRemaining = sumRemaining(hypothetical.programs);

    return {
        coursesTransferred: hypoSatisfying.size,
        additionalRequirementsRemaining: hypoRemaining - currentRemaining,
        droppedPrograms,
        addedPrograms,
        sharedRequirementCourses,
    };
}

function collectSatisfyingCourses(entries: ProgramAuditEntry[]): Set<string> {
    const out = new Set<string>();
    for (const entry of entries) {
        for (const rule of entry.audit.rules) {
            for (const id of rule.coursesSatisfying) out.add(id);
        }
    }
    return out;
}

function sumRemaining(entries: ProgramAuditEntry[]): number {
    let total = 0;
    for (const entry of entries) {
        for (const rule of entry.audit.rules) total += rule.remaining;
    }
    return total;
}
