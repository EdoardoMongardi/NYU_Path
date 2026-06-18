import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseDpr } from "../../src/dpr/parser.js";

const FIXTURES = join(__dirname, "..", "fixtures");

describe("reportKind field on parsed DPR", () => {
    // The what_if case lives in whatIfParse.test.ts (which already parses the
    // same What-If fixture) to avoid a duplicate fixture read; here we pin the
    // standard-DPR case against its own fixture.
    it("sets reportKind='dpr' when parsing a standard Degree Progress Report", () => {
        const text = readFileSync(join(FIXTURES, "dpr_sample.redacted.txt"), "utf-8");
        const r = parseDpr(text, { nowIso: "2026-06-05T00:00:00Z" });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.report.reportKind).toBe("dpr");
    });
});
