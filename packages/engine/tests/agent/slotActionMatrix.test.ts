// ============================================================
// slotActionMatrix.test.ts — D1 (plan 37 slot-editor)
// ============================================================
// Tests for the pure slotActionMatrix function: 3-state × F3-window × P/F-policy.
//
// Window dates used (NY campus, fall term "2026-fall"):
//   add/drop:  09-15  (NY DEFAULT_SEASON_WINDOWS.fall.addDropMonthDay)
//   withdraw:  11-26  (NY DEFAULT_SEASON_WINDOWS.fall.withdrawMonthDay)
//
// Test date anchors (UTC midnight):
//   "2026-09-01" → before add/drop (add_drop window — but BEFORE term start; still add_drop since
//                  we compare now ≤ addDropDate and 09-01 < 09-15)
//   "2026-09-10" → inside add/drop (before 09-15)
//   "2026-10-15" → past add/drop (09-15), inside withdraw window (before 11-26) → withdraw_pf
//   "2026-12-20" → past withdraw deadline (11-26) → closed
//
// The ipDpr helper builds a minimal DPR whose courseHistory has ONE IP row for
// the given courseId in the term "2026 Fall". deriveTemporalContext then derives
// enrolledNowTerm = "Fall 2026" when now is in fall 2026 (Aug-Dec).
// ============================================================

import { describe, it, expect } from "vitest";
import { slotActionMatrix } from "../../src/agent/forwardSchedule/slotActionMatrix.js";
import { NYU_ACADEMIC_CALENDAR } from "../../src/dpr/academicCalendar.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { ScheduleSlot } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** PassFailConfig for a school that CAN elect P/F (e.g. CAS, 32-credit limit). */
const casPf = {
    careerLimitType: "credits" as const,
    careerLimitValue: 32,
    canElect: true,
};

/** PassFailConfig for a school that CANNOT elect P/F (e.g. Tandon: canElect = false). */
const tandonPf = {
    careerLimitType: "credits" as const,
    careerLimitValue: null,
    canElect: false,
};

/**
 * Build a minimal DPR with one IP courseHistory row for `term`.
 * The subject/catalogNbr are extracted from `courseId` (e.g. "CSCI-UA 101" →
 * subject "CSCI-UA", catalogNbr "101").
 */
function ipDpr(courseId: string, term = "2026 Fall"): DegreeProgressReport {
    const parts = courseId.split(" ");
    const subject = parts[0]!;
    const catalogNbr = parts[1]!;
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:SYNTHETIC-slotActionMatrix-test",
            sourcePdfPageCount: 0,
            parseDurationMs: 0,
            warnings: ["SYNTHETIC FIXTURE — not parsed from a real DPR PDF"],
        },
        reportKind: "dpr",
        header: { studentName: "Test Student (fabricated)", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 64,
            cumulativeGpa: 3.5,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 32,
            passFailUsedUnits: 0,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [
            {
                term,
                subject,
                catalogNbr,
                courseTitle: "Test Course",
                grade: null,
                units: 4,
                type: "IP",
            },
        ],
    } as DegreeProgressReport;
}

/** An empty DPR (no IP rows — used for FINAL and PLANNED slots). */
const emptyDpr: DegreeProgressReport = {
    _meta: {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:SYNTHETIC-empty",
        sourcePdfPageCount: 0,
        parseDurationMs: 0,
        warnings: ["SYNTHETIC FIXTURE — empty DPR"],
    },
    reportKind: "dpr",
    header: { studentName: "Test Student (fabricated)", preparedDate: "01/01/2026" },
    programs: [],
    advisorNotations: [],
    cumulative: {
        creditsRequired: 128,
        creditsUsed: 64,
        cumulativeGpa: 3.5,
        cumulativeGpaRequired: 2.0,
        residencyRequired: 64,
        residencyUsed: 32,
        passFailUsedUnits: 0,
        passFailCapUnits: 32,
        outsideHomeUsedUnits: 0,
        outsideHomeCapUnits: 16,
        timeLimitYears: 8,
    },
    requirementGroups: [],
    courseHistory: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("slotActionMatrix (3-state × F3-window × P/F-policy)", () => {

    // -------------------------------------------------------------------------
    // FINAL — completed, immutable
    // -------------------------------------------------------------------------

    it("FINAL (completed) → all actions forbidden", () => {
        const slot: ScheduleSlot = { kind: "completed", courseId: "CSCI-UA 101", grade: "A", units: 4, term: "2024 Fall" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2024-fall",
            dpr: emptyDpr,
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: casPf,
        });
        expect(m.state).toBe("final");
        expect(m.allowed).toEqual({ add: false, drop: false, withdraw: false, passFail: false });
        // All perAction entries should carry a reason (not a hedge)
        expect(m.perAction.drop.reason).toBeTruthy();
        expect(m.perAction.withdraw.reason).toBeTruthy();
        expect(m.perAction.passFail.reason).toBeTruthy();
    });

    it("FINAL → add.reason is defined", () => {
        const slot: ScheduleSlot = { kind: "completed", courseId: "MATH-UA 121", grade: "B+", units: 4, term: "2025 Spring" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2025-spring",
            dpr: emptyDpr,
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
        });
        expect(m.perAction.add.reason).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // PLANNED — specific_planned / placeholder → drop-only
    // -------------------------------------------------------------------------

    it("PLANNED (specific_planned) → drop only, no withdraw/passFail/add", () => {
        const slot: ScheduleSlot = { kind: "specific_planned", courseId: "MATH-UA 121" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2027-fall",
            dpr: emptyDpr,
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: casPf,
            now: new Date("2026-09-01T00:00:00Z"),
        });
        expect(m.state).toBe("planned");
        expect(m.allowed.drop).toBe(true);
        expect(m.allowed.withdraw).toBe(false);
        expect(m.allowed.passFail).toBe(false);
        expect(m.allowed.add).toBe(false);
        // drop should carry a hedge, not a reason
        expect(m.perAction.drop.hedge).toBeTruthy();
        // withdraw / passFail carry a reason
        expect(m.perAction.withdraw.reason).toBeTruthy();
        expect(m.perAction.passFail.reason).toBeTruthy();
    });

    it("PLANNED (placeholder) → drop only", () => {
        const slot: ScheduleSlot = { kind: "placeholder", placeholderLabel: "Elective" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2027-spring",
            dpr: emptyDpr,
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: casPf,
            now: new Date("2026-09-01T00:00:00Z"),
        });
        expect(m.state).toBe("planned");
        expect(m.allowed.drop).toBe(true);
        expect(m.allowed.withdraw).toBe(false);
        expect(m.allowed.passFail).toBe(false);
        expect(m.allowed.add).toBe(false);
    });

    // -------------------------------------------------------------------------
    // REGISTERED — in_progress, add_drop window (now = 2026-09-10, before 09-15)
    // -------------------------------------------------------------------------

    it("REGISTERED in add_drop window → drop allowed (no withdraw), passFail allowed with CAS", () => {
        // now = Sep 10, inside add/drop (deadline Sep 15)
        const now = new Date("2026-09-10T00:00:00Z");
        const slot: ScheduleSlot = { kind: "in_progress", courseId: "CSCI-UA 101" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr: ipDpr("CSCI-UA 101"),
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: casPf,
            now,
        });
        expect(m.state).toBe("registered");
        // Inside add/drop → drop allowed
        expect(m.allowed.drop).toBe(true);
        // add is always false for a per-slot matrix
        expect(m.allowed.add).toBe(false);
    });

    // -------------------------------------------------------------------------
    // REGISTERED — withdraw_pf window (now = 2026-10-15, past add/drop, before withdraw 11-26)
    // -------------------------------------------------------------------------

    it("REGISTERED in withdraw_pf window → withdraw + passFail allowed (CAS)", () => {
        const now = new Date("2026-10-15T00:00:00Z");
        const slot: ScheduleSlot = { kind: "in_progress", courseId: "CSCI-UA 101" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr: ipDpr("CSCI-UA 101"),
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: casPf,
            now,
        });
        expect(m.state).toBe("registered");
        expect(m.allowed.withdraw).toBe(true);
        expect(m.allowed.passFail).toBe(true);
        expect(m.allowed.add).toBe(false);
        // Both should carry the F3 hedge (not a reason), since they're window-gated
        expect(m.perAction.withdraw.hedge).toBeTruthy();
        expect(m.perAction.passFail.hedge).toBeTruthy();
        // No reason for these (they're allowed)
        expect(m.perAction.withdraw.reason).toBeUndefined();
    });

    it("REGISTERED in withdraw_pf window → drop is also allowed (a drop = a withdraw after add/drop)", () => {
        const now = new Date("2026-10-15T00:00:00Z");
        const slot: ScheduleSlot = { kind: "in_progress", courseId: "CSCI-UA 101" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr: ipDpr("CSCI-UA 101"),
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: casPf,
            now,
        });
        expect(m.allowed.drop).toBe(true);
    });

    // -------------------------------------------------------------------------
    // REGISTERED — closed window (now = 2026-12-20, past withdraw deadline 11-26)
    // -------------------------------------------------------------------------

    it("REGISTERED closed (past withdraw deadline) → no withdraw, no passFail, no drop", () => {
        const now = new Date("2026-12-20T00:00:00Z");
        const slot: ScheduleSlot = { kind: "in_progress", courseId: "CSCI-UA 101" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr: ipDpr("CSCI-UA 101"),
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: casPf,
            now,
        });
        expect(m.state).toBe("registered");
        expect(m.allowed.withdraw).toBe(false);
        expect(m.allowed.passFail).toBe(false);
        expect(m.allowed.drop).toBe(false);
        expect(m.allowed.add).toBe(false);
        // closed → reason (not hedge)
        expect(m.perAction.withdraw.reason).toBeTruthy();
        expect(m.perAction.passFail.reason).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // REGISTERED — P/F policy: school that can't elect P/F (canElect=false)
    // -------------------------------------------------------------------------

    it("REGISTERED in withdraw_pf window, canElect=false (Tandon) → passFail forbidden with a reason", () => {
        const now = new Date("2026-10-15T00:00:00Z");
        const slot: ScheduleSlot = { kind: "in_progress", courseId: "CSCI-UA 101" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr: ipDpr("CSCI-UA 101"),
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: tandonPf,
            now,
        });
        expect(m.allowed.passFail).toBe(false);
        // reason must match the "can't elect" / "cannot elect" / "doesn't let you elect" pattern
        expect(m.perAction.passFail.reason).toMatch(/can'?t elect|cannot elect|doesn'?t let you elect/i);
    });

    it("REGISTERED in withdraw_pf window, canElect=false → withdraw still allowed", () => {
        const now = new Date("2026-10-15T00:00:00Z");
        const slot: ScheduleSlot = { kind: "in_progress", courseId: "CSCI-UA 101" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr: ipDpr("CSCI-UA 101"),
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: tandonPf,
            now,
        });
        // canElect=false does NOT affect withdraw
        expect(m.allowed.withdraw).toBe(true);
    });

    // -------------------------------------------------------------------------
    // REGISTERED — no passFail config passed → passFail still allowed in window
    // -------------------------------------------------------------------------

    it("REGISTERED in withdraw_pf window, no passFail config → passFail allowed (no explicit block)", () => {
        const now = new Date("2026-10-15T00:00:00Z");
        const slot: ScheduleSlot = { kind: "in_progress", courseId: "CSCI-UA 101" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr: ipDpr("CSCI-UA 101"),
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            // no passFail arg
            now,
        });
        // undefined passFail → canElect is not false → allowed in window
        expect(m.allowed.passFail).toBe(true);
    });

    // -------------------------------------------------------------------------
    // REGISTERED — add is always false (per-slot, add is term-level)
    // -------------------------------------------------------------------------

    it("REGISTERED → add is always false regardless of window", () => {
        const now = new Date("2026-09-10T00:00:00Z");
        const slot: ScheduleSlot = { kind: "in_progress", courseId: "CSCI-UA 101" } as any;
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr: ipDpr("CSCI-UA 101"),
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: casPf,
            now,
        });
        expect(m.allowed.add).toBe(false);
        expect(m.perAction.add.reason).toBeTruthy();
    });

    // -------------------------------------------------------------------------
    // State labeling
    // -------------------------------------------------------------------------

    it("state is 'final' for completed, 'registered' for in_progress, 'planned' for specific_planned/placeholder", () => {
        const now = new Date("2026-10-15T00:00:00Z");

        const final = slotActionMatrix({ slot: { kind: "completed" } as any, term: "2024-fall", dpr: emptyDpr, campus: "ny", calendar: NYU_ACADEMIC_CALENDAR });
        expect(final.state).toBe("final");

        const registered = slotActionMatrix({ slot: { kind: "in_progress" } as any, term: "2026-fall", dpr: ipDpr("CSCI-UA 101"), campus: "ny", calendar: NYU_ACADEMIC_CALENDAR, now });
        expect(registered.state).toBe("registered");

        const planned1 = slotActionMatrix({ slot: { kind: "specific_planned" } as any, term: "2027-fall", dpr: emptyDpr, campus: "ny", calendar: NYU_ACADEMIC_CALENDAR });
        expect(planned1.state).toBe("planned");

        const planned2 = slotActionMatrix({ slot: { kind: "placeholder" } as any, term: "2027-fall", dpr: emptyDpr, campus: "ny", calendar: NYU_ACADEMIC_CALENDAR });
        expect(planned2.state).toBe("planned");
    });
});
