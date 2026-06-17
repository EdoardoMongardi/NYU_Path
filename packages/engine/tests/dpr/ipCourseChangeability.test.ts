// ============================================================
// ipCourseChangeability (F3 — IP-course temporal model, per-season)
// ============================================================
// Pure-classifier tests with a FIXED `now` + an injected PER-SEASON
// calendar fixture, so every branch is fully deterministic. The calendar
// holds ONE typical "MM-DD" date-set PER SEASON; the classifier stamps the
// IP term's actual YEAR onto that season pattern to build concrete dates.
// Covers:
//   - future-term IP                       → "future"   (editable, no hedge)
//   - current within add/drop              → "add_drop" (editable, no hedge)
//   - current within withdraw / pass-fail  → "withdraw_pf" (editable + W/PF hedge)
//   - current PAST withdraw                → "closed"   (NOT editable + closed hedge)
//   - current past add/drop, NO withdraw   → "unknown"  (editable + generic hedge)
//       ⟵ the edge-case FIX: without the withdraw date we cannot know the
//         window closed, so we HEDGE rather than falsely lock.
//   - current SUMMER term                  → uses the summer pattern + the
//         extra summer-uncertainty hedge clause
//   - current with an UNRECOGNIZED season  → "unknown"  (editable + generic
//         hedge): a literal "winter" → seasonOfTerm null → hedge, never guess
//   - current on an EMPTY-calendar campus  → "unknown"  (editable + generic hedge)
//   - past / stale IP row                  → "closed"   (NOT editable)
//
// Every current-term hedge must convey the dates are NYU's TYPICAL seasonal
// deadlines (they shift each year) + "verify with your adviser/registrar".
//
// A hand-built DprTemporalContext fixture pins enrolledNowTerm /
// preRegisteredTerms so we don't depend on wall-clock derivation; a
// dedicated test also exercises the REAL deriveTemporalContext to prove
// the wiring holds end-to-end.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    classifyIpChangeability,
    type ClassifyIpChangeabilityArgs,
} from "../../src/dpr/ipCourseChangeability.js";
import type {
    AcademicCalendar,
    SeasonWindows,
} from "../../src/dpr/academicCalendar.js";
import { deriveTemporalContext } from "../../src/dpr/temporalContext.js";
import type { DprTemporalContext } from "../../src/dpr/temporalContext.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Per-season calendar fixtures (injected — never touch the bundled NYU
// calendar). Values are year-agnostic "MM-DD" patterns the classifier stamps
// the IP term's year onto.
// ---------------------------------------------------------------------------

const FALL: SeasonWindows = {
    termStartMonthDay: "09-02",
    addDropMonthDay: "09-15",
    withdrawMonthDay: "11-26",
};
const SUMMER: SeasonWindows = {
    termStartMonthDay: "05-27",
    addDropMonthDay: "06-02",
    withdrawMonthDay: "07-15",
};
// Spring with add/drop present but NO withdraw date — exercises the
// "past add/drop, no withdraw → unknown (not closed)" fix.
const SPRING_NO_WITHDRAW: SeasonWindows = {
    termStartMonthDay: "01-22",
    addDropMonthDay: "02-04",
    // withdrawMonthDay intentionally absent.
};
// A season with no windows at all → no usable dates → generic hedge.
const EMPTY: SeasonWindows = {};

/** ny campus fully specified; shanghai entirely empty (no usable dates for
 *  any season → the classifier hedges). */
const CAL: AcademicCalendar = {
    ny: {
        fall: FALL,
        spring: SPRING_NO_WITHDRAW,
        summer: SUMMER,
        january: EMPTY,
    },
    shanghai: {
        fall: EMPTY,
        spring: EMPTY,
        summer: EMPTY,
        january: EMPTY,
    },
    abudhabi: {
        fall: EMPTY,
        spring: EMPTY,
        summer: EMPTY,
        january: EMPTY,
    },
};

// ---------------------------------------------------------------------------
// DprTemporalContext fixtures — pin the enrolled/pre-registered terms so the
// classifier's current-vs-future decision is deterministic per test.
// ---------------------------------------------------------------------------

function ctx(opts: Partial<DprTemporalContext>): DprTemporalContext {
    return { ...opts };
}

function args(
    overrides: Partial<ClassifyIpChangeabilityArgs> &
        Pick<ClassifyIpChangeabilityArgs, "ipTerm" | "temporalContext" | "now">,
): ClassifyIpChangeabilityArgs {
    return {
        campus: "ny",
        calendar: CAL,
        ...overrides,
    };
}

describe("classifyIpChangeability — future (pre-registered) term", () => {
    it("a pre-registered future term → 'future', editable, NO hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2027",
                temporalContext: ctx({
                    enrolledNowTerm: "Summer 2027",
                    preRegisteredTerms: ["Fall 2027"],
                }),
                now: new Date("2027-06-16T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("future");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeUndefined();
    });
});

describe("classifyIpChangeability — current term, within add/drop", () => {
    it("today is before the season's typical add/drop → 'add_drop', editable, no hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2027",
                temporalContext: ctx({ enrolledNowTerm: "Fall 2027" }),
                // 2027-09-10 is before the stamped 2027-09-15 add/drop date.
                now: new Date("2027-09-10T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("add_drop");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeUndefined();
    });

    it("on the typical add/drop day → still 'add_drop' (inclusive)", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2027",
                temporalContext: ctx({ enrolledNowTerm: "Fall 2027" }),
                now: new Date("2027-09-15T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("add_drop");
        expect(r.editable).toBe(true);
    });
});

describe("classifyIpChangeability — current term, within withdraw / pass-fail", () => {
    it("past add/drop but on or before the typical withdraw → 'withdraw_pf', editable + W/PF + TYPICAL hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2027",
                temporalContext: ctx({ enrolledNowTerm: "Fall 2027" }),
                // Between 2027-09-15 (add/drop) and 2027-11-26 (withdraw).
                now: new Date("2027-10-20T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("withdraw_pf");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeDefined();
        // The hedge states the W / pass-fail CONSEQUENCE in prose…
        expect(r.hedge!.toLowerCase()).toContain("withdraw");
        expect(r.hedge!.toLowerCase()).toContain("pass");
        expect(r.hedge!.toLowerCase()).toContain("adviser");
        // …and conveys the date is TYPICAL (shifts each year) — verify.
        expect(r.hedge!.toLowerCase()).toContain("typical");
        // It is NOT the summer hedge for a fall course.
        expect(r.hedge!.toLowerCase()).not.toContain("sub-session");
    });
});

describe("classifyIpChangeability — current term, PAST the withdraw window", () => {
    it("today is past the stamped withdraw date → 'closed', NOT editable + TYPICAL closed hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2027",
                temporalContext: ctx({ enrolledNowTerm: "Fall 2027" }),
                // After 2027-11-26 (the stamped withdraw date).
                now: new Date("2027-12-01T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("closed");
        expect(r.editable).toBe(false);
        expect(r.hedge).toBeDefined();
        expect(r.hedge!.toLowerCase()).toContain("typical");
        expect(r.hedge!.toLowerCase()).toContain("adviser");
    });
});

describe("classifyIpChangeability — SUMMER current term (extra-uncertain)", () => {
    it("past add/drop but before withdraw → 'withdraw_pf' + the summer sub-session hedge clause", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Summer 2027",
                temporalContext: ctx({ enrolledNowTerm: "Summer 2027" }),
                // Between 2027-06-02 (add/drop) and 2027-07-15 (withdraw).
                now: new Date("2027-06-20T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("withdraw_pf");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeDefined();
        expect(r.hedge!.toLowerCase()).toContain("typical");
        // The summer-specific extra-uncertainty clause.
        expect(r.hedge!.toLowerCase()).toContain("summer");
        expect(r.hedge!.toLowerCase()).toContain("sub-session");
    });
});

describe("classifyIpChangeability — edge: past add/drop with NO withdraw date", () => {
    it("past add/drop but the season has NO withdraw pattern → 'unknown', EDITABLE + generic hedge (NOT closed)", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Spring 2027",
                temporalContext: ctx({ enrolledNowTerm: "Spring 2027" }),
                // After Spring add/drop (stamped 2027-02-04); the season has
                // NO withdraw pattern → we cannot know the window closed, so
                // we must NOT lock.
                now: new Date("2027-03-15T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("unknown");
        expect(r.editable).toBe(true); // the load-bearing assertion: NOT locked
        expect(r.hedge).toBeDefined();
        expect(r.hedge!.toLowerCase()).toContain("adviser");
    });
});

describe("classifyIpChangeability — current term with NO usable dates", () => {
    it("a season with no windows at all (january EMPTY) → 'unknown', editable + generic hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "January 2027",
                temporalContext: ctx({ enrolledNowTerm: "January 2027" }),
                now: new Date("2027-01-10T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("unknown");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeDefined();
    });

    it("an EMPTY-calendar campus (e.g. shanghai) → 'unknown', editable + generic hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2027",
                temporalContext: ctx({ enrolledNowTerm: "Fall 2027" }),
                campus: "shanghai",
                now: new Date("2027-10-20T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("unknown");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeDefined();
    });
});

describe("classifyIpChangeability — UNRECOGNIZED season", () => {
    it("a literal 'winter' term (seasonOfTerm → null) → 'unknown', editable + generic hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Winter 2027",
                temporalContext: ctx({ enrolledNowTerm: "Winter 2027" }),
                now: new Date("2027-01-10T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("unknown");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeDefined();
    });
});

describe("classifyIpChangeability — past / stale IP row", () => {
    it("a term that is neither current nor pre-registered → 'closed', NOT editable", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2025",
                temporalContext: ctx({
                    enrolledNowTerm: "Fall 2027",
                    preRegisteredTerms: ["Spring 2028"],
                }),
                now: new Date("2027-10-20T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("closed");
        expect(r.editable).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// End-to-end with the REAL deriveTemporalContext — proves the classifier
// consumes a genuinely-derived context (not just a hand-built fixture).
// ---------------------------------------------------------------------------

describe("classifyIpChangeability — wired to real deriveTemporalContext", () => {
    function dprWithIP(terms: string[]): DegreeProgressReport {
        return {
            courseHistory: terms.map((term, i) => ({
                term,
                subject: "CSCI-UA",
                catalogNbr: `${100 + i}`,
                courseTitle: `Course ${i}`,
                units: 4,
                grade: null,
                type: "IP" as const,
            })),
        } as unknown as DegreeProgressReport;
    }

    it("Summer-2027 enrolled + Fall-2027 pre-registered: Fall classifies as future", () => {
        const now = new Date("2027-06-16T00:00:00Z"); // Summer 2027
        const temporalContext = deriveTemporalContext(dprWithIP(["2027 Summer", "2027 Fall"]), { now });
        expect(temporalContext.enrolledNowTerm).toBe("Summer 2027");
        expect(temporalContext.preRegisteredTerms).toContain("Fall 2027");

        const r = classifyIpChangeability(
            args({ ipTerm: "2027 Fall", temporalContext, now }),
        );
        expect(r.window).toBe("future");
        expect(r.editable).toBe(true);
    });

    it("Fall-2027 enrolled mid-term (Oct) classifies as withdraw_pf", () => {
        const now = new Date("2027-10-20T00:00:00Z"); // Fall 2027, mid-term
        const temporalContext = deriveTemporalContext(dprWithIP(["2027 Fall"]), { now });
        expect(temporalContext.enrolledNowTerm).toBe("Fall 2027");

        const r = classifyIpChangeability(
            args({ ipTerm: "2027 Fall", temporalContext, now }),
        );
        expect(r.window).toBe("withdraw_pf");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeDefined();
    });
});
