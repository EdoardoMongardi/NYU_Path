// ============================================================
// CAS-1: deriveHomeSchool fallback + homeSchoolOverride threading
// ============================================================
// Task 1.5 TDD tests.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr } from "@nyupath/engine";
import { buildStudentProfileFromDpr } from "../lib/buildSession";
import type { DegreeProgressReport } from "@nyupath/engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);

function loadDpr(): DegreeProgressReport {
    const r = parseDpr(FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("parse failed");
    return r.report;
}

/**
 * Return a minimal valid DegreeProgressReport whose program labels match
 * no school indicator in the substring ladder (triggering the fallback).
 */
function makeUnderivableDpr(): DegreeProgressReport {
    const base = loadDpr();
    return {
        ...base,
        programs: [
            {
                programType: "Major",
                label: "Some Unknown Program Approved",
                requirementTerm: "Fall 2024",
                requirementStatus: "satisfied",
            },
        ],
    };
}

/**
 * Return a minimal valid DegreeProgressReport with a clearly CAS program label.
 */
function makeCasDpr(): DegreeProgressReport {
    const base = loadDpr();
    return {
        ...base,
        programs: [
            {
                programType: "Program",
                label: "UA-Coll of Arts & Sci",
                requirementTerm: "Fall 2024",
                requirementStatus: "satisfied",
            },
            {
                programType: "Major",
                label: "Computer Science Major Approved",
                requirementTerm: "Fall 2024",
                requirementStatus: "not_satisfied",
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deriveHomeSchool fallback — CAS-1", () => {
    it('underivable DPR yields homeSchool="unknown" (NOT "cas")', () => {
        const p = buildStudentProfileFromDpr(makeUnderivableDpr());
        expect(p.homeSchool).toBe("unknown");
        expect(p.homeSchool).not.toBe("cas");
    });

    it('explicit homeSchoolOverride="shanghai" is respected regardless of DPR labels', () => {
        // Use an underivable DPR to be sure the override wins over the fallback.
        const p = buildStudentProfileFromDpr(makeUnderivableDpr(), {
            homeSchoolOverride: "shanghai",
        });
        expect(p.homeSchool).toBe("shanghai");
    });

    it('explicit homeSchoolOverride="stern" beats a CAS-matching DPR label', () => {
        const p = buildStudentProfileFromDpr(makeCasDpr(), {
            homeSchoolOverride: "stern",
        });
        expect(p.homeSchool).toBe("stern");
    });

    it('derivable CAS DPR (label "UA-Coll of Arts & Sci") still yields "cas" (ladder unchanged)', () => {
        const p = buildStudentProfileFromDpr(makeCasDpr());
        expect(p.homeSchool).toBe("cas");
    });

    it('sample fixture DPR still yields "cas" (regression guard)', () => {
        const p = buildStudentProfileFromDpr(loadDpr());
        expect(p.homeSchool).toBe("cas");
    });
});
