// ============================================================
// sectionMaterialization/parseMeetingTimes.ts — Phase 15 Task 1
// ============================================================
// Parse FOSE section time data into structured MeetingPattern[].
//
// Primary source: `meetingTimes` (structured JSON field from FOSE).
// Fallback:       `meets` (human-readable string) for async detection.
//
// Day-index mapping verified against 27 recorded fixtures (2026-05-03):
//   "0" = Mon (M)   "1" = Tue (Tu)   "2" = Wed (W)
//   "3" = Thu (Th)  "4" = Fri (F)    "5" = Sat (Sa)   "6" = Sun (Su)
//
// Time format: 3–4 char 24h string — "800" = 08:00, "1045" = 10:45.
// ============================================================

import type { DayOfWeek, MeetingPattern, ParseResult } from "./types.js";

// ---- Day-index map (verified against fixtures) ----
// Fixture cross-check examples:
//   meets "TR 8-9:15a"  → meet_day ["1","3"]   → Tu, Th ✓
//   meets "MW 11a-12:15p" → meet_day ["0","2"] → M, W   ✓
//   meets "MWF 8-9:15a"  → meet_day ["0","2","4"] → M, W, F ✓
//   meets "TRF 9:30-10:45a" → meet_day ["1","3","4"] → Tu, Th, F ✓
//   meets "MTWR 11:10a-1:15p" → meet_day ["0","1","2","3"] → M, Tu, W, Th ✓
const DAY_INDEX_MAP: Record<string, DayOfWeek> = {
    "0": "M",
    "1": "Tu",
    "2": "W",
    "3": "Th",
    "4": "F",
    "5": "Sa",
    "6": "Su",
};

// ---- Async detection patterns (for meets string fallback) ----
const ASYNC_PATTERNS: RegExp[] = [
    /^\s*does\s+not\s+meet\s*$/i,
    /\basynchronous\b/i,
    /\basync\b/i,
    /^\s*tba\s*$/i,
    /^\s*$/,
    /^\s*online\s*$/i,
];

/**
 * Convert a 3–4 char 24h time string to minutes since midnight.
 * Examples: "800" → 480, "930" → 570, "1045" → 645, "1400" → 840.
 * Returns null if the string is not parseable.
 */
export function hhmmToMinutes(s: string): number | null {
    if (!s || s.length < 3 || s.length > 4) return null;
    // All chars must be digits
    if (!/^\d+$/.test(s)) return null;
    if (s.length === 3) {
        // e.g. "800" → h=8, m=00; "930" → h=9, m=30; "915" → h=9, m=15
        const h = parseInt(s[0]!, 10);
        const m = parseInt(s.slice(1), 10);
        if (m < 0 || m >= 60) return null;
        return h * 60 + m;
    } else {
        // s.length === 4, e.g. "1045" → h=10, m=45; "1400" → h=14, m=0
        const h = parseInt(s.slice(0, 2), 10);
        const m = parseInt(s.slice(2), 10);
        if (m < 0 || m >= 60) return null;
        return h * 60 + m;
    }
}

/** Shape of a single element in the meetingTimes JSON array from FOSE. */
interface MeetingTimeEntry {
    meet_day: string;
    start_time: string;
    end_time: string;
}

/**
 * Parse a FOSE meetingTimes JSON string into MeetingPattern[].
 * Returns null if the string is empty, missing, or unparseable.
 *
 * meetingTimesJson shape: JSON array of {meet_day, start_time, end_time}.
 * Example: '[{"meet_day":"0","start_time":"930","end_time":"1045"},...]'
 */
function parseMeetingTimesJson(meetingTimesJson: string): MeetingPattern[] | null {
    if (!meetingTimesJson || meetingTimesJson.trim() === "" || meetingTimesJson.trim() === "[]") {
        return null;
    }

    let entries: unknown;
    try {
        entries = JSON.parse(meetingTimesJson);
    } catch {
        return null;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
        return null;
    }

    const patterns: MeetingPattern[] = [];
    for (const entry of entries) {
        if (
            typeof entry !== "object" ||
            entry === null ||
            typeof (entry as MeetingTimeEntry).meet_day !== "string" ||
            typeof (entry as MeetingTimeEntry).start_time !== "string" ||
            typeof (entry as MeetingTimeEntry).end_time !== "string"
        ) {
            // Unexpected shape — bail and let caller fall through
            return null;
        }
        const e = entry as MeetingTimeEntry;
        const day = DAY_INDEX_MAP[e.meet_day];
        if (day === undefined) {
            // Unknown day index — bail
            return null;
        }
        const startMin = hhmmToMinutes(e.start_time);
        const endMin = hhmmToMinutes(e.end_time);
        if (startMin === null || endMin === null) {
            return null;
        }
        patterns.push({ day, startMin, endMin });
    }

    return patterns.length > 0 ? patterns : null;
}

/**
 * Parse FOSE section time data into structured ParseResult.
 *
 * @param rawMeets         — `meets` field from FOSE (human-readable string)
 * @param meetingTimesJson — `meetingTimes` field from FOSE (JSON array string)
 *
 * Strategy:
 * 1. If meetingTimesJson is non-empty and parseable → return { kind: "ok", patterns }.
 * 2. If meetingTimesJson is empty/missing:
 *    a. If rawMeets matches an async pattern → return { kind: "asynchronous" }.
 *    b. Otherwise → return { kind: "unparseable", raw: rawMeets }.
 *
 * Note: "Does Not Meet" has meetingTimes="[]" AND meets="Does Not Meet",
 * so condition 1 returns null → falls to 2a (async detection).
 */
export function parseMeetingTimes(rawMeets: string, meetingTimesJson?: string): ParseResult {
    // Step 1: try the structured field first
    if (meetingTimesJson !== undefined && meetingTimesJson !== null) {
        const patterns = parseMeetingTimesJson(meetingTimesJson);
        if (patterns !== null) {
            return { kind: "ok", patterns };
        }
    }

    // Step 2: fall back to meets-string async detection
    const meetsStr = rawMeets ?? "";
    if (ASYNC_PATTERNS.some(p => p.test(meetsStr))) {
        return { kind: "asynchronous" };
    }

    // Step 3: no structured times AND not obviously async
    return { kind: "unparseable", raw: meetsStr };
}
