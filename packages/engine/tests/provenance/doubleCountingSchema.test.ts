import { describe, expect, it } from "vitest";
import { validateSchoolConfigBody } from "../../src/provenance/configSchema.js";

// Minimal valid body the loader accepts; we only vary `doubleCounting`.
function bodyWith(doubleCounting: unknown) {
    return {
        schoolId: "test",
        name: "Test School",
        courseSuffix: ["-UA"],
        residency: { type: "suffix_based", suffix: "-UA" },
        doubleCounting,
    };
}

describe("doubleCounting config schema (cap + floor models)", () => {
    it("accepts a cap-model config (CAS-shape)", () => {
        const r = validateSchoolConfigBody(bodyWith({
            cap: { majorToMajor: 2, majorToMinor: 2, minorToMinor: 2 },
            noTripleCounting: true,
            requiresApproval: true,
            sourceRef: "arts-science/academic-policies/_index.md:126",
        }));
        expect(r.ok).toBe(true);
    });

    it("accepts a floor-model config (NYUAD-shape)", () => {
        const r = validateSchoolConfigBody(bodyWith({
            floor: { minDistinctCreditsPerMajor: 30, minUniqueCoursesPerMinor: 2 },
            noTripleCounting: true,
            requiresApproval: true,
            sourceRef: "abu-dhabi/academic-policies/_index.md:146",
        }));
        expect(r.ok).toBe(true);
    });

    it("accepts a hybrid cap+floor config (Shanghai-shape)", () => {
        const r = validateSchoolConfigBody(bodyWith({
            cap: { majorToMajor: 2 },
            floor: { minUniqueCreditsPerMinor: 12 },
            noTripleCounting: true,
            requiresApproval: true,
            sourceRef: "shanghai/academic-policies/_index.md:122",
        }));
        expect(r.ok).toBe(true);
    });

    it("rejects a config missing required noTripleCounting/requiresApproval/sourceRef", () => {
        const r = validateSchoolConfigBody(bodyWith({ cap: { majorToMajor: 2 } }));
        expect(r.ok).toBe(false);
    });

    it("accepts a body with no doubleCounting field at all (optional)", () => {
        const body = bodyWith(undefined);
        delete (body as Record<string, unknown>).doubleCounting;
        expect(validateSchoolConfigBody(body).ok).toBe(true);
    });
});
