// ============================================================
// Academic-calendar config (F3 — IP-course temporal model)
// ============================================================
// The OWNER-CORRECTABLE source of truth for NYU's per-campus, per-term
// registration windows: term start · add/drop deadline · withdraw
// deadline. The IP-changeability classifier (./ipCourseChangeability.ts)
// reads this map to decide whether a CURRENT-term in-progress course is
// still inside add/drop, inside the withdraw / pass-fail window, or
// effectively locked — and to surface the honest, verification-grounded
// state in the UI + the agent's grounding.
//
// ⚑ NEVER INVENT DATES (binding, core_philosophy.md). Every date here is
// SOURCED from NYU's official registrar/academic calendar and CITED in a
// comment. A term/campus we could NOT reliably source is left ABSENT
// (fields omitted) — the classifier then falls back to a GENERIC HEDGE
// ("changes depend on this term's registrar deadlines — verify with your
// adviser"). We never guess a date to fill a gap.
//
// ⚑ OWNER: verify / correct / extend. Dates change every year and are
// session-dependent (a 6-week summer course has different deadlines than
// the 12-week session). The values below are the STANDARD full-term
// session for each campus. Re-check every academic year against the
// registrar before relying on them. The DATA is intentionally separate
// from the LOGIC (the classifier in ipCourseChangeability.ts is pure and
// reads whatever this map provides).
//
// DEFERRED (own task, not in this pass): the precise requirement-engine
// modeling of W / pass-fail → requirement satisfaction (does a W satisfy
// rule R? does P/F satisfy a letter-grade major rule?). Until then the
// classifier HEDGES that impact rather than computing it — see the
// W/PF hedge in ipCourseChangeability.ts. Do NOT wire this into the
// solver / validator.
// ============================================================

/** A campus key. Maps from a student's home school via campusForHomeSchool
 *  below: NYU Shanghai → "shanghai", NYU Abu Dhabi → "abudhabi", every
 *  other NYU school (CAS/Stern/Tandon/…) → "ny". */
export type Campus = "ny" | "shanghai" | "abudhabi";

/** An ISO calendar date string, "YYYY-MM-DD". */
export type ISODate = string;

/** The registration windows for ONE term on ONE campus. Every field is
 *  OPTIONAL: an absent field means "not sourced" → the classifier must
 *  fall back to the generic hedge (never assume a missing date). */
export interface TermWindows {
    /** First day of classes / term start. */
    termStart?: ISODate;
    /** Last day to add/drop a class WITHOUT a transcript mark (a drop
     *  before this date leaves no trace). After this date, dropping
     *  becomes a withdrawal (a "W"). */
    addDropDeadline?: ISODate;
    /** Last day to withdraw from a class (a "W" appears on the
     *  transcript; in this window a student may also elect pass/fail
     *  where the school allows it). After this date the course is
     *  effectively locked — it will receive its letter grade. */
    withdrawDeadline?: ISODate;
}

/** The full calendar: campus → normalized-term-key ("YYYY-season",
 *  lowercase season) → its windows. */
export type AcademicCalendar = Record<Campus, Record<string, TermWindows>>;

/**
 * Normalize a term string to the calendar's canonical key. Accepts the
 * DPR's "2026 Fall" / "2026 Spr", the planner's "2026-fall", or the
 * inverted "Fall 2026". Returns "{year}-{season}" lowercased.
 *
 * Mirrors apps/web/lib/groupCoursesByTerm.ts:normalizeTermKey so the
 * engine + web agree on the key shape; kept local to avoid a web↔engine
 * dependency. NOTE: this engine copy additionally canonicalizes
 * `winter`/`win` → "winter"; the web `normalizeTermKey` does NOT (a
 * pre-existing web gap). The classifier uses only this engine normalizer,
 * and the calendar has no winter terms, so F3 is unaffected — but if a
 * Winter/J-term IP ever appears, reconcile the web normalizer too.
 */
export function normalizeCalendarTermKey(term: string): string {
    const SEASON_CANON: Record<string, string> = {
        january: "january",
        "j-term": "january",
        jterm: "january",
        winter: "winter",
        win: "winter",
        spring: "spring",
        spr: "spring",
        summer: "summer",
        sum: "summer",
        fall: "fall",
        fa: "fall",
    };
    const dash = term.match(/^(\d{4})-([a-z-]+)$/i);
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

/** Map a student's home-school id to a calendar campus. Only NYU
 *  Shanghai + NYU Abu Dhabi have their own registrar calendar; every
 *  other school sits on the New York campus calendar. */
export function campusForHomeSchool(homeSchool: string | undefined): Campus {
    switch ((homeSchool ?? "").toLowerCase()) {
        case "shanghai":
            return "shanghai";
        case "nyuad":
        case "abudhabi":
        case "abu_dhabi":
            return "abudhabi";
        default:
            return "ny";
    }
}

// ============================================================
// THE SOURCED DATA (owner-correctable)
// ============================================================
// Today is 2026-06-16 (Summer 2026), so a current student's DPR shows IP
// rows for roughly Summer 2026, Fall 2026, and Spring 2027. We source the
// NEW YORK campus standard full-term session for those terms below.
//
// SOURCE (NYU-official): NYU Computer Science Department academic
// calendar, which republishes the NYU Office of the Registrar dates:
//   https://cs.nyu.edu/dynamic/calendar/undergraduate/
// Cross-checked against the NYU Bulletins academic calendar
// (https://bulletins.nyu.edu/nyu/academic-calendar/) for term starts and
// the registrar landing page
// (https://www.nyu.edu/registrar/calendars).
//
// ⚑ OWNER: the registrar publishes session-specific deadlines (12-week,
// 6-week, etc.) that this STANDARD-session map flattens. For a summer
// course the student should confirm the deadline for THEIR session — the
// classifier already hedges current-term conclusions, but verify before
// extending this with summer sub-session granularity.

export const NYU_ACADEMIC_CALENDAR: AcademicCalendar = {
    ny: {
        // Summer 2026 — classes begin 2026-05-18 (12-week / multi-session).
        //   Source: cs.nyu.edu undergraduate calendar — "Summer 2026
        //   Classes Begin: 12-Week, 10-Week, 7-Week, First 6-Week, …".
        // ⚑ add/drop + withdraw deadlines are SESSION-DEPENDENT and NOT
        // published as a single full-term value we can rely on → left
        // ABSENT so the classifier uses the GENERIC HEDGE for a Summer-2026
        // current-term course. Do NOT invent these.
        "2026-summer": {
            termStart: "2026-05-18",
            // addDropDeadline: ⚑ owner: fill from the registrar for the
            //   student's specific summer session (absent → generic hedge).
            // withdrawDeadline: ⚑ owner: fill per session (absent → hedge).
        },
        // Fall 2026 — FULLY SOURCED (standard 15-week session).
        //   Source: cs.nyu.edu undergraduate calendar:
        //     "Fall 2026 Classes Begin"        → 2026-09-02
        //     "Fall 2026 Drop/Add Deadline"    → 2026-09-15
        //     "Fall 2026 Withdrawal Period Begins" → 2026-09-16
        //     "Fall 2026 Withdrawal Deadline"  → 2026-11-26
        "2026-fall": {
            termStart: "2026-09-02",
            addDropDeadline: "2026-09-15",
            withdrawDeadline: "2026-11-26",
        },
        // Spring 2027 — term start SOURCED; deadlines NOT YET published.
        //   Source: bulletins.nyu.edu academic calendar — "Spring 2027
        //   classes begin" → 2027-01-19. The Drop/Add + Withdrawal
        //   deadlines were NOT present on the sourced pages at authoring
        //   time → left ABSENT (generic hedge for a Spring-2027 current
        //   term course). ⚑ owner: fill once the registrar publishes them.
        "2027-spring": {
            termStart: "2027-01-19",
            // addDropDeadline: ⚑ owner: fill from the registrar (absent → hedge).
            // withdrawDeadline: ⚑ owner: fill from the registrar (absent → hedge).
        },
    },
    // ⚑ NEEDS-FILL: NYU Shanghai runs its own academic calendar
    // (https://shanghai.nyu.edu/academics/calendar). We did NOT reliably
    // source its Summer-2026 / Fall-2026 / Spring-2027 add-drop / withdraw
    // deadlines at authoring time, so it is left EMPTY → every Shanghai
    // current-term course gets the GENERIC HEDGE. Owner: add the sourced
    // dates here (same shape as `ny`) and cite the URL. Do NOT copy NY's
    // dates — Shanghai's term boundaries differ.
    shanghai: {},
    // ⚑ NEEDS-FILL: NYU Abu Dhabi runs its own academic calendar
    // (https://students.nyuad.nyu.edu/academics/registration/academic-calendar/).
    // Not reliably sourced at authoring time → EMPTY → generic hedge for
    // every Abu Dhabi current-term course. Owner: add the sourced dates
    // here and cite the URL. Do NOT copy NY's dates.
    abudhabi: {},
};

/**
 * Look up the registration windows for a campus + term. Returns the
 * sourced {@link TermWindows} (which may itself have absent fields), or
 * `undefined` when the campus/term pair has no entry at all (→ the
 * classifier must use the generic hedge). Pure: pass a `calendar` to
 * override the bundled {@link NYU_ACADEMIC_CALENDAR} (tests inject
 * fixtures this way).
 */
export function getTermWindows(
    campus: Campus,
    term: string,
    calendar: AcademicCalendar = NYU_ACADEMIC_CALENDAR,
): TermWindows | undefined {
    const byTerm = calendar[campus];
    if (!byTerm) return undefined;
    return byTerm[normalizeCalendarTermKey(term)];
}
