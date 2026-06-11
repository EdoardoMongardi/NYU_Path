// ============================================================
// D4 honesty-rail CORE RULES — explain-why/locked-vs-movable,
// risk-first, confidence+verify-with-adviser — plus the D4.3 banner
// count guard. These assert against buildSystemPrompt's emitted string
// (and the file's own source for the banner count).
// ============================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";

const here = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_SRC = resolve(here, "../../src/agent/systemPrompt.ts");

const baseStudent = {
    id: "u1",
    catalogYear: "2025-2026",
    declaredPrograms: [],
    coursesTaken: [],
};

/** Slice out just the numbered CORE RULES block (between the
 *  "CORE RULES" header and the blank line + "TOOL ROUTING:"). */
function coreRulesBlock(prompt: string): string {
    const start = prompt.indexOf("CORE RULES (mandatory");
    const end = prompt.indexOf("TOOL ROUTING:");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return prompt.slice(start, end);
}

/** Count lines that start a numbered rule. A rule line is `N. <text>` at
 *  column 0 of the CORE RULES block; continuation lines are indented and
 *  never start with `digit.`. Rule 2 opens with a quote ("I / my…") so we
 *  match any non-space after the number, not only `[A-Z]`. */
function numberedRuleCount(prompt: string): number {
    return coreRulesBlock(prompt)
        .split("\n")
        .filter((l) => /^\d+\.\s+\S/.test(l)).length;
}

describe("D4 honesty-rail CORE RULES", () => {
    const prompt = buildSystemPrompt({ student: { ...baseStudent, homeSchool: "cas" } });

    describe("D4.1 — EXPLAIN-WHY + LOCKED-VS-MOVABLE", () => {
        it("directs the agent to explain WHY each slot is placed, citing recorded rationale", () => {
            expect(prompt).toMatch(/explain why|why each|recorded rationale|view_forward_plan/i);
        });

        it("distinguishes locked vs in-progress vs movable slots", () => {
            expect(prompt).toMatch(/locked/i);
            expect(prompt).toMatch(/in progress/i);
            expect(prompt).toMatch(/movable/i);
        });

        it("points at view_forward_plan rich detail as the rationale source", () => {
            expect(prompt).toMatch(/view_forward_plan/);
            expect(prompt).toMatch(/rich/);
        });
    });

    describe("D4.2 — RISK & TRADE-OFFS ARE FIRST-CLASS", () => {
        it("makes risk and trade-offs a first-class directive", () => {
            expect(prompt).toMatch(/risk/i);
            expect(prompt).toMatch(/trade-?off/i);
        });

        it("applies to BOTH agent-proposed and student-proposed decisions", () => {
            // Tie the directive to both proposers.
            expect(prompt).toMatch(/agent-?proposed/i);
            expect(prompt).toMatch(/student-?proposed/i);
        });

        it("anchors the trade-off on the engine's computed diff, not an invented delta", () => {
            expect(prompt).toMatch(/propose_plan_change|probe_counterfactual/);
            expect(prompt).toMatch(/never invent (a |the )?delta|computed diff/i);
        });
    });

    describe("D4.4 — CONFIDENCE + VERIFY-WITH-ADVISER", () => {
        it("attaches a confidence signal scoped to non-99%-grounded conclusions", () => {
            expect(prompt).toMatch(/confidence/i);
            expect(prompt).toMatch(/99%|grounded/i);
        });

        it("tells the student to verify specific points with their human adviser", () => {
            expect(prompt).toMatch(/verify (it |this )?with (your )?adviser|verify with your adviser/i);
        });

        it("carries the non-CAS / CAS-approximated arm next to a verify-with-adviser instruction", () => {
            expect(prompt).toMatch(/CAS-approximated|non-CAS|Shanghai|Abu Dhabi/i);
            // The non-CAS arm must instruct verify-with-adviser, not narrate an
            // unqualified conclusion.
            const rule11 = prompt.slice(prompt.indexOf("11."));
            expect(rule11).toMatch(/CAS-approximated|non-CAS|Shanghai|Abu Dhabi/i);
            expect(rule11).toMatch(/verify.*adviser/i);
        });

        it("is DISTINCT from rule 6's Tier-2 estimate hedge (positive pointer, not a hedge dup)", () => {
            // Rule 6 owns the 'hedge with about/approximately' Tier-2 estimate
            // framing; rule 11 owns the explicit confidence + verify pointer.
            const block = coreRulesBlock(prompt);
            const rule6Idx = block.indexOf("6.");
            const rule11Idx = block.indexOf("11.");
            expect(rule6Idx).toBeGreaterThanOrEqual(0);
            expect(rule11Idx).toBeGreaterThan(rule6Idx);
        });

        it("present for a CAS student and for a non-CAS (Shanghai / Abu Dhabi) student", () => {
            for (const school of ["cas", "shanghai", "nyuad"]) {
                const p = buildSystemPrompt({ student: { ...baseStudent, homeSchool: school } });
                expect(p).toMatch(/confidence/i);
                expect(p).toMatch(/verify.*adviser/i);
                expect(p).toMatch(/CAS-approximated|non-CAS/i);
            }
        });
    });

    describe("D4.3 — banner count matches reality", () => {
        it("emits exactly 11 numbered CORE RULES", () => {
            expect(numberedRuleCount(prompt)).toBe(11);
        });

        it("the file's BANNER states a rule count EQUAL to the actual numbered-rule count", () => {
            const src = readFileSync(SYSTEM_PROMPT_SRC, "utf8");
            const actual = numberedRuleCount(prompt);
            // The banner must NOT claim the stale "25 rules" once the real
            // numbered list is 11. Derive: assert the actual count's number-word
            // appears in the banner and the stale 25 claim is gone.
            expect(actual).toBe(11);
            expect(src).toMatch(/\b11\b/);
            expect(src).not.toMatch(/25 rules|25-rule|25 rules verbatim/);
        });
    });
});
