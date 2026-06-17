import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseDpr } from "../../src/dpr/parser.js";

const FIXTURES = join(__dirname, "..", "fixtures");

describe("reportKind field on parsed DPR", () => {
    it("sets reportKind='what_if' when parsing a What-If report", () => {
        const text = readFileSync(join(FIXTURES, "dpr_whatif_sample.redacted.txt"), "utf-8");
        const r = parseDpr(text, { pageCount: 8, nowIso: "2026-06-05T00:00:00Z" });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.report.reportKind).toBe("what_if");
    });

    it("sets reportKind='dpr' when parsing a standard Degree Progress Report", () => {
        const text = readFileSync(join(FIXTURES, "dpr_sample.redacted.txt"), "utf-8");
        const r = parseDpr(text, { nowIso: "2026-06-05T00:00:00Z" });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.report.reportKind).toBe("dpr");
    });
});
