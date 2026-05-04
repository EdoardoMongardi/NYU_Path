import { describe, it, expect } from "vitest";
import { creditTargetForVisa, visaNotesForCredits } from "../../src/agent/forwardSchedule/visaPolicy";

describe("creditTargetForVisa", () => {
    it("returns 12 for F-1 (full-time floor)", () => {
        expect(creditTargetForVisa("f1")).toBe(12);
    });
    it("returns 16 for domestic", () => {
        expect(creditTargetForVisa("domestic")).toBe(16);
    });
    it("returns 16 for unknown / undefined visa (safe default)", () => {
        expect(creditTargetForVisa(undefined)).toBe(16);
        expect(creditTargetForVisa("other")).toBe(16);
    });
});

describe("visaNotesForCredits", () => {
    it("flags F-1 below floor as RCL-required", () => {
        const notes = visaNotesForCredits({ credits: 8, visa: "f1", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /F-?1/i.test(n) && /RCL/i.test(n))).toBe(true);
    });
    it("does NOT flag F-1 at or above floor", () => {
        const notes = visaNotesForCredits({ credits: 12, visa: "f1", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /RCL/i.test(n))).toBe(false);
    });
    it("flags domestic part-time enrollment between floor and full-time threshold", () => {
        const notes = visaNotesForCredits({ credits: 10, visa: "domestic", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /part-?time/i.test(n))).toBe(true);
    });
    it("flags credit-load below the part-time floor as below-minimum", () => {
        const notes = visaNotesForCredits({ credits: 4, visa: "domestic", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /below.*minimum/i.test(n))).toBe(true);
    });
});
