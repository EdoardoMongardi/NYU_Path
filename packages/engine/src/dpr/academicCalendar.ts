// ============================================================
// Academic-calendar config (F3 — IP-course temporal model)
// ============================================================
// The OWNER-CORRECTABLE source of TYPICAL per-SEASON registration windows
// for NYU: term start · add/drop deadline · withdraw deadline. The
// IP-changeability classifier (./ipCourseChangeability.ts) reads this map
// to decide whether a CURRENT-term in-progress course is still inside
// add/drop, inside the withdraw / pass-fail window, or effectively
// locked — and to surface the honest, verification-grounded state in the
// UI + the agent's grounding.
//
// ⚑ TYPICAL, NOT EXACT (binding, core_philosophy.md). These are NOT a
// specific year's officially-published dates. Instead we hold ONE TYPICAL
// date-set PER SEASON (fall · spring · summer · january/J-term) that we
// ASSUME applies EVERY year, expressed as year-agnostic MONTH-DAY strings.
// The classifier stamps the IP term's actual YEAR onto the season pattern
// to build a concrete date, then ALWAYS HEDGES the conclusion ("this is
// NYU's typical deadline for this season — the exact date shifts each
// year, verify with your adviser/registrar; nothing is official until your
// next DPR"). We are NOT inventing exact-year certainty — we hold a
// typical pattern and we never drop the hedge.
//
// SEASON PATTERNS (the values below):
//   - fall / spring are ANCHORED to NYU's recently-published dates and are
//     a reliable typical pattern. Representative source: the NYU Office of
//     the Registrar dates as republished by the NYU Computer Science
//     department academic calendar (https://cs.nyu.edu/dynamic/calendar/
//     undergraduate/), cross-checked against the NYU Bulletins academic
//     calendar (https://bulletins.nyu.edu/nyu/academic-calendar/).
//   - summer / january (J-term) are REASONABLE ESTIMATES, not anchored to
//     a single published value: summer has many overlapping sub-sessions
//     (12-week, 10-week, 6-week, …) each with its own deadlines, and the
//     J-term is a ~3-week intensive — so these are ESPECIALLY approximate
//     and the classifier flags that extra uncertainty.
//
// ⚑ DATA SEPARATE FROM LOGIC. The classifier in ipCourseChangeability.ts
// is pure and reads whatever this map provides. An owner may override the
// per-season pattern PER CAMPUS or, in future, layer a per-year exception
// on top — without touching the classifier.
//
// ⚑ OWNER: per-campus refinement. NYU Shanghai and NYU Abu Dhabi run
// genuinely different academic calendars (their term boundaries and
// deadlines do NOT match New York's). For now all three campuses reference
// the SAME assumed defaults (DEFAULT_SEASON_WINDOWS below) so the model is
// usable everywhere with an honest hedge; an owner SHOULD override the
// shanghai / abudhabi entries with their real registrar patterns when
// available (and may cite the URL). Do NOT silently copy NY's exact dates
// as if they were Shanghai's / Abu Dhabi's truth.
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

/** A season of the NYU academic year. `january` is the J-term — a ~3-week
 *  intensive in January (NYU's J-term IS January; we do NOT model a
 *  separate "winter"). */
export type Season = "fall" | "spring" | "summer" | "january";

/** A year-agnostic month-day string, "MM-DD" (e.g. "09-15"). The classifier
 *  stamps the IP term's actual year onto this to build a concrete date. */
export type MonthDay = string;

/** The TYPICAL registration windows for ONE season, assumed to apply every
 *  year, as year-agnostic MONTH-DAY strings. Every field is OPTIONAL: an
 *  absent field means "no typical pattern on file for this window" → the
 *  classifier hedges rather than assume a date. */
export interface SeasonWindows {
    /** First day of classes / term start, "MM-DD". */
    termStartMonthDay?: MonthDay;
    /** Last day to add/drop a class WITHOUT a transcript mark (a drop
     *  before this date leaves no trace), "MM-DD". After this date,
     *  dropping becomes a withdrawal (a "W"). */
    addDropMonthDay?: MonthDay;
    /** Last day to withdraw from a class (a "W" appears on the transcript;
     *  in this window a student may also elect pass/fail where the school
     *  allows it), "MM-DD". After this date the course is effectively
     *  locked — it will receive its letter grade. */
    withdrawMonthDay?: MonthDay;
}

/** The full calendar: campus → season → its TYPICAL windows. */
export type AcademicCalendar = Record<Campus, Record<Season, SeasonWindows>>;

// ============================================================
// THE ASSUMED PER-SEASON PATTERNS (owner-correctable)
// ============================================================
// One typical date-set per season, ASSUMED to apply every year. fall /
// spring anchored to NYU's recently-published dates; summer / january are
// reasonable estimates (see the header note). These are TYPICAL patterns,
// never an exact year's official dates — the classifier always hedges.
export const DEFAULT_SEASON_WINDOWS: Record<Season, SeasonWindows> = {
    // Fall — anchored to NYU's recently-published Fall dates (cs.nyu.edu /
    // bulletins.nyu.edu): classes begin early September, drop/add mid
    // September, withdrawal deadline late November.
    fall: {
        termStartMonthDay: "09-02",
        addDropMonthDay: "09-15",
        withdrawMonthDay: "11-26",
    },
    // Spring — anchored to NYU's recently-published Spring dates: classes
    // begin late January, drop/add early February, withdrawal early April.
    spring: {
        termStartMonthDay: "01-22",
        addDropMonthDay: "02-04",
        withdrawMonthDay: "04-03",
    },
    // Summer — REASONABLE ESTIMATE for a TYPICAL full-summer session.
    // Summer has many overlapping sub-sessions, each with its own
    // deadlines, so this single pattern is ESPECIALLY approximate; the
    // classifier flags that extra uncertainty in its hedge.
    summer: {
        termStartMonthDay: "05-27",
        addDropMonthDay: "06-02",
        withdrawMonthDay: "07-15",
    },
    // January (J-term) — REASONABLE ESTIMATE for the ~3-week intensive.
    // Approximate: the intensive's short calendar compresses the windows.
    january: {
        termStartMonthDay: "01-02",
        addDropMonthDay: "01-06",
        withdrawMonthDay: "01-15",
    },
};

// All three campuses reference the SAME assumed defaults for now. ⚑ OWNER:
// NYU Shanghai / Abu Dhabi calendars genuinely differ — override these per
// campus with the real registrar patterns when available (do NOT treat the
// shared NY-anchored defaults as those campuses' truth).
export const NYU_ACADEMIC_CALENDAR: AcademicCalendar = {
    ny: DEFAULT_SEASON_WINDOWS,
    shanghai: DEFAULT_SEASON_WINDOWS,
    abudhabi: DEFAULT_SEASON_WINDOWS,
};

/**
 * Normalize a term string to the calendar's canonical key. Accepts the
 * DPR's "2026 Fall" / "2026 Spr", the planner's "2026-fall", or the
 * inverted "Fall 2026". Returns "{year}-{season}" lowercased.
 *
 * Mirrors apps/web/lib/groupCoursesByTerm.ts:normalizeTermKey so the
 * engine + web agree on the key shape; kept local to avoid a web↔engine
 * dependency. NOTE: this engine copy additionally canonicalizes
 * `winter`/`win` → "winter"; the web `normalizeTermKey` does NOT (a
 * pre-existing web gap). `seasonOfTerm` (below) maps a normalized "winter"
 * to `null` + a hedge — NYU's J-term IS January, so we do NOT silently
 * fold winter into january.
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

/**
 * Extract the {@link Season} from a term string. Normalizes the term, then
 * maps the season token to a Season. Returns `null` when the season can't
 * be recognized (the caller then hedges rather than guess).
 *
 * Aliases are folded by `normalizeCalendarTermKey`: `j-term`/`jterm` →
 * "january". A normalized "winter" is mapped to `null` ON PURPOSE: NYU's
 * winter intersession IS the January J-term, but the DPR/planner do not
 * emit "winter" for it (they emit "january"/"jterm"), so an actual literal
 * "winter" token is ambiguous/unexpected — we return `null` so the
 * classifier hedges instead of silently treating it as J-term.
 */
export function seasonOfTerm(term: string): Season | null {
    const key = normalizeCalendarTermKey(term);
    const m = key.match(/^\d{4}-([a-z-]+)$/);
    const season = (m ? m[1]! : key).toLowerCase();
    switch (season) {
        case "fall":
            return "fall";
        case "spring":
            return "spring";
        case "summer":
            return "summer";
        case "january":
            return "january";
        // "winter" and anything else → unrecognized → hedge.
        default:
            return null;
    }
}

/** Map a student's home-school id to a calendar campus. Only NYU
 *  Shanghai + NYU Abu Dhabi have their own registrar calendar; every
 *  other school sits on the New York campus calendar. (All three campuses
 *  currently share DEFAULT_SEASON_WINDOWS — see the header note.) */
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

/**
 * Look up the TYPICAL registration windows for a campus + season. Returns
 * the season's {@link SeasonWindows} (which may itself have absent fields),
 * or `undefined` when the campus has no entry for that season at all (→ the
 * classifier hedges). Pure: pass a `calendar` to override the bundled
 * {@link NYU_ACADEMIC_CALENDAR} (tests inject fixtures this way).
 */
export function getSeasonWindows(
    campus: Campus,
    season: Season,
    calendar: AcademicCalendar = NYU_ACADEMIC_CALENDAR,
): SeasonWindows | undefined {
    const byCampus = calendar[campus];
    if (!byCampus) return undefined;
    return byCampus[season];
}
