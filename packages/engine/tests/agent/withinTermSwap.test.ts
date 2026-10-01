// ============================================================
// withinTermSwap.test.ts — Phase 38 Phase B (within-term swap finder)
// ============================================================
// The rung-1 alternative finder: for a course with no schedulable
// section this term, find another course on the SAME requirement leaf
// that is offered + open this term (so the bridge can SWAP in-term
// instead of MOVING across terms). PURE given its deps (leaf siblings
// + an offered/open check); the live-FOSE check is injected.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    findWithinTermAlternatives,
    makeLeafSiblingsResolver,
} from "../../src/agent/sectionMaterialization/withinTermSwap.js";
import type { ForwardSchedule } from "@nyupath/shared";
import type { ToolSession } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

describe("findWithinTermAlternatives — B (pure)", () => {
    it("maps a failed course to its first same-leaf sibling that is offered + open this term", async () => {
        const deps = {
            leafSiblingsFor: (c: string) => (c === "CSCI-UA 421" ? ["CSCI-UA 453", "CSCI-UA 470"] : []),
            // 453 is closed this term; 470 is open.
            isOfferedAndOpen: async (c: string) => c === "CSCI-UA 470",
        };
        const alts = await findWithinTermAlternatives(["CSCI-UA 421"], "2026-fall", deps);
        expect(alts).toEqual({ "CSCI-UA 421": "CSCI-UA 470" });
    });

    it("omits a course with no offered+open sibling (falls through to a cross-term move)", async () => {
        const deps = {
            leafSiblingsFor: () => ["CSCI-UA 453"],
            isOfferedAndOpen: async () => false,
        };
        const alts = await findWithinTermAlternatives(["CSCI-UA 421"], "2026-fall", deps);
        expect(alts).toEqual({});
    });

    it("never returns the failed course itself as its own alternative", async () => {
        const deps = {
            leafSiblingsFor: (c: string) => [c, "CSCI-UA 470"], // includes itself
            isOfferedAndOpen: async () => true,
        };
        const alts = await findWithinTermAlternatives(["CSCI-UA 421"], "2026-fall", deps);
        expect(alts["CSCI-UA 421"]).toBe("CSCI-UA 470");
    });

    it("handles multiple failed courses independently", async () => {
        const deps = {
            leafSiblingsFor: (c: string) =>
                c === "A" ? ["A2"] : c === "B" ? ["B2"] : [],
            isOfferedAndOpen: async (c: string) => c === "A2", // only A has an open sibling
        };
        const alts = await findWithinTermAlternatives(["A", "B"], "2026-fall", deps);
        expect(alts).toEqual({ A: "A2" });
    });
});

describe("makeLeafSiblingsResolver — B (production factory, composes poolMembersFor)", () => {
    it("returns a deterministic resolver that does not throw on a minimal session", () => {
        const dpr = {
            _meta: { parserVersion: "1", parsedAt: "2026-01-01T00:00:00Z", sourceFingerprint: "sha256:t", sourcePdfPageCount: 1, parseDurationMs: 0, warnings: [] },
            header: { studentName: "T", preparedDate: "01/01/2026" },
            programs: [],
            advisorNotations: [],
            cumulative: {
                creditsRequired: 128, creditsUsed: 96, cumulativeGpa: 3.4, cumulativeGpaRequired: 2.0,
                residencyRequired: 64, residencyUsed: 64, passFailUsedUnits: 0, passFailCapUnits: 32,
                outsideHomeUsedUnits: 0, outsideHomeCapUnits: 16, timeLimitYears: 8,
            },
            requirementGroups: [],
            courseHistory: [],
        } as unknown as DegreeProgressReport;
        const plan = { graduationTerm: "2027-spring", semesters: [] } as unknown as ForwardSchedule;
        const session = {
            student: {
                id: "t", catalogYear: "2024", homeSchool: "cas",
                declaredPrograms: [{ programId: "computer_science", programType: "major" }],
                coursesTaken: [], visaStatus: "f1",
            },
            schoolConfig: {
                schoolId: "cas", name: "CAS", degreeType: "BA", courseSuffix: ["-UA"],
                totalCreditsRequired: 128, overallGpaMin: 2.0, acceptsTransferCredit: true,
                maxCreditsPerSemester: 18, f1FullTimeMinCredits: 12, residency: { minCredits: 64, note: null },
            },
            degreeProgressReport: dpr,
            forwardSchedule: plan,
        } as unknown as ToolSession;

        const resolver = makeLeafSiblingsResolver(session, dpr, plan);
        expect(typeof resolver).toBe("function");
        expect(Array.isArray(resolver("CSCI-UA 421"))).toBe(true);
    });
});
