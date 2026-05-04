import { describe, it, expect } from "vitest";
import { meetsGradeThreshold } from "../../src/dpr/gradeComparison";

describe("meetsGradeThreshold", () => {
    it("B meets C threshold", () =>
        expect(meetsGradeThreshold("B", "C")).toBe(true));
    it("C meets C threshold", () =>
        expect(meetsGradeThreshold("C", "C")).toBe(true));
    it("C- does NOT meet C threshold", () =>
        expect(meetsGradeThreshold("C-", "C")).toBe(false));
    it("A- meets B+ threshold", () =>
        expect(meetsGradeThreshold("A-", "B+")).toBe(true));
    it("D meets D threshold", () =>
        expect(meetsGradeThreshold("D", "D")).toBe(true));
    it("F never meets anything passing", () =>
        expect(meetsGradeThreshold("F", "D")).toBe(false));
    it("P credit-hour pass treated as C-equivalent (passes C threshold)", () =>
        expect(meetsGradeThreshold("P", "C")).toBe(true));
    it("P does NOT meet B threshold", () =>
        expect(meetsGradeThreshold("P", "B")).toBe(false));
    it("undefined student grade fails closed", () =>
        expect(meetsGradeThreshold(undefined, "D")).toBe(false));
    it("unknown letter fails closed", () =>
        expect(meetsGradeThreshold("Z", "C")).toBe(false));
    it("case-insensitive", () =>
        expect(meetsGradeThreshold("b+", "c-")).toBe(true));
    it("whitespace tolerance", () =>
        expect(meetsGradeThreshold("  B  ", " C ")).toBe(true));
});
