// ============================================================
// groupCoursesByTerm — Phase 16 Task C (rewritten May 2026 post-mortem)
// ============================================================
// Pure helper that produces a chronologically-ordered render plan
// for the schedule sidebar.
//
// SOURCE OF TRUTH: when a parsed `DegreeProgressReport` is available,
// historical AND in-progress term cards are derived directly from
// `dpr.courseHistory` (so we get real titles + real types — not the
// synthesized `grade="C"` placeholder `buildStudentProfileFromDpr`
// stamps on IP rows for audit consumption). Future cards still come
// from `forwardSchedule.semesters`.
//
// FALLBACK: when no DPR is available (legacy transcript-only flow),
// fall back to `StudentProfile.coursesTaken` + `currentSemester` —
// less accurate (no real course titles, IP rows render as completed
// with placeholder grades) but the legacy path is being removed
// alongside Phase 16 cohort migration.
//
// Cardinal Rule §2.1: every entry traces back to a DPR / StudentProfile
// field; this helper performs no LLM synthesis and no fabrication. When
// upstream data is missing we omit the entry rather than guess.
//
// May 2026 post-mortem fixes:
//  - Two-card Fall-2026 duplicate: dedup now compares NORMALIZED term
//    keys (handles "2026 Fall", "Fall 2026", "2026-fall" interchangeably)
//    instead of literal strings.
//  - Spring 2026 C-grade leakage: IP-tagged rows render under their own
//    in-progress card with grade="IP", regardless of the synthesized "C"
//    on `coursesTaken`.
//  - Course title duplication ("CSCI-UA 4 CSCI-UA 4"): historical and
//    IP slots now carry `row.courseTitle` from the DPR row instead of
//    falling back to the courseId.
// ============================================================

import type {
    StudentProfile,
    ForwardSchedule,
    ScheduleSlot,
    CourseTaken,
} from "@nyupath/shared";
import type { DegreeProgressReport, DPRCourseRow, AcademicCalendar, Campus } from "@nyupath/engine";
import {
    deriveTemporalContext,
    campusForHomeSchool,
    classifyIpChangeability,
    NYU_ACADEMIC_CALENDAR,
} from "@nyupath/engine";
import type { SlotIpChangeability } from "../app/chat/sidebar/slotState";

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
    /** F3 — for an IP (in-progress) term bucket, the engine's per-term
     *  changeability classification (`classifyIpChangeability`). All slots
     *  in an IP bucket share the same term, so ONE classification per IP
     *  bucket is correct. The renderer threads this into `computeSlotState`
     *  so an in_progress slot's editable + label/hedge come from the honest
     *  registration-window state instead of the blanket "IP → editable".
     *  Absent on history/future buckets (and when no DPR is available). */
    ipChangeability?: SlotIpChangeability;
}

export interface GroupedDegree {
    priorCredits: PriorCreditEntry[];
    /** Chronological: history → current → future. */
    terms: TermBucket[];
}

export function groupCoursesByTerm(args: {
    student: StudentProfile | null;
    forwardSchedule: ForwardSchedule | null;
    /** Raw DPR for extracting TE rows + historical/IP titles + types.
     *  Optional — if absent, we fall back to `student.coursesTaken`. */
    dpr?: DegreeProgressReport | null;
    /** F3 — inject "today" + the academic calendar for the IP-changeability
     *  classification (tests pass a fixed clock + a fixture calendar).
     *  Default: real `new Date()` + the bundled NYU calendar. */
    now?: Date;
    calendar?: AcademicCalendar;
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

    // ---- 2. Historical + IP term buckets -----------------------------
    // Preferred path: walk dpr.courseHistory so we get real titles + the
    // accurate type discriminator (EN vs IP). Fallback path uses
    // student.coursesTaken when no DPR is available.
    //
    // F3 — derive the temporal context + campus ONCE here (from the DPR's
    // IP rows + the student's home school) so each IP bucket can be
    // classified by `classifyIpChangeability` (its registration window).
    const now = args.now ?? new Date();
    const calendar = args.calendar ?? NYU_ACADEMIC_CALENDAR;
    const dprTerms: TermBucket[] = dpr
        ? buildTermsFromDpr(dpr, {
            now,
            calendar,
            campus: campusForHomeSchool(student?.homeSchool),
        })
        : buildTermsFromCoursesTaken(student?.coursesTaken ?? [], student?.currentSemester);

    // ---- 3. Future-term buckets (from forwardSchedule) ---------------
    // De-dup against history + IP using a NORMALIZED term key so
    // "2026 Fall" / "Fall 2026" / "2026-fall" all collapse to one bucket.
    // The IP/historical rendering wins; the future-card duplicate is
    // dropped.
    const seenKeys = new Set<string>();
    for (const t of dprTerms) seenKeys.add(normalizeTermKey(t.term));

    const futureTerms: TermBucket[] = [];
    for (const sem of forwardSchedule?.semesters ?? []) {
        const key = normalizeTermKey(sem.term);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        futureTerms.push({
            term: sem.term,
            locked: sem.locked,
            slots: sem.slots,
        });
    }

    // ---- 4. Chronological merge --------------------------------------
    const allTerms: TermBucket[] = [...dprTerms, ...futureTerms];
    allTerms.sort((a, b) => compareTerms(a.term, b.term));

    return { priorCredits, terms: allTerms };
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

/**
 * Build term buckets directly from the DPR's course-history block. Each
 * term gets its OWN bucket; rows are classified as completed (`type=EN`
 * with a real grade) or in-progress (`type=IP`). When a single term has
 * a mix (rare — usually a re-take), we treat the whole card as IP so the
 * student doesn't see a phantom "passed" status next to a re-enrolled
 * row.
 */
function buildTermsFromDpr(
    dpr: DegreeProgressReport,
    ipCtx: { now: Date; calendar: AcademicCalendar; campus: Campus },
): TermBucket[] {
    const byTerm = new Map<string, DPRCourseRow[]>();
    for (const row of dpr.courseHistory) {
        // TE rows surface in the Prior Credits card, not a term card.
        if (row.type === "TE") continue;
        // Synthetic catch-all rows (subject="ELECTIVE") are credit-bucket
        // counters with no real course; skip them in the term cards.
        if (row.subject.toUpperCase() === "ELECTIVE") continue;
        const list = byTerm.get(row.term) ?? [];
        list.push(row);
        byTerm.set(row.term, list);
    }

    // F3 — derive the temporal context once for the whole DPR so each IP
    // bucket below can be classified against the real registration windows.
    const temporalContext = deriveTemporalContext(dpr, { now: ipCtx.now });

    const buckets: TermBucket[] = [];
    for (const [term, rows] of byTerm.entries()) {
        const isIP = rows.some((r) => r.type === "IP");
        if (isIP) {
            // Classify THIS IP term's changeability (future / add-drop /
            // withdraw-pf / closed / unknown). A "closed" current-term IP
            // renders NOT editable even though it's IP; a future-term IP is
            // freely changeable. The blanket `locked: !isIP` (false for IP)
            // stays — the per-slot editable gate now honors this instead.
            const result = classifyIpChangeability({
                ipTerm: term,
                temporalContext,
                campus: ipCtx.campus,
                calendar: ipCtx.calendar,
                now: ipCtx.now,
            });
            const ipChangeability: SlotIpChangeability = {
                window: result.window,
                editable: result.editable,
                ...(result.hedge ? { hedge: result.hedge } : {}),
            };
            buckets.push({
                term,
                locked: false, // IP term is not a history bucket
                slots: rows.map((r) => dprRowToSlot(r, true)),
                ipChangeability,
            });
        } else {
            buckets.push({
                term,
                locked: true, // historical = locked
                slots: rows.map((r) => dprRowToSlot(r, false)),
            });
        }
    }
    return buckets;
}

function dprRowToSlot(row: DPRCourseRow, isIPTerm: boolean): ScheduleSlot {
    const courseId = `${row.subject} ${row.catalogNbr}`.replace(/\s+/g, " ").trim();
    const title = row.courseTitle?.trim() || courseId;
    if (isIPTerm) {
        return {
            kind: "in_progress",
            courseId,
            title,
            credits: row.units,
        };
    }
    return {
        kind: "completed",
        courseId,
        title,
        credits: row.units,
        // Use the real DPR grade. Empty/missing falls through to a literal
        // "—" character so the renderer's grade column never crashes on
        // a null read.
        grade: row.grade ?? "—",
    };
}

/**
 * Defensive fallback that groups a profile's `coursesTaken` into term
 * buckets when a raw DPR isn't available to the sidebar. Produces
 * less-accurate slots than the DPR-driven builder (no real titles; IP
 * rows render as completed). In the DPR-only flow this path is not
 * normally reached, but it keeps the sidebar resilient.
 */
function buildTermsFromCoursesTaken(
    coursesTaken: CourseTaken[],
    currentSemester?: { term: string; courses: Array<{ courseId: string; title: string; credits: number }> },
): TermBucket[] {
    const currentTerm = currentSemester?.term;
    const historicalRows = coursesTaken.filter((c) => c.semester !== currentTerm);
    const byTerm = new Map<string, CourseTaken[]>();
    for (const row of historicalRows) {
        const list = byTerm.get(row.semester) ?? [];
        list.push(row);
        byTerm.set(row.semester, list);
    }
    const historical: TermBucket[] = Array.from(byTerm.entries()).map(([term, rows]) => ({
        term,
        locked: true,
        slots: rows.map((c) => ({
            kind: "completed" as const,
            courseId: c.courseId,
            title: c.courseId,
            credits: c.credits ?? 0,
            // grade is nullable (DPR-2); fall back to "—" for display.
            grade: c.grade ?? "—",
        })),
    }));
    const current: TermBucket[] = currentSemester && currentSemester.courses.length > 0
        ? [{
            term: currentSemester.term,
            locked: false,
            slots: currentSemester.courses.map((c) => ({
                kind: "in_progress" as const,
                courseId: c.courseId,
                title: c.title,
                credits: c.credits,
            })),
        }]
        : [];
    return [...historical, ...current];
}

function makePriorCreditEntry(row: DPRCourseRow): PriorCreditEntry {
    const isElective = row.subject.toUpperCase() === "ELECTIVE";
    const courseId = isElective
        ? (row.courseTitle && row.courseTitle.trim().length > 0
            ? row.courseTitle.trim()
            : "Elective Credit")
        : `${row.subject} ${row.catalogNbr}`.replace(/\s+/g, " ").trim();
    const entry: PriorCreditEntry = { courseId, credits: row.units };
    if (!isElective && row.courseTitle && row.courseTitle.trim() !== courseId) {
        entry.source = row.courseTitle.trim();
    }
    return entry;
}

/**
 * Normalize a term string to a canonical key for dedup. Accepts the
 * DPR's "2024 Fall" / "2026 Spr", the planner's "2026-fall", or the
 * inverted "Fall 2026". Returns "{year}-{season}" lowercased.
 *
 * RC: the literal-string dedup that shipped with Task C missed the
 * "2026 Fall" vs "Fall 2026" pair, producing two cards for the same
 * term. Normalizing fixes that without changing the canonical term
 * value displayed in the UI.
 */
export function normalizeTermKey(term: string): string {
    const SEASON_CANON: Record<string, string> = {
        january: "january",
        "j-term": "january",
        jterm: "january",
        spring: "spring",
        spr: "spring",
        summer: "summer",
        sum: "summer",
        fall: "fall",
    };
    const dash = term.match(/^(\d{4})-([a-z]+)$/i);
    if (dash) {
        return `${dash[1]}-${SEASON_CANON[dash[2]!.toLowerCase()] ?? dash[2]!.toLowerCase()}`;
    }
    const space = term.match(/(\d{4})\s+([A-Za-z-]+)/) ?? term.match(/([A-Za-z-]+)\s+(\d{4})/);
    if (space) {
        const [g1, g2] = [space[1]!, space[2]!];
        const yearStr = /^\d{4}$/.test(g1) ? g1 : g2;
        const seasonStr = /^\d{4}$/.test(g1) ? g2 : g1;
        const canon = SEASON_CANON[seasonStr.toLowerCase()] ?? seasonStr.toLowerCase();
        return `${yearStr}-${canon}`;
    }
    return term.toLowerCase();
}

/**
 * Term comparator that handles BOTH the DPR's "YYYY Season" shape (e.g.
 * "2024 Fall", "2026 Spr") AND the planner's "YYYY-season" shape (e.g.
 * "2026-fall"). Returns negative if `a` precedes `b`, positive otherwise.
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
        const dash = t.match(/^(\d{4})-([a-z]+)$/i);
        if (dash) {
            return {
                year: parseInt(dash[1]!, 10),
                season: SEASON_ORDER[dash[2]!.toLowerCase()] ?? 0,
            };
        }
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
