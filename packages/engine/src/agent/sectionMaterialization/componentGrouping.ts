// ============================================================
// sectionMaterialization/componentGrouping.ts — Phase 38 Task 0.1 / F1
// ============================================================
// Group a course's live FOSE sections by component type (`schd`:
// LEC / RCT / LAB / TUT / SEM …) and enumerate the *course
// selections* — one section of EACH required component type present.
//
// FREE-PAIRING (owner decision 2026-06-20): the FOSE API exposes NO
// LEC↔RCT linkage. The 2026-06-20 live probe confirmed the detail
// endpoint's `all_sections` returns the SAME flat section list for
// every section queried (a lecture and a recitation of MATH-UA 121
// both returned the identical 35-CRN block) — so it is NOT a per-
// lecture registration group and cannot pin which recitation pairs
// with which lecture. We therefore model a multi-component course as
// "one section of each distinct component type present, any pairing,
// all time-blocks conflict-free" and HEDGE that Albert may restrict
// which recitation pairs with which lecture (verify the exact
// pairing in Albert). This never produces a graduation-INVALID plan
// (the course still satisfies its requirement) — at worst the
// enumeration is conservative about which (LEC, RCT) pairs exist.
//
// Pure module — no I/O. `conflicts` is reused from conflictDetection.
// ============================================================

import { conflicts } from "./conflictDetection.js";
import type { SectionView } from "./types.js";

/** A course's sections bucketed by normalized component type (`schd`). */
export interface CourseComponents {
    courseId: string;
    title: string;
    /**
     * Sections grouped by normalized component type. Insertion order =
     * first-seen order across the input sections (stable enumeration).
     * Each key is an upper-cased `schd` (a missing `schd` defaults to
     * `"LEC"` — a course with no component info is treated as a single
     * lecture-like component).
     */
    components: Map<string, SectionView[]>;
}

/** One picked combination for a single course: one section per component type. */
export interface CourseSelection {
    courseId: string;
    title: string;
    /** One section per required component type, in component (key) order. */
    sections: SectionView[];
}

/**
 * Normalize a raw `schd` to a component key. Missing → `"LEC"`
 * (single-component default); otherwise upper-cased + trimmed so
 * `"lec"` and `"LEC"` bucket together.
 */
export function normalizeComponent(schd: string | undefined): string {
    const s = (schd ?? "").trim();
    return s === "" ? "LEC" : s.toUpperCase();
}

/**
 * Bucket a course's sections by component type. Pure; input order is
 * preserved within each bucket and across bucket insertion order.
 */
export function groupByComponent(
    courseId: string,
    title: string,
    sections: SectionView[],
): CourseComponents {
    const components = new Map<string, SectionView[]>();
    for (const s of sections) {
        const key = normalizeComponent(s.schd);
        const arr = components.get(key);
        if (arr === undefined) components.set(key, [s]);
        else arr.push(s);
    }
    return { courseId, title, components };
}

/**
 * Enumerate every course selection — the cartesian product over the
 * course's component groups (one section per component type). A
 * selection whose own sections overlap in time (e.g. a LEC that
 * clashes with the chosen RCT) is dropped: it can never be a valid
 * registration. A course with zero components yields zero selections.
 *
 * Pure.
 */
export function enumerateCourseSelections(course: CourseComponents): CourseSelection[] {
    const groups = [...course.components.values()];
    if (groups.length === 0) return [];

    const out: CourseSelection[] = [];

    function recurse(idx: number, picked: SectionView[]): void {
        if (idx === groups.length) {
            out.push({ courseId: course.courseId, title: course.title, sections: [...picked] });
            return;
        }
        for (const section of groups[idx]!) {
            // Skip if this section conflicts with an already-picked
            // component of the SAME course (internal conflict).
            const internalClash = picked.some(p =>
                conflicts(p.meetingPatterns, section.meetingPatterns),
            );
            if (internalClash) continue;
            picked.push(section);
            recurse(idx + 1, picked);
            picked.pop();
        }
    }

    recurse(0, []);
    return out;
}
