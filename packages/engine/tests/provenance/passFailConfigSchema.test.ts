import { describe, it, expect } from "vitest";
import { passFailConfigSchema } from "../../src/provenance/configSchema.js";

describe("passFailConfigSchema — careerLimitValue", () => {
    it("accepts a numeric career-limit value", () => {
        const r = passFailConfigSchema.safeParse({ careerLimitType: "credits", careerLimitValue: 32 });
        expect(r.success).toBe(true);
    });
    it("accepts null (no sourced cap → hedge)", () => {
        const r = passFailConfigSchema.safeParse({ careerLimitType: "credits", careerLimitValue: null });
        expect(r.success).toBe(true);
    });
    it("accepts the field being absent (back-compat)", () => {
        const r = passFailConfigSchema.safeParse({ careerLimitType: "credits" });
        expect(r.success).toBe(true);
    });
    it("rejects a non-number, non-null value", () => {
        const r = passFailConfigSchema.safeParse({ careerLimitType: "credits", careerLimitValue: "32" });
        expect(r.success).toBe(false);
    });
});
