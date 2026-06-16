// ============================================================
// ipCourseChangeability (F3 — IP-course temporal model)
// ============================================================
// Pure-classifier tests with a FIXED `now` + an injected calendar
// fixture, so every branch is fully deterministic. Covers:
//   - future-term IP                       → "future"   (editable, no hedge)
//   - current within add/drop              → "add_drop" (editable, no hedge)
//   - current within withdraw / pass-fail  → "withdraw_pf" (editable + W/PF hedge)
//   - current PAST withdraw                → "closed"   (NOT editable + closed hedge)
//   - current past add/drop, NO withdraw   → "unknown"  (editable + generic hedge)
//       ⟵ the Part-1 edge-case FIX: without the withdraw date we cannot
//         know the window closed, so we HEDGE rather than falsely lock.
//   - current with NO dates at all         → "unknown"  (editable + generic hedge)
//   - past / stale IP row                  → "closed"   (NOT editable)
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
import type { AcademicCalendar } from "../../src/dpr/academicCalendar.js";
import { deriveTemporalContext } from "../../src/dpr/temporalContext.js";
import type { DprTemporalContext } from "../../src/dpr/temporalContext.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Calendar fixtures (injected — never touch the bundled NYU calendar).
// ---------------------------------------------------------------------------

/** Fall 2026 fully specified; Spring 2027 term-start only (no deadlines);
 *  Summer 2026 entirely absent (the campus has no entry for it). */
const CAL: AcademicCalendar = {
    ny: {
        "2026-fall": {
            termStart: "2026-09-02",
            addDropDeadline: "2026-09-15",
            withdrawDeadline: "2026-11-26",
        },
        // Add/drop present but NO withdraw date — exercises the Part-1 fix.
        "2027-spring": {
            termStart: "2027-01-19",
            addDropDeadline: "2027-02-02",
            // withdrawDeadline intentionally absent.
        },
        // 2026-summer omitted entirely → getTermWindows returns undefined.
    },
    shanghai: {},
    abudhabi: {},
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
                ipTerm: "Fall 2026",
                temporalContext: ctx({
                    enrolledNowTerm: "Summer 2026",
                    preRegisteredTerms: ["Fall 2026"],
                }),
                now: new Date("2026-06-16T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("future");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeUndefined();
    });
});

describe("classifyIpChangeability — current term, within add/drop", () => {
    it("today is before the add/drop deadline → 'add_drop', editable, no hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2026",
                temporalContext: ctx({ enrolledNowTerm: "Fall 2026" }),
                // 2026-09-10 is before the 2026-09-15 add/drop deadline.
                now: new Date("2026-09-10T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("add_drop");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeUndefined();
    });

    it("on the add/drop deadline day → still 'add_drop' (inclusive)", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2026",
                temporalContext: ctx({ enrolledNowTerm: "Fall 2026" }),
                now: new Date("2026-09-15T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("add_drop");
        expect(r.editable).toBe(true);
    });
});

describe("classifyIpChangeability — current term, within withdraw / pass-fail", () => {
    it("past add/drop but on or before the withdraw deadline → 'withdraw_pf', editable + W/PF hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2026",
                temporalContext: ctx({ enrolledNowTerm: "Fall 2026" }),
                // Between 2026-09-15 (add/drop) and 2026-11-26 (withdraw).
                now: new Date("2026-10-20T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("withdraw_pf");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeDefined();
        // The hedge states the W / pass-fail CONSEQUENCE in prose.
        expect(r.hedge!.toLowerCase()).toContain("withdraw");
        expect(r.hedge!.toLowerCase()).toContain("pass");
        expect(r.hedge!.toLowerCase()).toContain("adviser");
    });
});

describe("classifyIpChangeability — current term, PAST the withdraw window", () => {
    it("today is past a KNOWN withdraw deadline → 'closed', NOT editable + closed hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2026",
                temporalContext: ctx({ enrolledNowTerm: "Fall 2026" }),
                // After 2026-11-26 (the withdraw deadline).
                now: new Date("2026-12-01T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("closed");
        expect(r.editable).toBe(false);
        expect(r.hedge).toBeDefined();
    });
});

describe("classifyIpChangeability — PART-1 FIX: past add/drop with NO withdraw date", () => {
    it("past add/drop but the term has NO withdraw deadline → 'unknown', EDITABLE + generic hedge (NOT closed)", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Spring 2027",
                temporalContext: ctx({ enrolledNowTerm: "Spring 2027" }),
                // After Spring-2027 add/drop (2027-02-02); NO withdraw date on
                // file → we cannot know the window closed, so we must NOT lock.
                now: new Date("2027-03-15T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("unknown");
        expect(r.editable).toBe(true); // the load-bearing assertion: NOT locked
        expect(r.hedge).toBeDefined();
        expect(r.hedge!.toLowerCase()).toContain("adviser");
    });
});

describe("classifyIpChangeability — current term with NO dates at all", () => {
    it("the campus/term has no calendar entry → 'unknown', editable + generic hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Summer 2026",
                temporalContext: ctx({ enrolledNowTerm: "Summer 2026" }),
                now: new Date("2026-06-16T00:00:00Z"),
            }),
        );
        expect(r.window).toBe("unknown");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeDefined();
    });

    it("an EMPTY-calendar campus (e.g. shanghai) → 'unknown', editable + generic hedge", () => {
        const r = classifyIpChangeability(
            args({
                ipTerm: "Fall 2026",
                temporalContext: ctx({ enrolledNowTerm: "Fall 2026" }),
                campus: "shanghai",
                now: new Date("2026-10-20T00:00:00Z"),
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
                    enrolledNowTerm: "Fall 2026",
                    preRegisteredTerms: ["Spring 2027"],
                }),
                now: new Date("2026-10-20T00:00:00Z"),
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

    it("Summer-2026 enrolled + Fall-2026 pre-registered: Fall classifies as future", () => {
        const now = new Date("2026-06-16T00:00:00Z"); // Summer 2026
        const temporalContext = deriveTemporalContext(dprWithIP(["2026 Summer", "2026 Fall"]), { now });
        expect(temporalContext.enrolledNowTerm).toBe("Summer 2026");
        expect(temporalContext.preRegisteredTerms).toContain("Fall 2026");

        const r = classifyIpChangeability(
            args({ ipTerm: "2026 Fall", temporalContext, now }),
        );
        expect(r.window).toBe("future");
        expect(r.editable).toBe(true);
    });

    it("Fall-2026 enrolled mid-term (Oct) classifies as withdraw_pf", () => {
        const now = new Date("2026-10-20T00:00:00Z"); // Fall 2026, mid-term
        const temporalContext = deriveTemporalContext(dprWithIP(["2026 Fall"]), { now });
        expect(temporalContext.enrolledNowTerm).toBe("Fall 2026");

        const r = classifyIpChangeability(
            args({ ipTerm: "2026 Fall", temporalContext, now }),
        );
        expect(r.window).toBe("withdraw_pf");
        expect(r.editable).toBe(true);
        expect(r.hedge).toBeDefined();
    });
});
