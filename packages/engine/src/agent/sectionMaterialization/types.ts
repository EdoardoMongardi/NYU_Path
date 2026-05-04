// ============================================================
// sectionMaterialization/types.ts — Phase 15 Tasks 1 + 2
// ============================================================
// Domain types for the section-materializer layer.
// Schema is derived from the REAL FOSE API field shapes verified
// against 27 recorded fixtures (2026-05-03).
//
// Key API field corrections vs. original plan:
//   • `rawHours` → `rawMeets`  (FOSE field is `meets`, not `hours`)
//   • Added `meetingTimes`, `schd`, `section` to SectionView
//   • `hours?` on FoseSearchResult kept as deprecation slot only
// ============================================================

export type DayOfWeek = "M" | "Tu" | "W" | "Th" | "F" | "Sa" | "Su";

export interface MeetingPattern {
    day: DayOfWeek;
    /** Minutes since midnight — e.g. 9:30 AM = 570. */
    startMin: number;
    /** Minutes since midnight — e.g. 10:45 AM = 645. */
    endMin: number;
}

export type ParseResult =
    | { kind: "ok"; patterns: MeetingPattern[] }
    | { kind: "asynchronous" }           // online / async / TBA / "Does Not Meet" / no time
    | { kind: "unparseable"; raw: string };

export interface SectionView {
    /** Course identifier, e.g. "CSCI-UA 421" */
    courseId: string;
    /** Course title from FOSE */
    title: string;
    /** Course Registration Number */
    crn: string;
    /** Credit hours — FOSE returns as string */
    credits: string;
    /** Raw `instr` from FOSE, surfaced verbatim to the student */
    instructor: string;
    /** Enrollment status: "O"=open, "W"=waitlist, "C"=closed, "A"=active (pre-reg) */
    status: string;
    /** Parsed meeting patterns from `meetingTimes` JSON field */
    meetingPatterns: MeetingPattern[];
    /**
     * True when meetingPatterns is empty AND parse returned "asynchronous".
     * Distinguishes async from "couldn't parse the time string".
     */
    isAsynchronous: boolean;
    /**
     * Raw `meets` string from FOSE for debugging / display.
     * (Renamed from `rawHours` to match the actual API field name.)
     */
    rawMeets: string;
    /**
     * Raw `meetingTimes` JSON string from FOSE.
     * Shape: JSON array of `{meet_day: string, start_time: string, end_time: string}`.
     * meet_day: "0"=Mon, "1"=Tue, "2"=Wed, "3"=Thu, "4"=Fri, "5"=Sat, "6"=Sun.
     * start_time / end_time: 24h, 3–4 chars, e.g. "800" or "1045".
     */
    meetingTimes?: string;
    /**
     * Section type from FOSE: "LEC", "LAB", "RCT", "TUT", "SEM", "IND", etc.
     * Populated from the `schd` field.
     */
    schd?: string;
    /**
     * Section number/identifier from FOSE `no` field (e.g. "002").
     * Renamed from `section` for clarity.
     */
    section?: string;
}

export interface MaterializedSemester {
    term: string;
    /**
     * Per-course bundles. Each course has zero or more SectionViews
     * (zero = unavailable; >0 = available).
     */
    courses: Array<{
        courseId: string;
        title: string;
        sections: SectionView[];
    }>;
    /**
     * All conflict-free combinations across the courses (cross-product
     * filtered for time conflicts). Capped at MAX_COMBINATIONS.
     */
    combinations: Array<{
        sections: SectionView[];     // one per course
        weeklyHours: number;         // total weekly meeting time in hours
    }>;
    /**
     * True when the combination list was capped at MAX_COMBINATIONS and
     * there were more valid combinations available.
     */
    combinationsTruncated: boolean;
}

export type AvailabilityState = "full" | "partial" | "unavailable";

export interface MaterializationResult {
    state: AvailabilityState;
    /** Populated when state === "full". */
    semester?: MaterializedSemester;
    /**
     * Populated when state === "partial" — courses are listed but meeting
     * times are missing. The student sees a warning + the structural plan
     * remains the source of truth until registration data is ready.
     */
    partialCourses?: Array<{ courseId: string; title: string; sections: SectionView[] }>;
    /** Always populated: explanation for the student. */
    message: string;
}
