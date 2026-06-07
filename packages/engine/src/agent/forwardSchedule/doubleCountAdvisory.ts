/**
 * Double-counting ADVISORY (data + advisory only — NO enforcement).
 *
 * Pure functions that surface a CITED heads-up to multi-program students that
 * double-counting may let them satisfy two programs with fewer total courses.
 * Quantified from the school's bulletin-cited `doubleCounting` config when one
 * exists; otherwise a generic (uncited) note. Never asserts a number we cannot
 * cite, never flips feasibility. See
 * docs/superpowers/plans/2026-06-07-double-count-data-advisory.md.
 */

import type { DegreeProgressReport } from "../../dpr/schema.js";
import type { SchoolConfig } from "@nyupath/shared";
import type { Disclaimer } from "../toolEnvelope.js";
import { walkRequirements } from "../../dpr/schema.js";

const PROGRAM_KINDS = new Set(["major", "minor", "concentration"]);

/** Count major/minor/concentration programs in the DPR (the multi-program
 *  signal that makes cross-program double-counting relevant). Career/Program
 *  rollup rows are ignored. */
export function countDeclaredPrograms(dpr: DegreeProgressReport): number {
    return dpr.programs.filter((p) => PROGRAM_KINDS.has(p.programType.trim().toLowerCase())).length;
}

/** Courses that appear in ≥2 requirement leaves' `coursesUsed` — a coarse,
 *  attribution-free signal that Albert has applied a course to more than one
 *  requirement. NOT a cross-program claim (we cannot attribute rIds to
 *  programs); used only to enrich the advisory text. */
export function detectSharedCourses(dpr: DegreeProgressReport): {
    sharedCourseCount: number;
    sharedCourseIds: string[];
} {
    const leafCount = new Map<string, number>();
    for (const req of walkRequirements(dpr.requirementGroups)) {
        const seen = new Set<string>();
        for (const r of req.coursesUsed) {
            const id = `${r.subject} ${r.catalogNbr}`.trim();
            if (seen.has(id)) continue; // dedupe within a single leaf
            seen.add(id);
            leafCount.set(id, (leafCount.get(id) ?? 0) + 1);
        }
    }
    const sharedCourseIds = [...leafCount.entries()]
        .filter(([, n]) => n >= 2)
        .map(([id]) => id)
        .sort();
    return { sharedCourseCount: sharedCourseIds.length, sharedCourseIds };
}

/** Build the double-count advisory `Disclaimer` for a multi-program student,
 *  or null when it does not apply (fewer than 2 programs). Quantified + cited
 *  when the school has a `doubleCounting` config with at least one numeric
 *  limit; generic + (optionally cited) otherwise. Sentences are filtered and
 *  joined so spacing/punctuation stay well-formed regardless of which optional
 *  parts are present. */
export function buildDoubleCountAdvisory(
    dpr: DegreeProgressReport,
    schoolConfig: SchoolConfig | null | undefined,
): Disclaimer | null {
    const programCount = countDeclaredPrograms(dpr);
    if (programCount < 2) return null;

    const schoolName = schoolConfig?.name ?? "your school";
    const dc = schoolConfig?.doubleCounting;
    const { sharedCourseCount } = detectSharedCourses(dpr);
    const sharedNote = sharedCourseCount > 0
        ? ` (your DPR already applies ${sharedCourseCount} course${sharedCourseCount === 1 ? "" : "s"} to more than one requirement)`
        : "";

    // Assemble quantified clauses from a cited config (only those that yield a number).
    const clauses: string[] = [];
    if (dc?.cap) {
        const caps: string[] = [];
        if (dc.cap.majorToMajor != null) caps.push(`up to ${dc.cap.majorToMajor} between two majors`);
        if (dc.cap.majorToMinor != null) caps.push(`up to ${dc.cap.majorToMinor} between a major and a minor`);
        if (dc.cap.minorToMinor != null) caps.push(`up to ${dc.cap.minorToMinor} between two minors`);
        if (caps.length) clauses.push(`you may share (double-count) ${caps.join(", ")} course(s) across programs`);
    }
    if (dc?.floor) {
        const floors: string[] = [];
        if (dc.floor.minDistinctCreditsPerMajor != null) floors.push(`each major must keep at least ${dc.floor.minDistinctCreditsPerMajor} credits unique to it`);
        if (dc.floor.minUniqueCreditsPerMinor != null) floors.push(`each minor must keep at least ${dc.floor.minUniqueCreditsPerMinor} credits unique to it`);
        if (dc.floor.minUniqueCoursesPerMinor != null) floors.push(`each minor must keep at least ${dc.floor.minUniqueCoursesPerMinor} course(s) unique to it`);
        if (floors.length) clauses.push(floors.join("; "));
    }

    // No quantifiable clause (no config, or a config with no numeric fields):
    // degrade to a number-free note. cite-or-stop — never assert a number we
    // cannot cite. Still cite the source / surface the note when a config exists.
    if (clauses.length === 0) {
        return {
            id: "double_count_advisory",
            text: [
                `You're pursuing ${programCount} programs${sharedNote}.`,
                "Double-counting some courses across them may be possible with department approval and could shorten your plan — confirm the specifics with your adviser.",
                dc?.note ? `Note: ${dc.note}` : "",
            ].filter(Boolean).join(" "),
            reason: `Student is pursuing ${programCount} programs; ${schoolName} publishes no clear/quantifiable double-count limit, so this is a generic heads-up.`,
            ...(dc?.sourceRef ? { bulletinSource: dc.sourceRef } : {}),
        };
    }

    // Quantified path (cited). `dc` is non-null here (clauses only fill when dc exists).
    return {
        id: "double_count_advisory",
        text: [
            `You're pursuing ${programCount} programs${sharedNote}.`,
            `At ${schoolName}, ${clauses.join("; ")}.`,
            dc!.requiresApproval ? "Sharing is never automatic — it needs approval from both departments." : "",
            dc!.noTripleCounting ? "No course may count toward three programs." : "",
            dc!.note ? `Note: ${dc!.note}` : "",
            "This can reduce how many courses you need — confirm which specific courses are eligible with your adviser.",
        ].filter(Boolean).join(" "),
        reason: `Student is pursuing ${programCount} programs; ${schoolName}'s bulletin double-count policy applies.`,
        bulletinSource: dc!.sourceRef,
    };
}
