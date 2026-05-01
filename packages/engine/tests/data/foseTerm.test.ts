// ============================================================
// Phase 10 Stage 2 — FOSE term-code encoding tests
// ============================================================

import { describe, expect, it } from "vitest";
import {
    encodeFoseTerm,
    decodeFoseTerm,
    foseTermLabel,
} from "../../src/data/foseTerm.js";

describe("encodeFoseTerm", () => {
    it("encodes the historical examples from the bulletin", () => {
        expect(encodeFoseTerm(2025, "spring")).toBe("1254");
        expect(encodeFoseTerm(2025, "fall")).toBe("1258");
        expect(encodeFoseTerm(2026, "fall")).toBe("1268");
        expect(encodeFoseTerm(2027, "spring")).toBe("1274");
        expect(encodeFoseTerm(2026, "summer")).toBe("1266");
    });

    it("rejects invalid years", () => {
        expect(() => encodeFoseTerm(1999, "fall")).toThrow();
        expect(() => encodeFoseTerm(2100, "fall")).toThrow();
    });
});

describe("decodeFoseTerm", () => {
    it("round-trips with encodeFoseTerm", () => {
        const cases: Array<[number, "spring" | "summer" | "fall"]> = [
            [2025, "spring"],
            [2026, "fall"],
            [2027, "spring"],
        ];
        for (const [year, term] of cases) {
            const code = encodeFoseTerm(year, term);
            const d = decodeFoseTerm(code);
            expect(d).toEqual({ year, term });
        }
    });

    it("returns null for malformed codes", () => {
        expect(decodeFoseTerm("9999")).toBeNull();
        expect(decodeFoseTerm("1255")).toBeNull(); // bad term digit
        expect(decodeFoseTerm("abcd")).toBeNull();
    });
});

describe("foseTermLabel", () => {
    it("renders human-readable labels", () => {
        expect(foseTermLabel("1268")).toBe("Fall 2026");
        expect(foseTermLabel("1274")).toBe("Spring 2027");
        expect(foseTermLabel("9999")).toBeNull();
    });
});
