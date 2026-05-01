// ============================================================
// Temporal context derivation (Phase 7-E + Phase 8 calendar fix)
// ============================================================
// Two related concerns the agent needs solved before it can answer
// "what should I take next semester" or "am I currently in X":
//
//   (1) What term IS IT today, in real wall-clock time?
//       — Comes from the system clock + the NYU academic calendar.
//
//   (2) What term is the student CURRENTLY ENROLLED in (vs.
//       pre-registered for)?
//       — Comes from the DPR's IP rows.
//
// The pre-Phase-8 implementation collapsed (1) and (2) by always
// taking the LATEST IP row as "currentTerm". That broke for students
// who had pre-registered for the next semester: a senior in
// Spring 2026 who has registered for Fall 2026 has TWO IP terms in
// their DPR, and "latest" picked Fall 2026 — making "next semester"
// resolve to Spring 2027, skipping Fall 2026 entirely.
//
// Fix: bring (1) into play. The clock tells us what term is in
// session right now; we then choose the IP-row term that matches
// (or is closest to) that wall-clock term.
// ============================================================

import type { DegreeProgressReport } from "./schema.js";

const TERM_TOKEN_TO_LABEL: Record<string, string> = {
    "Spr": "Spring",
    "Spring": "Spring",
    "Sum": "Summer",
    "Summer": "Summer",
    "Fall": "Fall",
    "Fa": "Fall",
    "Win": "Winter",
    "Winter": "Winter",
    "J-Term": "January",
    "JTerm": "January",
};

const SEASON_ORDER = ["Spring", "Summer", "Fall", "Winter", "January"] as const;

/** Parse a PeopleSoft-style term ("2026 Fall", "2026 Spr") into
 *  {year, season} or null if unparseable. */
function parseTerm(s: string): { year: number; season: typeof SEASON_ORDER[number] } | null {
    const trimmed = s.trim();
    // Try "<year> <season>" first (PeopleSoft canonical).
    let m = trimmed.match(/^(\d{4})\s+([A-Za-z-]+)$/);
    let year: number, raw: string;
    if (m) {
        year = parseInt(m[1]!, 10);
        raw = m[2]!;
    } else {
        // Try "<season> <year>" (display form).
        m = trimmed.match(/^([A-Za-z-]+)\s+(\d{4})$/);
        if (!m) return null;
        raw = m[1]!;
        year = parseInt(m[2]!, 10);
    }
    const normalized = TERM_TOKEN_TO_LABEL[raw];
    if (!normalized) return null;
    if (!SEASON_ORDER.includes(normalized as typeof SEASON_ORDER[number])) return null;
    return { year, season: normalized as typeof SEASON_ORDER[number] };
}

function termToLabel(t: { year: number; season: typeof SEASON_ORDER[number] }): string {
    return `${t.season} ${t.year}`;
}

/** Compute the immediately-following NYU term. NYU's primary calendar
 *  is Fall → Spring → Summer (most students skip Summer). For agent-
 *  facing "next semester" we advance Fall→Spring, Spring→Fall (skipping
 *  Summer by default — students treat Spring's "next" as the following
 *  Fall, not Summer). Summer→Fall. Winter/January→Spring. */
function nextTermAfter(t: { year: number; season: typeof SEASON_ORDER[number] }): { year: number; season: typeof SEASON_ORDER[number] } {
    switch (t.season) {
        case "Fall":    return { year: t.year + 1, season: "Spring" };
        case "Spring":  return { year: t.year, season: "Fall" };
        case "Summer":  return { year: t.year, season: "Fall" };
        case "Winter":  return { year: t.year, season: "Spring" };
        case "January": return { year: t.year, season: "Spring" };
    }
}

/** Map a calendar date → the NYU term in session at that date.
 *
 *  NYU's published academic calendar (https://www.nyu.edu/registrar/calendars):
 *    Spring  ~Jan 20 → mid-May          → "Spring <year>"
 *    Summer  late May → mid-August      → "Summer <year>"
 *    Fall    early September → mid-Dec  → "Fall <year>"
 *    (J-term/Winter: late Dec → mid-Jan, treated as bridging into the next Spring)
 *
 *  Boundaries chosen to match NYU's "term has begun" rather than the
 *  first day of classes — students think of August registration as
 *  "Fall registration" even though classes haven't started yet. */
export function termInSession(now: Date): { year: number; season: typeof SEASON_ORDER[number] } {
    const m = now.getUTCMonth() + 1; // 1..12
    const y = now.getUTCFullYear();
    if (m >= 1 && m <= 5) {
        // Jan 1 → May 31 = Spring (J-term + late Dec questions roll
        // into Spring's planning window since registration overlaps).
        return { year: y, season: "Spring" };
    }
    if (m >= 6 && m <= 7) {
        return { year: y, season: "Summer" };
    }
    // Aug 1 → Dec 31 = Fall (registration opens in late August;
    // students asking in August about "this semester" mean Fall).
    return { year: y, season: "Fall" };
}

/** From a set of student-IP terms + the wall-clock term, pick the
 *  one that's actually IN SESSION right now. Falls back to the
 *  earliest IP-row term that is ≥ the wall-clock term (for cases
 *  where the DPR is stale and doesn't include the current term). */
function pickCurrentFromIP(
    parsed: Array<{ year: number; season: typeof SEASON_ORDER[number] }>,
    wallClock: { year: number; season: typeof SEASON_ORDER[number] },
): { year: number; season: typeof SEASON_ORDER[number] } {
    // Prefer an exact match.
    const exact = parsed.find(
        (t) => t.year === wallClock.year && t.season === wallClock.season,
    );
    if (exact) return exact;
    // No exact match: take the earliest IP-row term that's ≥ the
    // wall-clock term (the soonest term the student is registered
    // for — likely the one they're about to start).
    const sorted = parsed.slice().sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return SEASON_ORDER.indexOf(a.season) - SEASON_ORDER.indexOf(b.season);
    });
    const future = sorted.find(
        (t) => t.year > wallClock.year
            || (t.year === wallClock.year && SEASON_ORDER.indexOf(t.season) >= SEASON_ORDER.indexOf(wallClock.season)),
    );
    if (future) return future;
    // Everything is in the past — return the latest as the best
    // approximation (DPR is stale, student probably hasn't re-uploaded
    // since graduating-or-near it).
    return sorted[sorted.length - 1]!;
}

export interface DprTemporalContext {
    /** The term in session right now per the wall clock + NYU calendar
     *  (e.g. "Spring 2026" if today is April 2026). Independent of the
     *  DPR — comes from the system clock. */
    currentTerm?: string;
    /** The term immediately AFTER currentTerm — what "next semester"
     *  means in normal student speech. */
    nextTerm?: string;
    /** The student's currently-enrolled term (i.e. the IP-row term
     *  that overlaps wall-clock currentTerm). When the DPR has IP
     *  rows for FUTURE terms (pre-registration), those are
     *  reported separately in `preRegisteredTerms` so the agent can
     *  see "you're in Spring 2026 AND already registered for Fall 2026". */
    enrolledNowTerm?: string;
    /** Future-term IP rows the student has pre-registered for, in
     *  chronological order. Excludes enrolledNowTerm. */
    preRegisteredTerms?: string[];
}

export interface DeriveTemporalContextOptions {
    /** Override "now" for tests. Defaults to new Date(). */
    now?: Date;
}

/** Derive temporal context from the DPR's IP rows + wall-clock today.
 *
 *  Resolves the "I'm pre-registered for next semester but it's still
 *  this semester" ambiguity by:
 *    1. Computing termInSession(now) → the calendar truth
 *    2. Picking the IP-row term that matches (or is closest to) it
 *       as `enrolledNowTerm`
 *    3. Anything else IP-row → `preRegisteredTerms`
 *    4. `currentTerm` = wall-clock truth (NOT the latest IP row)
 *    5. `nextTerm` = wall-clock currentTerm + 1
 *
 *  Returns `currentTerm` + `nextTerm` even when the student has no IP
 *  rows (those are clock-only fields).
 */
export function deriveTemporalContext(
    dpr: DegreeProgressReport,
    options: DeriveTemporalContextOptions = {},
): DprTemporalContext {
    const now = options.now ?? new Date();
    const wallClock = termInSession(now);
    const currentTerm = termToLabel(wallClock);
    const nextTerm = termToLabel(nextTermAfter(wallClock));

    const ipRows = dpr.courseHistory.filter((r) => r.type === "IP");
    if (ipRows.length === 0) {
        return { currentTerm, nextTerm };
    }
    const parsed = ipRows
        .map((r) => parseTerm(r.term))
        .filter((t): t is NonNullable<typeof t> => t !== null);
    if (parsed.length === 0) {
        return { currentTerm, nextTerm };
    }

    const enrolledNow = pickCurrentFromIP(parsed, wallClock);
    const enrolledNowTerm = termToLabel(enrolledNow);
    const preRegisteredTerms = parsed
        .filter((t) => !(t.year === enrolledNow.year && t.season === enrolledNow.season))
        .sort((a, b) => {
            if (a.year !== b.year) return a.year - b.year;
            return SEASON_ORDER.indexOf(a.season) - SEASON_ORDER.indexOf(b.season);
        })
        // Only future-or-equal-to-wall-clock counts as pre-registered;
        // anything earlier is just stale IP from a previous session
        // (rare but possible if the DPR is months old).
        .filter(
            (t) => t.year > wallClock.year
                || (t.year === wallClock.year && SEASON_ORDER.indexOf(t.season) > SEASON_ORDER.indexOf(wallClock.season)),
        )
        .map((t) => termToLabel(t));

    return {
        currentTerm,
        nextTerm,
        enrolledNowTerm,
        ...(preRegisteredTerms.length > 0 ? { preRegisteredTerms } : {}),
    };
}

/** Normalize a free-form student-typed graduation target like "spring2027"
 *  / "Spring 2027" / "spring 27" / "fall 2026" into "Spring 2027" form. */
export function normalizeGraduationTarget(raw: string | null | undefined): string | undefined {
    if (!raw) return undefined;
    const m = raw.trim().match(/(spring|summer|fall|winter|jterm|j-term)\s*(\d{2,4})/i);
    if (!m) return undefined;
    const seasonRaw = m[1]!.toLowerCase();
    const seasonMap: Record<string, typeof SEASON_ORDER[number]> = {
        "spring": "Spring", "summer": "Summer", "fall": "Fall", "winter": "Winter",
        "jterm": "January", "j-term": "January",
    };
    const season = seasonMap[seasonRaw];
    if (!season) return undefined;
    let year = parseInt(m[2]!, 10);
    if (year < 100) year += 2000;
    return `${season} ${year}`;
}
