// ============================================================
// termLabel — psTermToSolverTerm normalizer behavior table (D5.1)
// ============================================================
// Pins the single canonical human-term → solver-term normalizer shared
// by buildSolverInput.ts AND responseValidator.ts's checkPlanClaims, so
// the prose-vs-stored-plan diff can't drift from the solver's term shape.

import { describe, expect, it } from "vitest";
import { psTermToSolverTerm } from "../../src/agent/forwardSchedule/termLabel.js";

describe("psTermToSolverTerm", () => {
    const table: Array<[string, string | null]> = [
        // canonical pass-through (any case)
        ["2027-fall", "2027-fall"],
        ["2027-FALL", "2027-fall"],
        // "Season YYYY" (prose form used in replies)
        ["Fall 2027", "2027-fall"],
        ["Spring 2028", "2028-spring"],
        ["Summer 2026", "2026-summer"],
        ["January 2026", "2026-january"],
        ["J Term 2026", "2026-january"],
        ["J-Term 2026", "2026-january"],
        // "YYYY Season" (PeopleSoft / DPR form)
        ["2026 Fall", "2026-fall"],
        ["2026 Spr", "2026-spring"],
        ["2026 Sum", "2026-summer"],
        // unrecognizable → null (never block on a guess)
        ["next fall", null],
        ["the following term", null],
        ["2026", null],
        ["", null],
    ];
    for (const [input, expected] of table) {
        it(`maps ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
            expect(psTermToSolverTerm(input)).toBe(expected);
        });
    }
});
