// ============================================================
// Phase D — validator treats Tier-2 estimates as estimates
// ============================================================
// A hedged INTEGER count reasoned from a non-high-confidence Tier-2 tool
// is exempt from the hard number-grounding rule — but only when it is
// (a) hedged, (b) backed by a Tier-2 estimate tool this turn, and the
// reply (c) carries the consult-adviser caveat. Tier-1 (DPR) numbers,
// decimals/GPAs, and unhedged counts stay hard-grounded.

import { describe, expect, it } from "vitest";
import { validateResponse } from "../../src/agent/responseValidator.js";

const PROGRAM_REQ_MEDIUM = {
    toolName: "get_program_requirements",
    args: { program: "economics" },
    // No bare "5" in the summary, so the estimate isn't trivially grounded.
    summary: "PROGRAM REQUIREMENTS — FULL PAGE (confidence=medium; scope=cas,all; override=false)\nMajor Requirements: complete the listed core and elective courses.",
};

describe("Tier-2 estimate grounding exemption (Phase D)", () => {
    it("EXEMPTS a hedged integer estimate backed by a Tier-2 tool + adviser caveat", () => {
        const verdict = validateResponse({
            assistantText:
                "Per the bulletin, you have about 5 requirements left for the Economics major. " +
                "This is an estimate — please confirm with your academic adviser.",
            invocations: [PROGRAM_REQ_MEDIUM],
        });
        expect(verdict.violations.some((v) => v.kind === "ungrounded_number" && v.number === "5")).toBe(false);
        // And the consult-adviser interlock is satisfied (no missing caveat).
        expect(
            verdict.violations.some(
                (v) => v.kind === "missing_caveat" && v.caveatId === "low_confidence_consult_adviser",
            ),
        ).toBe(false);
    });

    it("does NOT exempt when no Tier-2 estimate tool ran this turn", () => {
        const verdict = validateResponse({
            assistantText: "You have about 5 requirements left. Please consult your adviser.",
            invocations: [
                { toolName: "run_full_audit", args: {}, summary: "STANDING: good_standing; credits 90/128." },
            ],
        });
        expect(verdict.violations.some((v) => v.kind === "ungrounded_number" && v.number === "5")).toBe(true);
    });

    it("NEVER exempts a decimal/GPA, even hedged + Tier-2 (Tier-1 stays hard)", () => {
        const verdict = validateResponse({
            assistantText: "Your GPA is about 3.42. Please consult your adviser.",
            invocations: [PROGRAM_REQ_MEDIUM],
        });
        expect(verdict.violations.some((v) => v.kind === "ungrounded_number" && v.number === "3.42")).toBe(true);
    });

    it("does NOT exempt an UNHEDGED integer claim", () => {
        const verdict = validateResponse({
            assistantText: "You have 5 requirements left. Please consult your adviser.",
            invocations: [PROGRAM_REQ_MEDIUM],
        });
        expect(verdict.violations.some((v) => v.kind === "ungrounded_number" && v.number === "5")).toBe(true);
    });
});

describe("Tier-2 consult-adviser caveat (Phase D)", () => {
    it("REQUIRES a consult-adviser caveat when get_program_requirements is non-high confidence", () => {
        const verdict = validateResponse({
            assistantText: "Per the bulletin, the Economics major needs the listed core and elective courses.",
            invocations: [PROGRAM_REQ_MEDIUM],
        });
        expect(
            verdict.violations.some(
                (v) => v.kind === "missing_caveat" && v.caveatId === "low_confidence_consult_adviser",
            ),
        ).toBe(true);
    });

    it("satisfied when the reply directs the student to their adviser", () => {
        const verdict = validateResponse({
            assistantText: "Per the bulletin, the Economics major needs the listed courses. Please confirm with your academic adviser.",
            invocations: [PROGRAM_REQ_MEDIUM],
        });
        expect(
            verdict.violations.some(
                (v) => v.kind === "missing_caveat" && v.caveatId === "low_confidence_consult_adviser",
            ),
        ).toBe(false);
    });

    it("still fires for a low-confidence search_policy result (regression)", () => {
        const verdict = validateResponse({
            assistantText: "Here is what the bulletin says about pass/fail.",
            invocations: [
                { toolName: "search_policy", args: { query: "pass fail" }, summary: "RAG hits (confidence=low; scope=cas,all)" },
            ],
        });
        expect(
            verdict.violations.some(
                (v) => v.kind === "missing_caveat" && v.caveatId === "low_confidence_consult_adviser",
            ),
        ).toBe(true);
    });

    it("does NOT fire for a HIGH-confidence Tier-2 result", () => {
        const verdict = validateResponse({
            assistantText: "Per the bulletin, the Economics major requires these courses.",
            invocations: [
                {
                    toolName: "get_program_requirements",
                    args: {},
                    summary: "PROGRAM REQUIREMENTS — FULL PAGE (confidence=high; scope=cas,all; override=false)",
                },
            ],
        });
        expect(
            verdict.violations.some(
                (v) => v.kind === "missing_caveat" && v.caveatId === "low_confidence_consult_adviser",
            ),
        ).toBe(false);
    });
});
