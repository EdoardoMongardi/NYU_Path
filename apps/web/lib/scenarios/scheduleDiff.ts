/**
 * H1.1 — scheduleDiff.ts
 *
 * PURE function that compares two ForwardSchedules and annotates both for a
 * side-by-side compare view (H3 renders the two annotated columns).
 *
 * PURE: no React, no I/O, no module-level state, no Date.now().
 * Engine is read-only (public barrel only — no deep-path imports).
 * `computeSlotDiff` is NOT on the @nyupath/engine barrel; the added/removed
 * sets are computed directly from `semesters[].slots` below.
 *
 * ── Semantics (per canonical course id) ────────────────────────────────────
 *
 *  same     – course appears in both schedules in the SAME term.
 *             → marked `same` in both columns.
 *
 *  removed  – course in base but NOT in other.
 *             → marked `removed` in the base column at its base term.
 *
 *  added    – course in other but NOT in base.
 *             → marked `added` in the other column at its other term.
 *
 *  moved    – course appears in BOTH schedules but at DIFFERENT terms.
 *             → marked `moved` in BOTH columns (base at its original term,
 *               other at its new term). Both sides show "moved" so the reader
 *               immediately understands this is a relocation, not a
 *               removal + fresh addition.
 *
 *  retake   – course was `removed` from its base term (base has it at term T,
 *               other does NOT have it at term T) AND the same course re-appears
 *               in `other` at a STRICTLY LATER term.
 *             → the base column marks it `removed` (at the original term T).
 *             → the other column marks the later-term occurrence `retake`.
 *             Heuristic: determined by term string comparison (lexicographic
 *             ordering works for the "YYYY-season" format: 2026-fall < 2027-spring
 *             because 'f' < 's' and the year prefix dominates). Simple rule:
 *             if the course is in base at term T and is absent at term T in other
 *             but present at term U in other where U > T (lex), → retake.
 *             We do NOT attempt to handle exotic cases (e.g. a course listed
 *             twice in the same schedule; the first occurrence wins).
 *
 * ── Placeholders ─────────────────────────────────────────────────────────────
 * Placeholder slots carry no `courseId`; they use their `placeholderId` as the
 * diff key and `category` as the label. They are included in the output but
 * two placeholders only match if their `placeholderId` is identical.
 */

import { canonicalizeCourseId } from "@nyupath/engine";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CourseDiff = "same" | "added" | "removed" | "moved" | "retake";

export interface DiffRow {
    /** Canonical course id, or a placeholder key like `placeholder:{placeholderId}`. */
    courseId: string;
    /** Display label: course code/title (or placeholder category). */
    label: string;
    /** The term this row sits in within its column. */
    term: string;
    diff: CourseDiff;
}

export interface AnnotatedColumn {
    terms: Array<{ term: string; rows: DiffRow[] }>;
}

export interface ScheduleDiff {
    /** The "left" / base schedule, rows marked same | removed | moved. */
    base: AnnotatedColumn;
    /** The "right" / other schedule, rows marked same | added | moved | retake. */
    other: AnnotatedColumn;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract a stable diff-key and display label from a slot. */
function slotKey(slot: ScheduleSlot): { key: string; label: string } {
    if (slot.kind === "placeholder") {
        return {
            key: `placeholder:${slot.placeholderId}`,
            label: slot.category,
        };
    }
    const canonical = canonicalizeCourseId(slot.courseId);
    return {
        key: canonical,
        label: slot.title ?? canonical,
    };
}

/**
 * Build a flat list of { key, label, term } for all slots in a schedule,
 * preserving schedule order.  The FIRST occurrence of a key wins for the
 * purpose of term assignment (exotic duplicates are ignored).
 */
interface SlotRecord {
    key: string;
    label: string;
    term: string;
}

function buildRecords(schedule: ForwardSchedule): SlotRecord[] {
    const seen = new Set<string>();
    const records: SlotRecord[] = [];
    for (const sem of schedule.semesters) {
        for (const slot of sem.slots) {
            const { key, label } = slotKey(slot);
            if (!seen.has(key)) {
                seen.add(key);
                records.push({ key, label, term: sem.term });
            }
        }
    }
    return records;
}

/** Build a Map<key → SlotRecord> from a schedule (first occurrence wins). */
function buildMap(schedule: ForwardSchedule): Map<string, SlotRecord> {
    const map = new Map<string, SlotRecord>();
    for (const rec of buildRecords(schedule)) {
        if (!map.has(rec.key)) {
            map.set(rec.key, rec);
        }
    }
    return map;
}

/**
 * Determine the union of terms, preserving relative order:
 * base terms first (in order), then any extra other-only terms in their
 * original order.
 */
function mergedTermOrder(base: ForwardSchedule, other: ForwardSchedule): string[] {
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const sem of base.semesters) {
        if (!seen.has(sem.term)) {
            seen.add(sem.term);
            terms.push(sem.term);
        }
    }
    for (const sem of other.semesters) {
        if (!seen.has(sem.term)) {
            seen.add(sem.term);
            terms.push(sem.term);
        }
    }
    return terms;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function diffSchedules(base: ForwardSchedule, other: ForwardSchedule): ScheduleDiff {
    const baseMap = buildMap(base);
    const otherMap = buildMap(other);

    // Collect all unique keys across both schedules.
    const allKeys = new Set<string>([...baseMap.keys(), ...otherMap.keys()]);

    // Classify each key.
    type ClassifiedEntry = {
        key: string;
        label: string;
        // Where the row actually sits (in the column it belongs to).
        baseTerm: string | null;   // null = absent from base
        otherTerm: string | null;  // null = absent from other
        baseDiff: CourseDiff | null;
        otherDiff: CourseDiff | null;
    };

    const entries: ClassifiedEntry[] = [];

    for (const key of allKeys) {
        const inBase = baseMap.get(key);
        const inOther = otherMap.get(key);
        const label = (inBase ?? inOther)!.label;

        if (inBase && inOther) {
            if (inBase.term === inOther.term) {
                // same term → same in both
                entries.push({
                    key, label,
                    baseTerm: inBase.term, otherTerm: inOther.term,
                    baseDiff: "same", otherDiff: "same",
                });
            } else {
                // different term → moved in both
                entries.push({
                    key, label,
                    baseTerm: inBase.term, otherTerm: inOther.term,
                    baseDiff: "moved", otherDiff: "moved",
                });
            }
        } else if (inBase && !inOther) {
            // Absent from other entirely.
            // Check if it is a retake candidate: the course IS in other but at a
            // different (later) term.  Since we already handled inBase && inOther
            // above, reaching here means it is truly absent from other → removed.
            entries.push({
                key, label,
                baseTerm: inBase.term, otherTerm: null,
                baseDiff: "removed", otherDiff: null,
            });
        } else if (!inBase && inOther) {
            // !inBase && inOther — course is new in other; may be plain added or retake.
            // (Retake promotion happens in the second pass below.)
            entries.push({
                key, label,
                baseTerm: null, otherTerm: inOther.term,
                baseDiff: null, otherDiff: "added",
            });
        }
        // (No else — every key is in at least one of the two maps.)
    }

    // ── retake promotion pass ────────────────────────────────────────────────
    // A "removed" base entry whose key also appears in other at a LATER term
    // (lex comparison — works for "YYYY-season" format) should be promoted to
    // retake in the other column.
    //
    // By construction, if the key is in BOTH maps it was handled as moved/same
    // above.  So a "removed" entry has `otherTerm = null`.  We re-check whether
    // there is an "added" entry with the same key that appeared later.
    //
    // We cannot have the same key in both "removed" and "added" entries because
    // `buildMap` deduplicates — if the key was in both schedules it becomes
    // same/moved.  However, we maintain the retake check as the spec describes:
    // base has CourseX at term T, other drops it from T but has it at a later U.
    // That scenario is exactly what "moved" covers (both in base AND other, just
    // different terms) — except the spec wants `retake` specifically when the
    // "intent" is to re-do the course after a withdrawal.
    //
    // Per the task spec:
    //   "retake: a course that is `removed` from its base term AND re-appears
    //    in `other` in a LATER term"
    //
    // The key insight: if the course is in BOTH schedules at different terms we
    // classify it as "moved" — that is the normal "I shifted the course forward"
    // case.  But the retake scenario from the spec is about a WITHDRAWAL: the
    // course is in base.semesters[fall], other.semesters[fall] does NOT have it,
    // AND other.semesters[laterSpring] DOES.  In the data model, after a
    // withdrawal the slot is simply gone from `other` for that term; it may still
    // appear later.  If it appears later, buildMap captures the later occurrence
    // in otherMap — so the course IS in both maps at different terms → "moved".
    //
    // To honour the retake semantics we need to DISTINGUISH between a genuine
    // forward-move (same intent, just shifted) and a re-attempt after a drop.
    // The spec says: "base has it at term T; other drops it from T AND has it
    // in a later term".  This matches: inBase.term = T, inOther.term = U (> T).
    //
    // So: among all "moved" entries, if inOther.term > inBase.term (lex), mark
    // the other column as "retake" instead of "moved".
    //
    // Rationale for using lex on "YYYY-season" strings:
    //   2026-fall < 2027-spring  (year dominates)
    //   2026-fall < 2026-spring  ← FALSE: 'f' > 's', so lex gives 2026-fall > 2026-spring
    //
    // That is wrong for the within-year case (fall comes after spring in the same
    // year).  We use a simple numeric sort instead: parse YYYY, map season to an
    // index (spring=0, summer=1, fall=2, january=3 of the next calendar year),
    // and compare the resulting ordinals.

    for (const e of entries) {
        if (e.baseDiff === "moved" && e.otherDiff === "moved") {
            if (e.baseTerm !== null && e.otherTerm !== null) {
                if (termOrdinal(e.otherTerm) > termOrdinal(e.baseTerm)) {
                    // The course is in other at a LATER term after being
                    // removed from the base term → retake semantics.
                    e.otherDiff = "retake";
                    // Keep baseDiff as "moved" for consistency — the base side
                    // still shows where the course originally was, and "moved"
                    // communicates "this course changed position" clearly.
                    // (If we marked it "removed" in base it would be more
                    //  accurate for a withdrawal scenario, but the diff engine
                    //  has no withdrawal metadata — we rely purely on position.
                    //  Document: base side of a retake shows "moved".)
                    // UPDATE: per task spec the retake test expects the base
                    // Fall row to be "removed".  But in the retake fixture the
                    // course is absent from other's fall term, which means
                    // buildMap gives otherMap[key].term = spring (the later
                    // occurrence) — so the entry was already classified as
                    // "moved" (both present, different terms).  To emit the
                    // spec-expected "removed" in base, we now downgrade the
                    // base side.
                    e.baseDiff = "removed";
                }
            }
        }
    }

    // ── Assemble the annotated columns ───────────────────────────────────────
    // We need one term-bucket map per column.

    const baseTermMap = new Map<string, DiffRow[]>();
    const otherTermMap = new Map<string, DiffRow[]>();

    // Pre-populate term order so output preserves schedule ordering.
    const allTerms = mergedTermOrder(base, other);
    for (const t of allTerms) {
        baseTermMap.set(t, []);
        otherTermMap.set(t, []);
    }

    for (const e of entries) {
        if (e.baseTerm !== null && e.baseDiff !== null) {
            if (!baseTermMap.has(e.baseTerm)) baseTermMap.set(e.baseTerm, []);
            baseTermMap.get(e.baseTerm)!.push({
                courseId: e.key,
                label: e.label,
                term: e.baseTerm,
                diff: e.baseDiff,
            });
        }
        if (e.otherTerm !== null && e.otherDiff !== null) {
            if (!otherTermMap.has(e.otherTerm)) otherTermMap.set(e.otherTerm, []);
            otherTermMap.get(e.otherTerm)!.push({
                courseId: e.key,
                label: e.label,
                term: e.otherTerm,
                diff: e.otherDiff,
            });
        }
    }

    // Convert to AnnotatedColumn format, preserving term order.
    function toColumn(termMap: Map<string, DiffRow[]>, schedTerms: string[]): AnnotatedColumn {
        // Emit terms in the schedule's own order first, then any extra terms.
        const seen = new Set<string>();
        const terms: AnnotatedColumn["terms"] = [];
        for (const t of schedTerms) {
            if (!seen.has(t)) {
                seen.add(t);
                const rows = termMap.get(t) ?? [];
                if (rows.length > 0) {
                    terms.push({ term: t, rows });
                }
            }
        }
        // Any extra terms not in this schedule's list (e.g. other-only terms in base col)
        for (const [t, rows] of termMap) {
            if (!seen.has(t) && rows.length > 0) {
                terms.push({ term: t, rows });
            }
        }
        return { terms };
    }

    const baseTermOrder = base.semesters.map((s) => s.term);
    const otherTermOrder = other.semesters.map((s) => s.term);

    // For the base column: include all terms from allTerms that have base rows.
    // For the other column: include all terms from allTerms that have other rows.
    // We want to respect the schedule's own ordering for its terms.
    return {
        base: toColumn(baseTermMap, allTerms),
        other: toColumn(otherTermMap, allTerms),
    };
}

// ---------------------------------------------------------------------------
// Term ordinal (for retake heuristic)
// ---------------------------------------------------------------------------

/**
 * Convert a "YYYY-season" string to a numeric ordinal for temporal comparison.
 * Season ordering within a year: spring=0, summer=1, fall=2, january(next)=3.
 * january is treated as belonging to the NEXT calendar year (it is a winter
 * intersession before the spring of YYYY).
 */
function termOrdinal(term: string): number {
    const [yearStr, season] = term.split("-");
    const year = parseInt(yearStr, 10);
    const seasonMap: Record<string, number> = {
        spring: 0,
        summer: 1,
        fall: 2,
        january: 3, // treated as belonging to the NEXT calendar year
    };
    const s = seasonMap[season] ?? 0;
    // january is effectively NEXT year's very start
    const effectiveYear = season === "january" ? year + 1 : year;
    return effectiveYear * 10 + s;
}
