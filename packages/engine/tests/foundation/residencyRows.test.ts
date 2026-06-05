// ============================================================
// DPR-6 — surface all residency rows incl. joint-major residency
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr } from "../../src/dpr/parser.js";

const FIXTURE = readFileSync(
    join(__dirname, "..", "fixtures", "dpr_sample.redacted.txt"),
    "utf-8",
);

function parse() {
    const r = parseDpr(FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error(`parse failed: ${r.error}`);
    return r.report;
}

describe("DPR-6 — residencyAll captures all residency rows", () => {
    it("residencyAll is defined on the cumulative object", () => {
        const c = parse().cumulative;
        expect(c.residencyAll).toBeDefined();
    });

    it("residencyAll contains R1001/35 (CAS residency)", () => {
        const c = parse().cumulative;
        const cas = c.residencyAll!.find((r) => r.rId === "R1001/35");
        expect(cas).toBeDefined();
        // The fixture has 64 required, 80 used for CAS residency
        expect(cas!.required).toBe(64);
        expect(cas!.used).toBe(80);
    });

    it("residencyAll contains R1142/80 (joint-major residency — previously invisible)", () => {
        const c = parse().cumulative;
        const joint = c.residencyAll!.find((r) => r.rId === "R1142/80");
        expect(joint).toBeDefined();
        // The fixture has 36 required, 56 used for joint-major residency
        expect(joint!.required).toBe(36);
        expect(joint!.used).toBe(56);
    });

    it("existing residencyRequired (from R1001/35) is unchanged", () => {
        const c = parse().cumulative;
        expect(c.residencyRequired).toBe(64);
    });

    it("existing residencyUsed (from R1001/35) is unchanged", () => {
        const c = parse().cumulative;
        expect(c.residencyUsed).toBe(80);
    });
});
