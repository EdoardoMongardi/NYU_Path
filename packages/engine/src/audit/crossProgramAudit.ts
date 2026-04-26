// ============================================================
// Cross-Program Audit (Phase 1 §11.0 + §11.2 doubleCounting)
// ============================================================
// Runs degreeAudit() per declared program and applies the school-level
// double-counting limits from SchoolConfig.doubleCounting.
//
// v1 scope (intentional):
//   - default major-to-major / major-to-minor / minor-to-minor limits
//   - "no triple counting" enforcement
//
// Out of scope at v1 (Phase 2+):
//   - SchoolConfig.doubleCounting.overrideByProgram per-pair overrides
//   - course substitutions across programs
//   - concentration/track-aware double-counting
// ============================================================

import type {
    AuditResult,
    Course,
    Program,
    ProgramDeclaration,
    ProgramType,
    SchoolConfig,
    StudentProfile,
} from "@nyupath/shared";
import { degreeAudit } from "./degreeAudit.js";

export interface ProgramAuditEntry {
    declaration: ProgramDeclaration;
    program: Program;
    audit: AuditResult;
}

export interface DoubleCountWarning {
    /** Course shared across programs */
    courseId: string;
    /** Program ids that all claim this course */
    programIds: string[];
    /**
     * "exceeds_pair_limit" — pair (e.g., major-major) limit reached
     * "triple_count"       — same course in 3+ programs and noTripleCounting=true
     */
    kind: "exceeds_pair_limit" | "triple_count";
    /** Human-readable message */
    message: string;
}

export interface CrossProgramAuditResult {
    studentId: string;
    /** Per-program audit results, in declaration order */
    programs: ProgramAuditEntry[];
    /** Cross-program warnings (double-count violations) */
    warnings: DoubleCountWarning[];
    /** Courses appearing in 2+ programs after audit */
    sharedCourses: Array<{ courseId: string; programIds: string[] }>;
}

/**
 * Run a cross-program audit for all of a student's declared programs.
 *
 * @param student        student profile (ProgramDeclaration[]-shaped)
 * @param programs       resolved Program objects, keyed by programId
 * @param courses        course catalog
 * @param schoolConfig   school config for the student's home school
 *                       (used for doubleCounting limits + per-program audits)
 */
export function crossProgramAudit(
    student: StudentProfile,
    programs: Map<string, Program>,
    courses: Course[],
    schoolConfig: SchoolConfig | null = null,
): CrossProgramAuditResult {
    // 1. Per-program audits
    const entries: ProgramAuditEntry[] = [];
    for (const decl of student.declaredPrograms) {
        const program = programs.get(decl.programId);
        if (!program) {
            // Caller is responsible for resolving programs; skip unknown
            // programs rather than throwing so partial declarations don't
            // brick the whole audit run.
            continue;
        }
        const audit = degreeAudit(student, program, courses, schoolConfig);
        entries.push({ declaration: decl, program, audit });
    }

    // 2. Build courseId -> programIds satisfying it
    const courseToPrograms = new Map<string, string[]>();
    for (const entry of entries) {
        const seen = new Set<string>();
        for (const rule of entry.audit.rules) {
            for (const id of rule.coursesSatisfying) {
                if (seen.has(id)) continue; // count each course once per program
                seen.add(id);
                const list = courseToPrograms.get(id) ?? [];
                list.push(entry.declaration.programId);
                courseToPrograms.set(id, list);
            }
        }
    }

    const sharedCourses: Array<{ courseId: string; programIds: string[] }> = [];
    for (const [courseId, programIds] of courseToPrograms) {
        if (programIds.length >= 2) sharedCourses.push({ courseId, programIds });
    }

    // 3. Apply double-counting limits + triple-count flag
    const warnings: DoubleCountWarning[] = [];
    const dc = schoolConfig?.doubleCounting ?? null;
    const noTriple = dc?.noTripleCounting ?? false;

    // Triple-count check (independent of pair limits)
    if (noTriple) {
        for (const sc of sharedCourses) {
            if (sc.programIds.length >= 3) {
                warnings.push({
                    courseId: sc.courseId,
                    programIds: sc.programIds,
                    kind: "triple_count",
                    message:
                        `${sc.courseId} appears in ${sc.programIds.length} programs ` +
                        `(${sc.programIds.join(", ")}); ${schoolConfig?.schoolId ?? "school"} ` +
                        `policy forbids triple-counting.`,
                });
            }
        }
    }

    // Pair-limit checks. Group shared courses by program-pair-kind, then
    // count how many courses each pair shares; flag any course that pushes
    // the pair over its configured limit.
    const declTypeById = new Map<string, ProgramType>();
    for (const e of entries) declTypeById.set(e.declaration.programId, e.declaration.programType);

    type PairKey = string; // "programA||programB" with sorted ids
    const pairCounts = new Map<PairKey, { kind: string; courses: string[] }>();

    function pairKindOf(a: ProgramType, b: ProgramType): keyof NonNullable<SchoolConfig["doubleCounting"]> | null {
        // [a, b].sort() gives concentration < major < minor lexicographically.
        const types = [a, b].sort().join("-");
        if (types === "major-major") return "defaultMajorToMajor";
        if (types === "major-minor") return "defaultMajorToMinor";
        if (types === "minor-minor") return "defaultMinorToMinor";
        if (types === "concentration-concentration") return "defaultConcentrationToConcentration";
        if (types === "concentration-major") return "defaultMajorToConcentration";
        if (types === "concentration-minor") return "defaultMinorToConcentration";
        return null;
    }

    function pairLimit(a: ProgramType, b: ProgramType, programA?: string, programB?: string): number | null {
        if (!dc) return null;
        const key = pairKindOf(a, b);
        if (!key) return null;
        const defaultV = dc[key];
        let limit = typeof defaultV === "number" ? defaultV : null;

        // Phase 2: per-program override. doubleCounting.overrideByProgram may
        // be a map keyed by programId pointing at per-pair overrides:
        //   { "stern_business_core": { majorToMinor: 0 } }
        // The MORE RESTRICTIVE limit (smaller number) wins — this matches the
        // bulletin convention "more restrictive rule wins" (Steinhardt example).
        if (typeof dc.overrideByProgram === "object" && dc.overrideByProgram !== null) {
            const map = dc.overrideByProgram as Record<string, { majorToMajor?: number; majorToMinor?: number }>;
            const overrideKey =
                key === "defaultMajorToMajor" ? "majorToMajor"
                    : key === "defaultMajorToMinor" ? "majorToMinor"
                        : null;
            if (overrideKey) {
                const candidates: number[] = [];
                if (programA && map[programA]?.[overrideKey] !== undefined) candidates.push(map[programA]![overrideKey]!);
                if (programB && map[programB]?.[overrideKey] !== undefined) candidates.push(map[programB]![overrideKey]!);
                for (const c of candidates) {
                    if (limit === null || c < limit) limit = c;
                }
            }
        }
        return limit;
    }

    for (const sc of sharedCourses) {
        // Enumerate every program-pair this course appears in
        for (let i = 0; i < sc.programIds.length; i++) {
            for (let j = i + 1; j < sc.programIds.length; j++) {
                const a = sc.programIds[i]!;
                const b = sc.programIds[j]!;
                const ta = declTypeById.get(a);
                const tb = declTypeById.get(b);
                if (!ta || !tb) continue;
                const pairKey = [a, b].sort().join("||");
                const kindKey = pairKindOf(ta, tb);
                if (!kindKey) continue;
                const bucket = pairCounts.get(pairKey) ?? { kind: kindKey, courses: [] };
                bucket.courses.push(sc.courseId);
                pairCounts.set(pairKey, bucket);
            }
        }
    }

    for (const [pairKey, bucket] of pairCounts) {
        const [a, b] = pairKey.split("||");
        const ta = declTypeById.get(a!)!;
        const tb = declTypeById.get(b!)!;
        const limit = pairLimit(ta, tb, a, b);
        if (limit === null) continue; // no limit configured at school level
        if (bucket.courses.length > limit) {
            // Flag every course beyond the limit
            const overflow = bucket.courses.slice(limit);
            for (const courseId of overflow) {
                warnings.push({
                    courseId,
                    programIds: [a!, b!],
                    kind: "exceeds_pair_limit",
                    message:
                        `${courseId} double-counts between ${a} (${ta}) and ${b} (${tb}); ` +
                        `${bucket.courses.length} shared courses exceeds the ` +
                        `${ta}↔${tb} limit of ${limit}.`,
                });
            }
        }
    }

    return {
        studentId: student.id,
        programs: entries,
        warnings,
        sharedCourses,
    };
}
