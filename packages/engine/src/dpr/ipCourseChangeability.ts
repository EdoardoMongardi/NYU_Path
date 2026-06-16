// ============================================================
// IP-course changeability classifier (F3 — IP-course temporal model)
// ============================================================
// A pure, node-testable classifier that decides how changeable an
// IN-PROGRESS (IP) course is, per owner decision #2 of the Phase-4
// pre-merge follow-ups (Docs/plans/34-2026-06-16-phase4-pre-merge-
// followups.md). The changeability of an IP course depends on its TERM
// relative to today + that campus/term's real NYU registration windows:
//
//   - A final grade on the DPR → LOCKED (absolute). That is handled
//     upstream by `slot.kind === "completed"`; this classifier only sees
//     IP rows.
//   - IP course in a FUTURE term (pre-registered) → "future": freely
//     changeable. It is pure planning — there is no real-world
//     registration to undo yet. No hedge.
//   - IP course in the CURRENT term → classify by the registration
//     windows:
//       · within add/drop                → "add_drop": changeable.
//       · within withdraw / pass-fail    → "withdraw_pf": can WITHDRAW (a
//         "W" lands on the transcript and does NOT fulfill the
//         requirement) or switch to PASS/FAIL (P/F may not satisfy a
//         letter-grade major rule). Surfaced as options WITH a
//         "verify with your adviser" hedge.
//       · after those windows            → "closed": effectively locked
//         (it will receive its letter grade) + hedge.
//       · dates missing for that term    → "unknown": a GENERIC hedge.
//   - A past / stale IP row (the term is already over) → "closed".
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
    getTermWindows,
    normalizeCalendarTermKey,
    type AcademicCalendar,
    type Campus,
    type TermWindows,
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

const WITHDRAW_PF_HEDGE =
    "Past add/drop for this term, so you can't simply drop it: you could WITHDRAW " +
    "(a \"W\" appears on your transcript and does NOT fulfill the requirement) or, " +
    "where your school allows, switch to PASS/FAIL (which may not satisfy a " +
    "letter-grade major requirement). I can't confirm whether a W or P/F still " +
    "satisfies your specific requirement — verify with your adviser, and note " +
    "nothing is official until it shows on a new DPR.";

const CLOSED_HEDGE =
    "The add/drop and withdrawal windows for this term have closed, so this course " +
    "is effectively locked — it will receive its letter grade. If you believe you " +
    "have grounds for a late drop, verify the options with your adviser; nothing " +
    "changes until it shows on a new DPR.";

const GENERIC_HEDGE =
    "Whether this course can still be changed depends on this term's registrar " +
    "deadlines (add/drop and withdrawal), which I don't have on file for your " +
    "campus and term — verify with your adviser, and note nothing is official " +
    "until it shows on a new DPR.";

/** Parse "YYYY-MM-DD" as a UTC midnight Date (so comparisons are
 *  timezone-stable). Returns null on a malformed string. */
function parseISODateUTC(s: string | undefined): Date | null {
    if (!s) return null;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
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
 *   2. Current term → consult the calendar windows:
 *        no windows / no dates       → "unknown" (editable + generic hedge)
 *        now ≤ addDropDeadline        → "add_drop" (editable, no hedge)
 *        now ≤ withdrawDeadline       → "withdraw_pf" (editable + W/PF hedge)
 *        past add/drop, no withdraw   → "unknown" (editable + generic hedge):
 *          without the withdraw date we CANNOT know the window has closed,
 *          so we hedge rather than falsely lock.
 *        now > withdrawDeadline       → "closed" (NOT editable + closed hedge)
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

    // 2. The current (enrolled-now) term — classify by the windows.
    if (isCurrentTerm(ipTerm, temporalContext)) {
        const windows: TermWindows | undefined = getTermWindows(campus, ipTerm, calendar);
        const addDrop = parseISODateUTC(windows?.addDropDeadline);
        const withdraw = parseISODateUTC(windows?.withdrawDeadline);

        // No usable dates → generic hedge (never guess).
        if (!addDrop && !withdraw) {
            return {
                window: "unknown",
                editable: true,
                hedge: GENERIC_HEDGE,
                rationale: `${ipTerm} is the current term but no add/drop or withdrawal dates are on file for campus "${campus}" — generic hedge.`,
            };
        }

        // Within add/drop (inclusive of the deadline day).
        if (addDrop && now.getTime() <= addDrop.getTime()) {
            return {
                window: "add_drop",
                editable: true,
                rationale: `${ipTerm} is the current term and today is on or before the add/drop deadline (${windows!.addDropDeadline}) — changeable.`,
            };
        }

        // Past add/drop, within the withdraw / pass-fail window.
        if (withdraw && now.getTime() <= withdraw.getTime()) {
            return {
                window: "withdraw_pf",
                editable: true,
                hedge: WITHDRAW_PF_HEDGE,
                rationale: `${ipTerm} is the current term, past add/drop but on or before the withdrawal deadline (${windows!.withdrawDeadline}) — withdraw / pass-fail only.`,
            };
        }

        // Past add/drop but we have NO withdrawal date on file. We CANNOT
        // know we're past the withdraw window without that date — locking
        // here would be a FALSE certainty. Fall back to the generic hedge
        // (editable-with-a-hedge) rather than assert "closed". We only
        // ever return "closed" when we have a withdrawal date and are past
        // it (the branch below).
        if (!withdraw) {
            return {
                window: "unknown",
                editable: true,
                hedge: GENERIC_HEDGE,
                rationale: `${ipTerm} is the current term and today is past the add/drop deadline (${windows!.addDropDeadline}), but no withdrawal date is on file for campus "${campus}" — we can't confirm the withdraw window has closed, so generic hedge (not locked).`,
            };
        }

        // We HAVE a withdrawal date and today is past it → effectively
        // locked (the course will receive its letter grade).
        return {
            window: "closed",
            editable: false,
            hedge: CLOSED_HEDGE,
            rationale: `${ipTerm} is the current term and today is past the withdrawal deadline (${windows!.withdrawDeadline}) — effectively locked (will receive its letter grade).`,
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
