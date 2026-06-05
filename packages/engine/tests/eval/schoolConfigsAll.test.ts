// ============================================================
// Step 8c PR-B — all NYU undergraduate school configs validate
// ============================================================
// Guards that every school in data/schools/ loads cleanly through the
// strict loader (body + provenance _meta) and carries its real,
// school-specific policy values (not CAS defaults). The 8 non-CAS/Stern/
// Tandon configs were extracted from each school's bulletin
// academic-policies; bulletin-silent fields are flagged in _inferredFields.
// ============================================================

import { describe, expect, it } from "vitest";
import { loadSchoolConfigStrict } from "../../src/data/schoolConfigLoader.js";

const SCHOOLS = [
    "cas", "stern", "tandon", "tisch", "steinhardt", "gallatin",
    "liberal_studies", "sps", "nursing", "nyuad", "shanghai",
] as const;

describe("all school configs (Step 8c PR-B)", () => {
    it("every school config passes the strict loader (body + _meta)", () => {
        for (const s of SCHOOLS) {
            const r = loadSchoolConfigStrict(s);
            expect(r.ok, `${s} should validate: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
        }
    });

    it("each config carries its own course suffix", () => {
        const expected: Record<string, string> = {
            cas: "-UA", stern: "-UB", tandon: "-UY", tisch: "-UT",
            steinhardt: "-UE", gallatin: "-UG", liberal_studies: "-UF",
            sps: "-UC", nursing: "-UN", nyuad: "-UH", shanghai: "-SHU",
        };
        for (const s of SCHOOLS) {
            const r = loadSchoolConfigStrict(s);
            if (!r.ok) throw new Error(`${s} failed to load`);
            expect(r.config.courseSuffix).toContain(expected[s]);
            expect(r.config.residency?.suffix).toBe(expected[s]);
        }
    });

    it("carries real school-specific values (not flattened to CAS defaults)", () => {
        const get = (s: string) => {
            const r = loadSchoolConfigStrict(s);
            if (!r.ok) throw new Error(`${s} failed to load`);
            return r.config;
        };
        // Residency final-credits-in-residence genuinely varies by school.
        expect(get("gallatin").residency?.finalCreditsInResidence).toBe(32);
        // Pass/Fail policy *unit* varies (Stern counts courses, not credits).
        expect(get("stern").passFail?.careerLimitType).toBe("courses");
        expect(get("steinhardt").passFail?.careerLimitType).toBe("percent_of_program");
        // Dropped fields (Step 8c/8e) must NOT reappear on any config.
        for (const s of SCHOOLS) {
            const c = get(s) as Record<string, unknown>;
            expect(c.totalCreditsRequired).toBeUndefined();
            expect(c.timeLimitYears).toBeUndefined();
            expect(c.overallGpaMin).toBeUndefined();
            expect(c.doubleCounting).toBeUndefined();
            expect(c.gradeThresholds).toBeUndefined();
            // Replaced by completionRatePolicy (per-school) in the standing fix.
            expect(c.goodStandingReturnThreshold).toBeUndefined();
            expect((c.residency as Record<string, unknown>)?.minCredits).toBeUndefined();
            expect((c.passFail as Record<string, unknown>)?.careerLimit).toBeUndefined();
        }
    });

    it("completion-rate standing is per-school (verified policies only; CAS alone has the dismissal mechanic)", () => {
        const get = (s: string) => {
            const r = loadSchoolConfigStrict(s);
            if (!r.ok) throw new Error(`${s} failed to load`);
            return r.config;
        };
        // GPA-only / tiered schools publish NO completion-rate policy.
        for (const s of ["stern", "tandon", "steinhardt", "nursing"]) {
            expect(get(s).completionRatePolicy).toBeUndefined();
        }
        // CAS publishes the full policy incl. the hard pace-dismissal rule
        // (bulletin L494: <50% after 2 semesters).
        const cas = get("cas").completionRatePolicy;
        expect(cas?.goodStandingThreshold).toBe(0.75);
        expect(cas?.dismissalThreshold).toBe(0.5);
        expect(cas?.dismissalAfterSemesters).toBe(2);
        // Other completion-rate schools carry only a good-standing threshold
        // (bulletin-verified), and NO dismissal mechanic.
        const tisch = get("tisch").completionRatePolicy;
        expect(tisch?.goodStandingThreshold).toBe(0.5);
        expect(tisch?.dismissalThreshold).toBeUndefined();
        expect(get("gallatin").completionRatePolicy?.goodStandingThreshold).toBe(0.76);
    });
});
