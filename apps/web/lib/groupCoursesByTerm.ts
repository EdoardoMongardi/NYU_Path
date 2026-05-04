// ============================================================
// groupCoursesByTerm — Phase 16 Task C
// ============================================================
// Pure helper that produces a chronologically-ordered render plan
// for the schedule sidebar. Combines:
//
//   - StudentProfile.coursesTaken (history)        → "completed" slots
//   - StudentProfile.currentSemester               → "in_progress" slots
//   - ForwardSchedule.semesters (planner output)   → "specific_planned"
//                                                    + "placeholder" slots
//   - DegreeProgressReport.courseHistory[type=TE]  → priorCredits payload
//
// Phase 14/15 emitted only the future-only forward plan; Phase 16 Task C's
// goal is to surface the ENTIRE degree timeline so a returning student
// sees their history (locked), the in-flight term (editable), and the
// proposed future (editable) in one place.
//
// Cardinal Rule §2.1: every entry traces back to a DPR / StudentProfile
// field; this helper performs no LLM synthesis and no fabrication. When
// upstream data is missing we omit the entry rather than guess.
// ============================================================

import type {
    StudentProfile,
    ForwardSchedule,
    ScheduleSlot,
    CourseTaken,
} from "@nyupath/shared";
import type { DegreeProgressReport, DPRCourseRow } from "@nyupath/engine";

export interface PriorCreditEntry {
    /**
     * Human-readable label. For named transfer rows (CSCI-UA 101, MATH-UA
     * 121, …) this is the rendered subject + catalogNbr. For synthetic
     * `subject = "ELECTIVE"` rows (the catch-all bucket PeopleSoft uses
     * for AP/IB credits without a concrete NYU equivalent) this falls
     * back to the row's `courseTitle` so the student sees something
     * meaningful instead of "ELECTIVE CREDIT".
     */
    courseId: string;
    credits: number;
    /**
     * Origin label, kept verbatim from the DPR row when useful. Not
     * required by the renderer — the sidebar just lists `courseId` +
     * credits — but it's a useful hook for Task 16.D's tooltip.
     */
    source?: string;
}

export interface TermBucket {
    /** Term key in the DPR's native shape ("2024 Fall") OR the planner's
     *  shape ("2026-fall"). The renderer formats with formatTermLabel. */
    term: string;
    /** History = true (locked, no popover); IP / future = false. */
    locked: boolean;
    slots: ScheduleSlot[];
}

export interface GroupedDegree {
    priorCredits: PriorCreditEntry[];
    /** Chronological: history → current → future. */
    terms: TermBucket[];
}

export function groupCoursesByTerm(args: {
    student: StudentProfile | null;
    forwardSchedule: ForwardSchedule | null;
    /** Raw DPR for extracting TE rows. Optional — if absent, no prior
     *  credits surface in the UI. */
    dpr?: DegreeProgressReport | null;
}): GroupedDegree {
    const { student, forwardSchedule, dpr } = args;

    // ---- 1. Prior credits (TE rows) ----------------------------------
    const priorCredits: PriorCreditEntry[] = [];
    if (dpr) {
        for (const row of dpr.courseHistory) {
            if (row.type !== "TE") continue;
            priorCredits.push(makePriorCreditEntry(row));
        }
    }

    // ---- 2. Historical buckets (from coursesTaken) -------------------
    // Skip the term that matches `currentSemester.term` so IP rows don't
    // double-render as a "completed" history card AND an "in_progress"
    // current-term card. (buildStudentProfileFromDpr stamps grade="C" on
    // IP rows so the audit can see them; that placeholder grade isn't
    // meant for the sidebar.)
    const currentTerm = student?.currentSemester?.term;
    const historicalRows: CourseTaken[] = (student?.coursesTaken ?? []).filter(
        (c) => c.semester !== currentTerm,
    );

    const historicalByTerm = new Map<string, CourseTaken[]>();
    for (const row of historicalRows) {
        const list = historicalByTerm.get(row.semester) ?? [];
        list.push(row);
        historicalByTerm.set(row.semester, list);
    }

    const historicalTerms: TermBucket[] = Array.from(historicalByTerm.entries())
        .map(([term, rows]) => ({
            term,
            locked: true,
            slots: rows.map(courseTakenToCompletedSlot),
        }));

    // ---- 3. Current-term bucket (from currentSemester) ---------------
    let currentBucket: TermBucket | null = null;
    if (student?.currentSemester && student.currentSemester.courses.length > 0) {
        currentBucket = {
            term: student.currentSemester.term,
            locked: false,
            slots: student.currentSemester.courses.map((c) => ({
                kind: "in_progress" as const,
                courseId: c.courseId,
                title: c.title,
                credits: c.credits,
            })),
        };
    }

    // ---- 4. Future-term buckets (from forwardSchedule) ---------------
    // De-dup against history + current. The Phase 13 forward planner
    // sometimes emits the immediate term as the first slot of
    // `forwardSchedule.semesters`; when it does, the IP rendering
    // (driven by `currentSemester`) wins and the future-card duplicate
    // is dropped.
    const seenTerms = new Set<string>();
    for (const t of historicalTerms) seenTerms.add(t.term);
    if (currentBucket) seenTerms.add(currentBucket.term);

    const futureTerms: TermBucket[] = [];
    for (const sem of forwardSchedule?.semesters ?? []) {
        if (seenTerms.has(sem.term)) continue;
        // Avoid intra-`semesters` duplicates too (defensive).
        seenTerms.add(sem.term);
        futureTerms.push({
            term: sem.term,
            locked: sem.locked,
            slots: sem.slots,
        });
    }

    // ---- 5. Chronological merge --------------------------------------
    const allTerms: TermBucket[] = [
        ...historicalTerms,
        ...(currentBucket ? [currentBucket] : []),
        ...futureTerms,
    ];
    allTerms.sort((a, b) => compareTerms(a.term, b.term));

    return { priorCredits, terms: allTerms };
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function makePriorCreditEntry(row: DPRCourseRow): PriorCreditEntry {
    const isElective = row.subject.toUpperCase() === "ELECTIVE";
    const courseId = isElective
        ? (row.courseTitle && row.courseTitle.trim().length > 0
            ? row.courseTitle.trim()
            : "Elective Credit")
        : `${row.subject} ${row.catalogNbr}`.replace(/\s+/g, " ").trim();
    const entry: PriorCreditEntry = { courseId, credits: row.units };
    // Preserve a light source hint when the courseTitle differs from the
    // courseId — useful for Task 16.D's tooltip ("AP Calculus AB → MATH-UA
    // 121"). For now we keep it strictly as the row's own courseTitle.
    if (!isElective && row.courseTitle && row.courseTitle.trim() !== courseId) {
        entry.source = row.courseTitle.trim();
    }
    return entry;
}

function courseTakenToCompletedSlot(c: CourseTaken): ScheduleSlot {
    return {
        kind: "completed",
        courseId: c.courseId,
        title: c.courseId, // CourseTaken doesn't carry a title; reuse the id
        credits: c.credits ?? 0,
        grade: c.grade,
    };
}

/**
 * Term comparator that handles BOTH the DPR's "YYYY Season" shape (e.g.
 * "2024 Fall", "2026 Spr") AND the planner's "YYYY-season" shape (e.g.
 * "2026-fall"). Returns negative if `a` precedes `b`, positive otherwise.
 *
 * Mirrors the small comparator inline in `apps/web/lib/buildSession.ts`
 * but extends it to recognize both case variants because the sidebar
 * mixes terms from both sources.
 */
export function compareTerms(a: string, b: string): number {
    const SEASON_ORDER: Record<string, number> = {
        january: 0,
        "j-term": 0,
        spring: 1,
        spr: 1,
        summer: 2,
        sum: 2,
        fall: 3,
    };
    const parse = (t: string): { year: number; season: number } => {
        // Try "YYYY-season" first.
        const dash = t.match(/^(\d{4})-([a-z]+)$/i);
        if (dash) {
            return {
                year: parseInt(dash[1]!, 10),
                season: SEASON_ORDER[dash[2]!.toLowerCase()] ?? 0,
            };
        }
        // Fall back to "YYYY Season" / "Season YYYY".
        const space = t.match(/(\d{4})\s+([A-Za-z-]+)/) ?? t.match(/([A-Za-z-]+)\s+(\d{4})/);
        if (space) {
            const [g1, g2] = [space[1]!, space[2]!];
            const yearStr = /^\d{4}$/.test(g1) ? g1 : g2;
            const seasonStr = /^\d{4}$/.test(g1) ? g2 : g1;
            return {
                year: parseInt(yearStr, 10),
                season: SEASON_ORDER[seasonStr.toLowerCase()] ?? 0,
            };
        }
        return { year: 0, season: 0 };
    };
    const pa = parse(a);
    const pb = parse(b);
    if (pa.year !== pb.year) return pa.year - pb.year;
    return pa.season - pb.season;
}
