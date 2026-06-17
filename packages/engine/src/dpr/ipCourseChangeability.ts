// ============================================================
// IP-course changeability classifier (F3 — IP-course temporal model)
// ============================================================
// A pure, node-testable classifier that decides how changeable an
// IN-PROGRESS (IP) course is, per owner decision #2 of the Phase-4
// pre-merge follow-ups (Docs/plans/34-2026-06-16-phase4-pre-merge-
// followups.md). The changeability of an IP course depends on its TERM
// relative to today + that campus/season's TYPICAL NYU registration
// windows:
//
//   - A final grade on the DPR → LOCKED (absolute). That is handled
//     upstream by `slot.kind === "completed"`; this classifier only sees
//     IP rows.
//   - IP course in a FUTURE term (pre-registered) → "future": freely
//     changeable. It is pure planning — there is no real-world
//     registration to undo yet. No hedge.
//   - IP course in the CURRENT term → classify by the season's TYPICAL
//     registration windows (academicCalendar.ts holds ONE assumed
//     date-set PER SEASON; the classifier stamps the term's actual YEAR
//     onto that season pattern to build a concrete date, then ALWAYS
//     hedges that the date is typical and shifts year to year):
//       · within add/drop                → "add_drop": changeable.
//       · within withdraw / pass-fail    → "withdraw_pf": can WITHDRAW (a
//         "W" lands on the transcript and does NOT fulfill the
//         requirement) or switch to PASS/FAIL (P/F may not satisfy a
//         letter-grade major rule). Surfaced as options WITH a
//         "verify with your adviser" hedge.
//       · after those windows            → "closed": effectively locked
//         (it will receive its letter grade) + hedge.
//       · season unrecognized / no dates → "unknown": a GENERIC hedge.
//   - A past / stale IP row (the term is already over) → "closed".
//
// ⚑ TYPICAL, NOT EXACT (binding, core_philosophy.md). The windows are
// NOT a specific year's officially-published dates — they are ONE assumed
// per-SEASON pattern (academicCalendar.ts) we stamp the IP term's YEAR
// onto. Every current-term hedge therefore says the deadline is NYU's
// TYPICAL deadline for that season and the EXACT date shifts each year,
// so the student must confirm it with their adviser/registrar and
// nothing is official until their next DPR. fall / spring are anchored to
// recently-published dates; summer / january (J-term) are reasonable
// estimates — for a SUMMER current-term course the hedge additionally
// flags that summer has many sub-sessions so the deadline is especially
// uncertain.
//
// VERIFICATION-GROUNDED (binding, core_philosophy.md + decision #2): any
// CLAIMED change to a current-term course (drop / withdraw / pass-fail)
// is an UNVERIFIED assumption. The agent plans around it only as a
// clearly-marked draft / what-if and NEVER records it as fact — only a
// new DPR confirms a status change. This classifier expresses the
// SPACE of available actions + their consequences; it does not assert a
// change happened. The agent grounding lives in systemPrompt.ts CORE
// RULE 15.
//
// ⚑ DEFERRED — own task, NOT in this pass (flag): the precise
// requirement-engine modeling of W / pass-fail → requirement
// satisfaction (does a W satisfy rule R? does P/F satisfy a letter-grade
// major rule?). Until that lands, the "withdraw_pf" hedge below states
// the CONSEQUENCE in prose ("a W does not fulfill the requirement";
// "pass/fail may not satisfy a letter-grade major rule") rather than
// computing it. Do NOT wire W/PF into finalizeForwardSchedule /
// runGraduationPathValidator / the solver — the frozen-engine contract
// stays intact.
// ============================================================

import {
    getSeasonWindows,
    normalizeCalendarTermKey,
    seasonOfTerm,
    type AcademicCalendar,
    type Campus,
    type Season,
    type SeasonWindows,
} from "./academicCalendar.js";
import type { DprTemporalContext } from "./temporalContext.js";

/** The registration-window classification for an IP course. */
export type IpChangeWindow =
    /** Future term (pre-registered) — freely changeable planning. */
    | "future"
    /** Current term, still inside add/drop — changeable. */
    | "add_drop"
    /** Current term, past add/drop but inside withdraw / pass-fail. */
    | "withdraw_pf"
    /** Current term, past the withdraw window (or the term is over) —
     *  effectively locked, will receive its letter grade. */
    | "closed"
    /** Current term but the calendar has no sourced dates for it — fall
     *  back to a generic hedge. */
    | "unknown";

export interface IpChangeabilityResult {
    /** Which registration window the IP course is in. */
    window: IpChangeWindow;
    /** Does the planner treat this IP course as student-changeable?
     *  future / add_drop / withdraw_pf / unknown → true; closed → false.
     *  ("unknown" stays editable-with-a-hedge — we don't lock a course
     *  just because we lack its dates; we hedge instead.) */
    editable: boolean;
    /** A "verify with your adviser" hedge to surface, when one applies.
     *  Absent for a freely-changeable FUTURE term. */
    hedge?: string;
    /** A short machine/debug rationale for why this window was chosen. */
    rationale: string;
}

export interface ClassifyIpChangeabilityArgs {
    /** The IP course's term, in any recognized shape ("2026 Fall",
     *  "2026-fall", "Fall 2026"). */
    ipTerm: string;
    /** The derived temporal context (deriveTemporalContext): tells us the
     *  wall-clock currentTerm, the student's enrolledNowTerm, and the
     *  preRegisteredTerms (future). */
    temporalContext: DprTemporalContext;
    /** The campus whose registration windows govern this course. */
    campus: Campus;
    /** The academic-calendar config (inject a fixture in tests). */
    calendar: AcademicCalendar;
    /** "Today" — defaults to new Date(). Injected in tests. */
    now?: Date;
}

// ⚑ Every current-term hedge below conveys that the deadline we used is
// NYU's TYPICAL deadline for that season and the EXACT date shifts each
// year — so the student must confirm it with their adviser/registrar and
// nothing is official until their next DPR. We never present these as a
// specific year's official dates.

const WITHDRAW_PF_HEDGE =
    "You appear to be past the add/drop window for this term, so you can't simply " +
    "drop it: you could WITHDRAW (a \"W\" appears on your transcript and does NOT " +
    "fulfill the requirement) or, where your school allows, switch to PASS/FAIL " +
    "(which may not satisfy a letter-grade major requirement). Note I'm using NYU's " +
    "TYPICAL deadlines for this season — the exact dates shift each year — so " +
    "confirm the precise withdrawal deadline (and whether a W or P/F still satisfies " +
    "your specific requirement) with your adviser/registrar; nothing is official " +
    "until it shows on a new DPR.";

const CLOSED_HEDGE =
    "Based on NYU's TYPICAL deadlines for this season, the add/drop and withdrawal " +
    "windows for this term have passed, so this course is effectively locked — it " +
    "will receive its letter grade. Because the exact deadline shifts each year, " +
    "confirm the precise date with your adviser/registrar (and, if you believe you " +
    "have grounds for a late drop, the options) — nothing changes until it shows on " +
    "a new DPR.";

const GENERIC_HEDGE =
    "Whether this course can still be changed depends on this season's registrar " +
    "deadlines (add/drop and withdrawal). I'm working from NYU's TYPICAL seasonal " +
    "deadlines, which shift each year and which I can't pin down for your specific " +
    "campus and term — verify the exact dates with your adviser/registrar, and note " +
    "nothing is official until it shows on a new DPR.";

/** A season-specific clause appended to a current-term hedge when extra
 *  uncertainty applies. Summer runs many overlapping sub-sessions
 *  (12-week, 10-week, 6-week, …) each with its OWN deadlines, so a single
 *  typical date is especially unreliable — flag that explicitly. */
const SUMMER_EXTRA_CLAUSE =
    " (Summer is especially uncertain: it runs several overlapping sub-sessions, " +
    "each with its own add/drop and withdrawal deadlines, so the typical date above " +
    "may not match your specific summer session — check that session's deadlines.)";

/** Append the summer extra-uncertainty clause to a hedge when the season
 *  is summer; otherwise return the hedge unchanged. */
function withSeasonClause(hedge: string, season: Season | null): string {
    return season === "summer" ? hedge + SUMMER_EXTRA_CLAUSE : hedge;
}

/** Extract the 4-digit YEAR from a term string ("2027 Fall", "2027-fall",
 *  "Fall 2027"). Returns null when no 4-digit year is present (the caller
 *  then hedges rather than guess). */
function yearOfTerm(term: string): number | null {
    const m = normalizeCalendarTermKey(term).match(/(\d{4})/);
    return m ? +m[1]! : null;
}

/** Stamp a year onto a year-agnostic "MM-DD" month-day string to build a
 *  concrete UTC-midnight Date (so comparisons are timezone-stable).
 *  Returns null when the year or month-day is missing/malformed. */
function monthDayToUTCDate(year: number | null, monthDay: string | undefined): Date | null {
    if (year === null || !monthDay) return null;
    const m = monthDay.match(/^(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Date.UTC(year, +m[1]! - 1, +m[2]!));
}

/** Is the IP course's term the student's CURRENT (enrolled-now) term?
 *  Prefer the DPR-grounded enrolledNowTerm; fall back to the wall-clock
 *  currentTerm. Compared on normalized keys so shapes don't matter. */
function isCurrentTerm(ipTerm: string, ctx: DprTemporalContext): boolean {
    const key = normalizeCalendarTermKey(ipTerm);
    const enrolledKey = ctx.enrolledNowTerm
        ? normalizeCalendarTermKey(ctx.enrolledNowTerm)
        : undefined;
    if (enrolledKey) return key === enrolledKey;
    // No enrolledNowTerm derived — fall back to wall-clock currentTerm.
    const currentKey = ctx.currentTerm
        ? normalizeCalendarTermKey(ctx.currentTerm)
        : undefined;
    return currentKey !== undefined && key === currentKey;
}

/** Is the IP course's term in the FUTURE (pre-registered)? It's future
 *  if the temporal context lists it among preRegisteredTerms. */
function isPreRegisteredTerm(ipTerm: string, ctx: DprTemporalContext): boolean {
    const key = normalizeCalendarTermKey(ipTerm);
    return (ctx.preRegisteredTerms ?? [])
        .map((t) => normalizeCalendarTermKey(t))
        .includes(key);
}

/**
 * Classify how changeable an IP course is. Pure — `now` + `calendar` are
 * injected so the result is fully deterministic in tests.
 *
 * Decision order:
 *   1. Future (pre-registered) term → "future" (editable, no hedge).
 *   2. Current term → derive the SEASON + YEAR, stamp the year onto the
 *      season's TYPICAL "MM-DD" windows to build concrete dates, then:
 *        season unrecognized          → "unknown" (editable + generic hedge):
 *          a literal "winter" / unknown season → seasonOfTerm returns null,
 *          so we hedge rather than guess a pattern.
 *        no usable dates              → "unknown" (editable + generic hedge)
 *        now ≤ stamped add/drop date  → "add_drop" (editable, no hedge)
 *        now ≤ stamped withdraw date  → "withdraw_pf" (editable + W/PF hedge)
 *        past add/drop, no withdraw   → "unknown" (editable + generic hedge):
 *          without the withdraw date we CANNOT know the window has closed,
 *          so we hedge rather than falsely lock.
 *        now > stamped withdraw date  → "closed" (NOT editable + closed hedge)
 *      Every current-term hedge conveys the dates are NYU's TYPICAL seasonal
 *      deadlines (they shift each year); a SUMMER course appends an extra
 *      "summer has many sub-sessions" uncertainty clause.
 *   3. Neither future nor current (a past / stale IP row) → "closed".
 */
export function classifyIpChangeability(
    args: ClassifyIpChangeabilityArgs,
): IpChangeabilityResult {
    const { ipTerm, temporalContext, campus, calendar } = args;
    const now = args.now ?? new Date();

    // 1. A future / pre-registered term is freely changeable planning.
    //    Checked BEFORE isCurrentTerm — safe because deriveTemporalContext
    //    builds preRegisteredTerms by EXCLUDING the enrolledNow term, so the
    //    two sets are disjoint (a term is never both). If a future caller
    //    hand-builds a temporalContext that puts a term in both, "future"
    //    would win (editable, no window check) — keep the sets disjoint.
    if (isPreRegisteredTerm(ipTerm, temporalContext)) {
        return {
            window: "future",
            editable: true,
            rationale: `${ipTerm} is a pre-registered future term — freely changeable planning, no real-world registration yet.`,
        };
    }

    // 2. The current (enrolled-now) term — classify by the season's TYPICAL
    //    windows, stamped with the term's actual year.
    if (isCurrentTerm(ipTerm, temporalContext)) {
        // Derive the SEASON. An unrecognized season (a literal "winter" or
        // anything seasonOfTerm can't map) → we cannot pick a pattern, so
        // hedge rather than guess.
        const season: Season | null = seasonOfTerm(ipTerm);
        if (season === null) {
            return {
                window: "unknown",
                editable: true,
                hedge: GENERIC_HEDGE,
                rationale: `${ipTerm} is the current term but its season is unrecognized (e.g. a literal "winter") — generic hedge (we don't guess a pattern).`,
            };
        }

        // The season's TYPICAL "MM-DD" windows + the term's actual year.
        const year = yearOfTerm(ipTerm);
        const windows: SeasonWindows | undefined = getSeasonWindows(campus, season, calendar);
        const addDrop = monthDayToUTCDate(year, windows?.addDropMonthDay);
        const withdraw = monthDayToUTCDate(year, windows?.withdrawMonthDay);

        // No usable dates → generic hedge (never guess). Covers a missing
        // year, a campus with no entry for this season, and a season whose
        // pattern omits both windows.
        if (!addDrop && !withdraw) {
            return {
                window: "unknown",
                editable: true,
                hedge: withSeasonClause(GENERIC_HEDGE, season),
                rationale: `${ipTerm} is the current term but no usable add/drop or withdrawal dates could be built for campus "${campus}" / season "${season}" — generic hedge.`,
            };
        }

        // Within add/drop (inclusive of the typical deadline day).
        if (addDrop && now.getTime() <= addDrop.getTime()) {
            return {
                window: "add_drop",
                editable: true,
                rationale: `${ipTerm} is the current term and today is on or before the season's typical add/drop deadline (${windows!.addDropMonthDay} → ${year}) — changeable.`,
            };
        }

        // Past add/drop, within the withdraw / pass-fail window.
        if (withdraw && now.getTime() <= withdraw.getTime()) {
            return {
                window: "withdraw_pf",
                editable: true,
                hedge: withSeasonClause(WITHDRAW_PF_HEDGE, season),
                rationale: `${ipTerm} is the current term, past the typical add/drop date but on or before the season's typical withdrawal deadline (${windows!.withdrawMonthDay} → ${year}) — withdraw / pass-fail only.`,
            };
        }

        // Past add/drop but we have NO withdrawal date for this season. We
        // CANNOT know we're past the withdraw window without that date —
        // locking here would be a FALSE certainty. Fall back to the generic
        // hedge (editable-with-a-hedge) rather than assert "closed". We only
        // ever return "closed" when we have a withdrawal date and are past
        // it (the branch below).
        if (!withdraw) {
            return {
                window: "unknown",
                editable: true,
                hedge: withSeasonClause(GENERIC_HEDGE, season),
                rationale: `${ipTerm} is the current term and today is past the season's typical add/drop date (${windows!.addDropMonthDay} → ${year}), but no withdrawal date is on file for season "${season}" — we can't confirm the withdraw window has closed, so generic hedge (not locked).`,
            };
        }

        // We HAVE a withdrawal date and today is past it → effectively
        // locked (the course will receive its letter grade). Still hedged:
        // the date is the season's TYPICAL deadline and shifts each year.
        return {
            window: "closed",
            editable: false,
            hedge: withSeasonClause(CLOSED_HEDGE, season),
            rationale: `${ipTerm} is the current term and today is past the season's typical withdrawal deadline (${windows!.withdrawMonthDay} → ${year}) — effectively locked (will receive its letter grade).`,
        };
    }

    // 3. Neither future nor current: a past / stale IP row. The term is
    //    over; treat it as closed (will receive / has received its grade).
    return {
        window: "closed",
        editable: false,
        hedge: CLOSED_HEDGE,
        rationale: `${ipTerm} is neither the current term nor a pre-registered future term — a past/stale IP row, effectively closed.`,
    };
}
