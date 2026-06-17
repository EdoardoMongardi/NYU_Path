// ============================================================
// pfEligibility — table-driven tests across all 11 home schools
// ============================================================
// RED PHASE: all tests fail until pfEligibility.ts is implemented.
//
// Covers:
//   - elective category: counts for any school where canElect !== false;
//     "unknown" for Tandon where canElect:false (students can't elect P/F)
//   - Gallatin/minor: "defer" (bulletin cites adviser consultation)
//   - Gallatin/major: "elective_only" (countsForMajor:false)
//   - Stern/major + Stern/minor: "counts" (the critical P/F-toward-major
//     exception, bulletin-cited, countsForMajor:true / countsForMinor:true)
//   - CAS/major + CAS/minor + CAS/gen_ed: "elective_only"
//   - Steinhardt/major: "unknown" (bulletin ambiguous; countsForMajor absent)
//   - SPS/major: "elective_only" (bulletin explicit elective-only;
//     countsForMajor:false set in sps.json as part of G1.2)
//   - tisch/tandon/liberal_studies/nursing/shanghai/nyuad /major → "elective_only"
//   - unknown school: "unknown"
// ============================================================

import { describe, it, expect } from "vitest";
import { pfEligibility } from "../../src/dpr/pfEligibility.js";

describe("pfEligibility", () => {
    // -------------------------------------------------------------------
    // ELECTIVE category
    // -------------------------------------------------------------------
    describe("category=elective", () => {
        it("cas/elective → counts (canElect:true)", () => {
            expect(pfEligibility("cas", "elective")).toBe("counts");
        });
        it("stern/elective → counts (canElect:true)", () => {
            expect(pfEligibility("stern", "elective")).toBe("counts");
        });
        it("gallatin/elective → counts (canElect:true)", () => {
            expect(pfEligibility("gallatin", "elective")).toBe("counts");
        });
        it("tandon/elective → unknown (canElect:false — students cannot elect P/F at all)", () => {
            expect(pfEligibility("tandon", "elective")).toBe("unknown");
        });
        it("tisch/elective → counts (canElect:true)", () => {
            expect(pfEligibility("tisch", "elective")).toBe("counts");
        });
        it("steinhardt/elective → counts (canElect not explicitly false)", () => {
            // Steinhardt's passFail block doesn't set canElect:false,
            // so students may elect; but where it lands is unknown.
            expect(pfEligibility("steinhardt", "elective")).toBe("counts");
        });
        it("liberal_studies/elective → counts (canElect:true)", () => {
            expect(pfEligibility("liberal_studies", "elective")).toBe("counts");
        });
        it("nursing/elective → counts (canElect:true)", () => {
            expect(pfEligibility("nursing", "elective")).toBe("counts");
        });
        it("nyuad/elective → counts (canElect:true)", () => {
            expect(pfEligibility("nyuad", "elective")).toBe("counts");
        });
        it("shanghai/elective → counts (canElect:true)", () => {
            expect(pfEligibility("shanghai", "elective")).toBe("counts");
        });
        it("sps/elective → counts (canElect not false)", () => {
            expect(pfEligibility("sps", "elective")).toBe("counts");
        });
    });

    // -------------------------------------------------------------------
    // MAJOR category
    // -------------------------------------------------------------------
    describe("category=major", () => {
        it("cas/major → elective_only (countsForMajor:false)", () => {
            expect(pfEligibility("cas", "major")).toBe("elective_only");
        });
        it("stern/major → counts (countsForMajor:true — the critical Stern exception)", () => {
            expect(pfEligibility("stern", "major")).toBe("counts");
        });
        it("gallatin/major → elective_only (countsForMajor:false)", () => {
            expect(pfEligibility("gallatin", "major")).toBe("elective_only");
        });
        it("tandon/major → elective_only (countsForMajor:false)", () => {
            expect(pfEligibility("tandon", "major")).toBe("elective_only");
        });
        it("tisch/major → elective_only (countsForMajor:false)", () => {
            expect(pfEligibility("tisch", "major")).toBe("elective_only");
        });
        it("steinhardt/major → unknown (countsForMajor absent; bulletin ambiguous)", () => {
            expect(pfEligibility("steinhardt", "major")).toBe("unknown");
        });
        it("liberal_studies/major → elective_only (countsForMajor:false)", () => {
            expect(pfEligibility("liberal_studies", "major")).toBe("elective_only");
        });
        it("nursing/major → elective_only (countsForMajor:false)", () => {
            expect(pfEligibility("nursing", "major")).toBe("elective_only");
        });
        it("nyuad/major → elective_only (countsForMajor:false)", () => {
            expect(pfEligibility("nyuad", "major")).toBe("elective_only");
        });
        it("shanghai/major → elective_only (countsForMajor:false)", () => {
            expect(pfEligibility("shanghai", "major")).toBe("elective_only");
        });
        it("sps/major → elective_only (countsForMajor:false; bulletin explicit elective-only)", () => {
            expect(pfEligibility("sps", "major")).toBe("elective_only");
        });
        it("unknown-school/major → unknown (fail-safe hedge)", () => {
            expect(pfEligibility("unknown_school_xyz", "major")).toBe("unknown");
        });
    });

    // -------------------------------------------------------------------
    // MINOR category
    // -------------------------------------------------------------------
    describe("category=minor", () => {
        it("cas/minor → elective_only (countsForMinor:false)", () => {
            expect(pfEligibility("cas", "minor")).toBe("elective_only");
        });
        it("stern/minor → counts (countsForMinor:true)", () => {
            expect(pfEligibility("stern", "minor")).toBe("counts");
        });
        it("gallatin/minor → defer (bulletin: 'students who have opted to complete a minor may not be able to fulfill the minor requirements with courses graded P; consult the department offering the minor')", () => {
            expect(pfEligibility("gallatin", "minor")).toBe("defer");
        });
        it("tandon/minor → elective_only (countsForMinor:false)", () => {
            expect(pfEligibility("tandon", "minor")).toBe("elective_only");
        });
        it("tisch/minor → elective_only (countsForMinor:false)", () => {
            expect(pfEligibility("tisch", "minor")).toBe("elective_only");
        });
        it("steinhardt/minor → unknown (countsForMinor absent)", () => {
            expect(pfEligibility("steinhardt", "minor")).toBe("unknown");
        });
        it("liberal_studies/minor → elective_only (countsForMinor:false)", () => {
            expect(pfEligibility("liberal_studies", "minor")).toBe("elective_only");
        });
        it("nursing/minor → unknown (countsForMinor absent in nursing)", () => {
            expect(pfEligibility("nursing", "minor")).toBe("unknown");
        });
        it("nyuad/minor → elective_only (countsForMinor:false)", () => {
            expect(pfEligibility("nyuad", "minor")).toBe("elective_only");
        });
        it("shanghai/minor → elective_only (countsForMinor:false)", () => {
            expect(pfEligibility("shanghai", "minor")).toBe("elective_only");
        });
        it("sps/minor → elective_only (countsForMinor:false; bulletin explicit elective-only)", () => {
            expect(pfEligibility("sps", "minor")).toBe("elective_only");
        });
        it("unknown-school/minor → unknown", () => {
            expect(pfEligibility("unknown_school_xyz", "minor")).toBe("unknown");
        });
    });

    // -------------------------------------------------------------------
    // GEN_ED category
    // -------------------------------------------------------------------
    describe("category=gen_ed", () => {
        it("cas/gen_ed → elective_only (countsForGenEd:false)", () => {
            expect(pfEligibility("cas", "gen_ed")).toBe("elective_only");
        });
        it("stern/gen_ed → unknown (countsForGenEd absent in stern.json)", () => {
            // Stern's passFail doesn't specify countsForGenEd → hedge.
            expect(pfEligibility("stern", "gen_ed")).toBe("unknown");
        });
        it("gallatin/gen_ed → unknown (countsForGenEd absent — Gallatin core reqs are sui generis)", () => {
            // Gallatin's passFail doesn't have countsForGenEd → hedge.
            expect(pfEligibility("gallatin", "gen_ed")).toBe("unknown");
        });
        it("tisch/gen_ed → elective_only (countsForGenEd:false)", () => {
            expect(pfEligibility("tisch", "gen_ed")).toBe("elective_only");
        });
        it("liberal_studies/gen_ed → elective_only (countsForGenEd:false)", () => {
            expect(pfEligibility("liberal_studies", "gen_ed")).toBe("elective_only");
        });
        it("nursing/gen_ed → elective_only (countsForGenEd:false)", () => {
            expect(pfEligibility("nursing", "gen_ed")).toBe("elective_only");
        });
        it("steinhardt/gen_ed → unknown (absent)", () => {
            expect(pfEligibility("steinhardt", "gen_ed")).toBe("unknown");
        });
        it("sps/gen_ed → elective_only (countsForGenEd:false; bulletin explicit elective-only)", () => {
            expect(pfEligibility("sps", "gen_ed")).toBe("elective_only");
        });
        it("unknown-school/gen_ed → unknown", () => {
            expect(pfEligibility("unknown_school_xyz", "gen_ed")).toBe("unknown");
        });
    });
});
