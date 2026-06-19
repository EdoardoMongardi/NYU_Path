// ============================================================
// passFailDefaults.test.ts — Plan 37 follow-up
// ============================================================
// Unit tests for `passFailForSchool`, the client-safe per-school P/F lookup.
//
// Covers:
//   (1) Tandon (canElect: false) — the key UX fix: button pre-disabled on client.
//   (2) CAS (canElect: true) — electing is allowed.
//   (3) Unknown school id → undefined (treated as "not explicitly blocked").
//   (4) Case-insensitivity.
//   (5) Integration: passing the result to slotActionMatrix pre-disables the
//       Pass/Fail button in the withdraw_pf window at a canElect:false school.
// ============================================================

import { describe, it, expect } from "vitest";
import { passFailForSchool } from "../../src/data/passFailDefaults.js";
import { slotActionMatrix } from "../../src/agent/forwardSchedule/slotActionMatrix.js";
import { NYU_ACADEMIC_CALENDAR } from "../../src/dpr/academicCalendar.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { ScheduleSlot } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DPR with one IP courseHistory row for the given term. */
function ipDpr(courseId: string, term = "2026 Fall"): DegreeProgressReport {
    const parts = courseId.split(" ");
    const subject = parts[0]!;
    const catalogNbr = parts[1]!;
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:SYNTHETIC-passFailDefaults-test",
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

// ---------------------------------------------------------------------------
// (1) Tandon — canElect: false
// ---------------------------------------------------------------------------

describe("passFailForSchool — Tandon (canElect:false)", () => {
    it("returns a config with canElect === false", () => {
        const pf = passFailForSchool("tandon");
        expect(pf).toBeDefined();
        expect(pf!.canElect).toBe(false);
    });

    it("case-insensitive: 'TANDON' also returns canElect:false", () => {
        const pf = passFailForSchool("TANDON");
        expect(pf).toBeDefined();
        expect(pf!.canElect).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// (2) CAS — canElect: true
// ---------------------------------------------------------------------------

describe("passFailForSchool — CAS (canElect:true)", () => {
    it("returns a config with canElect === true", () => {
        const pf = passFailForSchool("cas");
        expect(pf).toBeDefined();
        expect(pf!.canElect).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// (3) Unknown school → undefined
// ---------------------------------------------------------------------------

describe("passFailForSchool — unknown school", () => {
    it("returns undefined for an unrecognised school id", () => {
        expect(passFailForSchool("unknown_school_xyz")).toBeUndefined();
    });

    it("returns undefined when called with undefined", () => {
        expect(passFailForSchool(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
        expect(passFailForSchool("")).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// (4) Spot-check a handful of other schools for sanity
// ---------------------------------------------------------------------------

describe("passFailForSchool — other schools", () => {
    it("stern: canElect true (counts for major/minor)", () => {
        const pf = passFailForSchool("stern");
        expect(pf).toBeDefined();
        expect(pf!.canElect).toBe(true);
        expect(pf!.countsForMajor).toBe(true);
    });

    it("tisch: canElect true, 32-credit career cap", () => {
        const pf = passFailForSchool("tisch");
        expect(pf).toBeDefined();
        expect(pf!.canElect).toBe(true);
        expect(pf!.careerLimitValue).toBe(32);
    });

    it("sps: canElect absent (undefined) — not explicitly false", () => {
        const pf = passFailForSchool("sps");
        expect(pf).toBeDefined();
        // sps.json has no canElect field → undefined (not explicitly false)
        expect(pf!.canElect).not.toBe(false);
    });
});

// ---------------------------------------------------------------------------
// (5) Integration: passFailForSchool result wired into slotActionMatrix
// ---------------------------------------------------------------------------

describe("slotActionMatrix × passFailForSchool integration", () => {
    const slot: ScheduleSlot = { kind: "in_progress", courseId: "CS-UY 1134" } as any;
    // "2026-10-15" is past the add/drop deadline (2026-09-15) and inside the
    // withdraw window (before 2026-11-26) — the withdraw_pf window.
    const now = new Date("2026-10-15T00:00:00Z");
    const dpr = ipDpr("CS-UY 1134");

    it("Tandon in withdraw_pf window → allowed.passFail === false (button pre-disabled)", () => {
        const pf = passFailForSchool("tandon");
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr,
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: pf,
            now,
        });
        expect(m.allowed.passFail).toBe(false);
        // reason must explain the school policy
        expect(m.perAction.passFail.reason).toMatch(/can'?t elect|cannot elect|doesn'?t let you elect/i);
    });

    it("Tandon in withdraw_pf window → allowed.withdraw is still true (W unaffected)", () => {
        const pf = passFailForSchool("tandon");
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr,
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: pf,
            now,
        });
        expect(m.allowed.withdraw).toBe(true);
    });

    it("CAS in withdraw_pf window → allowed.passFail === true (button enabled)", () => {
        const pf = passFailForSchool("cas");
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr,
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: pf,
            now,
        });
        expect(m.allowed.passFail).toBe(true);
    });

    it("unknown school (undefined passFail) in withdraw_pf window → allowed.passFail === true (not explicitly blocked)", () => {
        const pf = passFailForSchool("unknown_xyz");
        const m = slotActionMatrix({
            slot,
            term: "2026-fall",
            dpr,
            campus: "ny",
            calendar: NYU_ACADEMIC_CALENDAR,
            passFail: pf, // undefined → not explicitly false
            now,
        });
        expect(m.allowed.passFail).toBe(true);
    });
});
