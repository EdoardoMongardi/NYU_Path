import { describe, it, expect } from "vitest";
import { checkPassFailLimits } from "../../src/agent/forwardSchedule/passFailLimitAxis.js";
import type { PassFailConfig } from "@nyupath/shared";

const credits32: PassFailConfig = { careerLimitType: "credits", careerLimitValue: 32 };
const courses4: PassFailConfig  = { careerLimitType: "courses", careerLimitValue: 4 };
const pct25: PassFailConfig     = { careerLimitType: "percent_of_program", careerLimitValue: 25 };
const noCap: PassFailConfig     = { careerLimitType: "credits", careerLimitValue: null };

/** Build a DPR with `pCourses` grade-"P" rows. By default the rows are ELECTED
 *  (passFailElected:true) so they exercise the HARD career-courses-cap path;
 *  pass `elected=false` to model NATIVE / historical P/F (PE, labs) that must
 *  NOT be counted against the cap. */
function dprWithPf(usedUnits: number, pCourses = 0, elected = true) {
    return {
        cumulative: { passFailUsedUnits: usedUnits, passFailCapUnits: 32, creditsRequired: 128 },
        courseHistory: Array.from({ length: pCourses }, (_, i) => ({ subject: "X", catalogNbr: `${i}`, grade: "P", type: "EN", units: 4, term: "2024 Fall", courseTitle: `Course ${i}`, passFailElected: elected })),
    } as any;
}

/** Build a DPR whose courseHistory carries one grade-"P" row per entry in
 *  `pRows` ({term, elected?}); a `null`/omitted term means an unparseable term
 *  string. `elected` defaults to true (an ELECTED P/F WE made → counted);
 *  set `elected:false` to model a native / historical P that must NOT count. */
function dprWithPfRows(
    pRows: Array<{ term: string | null; elected?: boolean }>,
    usedUnits = 0,
) {
    return {
        cumulative: { passFailUsedUnits: usedUnits, passFailCapUnits: 32, creditsRequired: 128 },
        courseHistory: pRows.map((r, i) => ({
            subject: "X",
            catalogNbr: `${i}`,
            grade: "P",
            type: "EN",
            units: 4,
            term: r.term ?? "??unparseable??",
            courseTitle: `Course ${i}`,
            passFailElected: r.elected ?? true,
        })),
    } as any;
}

describe("checkPassFailLimits (8th axis)", () => {
    it("credits cap not exceeded → pass", () => {
        expect(checkPassFailLimits(dprWithPf(28), credits32).status).toBe("pass");
    });
    it("credits cap exceeded → fail", () => {
        const r = checkPassFailLimits(dprWithPf(36), credits32);
        expect(r.status).toBe("fail");
        expect((r as any).reason).toMatch(/32/);
    });
    it("courses cap exceeded (5 P rows > 4) → fail", () => {
        expect(checkPassFailLimits(dprWithPf(0, 5), courses4).status).toBe("fail");
    });
    it("courses cap not exceeded (3 P rows ≤ 4) → pass", () => {
        expect(checkPassFailLimits(dprWithPf(0, 3), courses4).status).toBe("pass");
    });
    it("percent_of_program → requires-approval (unit-ambiguous, never hard fail)", () => {
        expect(checkPassFailLimits(dprWithPf(40), pct25).status).toBe("requires-approval");
    });
    it("null cap → assumed-pass + hedge (never blocks)", () => {
        const r = checkPassFailLimits(dprWithPf(40), noCap);
        expect(r.status).toBe("assumed-pass");
    });
    it("no passFail config → pass (axis is opt-in)", () => {
        expect(checkPassFailLimits(dprWithPf(40), undefined).status).toBe("pass");
    });
});

// ---------------------------------------------------------------------------
// Per-term P/F limit (Plan 37 follow-up — perTermLimit / perTermUnit).
// ---------------------------------------------------------------------------

// A CAS-style config: 1 P/F course per SEMESTER, generous career cap.
const semesterLimit1: PassFailConfig = {
    careerLimitType: "credits",
    careerLimitValue: 32,
    perTermLimit: 1,
    perTermUnit: "semester",
};

// A Stern/Gallatin-style config: 1 P/F course per ACADEMIC YEAR.
const academicYearLimit1: PassFailConfig = {
    careerLimitType: "courses",
    careerLimitValue: 8,
    perTermLimit: 1,
    perTermUnit: "academic_year",
};

describe("checkPassFailLimits — per-term limit (perTermUnit:'semester')", () => {
    it("2 grade-'P' rows in the SAME term → fail (per-term exceeded)", () => {
        const r = checkPassFailLimits(
            dprWithPfRows([{ term: "2026 Fall" }, { term: "2026 Fall" }]),
            semesterLimit1,
        );
        expect(r.status).toBe("fail");
        expect((r as any).reason).toMatch(/2026 Fall/);
        expect((r as any).reason).toMatch(/1 per term/);
    });

    it("1 P-row per term across 2 DIFFERENT terms → pass", () => {
        const r = checkPassFailLimits(
            dprWithPfRows([{ term: "2026 Fall" }, { term: "2027 Spring" }]),
            semesterLimit1,
        );
        expect(r.status).toBe("pass");
    });

    it("the common single-election case (1 P-row) → pass (no false-fire)", () => {
        const r = checkPassFailLimits(dprWithPfRows([{ term: "2026 Fall" }]), semesterLimit1);
        expect(r.status).toBe("pass");
    });

    it("accepts the '2024 Spr' display abbreviation when grouping by semester", () => {
        const r = checkPassFailLimits(
            dprWithPfRows([{ term: "2024 Spr" }, { term: "2024 Spr" }]),
            semesterLimit1,
        );
        expect(r.status).toBe("fail");
    });
});

describe("checkPassFailLimits — per-term limit (perTermUnit:'academic_year')", () => {
    it("2 P-rows in the SAME academic year (Fall 2026 + Spring 2027) → fail", () => {
        // NYU academic year: Fall 2026 opens AY2026; Spring 2027 belongs to AY2026.
        const r = checkPassFailLimits(
            dprWithPfRows([{ term: "2026 Fall" }, { term: "2027 Spring" }]),
            academicYearLimit1,
        );
        expect(r.status).toBe("fail");
        expect((r as any).reason).toMatch(/academic year 2026/);
        expect((r as any).reason).toMatch(/1 per academic year/);
    });

    it("the same 2 P-rows split across DIFFERENT academic years → pass", () => {
        // Spring 2026 belongs to AY2025; Fall 2026 opens AY2026 → different years.
        const r = checkPassFailLimits(
            dprWithPfRows([{ term: "2026 Spring" }, { term: "2026 Fall" }]),
            academicYearLimit1,
        );
        expect(r.status).toBe("pass");
    });

    it("a January term groups with the prior Fall's academic year (Fall 2026 + January 2027 → AY2026, fail)", () => {
        const r = checkPassFailLimits(
            dprWithPfRows([{ term: "2026 Fall" }, { term: "2027 J-Term" }]),
            academicYearLimit1,
        );
        expect(r.status).toBe("fail");
        expect((r as any).reason).toMatch(/academic year 2026/);
    });
});

describe("checkPassFailLimits — per-term limit hedges on unreliable terms", () => {
    it("2 P-rows with NO parseable term + a perTermLimit set → does NOT hard-fail (hedge)", () => {
        const r = checkPassFailLimits(
            dprWithPfRows([{ term: null }, { term: null }]),
            semesterLimit1,
        );
        // Career cap is comfortably met (0 used) → the un-groupable per-term rows
        // must NOT escalate to a fail.
        expect(r.status).not.toBe("fail");
        expect(r.status).toBe("pass");
    });

    it("mix of one parseable + one unparseable in the same term → only the parseable counts (no false fail under the limit)", () => {
        const r = checkPassFailLimits(
            dprWithPfRows([{ term: "2026 Fall" }, { term: null }]),
            semesterLimit1,
        );
        // Only 1 reliably-grouped P-row in 2026 Fall ≤ limit 1 → pass.
        expect(r.status).toBe("pass");
    });
});

describe("checkPassFailLimits — career + per-term combine (worse status wins)", () => {
    it("career cap fail is preserved (credit phrasing) even when per-term also fails", () => {
        // 36 used > 32 cap (career fail) AND 2 P-rows in one term (per-term fail).
        const r = checkPassFailLimits(
            dprWithPfRows([{ term: "2026 Fall" }, { term: "2026 Fall" }], 36),
            semesterLimit1,
        );
        expect(r.status).toBe("fail");
        // Career-credit phrasing is kept (preferred when the career cap fails).
        expect((r as any).reason).toMatch(/career limit/);
    });

    it("a per-term violation ESCALATES an otherwise-passing career result to fail", () => {
        // 8 used ≤ 32 cap (career pass) but 2 P-rows in one term → per-term fail.
        const r = checkPassFailLimits(
            dprWithPfRows([{ term: "2026 Fall" }, { term: "2026 Fall" }], 8),
            semesterLimit1,
        );
        expect(r.status).toBe("fail");
        expect((r as any).reason).toMatch(/per term/);
    });

    it("existing axis tests with NO perTermLimit are unaffected: 5 P-rows in one term + courses4 (no perTermLimit) → career-only fail", () => {
        // courses4 has no perTermLimit → gate off; 5 > 4 career-course cap → fail.
        const r = checkPassFailLimits(dprWithPf(0, 5), courses4);
        expect(r.status).toBe("fail");
        expect((r as any).reason).toMatch(/career limit/);
    });

    it("no perTermLimit + many same-term P-rows under the career cap → pass (gate truly off)", () => {
        // 3 P-rows all in 2024 Fall, courses4 (cap 4, no perTermLimit) → pass.
        expect(checkPassFailLimits(dprWithPf(0, 3), courses4).status).toBe("pass");
    });
});

// ---------------------------------------------------------------------------
// FALSE-FIRE REGRESSION (c261395 follow-up): a grade-"P" row that is NATIVE /
// historical (passFailElected absent/false) must NOT be counted against the
// per-term or career-COURSES cap. The DPR conflates elected P/F with natively-
// P/F courses (PE, 0-credit seminars, labs) — both show grade:"P" — so the
// limit checks count ONLY rows we KNOW are elected (D-4).
// ---------------------------------------------------------------------------

describe("checkPassFailLimits — native / historical P does NOT false-fire", () => {
    it("PER-TERM: 2 NATIVE grade-'P' rows in one term + perTermLimit:1 → pass (NOT fail)", () => {
        // e.g. a student with 2 PE courses in one term: both grade "P", neither
        // ELECTED. Previously counted → false INFEASIBLE; now uncounted → pass.
        const r = checkPassFailLimits(
            dprWithPfRows([
                { term: "2026 Fall", elected: false },
                { term: "2026 Fall", elected: false },
            ]),
            semesterLimit1,
        );
        expect(r.status).toBe("pass");
    });

    it("PER-TERM: 1 ELECTED + 1 NATIVE in the same term + perTermLimit:1 → pass (only the elected one counts)", () => {
        const r = checkPassFailLimits(
            dprWithPfRows([
                { term: "2026 Fall", elected: true },
                { term: "2026 Fall", elected: false },
            ]),
            semesterLimit1,
        );
        expect(r.status).toBe("pass");
    });

    it("PER-TERM: 2 ELECTED in the same term still HARD-fails (the genuine case)", () => {
        const r = checkPassFailLimits(
            dprWithPfRows([
                { term: "2026 Fall", elected: true },
                { term: "2026 Fall", elected: true },
            ]),
            semesterLimit1,
        );
        expect(r.status).toBe("fail");
    });

    it("CAREER-COURSES: 5 NATIVE grade-'P' rows over the 4-course cap → pass (NOT fail)", () => {
        // A Stern student with PE / native-P courses: grade-"P" count would be
        // > 4, but none are ELECTED → must NOT fail the courses cap.
        const r = checkPassFailLimits(dprWithPf(0, 5, /* elected */ false), courses4);
        expect(r.status).toBe("pass");
    });

    it("CAREER-COURSES: 5 ELECTED grade-'P' rows over the 4-course cap still fails", () => {
        const r = checkPassFailLimits(dprWithPf(0, 5, /* elected */ true), courses4);
        expect(r.status).toBe("fail");
    });

    it("CAREER-CREDITS is unaffected by the flag: passFailUsedUnits drives it (authoritative elected total)", () => {
        // The credits cap reads cumulative.passFailUsedUnits (registrar elected
        // total), so it fires regardless of per-row passFailElected flags.
        expect(checkPassFailLimits(dprWithPf(36, 0), credits32).status).toBe("fail");
    });
});
