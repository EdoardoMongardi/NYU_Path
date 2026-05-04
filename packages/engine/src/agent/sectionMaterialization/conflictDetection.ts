// ============================================================
// sectionMaterialization/conflictDetection.ts — Phase 15 Task 2
// ============================================================
// Pure helpers for time-conflict detection and conflict-free
// combination enumeration.
//
// Interval semantics: HALF-OPEN — [startMin, endMin).
// Two patterns conflict iff same day AND aStart < bEnd AND bStart < aEnd.
// Boundary touch (aEnd === bStart) is NOT a conflict.
// ============================================================

import type { MeetingPattern, SectionView } from "./types.js";

export const MAX_COMBINATIONS = 50;

/**
 * True iff two MeetingPatterns overlap in time on the same day.
 * Uses half-open interval semantics: [startMin, endMin).
 * Touching at a boundary (a.endMin === b.startMin) is NOT an overlap.
 */
function patternsOverlap(a: MeetingPattern, b: MeetingPattern): boolean {
    if (a.day !== b.day) return false;
    return a.startMin < b.endMin && b.startMin < a.endMin;
}

/**
 * True iff any pattern in array `a` overlaps any pattern in array `b`.
 * Empty arrays (asynchronous sections) never conflict with anything.
 */
export function conflicts(a: MeetingPattern[], b: MeetingPattern[]): boolean {
    for (const pa of a) {
        for (const pb of b) {
            if (patternsOverlap(pa, pb)) return true;
        }
    }
    return false;
}

// ---- Combination types ----

export interface CourseBundle {
    courseId: string;
    title: string;
    sections: SectionView[];
}

export interface Combination {
    /** One section per input course (courses with 0 sections are skipped). */
    sections: SectionView[];
    /** Total weekly meeting time in decimal hours. */
    weeklyHours: number;
}

export interface CombinationResult {
    combinations: Combination[];
    /** True when results were capped at MAX_COMBINATIONS. */
    truncated: boolean;
}

function weeklyHoursOf(sections: SectionView[]): number {
    let total = 0;
    for (const s of sections) {
        for (const p of s.meetingPatterns) {
            total += (p.endMin - p.startMin) / 60;
        }
    }
    // Round to 2 decimal places to avoid floating-point noise
    return Math.round(total * 100) / 100;
}

/**
 * Enumerate all conflict-free combinations across the given courses.
 *
 * Algorithm: recursive backtracking over the courses array.
 * For each course, try each section; skip if it conflicts with any
 * already-picked section. Courses with zero sections are skipped
 * (treated as unavailable — the upstream materializer surfaces this).
 *
 * Output is capped at MAX_COMBINATIONS (default 50). The returned
 * `truncated` flag indicates whether the cap was hit.
 *
 * @param courses — array of course bundles, each with a sections list
 * @param cap     — maximum combinations to return (default MAX_COMBINATIONS)
 */
export function enumerateConflictFreeCombinations(
    courses: CourseBundle[],
    cap: number = MAX_COMBINATIONS,
): CombinationResult {
    if (courses.length === 0) {
        return { combinations: [], truncated: false };
    }

    const out: Combination[] = [];
    let hitCap = false;

    function recurse(idx: number, picked: SectionView[]): void {
        // Early exit once cap is reached
        if (out.length >= cap) {
            hitCap = true;
            return;
        }

        if (idx === courses.length) {
            out.push({
                sections: [...picked],
                weeklyHours: weeklyHoursOf(picked),
            });
            return;
        }

        const course = courses[idx]!;

        if (course.sections.length === 0) {
            // No sections for this course — skip it; combination remains valid
            // but this course won't be represented. Upstream decides what to do.
            recurse(idx + 1, picked);
            return;
        }

        for (const section of course.sections) {
            if (out.length >= cap) {
                hitCap = true;
                return;
            }
            // Prune: skip this section if it conflicts with any already-picked section
            const conflictsWithPrior = picked.some(prior =>
                conflicts(prior.meetingPatterns, section.meetingPatterns),
            );
            if (!conflictsWithPrior) {
                picked.push(section);
                recurse(idx + 1, picked);
                picked.pop();
            }
        }
    }

    recurse(0, []);

    return { combinations: out, truncated: hitCap };
}
