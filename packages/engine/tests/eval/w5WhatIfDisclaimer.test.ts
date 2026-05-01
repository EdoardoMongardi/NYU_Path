// ============================================================
// Phase 7-E W5 — what_if disclaimer end-to-end test
// ============================================================
// Verifies the verbatim_drift validator catches a what-if reply
// that paraphrases or omits the unauthored-program disclaimer.
// This is the gate that makes the disclaimer non-removable in
// production: even if the LLM tries to summarize it away, the
// validator rejects the reply.
// ============================================================

import { describe, expect, it } from "vitest";
import { validateResponse } from "../../src/agent/responseValidator.js";
import { whatIfAuditTool } from "../../src/agent/tools/whatIfAudit.js";
import { mkDpr } from "../helpers/mkDpr.js";
import type { ToolInvocation, ToolSession } from "../../src/index.js";

const ABORT = new AbortController().signal;

function dprSession(): ToolSession {
    return {
        student: {
            id: "test_student",
            catalogYear: "2024-2025",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "major" }],
            coursesTaken: [],
        },
        degreeProgressReport: mkDpr(),
    };
}

describe("W5 — what_if disclaimer survives the validator gate", () => {
    it("returns a verbatim disclaimer for unauthored programs", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["stern_finance_bs"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const verbatim = whatIfAuditTool.extractVerbatim?.(out);
        expect(verbatim).toBeTruthy();
        expect(verbatim).toMatch(/Verify with an academic adviser/);
    });

    // Both follow-up tests below include a stub `check_transfer_eligibility`
    // invocation so the unrelated invocation-auditor + transfer-caveat
    // rules don't fire (they trigger on the "internal transfer" wording
    // inside the disclaimer, which is the intended phrasing — we just
    // need the test to isolate the verbatim_drift signal).
    const TRANSFER_STUB: ToolInvocation = {
        toolName: "check_transfer_eligibility",
        args: { targetSchool: "stern" },
        summary:
            "GPA thresholds for internal transfer are not published; "
            + "decision is holistic. Confirm with the destination school.",
    };

    it("validator REJECTS a reply that paraphrases the disclaimer", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["stern_finance_bs"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const inv: ToolInvocation = {
            toolName: "what_if_audit",
            args: { hypotheticalPrograms: ["stern_finance_bs"] },
            summary: whatIfAuditTool.summarizeResult(out),
            verbatimText: whatIfAuditTool.extractVerbatim?.(out) ?? undefined,
        };
        const paraphrasedReply =
            "If you switched to Stern Finance, you'd need to consult an adviser. "
            + "I can't give you a precise audit estimate. "
            + "GPA thresholds for internal transfer are not published; talk to your adviser.";
        const verdict = validateResponse({
            assistantText: paraphrasedReply,
            invocations: [inv, TRANSFER_STUB],
            student: session.student!,
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some((v) => v.kind === "verbatim_drift")).toBe(true);
    });

    it("validator ACCEPTS a reply that includes the disclaimer verbatim", async () => {
        const session = dprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["stern_finance_bs"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const verbatim = whatIfAuditTool.extractVerbatim?.(out)!;
        const inv: ToolInvocation = {
            toolName: "what_if_audit",
            args: { hypotheticalPrograms: ["stern_finance_bs"] },
            summary: whatIfAuditTool.summarizeResult(out),
            verbatimText: verbatim,
        };
        const goodReply =
            `Considering Stern Finance: I don't have structured rules for that program. `
            + `${verbatim} `
            + `GPA thresholds for internal transfer are not published; consult your adviser. `
            + `Use search_policy to look up the bulletin requirements.`;
        const verdict = validateResponse({
            assistantText: goodReply,
            invocations: [inv, TRANSFER_STUB],
            student: session.student!,
        });
        expect(verdict.ok).toBe(true);
    });
});
