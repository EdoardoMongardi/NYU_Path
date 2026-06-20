// ============================================================
// sectionMaterialization/feasibleSchedules.ts — Phase 38 F1 + 0.2
// ============================================================
// Enumerate the VERIFIED feasible single-term schedules over a set
// of multi-component courses (§2 ①). A *schedule* picks one course
// selection per course (each selection = one section of every
// required component type, from componentGrouping). Feasible iff:
//
//   (a) NO time conflict across ALL component blocks of every course
//       (a recitation/lab clashes exactly like a lecture);
//   (b) every chosen section is usable — open (`O`), waitlist (`W`), or
//       `A` (offered, seat-status-unknown — the only status the public
//       FOSE API returns live); the caller pre-filters closed/cancelled
//       sections out of the component groups (orchestrator step). It may
//       also pass `occupiedBlocks` (already-registered IP-course times)
//       the candidate must avoid;
//   (c) [strict student prefs are applied upstream, before grouping];
//   (d) the §2①(d) two-state waitlist backup: a `W` section keeps a
//       candidate feasible ONLY if there is a SPECIFIC OPEN backup
//       section `B` that is conflict-free with the REST of the
//       schedule (the candidate minus that one `W` section's blocks —
//       `B` and `W` are alternatives, never held together). The
//       backup is preferentially another OPEN section of the SAME
//       course + SAME component (Albert auto-swap, trivially grad-
//       safe — only the section/time differs). When no same-course
//       backup is conflict-free, an injected `backupResolver` may
//       supply a graduation-validated different-course backup; with
//       no resolver (this slice's default) such a candidate is
//       rejected. NO conflict-free, grad-valid backup ⇒ the `W`
//       candidate is NOT feasible.
//
// Pure module — no I/O, no engine coupling. The frozen graduation
// validator is reached (for different-course backups) only through
// the injected `backupResolver`, so this enumerator never imports
// the solver.
// ============================================================

import { conflicts, MAX_COMBINATIONS } from "./conflictDetection.js";
import {
    enumerateCourseSelections,
    normalizeComponent,
    type CourseComponents,
    type CourseSelection,
} from "./componentGrouping.js";
import { isOpenStatus, isWaitlistStatus } from "./statusHelpers.js";
import type { MeetingPattern, SectionView } from "./types.js";

/** A `W` section's verified open backup (Albert auto-swap target). */
export interface OpenFallback {
    /** The waitlisted section's CRN. */
    forCrn: string;
    /** The specific open backup section's CRN (conflict-free with the rest). */
    fallbackCrn: string;
}

/** A verified feasible candidate schedule. No id yet — the tool assigns one. */
export interface FeasibleCandidate {
    /** One selection per input course (component sections inside). */
    selections: CourseSelection[];
    /** Total weekly meeting time in decimal hours across all blocks. */
    weeklyHours: number;
    /** True iff any chosen section is waitlist (`W`). */
    hasWaitlist: boolean;
    /** CRNs of the waitlisted sections in this candidate. */
    waitlistCrns: string[];
    /** Verified open backup per waitlisted section (§2①(d)). */
    openFallbacks: OpenFallback[];
}

/** Input to the different-course graduation-validated backup resolver. */
export interface BackupResolverInput {
    /** The waitlisted section needing a backup. */
    waitlisted: SectionView;
    /** All candidate blocks EXCEPT the waitlisted section's own blocks. */
    restPatterns: MeetingPattern[];
    /**
     * Blocks of the backups already chosen for OTHER waitlisted sections in
     * this candidate. With Albert auto-swap the student registers ALL backups
     * simultaneously, so a resolver-supplied backup must also be conflict-free
     * with these (the same joint two-state check the same-course path enforces).
     */
    otherBackupPatterns: MeetingPattern[];
}

/**
 * Resolve a different-course OPEN backup whose substituted plan is
 * graduation-valid (re-validated through the frozen
 * `finalizeForwardSchedule` by the caller). Returns the backup CRN
 * or `null` when none is conflict-free + grad-valid. Injected so the
 * enumerator stays pure and decoupled from the solver; the real
 * wiring is the Phase A/B/C escalation work. Default (undefined) ⇒
 * same-course backups only.
 */
export type BackupResolver = (input: BackupResolverInput) => { fallbackCrn: string } | null;

export interface EnumerateFeasibleOptions {
    /** Cap on feasible candidates returned. Default MAX_COMBINATIONS. */
    cap?: number;
    /** Different-course grad-valid backup resolver (Phase A/B/C). */
    backupResolver?: BackupResolver;
    /**
     * Phase 38 #2 — FIXED, already-occupied time blocks the candidate must
     * avoid: the meeting times of courses the student is ALREADY registered for
     * this term (IP courses). The DPR doesn't carry the registered section, so
     * the caller resolves these (student-supplied CRN/times) and passes them
     * here; every candidate's blocks must be conflict-free against them.
     */
    occupiedBlocks?: MeetingPattern[];
}

export interface FeasibleScheduleResult {
    candidates: FeasibleCandidate[];
    /** True when enumeration stopped at the cap (more may exist). */
    truncated: boolean;
}

function isOpen(s: SectionView): boolean {
    return isOpenStatus(s.status);
}

function isWaitlist(s: SectionView): boolean {
    return isWaitlistStatus(s.status);
}

function weeklyHoursOf(sections: SectionView[]): number {
    let total = 0;
    for (const s of sections) {
        for (const p of s.meetingPatterns) {
            total += (p.endMin - p.startMin) / 60;
        }
    }
    return Math.round(total * 100) / 100;
}

/**
 * For an assembled conflict-free candidate (flat section list), verify
 * the §2①(d) waitlist backup rule and collect the fallbacks. Returns
 * the fallbacks when every `W` section has a verified backup, else
 * `null` (the candidate is infeasible).
 *
 * JOINT two-state feasibility: with Albert auto-swap the student
 * registers ALL backups simultaneously, so each chosen backup must be
 * conflict-free not only with the candidate's held blocks (minus the
 * W it replaces) but ALSO with every backup already chosen for the
 * other waitlisted sections — otherwise the all-backups-registered
 * state is itself unschedulable.
 */
function resolveWaitlistBackups(
    flatSections: SectionView[],
    componentsByCourse: Map<string, CourseComponents>,
    backupResolver: BackupResolver | undefined,
): OpenFallback[] | null {
    const fallbacks: OpenFallback[] = [];
    // Blocks of the backups already chosen for earlier W sections in this
    // candidate — every later backup must avoid these too (joint feasibility).
    const chosenBackupPatterns: MeetingPattern[] = [];

    for (const s of flatSections) {
        if (!isWaitlist(s)) continue;

        // The "rest" = every other chosen block (the W section's own
        // blocks are excluded — B and W are alternatives, never held
        // together, so the backup need only fit around the rest).
        const restPatterns = flatSections
            .filter(other => other !== s)
            .flatMap(other => other.meetingPatterns);

        // (1) Prefer a same-course, same-component OPEN backup that is
        // conflict-free with BOTH the rest AND the other chosen backups
        // (Albert auto-swap, grad-trivial).
        const group = componentsByCourse.get(s.courseId)?.components.get(normalizeComponent(s.schd));
        const sameCourse = (group ?? []).find(
            b =>
                isOpen(b) &&
                b.crn !== s.crn &&
                !conflicts(b.meetingPatterns, restPatterns) &&
                !conflicts(b.meetingPatterns, chosenBackupPatterns),
        );
        if (sameCourse !== undefined) {
            fallbacks.push({ forCrn: s.crn, fallbackCrn: sameCourse.crn });
            chosenBackupPatterns.push(...sameCourse.meetingPatterns);
            continue;
        }

        // (2) Fall back to a graduation-validated different-course backup
        // via the injected resolver (Phase A/B/C). The resolver receives the
        // other chosen backups so it can keep the joint state conflict-free.
        // No resolver ⇒ reject.
        const resolved = backupResolver?.({
            waitlisted: s,
            restPatterns,
            otherBackupPatterns: [...chosenBackupPatterns],
        });
        if (resolved != null) {
            fallbacks.push({ forCrn: s.crn, fallbackCrn: resolved.fallbackCrn });
            // The resolver does not surface the backup's blocks, so we cannot
            // thread them into later joint checks — documented limitation of
            // the (deferred) different-course path; the same-course path above
            // is fully joint-checked.
            continue;
        }

        // No conflict-free, grad-valid backup ⇒ this W candidate is infeasible.
        return null;
    }
    return fallbacks;
}

/** Keep only the NON-WAITLIST sections of each component group (drop W).
 *  These are O (confirmed open) + A (offered, seat-unknown) — the tier that
 *  needs no auto-swap backup. */
function filterCourseToNonWaitlist(course: CourseComponents): CourseComponents {
    const components = new Map<string, SectionView[]>();
    for (const [key, sections] of course.components) {
        components.set(key, sections.filter(s => !isWaitlist(s)));
    }
    return { ...course, components };
}

type EnumMode = "non-waitlist" | "waitlist-only";

/**
 * Core backtracking enumeration. Collects up to `cap` FEASIBLE candidates
 * matching `mode`:
 *   - "non-waitlist"  → every candidate has NO waitlist section (input
 *     groups are pre-filtered to drop W, so candidates are O/A only).
 *   - "waitlist-only" → only candidates containing ≥1 waitlist section are
 *     kept (the no-waitlist ones are produced by the prior pass).
 * `componentsByCourse` must be the FULL (O|W) groups so same-course open
 * backups remain findable.
 */
function runEnumeration(
    courses: CourseComponents[],
    componentsByCourse: Map<string, CourseComponents>,
    cap: number,
    backupResolver: BackupResolver | undefined,
    mode: EnumMode,
    occupiedBlocks: MeetingPattern[],
): FeasibleScheduleResult {
    const perCourseSelections = courses.map(c => enumerateCourseSelections(c));
    const candidates: FeasibleCandidate[] = [];
    let truncated = false;

    function recurse(idx: number, picked: CourseSelection[], pickedSections: SectionView[]): void {
        if (candidates.length >= cap) {
            truncated = true;
            return;
        }
        if (idx === courses.length) {
            const waitlistCrns = pickedSections.filter(isWaitlist).map(s => s.crn);
            const hasWaitlist = waitlistCrns.length > 0;
            // In waitlist-only mode skip no-waitlist candidates (the prior pass
            // owns them — this guarantees open ≻ waitlist survives truncation).
            if (mode === "waitlist-only" && !hasWaitlist) return;
            const fallbacks = resolveWaitlistBackups(pickedSections, componentsByCourse, backupResolver);
            if (fallbacks === null) return; // a W section lacked a valid backup
            candidates.push({
                selections: picked.map(p => ({ ...p, sections: [...p.sections] })),
                weeklyHours: weeklyHoursOf(pickedSections),
                hasWaitlist,
                waitlistCrns,
                openFallbacks: fallbacks,
            });
            return;
        }

        for (const selection of perCourseSelections[idx]!) {
            if (candidates.length >= cap) {
                truncated = true;
                return;
            }
            // Every block of this selection must be conflict-free with every
            // already-picked block (across courses) AND with the fixed
            // occupied blocks (already-registered IP courses this term).
            const clashes = selection.sections.some(s =>
                conflicts(s.meetingPatterns, occupiedBlocks) ||
                pickedSections.some(prev => conflicts(prev.meetingPatterns, s.meetingPatterns)),
            );
            if (clashes) continue;
            picked.push(selection);
            pickedSections.push(...selection.sections);
            recurse(idx + 1, picked, pickedSections);
            pickedSections.length -= selection.sections.length;
            picked.pop();
        }
    }

    if (courses.length > 0) recurse(0, [], []);
    return { candidates, truncated };
}

/**
 * Enumerate the verified feasible candidate schedules. `courses` must
 * already be filtered to open/waitlist sections (closed/cancelled
 * removed) and have any strict scheduling preferences applied.
 *
 * TWO PASSES so the cap never drops a no-waitlist candidate in favor of a
 * waitlist-containing one (the binding "open ≻ waitlist" invariant must
 * survive truncation): pass 1 enumerates ALL-OPEN candidates over the
 * open-only groups; pass 2 fills any remaining cap budget with
 * waitlist-containing candidates. Within each pass `candidatePreRank`
 * orders by soft preference.
 *
 * Pure. Output is capped at `cap` FEASIBLE candidates total; `truncated`
 * indicates the cap was hit (more candidates may exist).
 */
export function enumerateFeasibleSchedules(
    courses: CourseComponents[],
    opts: EnumerateFeasibleOptions = {},
): FeasibleScheduleResult {
    const cap = opts.cap ?? MAX_COMBINATIONS;
    // FULL groups — so the waitlist backup search can see open sections.
    const componentsByCourse = new Map(courses.map(c => [c.courseId, c]));

    // Pass 1 — NO-WAITLIST candidates (over groups with W dropped). These
    // never need an auto-swap backup; doing them first guarantees the cap
    // can't drop a no-waitlist candidate in favor of a waitlist one.
    const nonWaitlistCourses = courses.map(filterCourseToNonWaitlist);
    const occupiedBlocks = opts.occupiedBlocks ?? [];
    const pass1 = runEnumeration(nonWaitlistCourses, componentsByCourse, cap, opts.backupResolver, "non-waitlist", occupiedBlocks);

    if (pass1.candidates.length >= cap) {
        // The cap is full of no-waitlist candidates; more exist.
        return { candidates: pass1.candidates, truncated: true };
    }

    // Pass 2 — fill the remaining budget with waitlist-containing candidates.
    const remaining = cap - pass1.candidates.length;
    const pass2 = runEnumeration(courses, componentsByCourse, remaining, opts.backupResolver, "waitlist-only", occupiedBlocks);

    return {
        candidates: [...pass1.candidates, ...pass2.candidates],
        truncated: pass1.truncated || pass2.truncated,
    };
}
