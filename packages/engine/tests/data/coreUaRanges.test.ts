// ============================================================
// Phase 10 Stage 2 — coreUaRanges deterministic mapping tests
// ============================================================

import { describe, expect, it } from "vitest";
import {
    classifyCoreUa,
    detectCoreUaReferences,
    detectRequirementReferences,
    CORE_UA_RANGES,
} from "../../src/data/coreUaRanges.js";

describe("classifyCoreUa", () => {
    it("classifies the canonical hundreds-range examples", () => {
        expect(classifyCoreUa("CORE-UA 400")?.range?.requirement).toBe("Texts and Ideas");
        expect(classifyCoreUa("CORE-UA 499")?.range?.requirement).toBe("Texts and Ideas");
        expect(classifyCoreUa("CORE-UA 500")?.range?.requirement).toBe("Cultures and Contexts");
        expect(classifyCoreUa("CORE-UA 700")?.range?.requirement).toBe("Expressive Culture");
        expect(classifyCoreUa("CORE-UA 720")?.range?.requirement).toBe("Expressive Culture");
        expect(classifyCoreUa("CORE-UA 800")?.range?.requirement).toBe("Societies and the Social Sciences");
    });

    it("returns range=null for numbers outside any known range", () => {
        expect(classifyCoreUa("CORE-UA 100")?.range).toBeNull();
        expect(classifyCoreUa("CORE-UA 999")?.range).toBeNull();
        expect(classifyCoreUa("CORE-UA 600")?.range).toBeNull();
    });

    it("returns null for non-CORE-UA course ids", () => {
        expect(classifyCoreUa("CSCI-UA 101")).toBeNull();
        expect(classifyCoreUa("MATH-UA 121")).toBeNull();
    });

    it("is case-insensitive on the prefix", () => {
        expect(classifyCoreUa("core-ua 700")?.range?.requirement).toBe("Expressive Culture");
    });
});

describe("detectCoreUaReferences", () => {
    it("pulls out all CORE-UA codes mentioned in a query", () => {
        const cs = detectCoreUaReferences("Does CORE-UA 700 count, or does CORE-UA 800 work better?");
        expect(cs.map((c) => c.courseId)).toEqual(["CORE-UA 700", "CORE-UA 800"]);
    });

    it("dedupes repeated mentions of the same code", () => {
        const cs = detectCoreUaReferences("CORE-UA 700, CORE-UA 700, again CORE-UA 700");
        expect(cs).toHaveLength(1);
    });

    it("returns empty for queries without CORE-UA codes", () => {
        expect(detectCoreUaReferences("what's my GPA?")).toHaveLength(0);
    });
});

describe("detectRequirementReferences", () => {
    it("matches requirement names in queries", () => {
        const rs = detectRequirementReferences("does this satisfy Texts and Ideas?");
        expect(rs.map((r) => r.requirement)).toContain("Texts and Ideas");
    });

    it("works for all four ranges", () => {
        for (const r of CORE_UA_RANGES) {
            const matches = detectRequirementReferences(`is X a ${r.requirement} course?`);
            expect(matches.map((m) => m.requirement)).toContain(r.requirement);
        }
    });
});
