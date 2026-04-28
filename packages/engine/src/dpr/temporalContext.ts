// ============================================================
// DPR temporal-context derivation (Phase 7-E follow-up)
// ============================================================
// Extracts the "current term" and "next term" labels from a parsed
// DPR by looking at the courseHistory rows marked `type: "IP"`
// (in-progress). The agent uses these in the system prompt so it
// answers "what should I take next semester" with the right semester
// label instead of guessing.
//
// Term format: PeopleSoft writes terms as "2026 Fall" / "2026 Spr" /
// "2026 Sum" / "2025 J-Term" etc. We normalize to "Fall 2026" / etc.
// for the prompt.
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

export interface DprTemporalContext {
    /** The student's most recent in-progress term. */
    currentTerm?: string;
    /** The term immediately after currentTerm. */
    nextTerm?: string;
}

/** Derive currentTerm + nextTerm from the DPR's IP courseHistory.
 *  Returns empty strings (omitted) when no IP rows exist (the student
 *  is not currently enrolled). */
export function deriveTemporalContext(dpr: DegreeProgressReport): DprTemporalContext {
    const ipRows = dpr.courseHistory.filter((r) => r.type === "IP");
    if (ipRows.length === 0) return {};

    // Pick the latest in-progress term (a multi-term IP set means the
    // student has registered for two future semesters; the LATEST is
    // the one we care about for "next semester").
    const parsed = ipRows
        .map((r) => parseTerm(r.term))
        .filter((t): t is NonNullable<typeof t> => t !== null);
    if (parsed.length === 0) return {};

    parsed.sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return SEASON_ORDER.indexOf(a.season) - SEASON_ORDER.indexOf(b.season);
    });
    const current = parsed[parsed.length - 1]!;
    const next = nextTermAfter(current);
    return {
        currentTerm: termToLabel(current),
        nextTerm: termToLabel(next),
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
