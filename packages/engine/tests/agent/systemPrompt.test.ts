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
        it("emits exactly 16 numbered CORE RULES", () => {
            expect(numberedRuleCount(prompt)).toBe(16);
        });

        it("the file's BANNER states a rule count EQUAL to the actual numbered-rule count", () => {
            const src = readFileSync(SYSTEM_PROMPT_SRC, "utf8");
            const actual = numberedRuleCount(prompt);
            // The banner must NOT claim the stale "25 rules" once the real
            // numbered list is 16. Derive: assert the actual count's number-word
            // appears in the banner and the stale 25 claim is gone.
            expect(actual).toBe(16);
            expect(src).toMatch(/\b16\b/);
            expect(src).not.toMatch(/25 rules|25-rule|25 rules verbatim/);
        });
    });

    describe("F2 — CORE RULE 14 (DPR-DERIVED FIELDS ARE AUTHORITATIVE / READ-ONLY)", () => {
        /** Slice rule 14 from its number to the end of the CORE RULES block. */
        function rule14(p: string): string {
            const block = coreRulesBlock(p);
            const idx = block.indexOf("14.");
            expect(idx).toBeGreaterThanOrEqual(0);
            return block.slice(idx);
        }

        it("names the DPR-derived fields that are authoritative + cannot be changed by request", () => {
            const r = rule14(prompt);
            expect(r).toMatch(/DPR-?derived|from (your |the )?DPR|authoritative/i);
            // The specific fields the owner enumerated.
            expect(r).toMatch(/home school/i);
            expect(r).toMatch(/major|minor|declared/i);
            expect(r).toMatch(/catalog year/i);
            expect(r).toMatch(/courses? taken|grades?/i);
        });

        it("redirects a change request to uploading a corrected/new DPR — never force-change, never fabricate", () => {
            const r = rule14(prompt);
            expect(r).toMatch(/upload (a )?(corrected|new) DPR|upload a (new|corrected)/i);
            expect(r).toMatch(/never (invent|fabricate)|do not (invent|fabricate)/i);
        });

        it("carves out the non-DPR editable fields (visa / F-1, preferences)", () => {
            const r = rule14(prompt);
            expect(r).toMatch(/visa|F-?1/i);
            expect(r).toMatch(/preferences?/i);
        });

        it("now emits exactly 16 numbered CORE RULES, and the banner agrees", () => {
            expect(numberedRuleCount(prompt)).toBe(16);
            const src = readFileSync(SYSTEM_PROMPT_SRC, "utf8");
            expect(src).toMatch(/\b16\b/);
        });
    });

    describe("F3 — CORE RULE 15 (CLAIMED CURRENT-TERM COURSE CHANGE IS UNVERIFIED)", () => {
        /** Slice rule 15 from its number to the start of rule 16. */
        function rule15(p: string): string {
            const block = coreRulesBlock(p);
            const idx = block.indexOf("15.");
            expect(idx).toBeGreaterThanOrEqual(0);
            const end = block.indexOf("16.", idx);
            return block.slice(idx, end >= 0 ? end : undefined);
        }

        it("frames a claimed current-term drop/withdraw/pass-fail as UNVERIFIED — a draft / what-if, not a recorded fact", () => {
            const r = rule15(prompt);
            expect(r).toMatch(/unverified/i);
            expect(r).toMatch(/draft|what-?if/i);
            expect(r).toMatch(/drop|withdraw|pass-?fail/i);
            // Must NOT record it as fact.
            expect(r).toMatch(/never (record|silently|fold)|not (a )?fact|never silently/i);
        });

        it("surfaces the registration window + the W / pass-fail consequences", () => {
            const r = rule15(prompt);
            expect(r).toMatch(/add\/?drop|withdraw|window/i);
            // A W does not fulfill the requirement.
            expect(r).toMatch(/\bW\b/);
            expect(r).toMatch(/does not fulfill|not fulfill the requirement/i);
            // Pass/fail may not satisfy a letter-grade major rule.
            expect(r).toMatch(/pass\/?fail|pass-?fail/i);
            expect(r).toMatch(/letter-?grade/i);
        });

        it("closes with verify-with-adviser + not-official-until-next-DPR", () => {
            const r = rule15(prompt);
            // The rule text wraps "verify with your" / "adviser" across lines,
            // so match across the newline ([\s\S], not `.`).
            expect(r).toMatch(/verify[\s\S]*adviser/i);
            expect(r).toMatch(/next DPR|on (your |a )?(new |next )?DPR|official until/i);
        });

        it("contrasts a future / pre-registered course as freely changeable planning", () => {
            const r = rule15(prompt);
            expect(r).toMatch(/future|pre-?registered/i);
            expect(r).toMatch(/freely changeable|pure planning|no real-world/i);
        });

        it("present for a CAS student and for a non-CAS (Shanghai / Abu Dhabi) student", () => {
            for (const school of ["cas", "shanghai", "nyuad"]) {
                const p = buildSystemPrompt({ student: { ...baseStudent, homeSchool: school } });
                const r = (() => {
                    const block = p.slice(p.indexOf("CORE RULES (mandatory"), p.indexOf("TOOL ROUTING:"));
                    return block.slice(block.indexOf("15."));
                })();
                expect(r).toMatch(/unverified/i);
                expect(r).toMatch(/verify[\s\S]*adviser/i);
            }
        });
    });

    describe("Plan 35 — CORE RULE 15 §6 (confirmable assumption) + CORE RULE 16 (what-if router)", () => {
        function rule16(p: string): string {
            const block = coreRulesBlock(p);
            const idx = block.indexOf("16.");
            expect(idx).toBeGreaterThanOrEqual(0);
            return block.slice(idx);
        }

        it("rule 15 now allows CONFIRMING the assumption as a plan — but never as a DPR fact", () => {
            const block = coreRulesBlock(prompt);
            const r = block.slice(block.indexOf("15."), block.indexOf("16."));
            expect(r).toMatch(/confirm/i);
            // ...but the DPR stays authoritative / the claim is never folded in.
            expect(r).toMatch(/never (fold|fabricate)|DPR stays authoritative|authoritative/i);
            // P/F is school-specific (not a blanket rule).
            expect(r).toMatch(/school-?specific|Stern/i);
        });

        it("rule 16 routes the three what-if branches", () => {
            const r = rule16(prompt);
            // (A) program change → upload the Albert What-If audit as an exploration.
            expect(r).toMatch(/program change|major|minor|school/i);
            expect(r).toMatch(/upload/i);
            expect(r).toMatch(/what-?if/i);
            // (B) grade-outcome → the what-if-assumption flow.
            expect(r).toMatch(/withdraw|pass-?fail/i);
            expect(r).toMatch(/propose_whatif_assumption|probe_counterfactual|assumption/i);
            // (C) anything else → confidence-disclaimed estimate tools.
            expect(r).toMatch(/estimate|what_if_audit|simulate_alternatives|policy search/i);
        });

        it("rule 16 present for CAS + non-CAS (Shanghai / Abu Dhabi) students", () => {
            for (const school of ["cas", "shanghai", "nyuad"]) {
                const p = buildSystemPrompt({ student: { ...baseStudent, homeSchool: school } });
                const block = p.slice(p.indexOf("CORE RULES (mandatory"), p.indexOf("TOOL ROUTING:"));
                const r = block.slice(block.indexOf("16."));
                expect(r).toMatch(/upload/i);
            }
        });
    });

    describe("D7.1 — CORE RULE 13 (PROACTIVE ELICITATION)", () => {
        it("teaches the agent to ANSWER first, then append ONE focused question", () => {
            const rule13 = prompt.slice(prompt.indexOf("13."), prompt.indexOf("TOOL ROUTING:"));
            expect(rule13).toMatch(/proactive/i);
            // Answer-first framing.
            expect(rule13).toMatch(/answer (the question )?first|answer first/i);
            // Exactly ONE bounded question.
            expect(rule13).toMatch(/one (focused |proactive )?question|at most one/i);
        });

        it("is bounded — never substitute the answer, never stack asks, never interrogate", () => {
            const rule13 = prompt.slice(prompt.indexOf("13."), prompt.indexOf("TOOL ROUTING:"));
            expect(rule13).toMatch(/never substitute|not substitute|do not substitute/i);
            expect(rule13).toMatch(/interrogate|quiz|sparingly/i);
        });

        it("names the decision-relevant context an adviser would elicit", () => {
            const rule13 = prompt.slice(prompt.indexOf("13."), prompt.indexOf("TOOL ROUTING:"));
            // At least the major/direction + a global-campus study-away cue.
            expect(rule13).toMatch(/major|direction|interest|career/i);
            expect(rule13).toMatch(/study-?away|Shanghai|Abu Dhabi|global/i);
        });
    });
});
