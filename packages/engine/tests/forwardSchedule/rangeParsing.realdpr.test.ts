/**
 * T5 — real-DPR integration test.
 *
 * Parses the redacted DPR fixture, pulls the unmet requirements, and
 * exercises extractCandidatesAndPool on the CORE-UA 400-499 leaf
 * (R1004/10 — Texts & Ideas, Not Satisfied per fixture line 233).
 *
 * Asserts:
 *   1. The range requirement yields pool={dept:"CORE-UA",levelMin:400,levelMax:499}
 *   2. candidateCourses does NOT contain the phantom "CORE-UA 400"
 *   3. No requirement with a pool has "DEPT levelMin" phantom in candidateCourses
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr } from "../../src/dpr/parser.js";
import { notSatisfiedRequirements } from "../../src/dpr/schema.js";
import { extractCandidatesAndPool } from "../../src/agent/forwardSchedule/buildSolverInput.js";

const FIXTURE_TEXT = readFileSync(
    join(__dirname, "..", "fixtures", "dpr_sample.redacted.txt"),
    "utf-8",
);

function parsedDpr() {
    const r = parseDpr(FIXTURE_TEXT, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error(`parse failed: ${r.error}`);
    return r.report;
}

describe("T5 — real DPR fixture: range requirements emit pool descriptors, not phantom courses", () => {
    it("R1004/10 (Texts & Ideas, CORE-UA 400-499) produces a pool descriptor and no phantom CORE-UA 400", () => {
        const dpr = parsedDpr();
        const unmetReqs = notSatisfiedRequirements(dpr.requirementGroups);

        // Locate the unmet Texts & Ideas leaf that carries the range
        const textsAndIdeas = unmetReqs.find(req => req.rId === "R1004/10");
        expect(textsAndIdeas).toBeDefined();

        const result = extractCandidatesAndPool(textsAndIdeas!);

        // Pool descriptor must be present with correct bounds
        expect(result.pool).toEqual({ dept: "CORE-UA", levelMin: 400, levelMax: 499 });

        // The phantom single-course MUST NOT appear in candidateCourses
        expect(result.candidateCourses).not.toContain("CORE-UA 400");
    });

    it("no requirement with a pool carries a phantom '<dept> <levelMin>' in candidateCourses", () => {
        const dpr = parsedDpr();
        const unmetReqs = notSatisfiedRequirements(dpr.requirementGroups);

        for (const req of unmetReqs) {
            const result = extractCandidatesAndPool(req);
            if (result.pool !== undefined) {
                const phantom = `${result.pool.dept} ${result.pool.levelMin}`;
                expect(result.candidateCourses).not.toContain(phantom);
            }
        }
    });
});
