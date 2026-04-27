// ============================================================
// what_if_audit (Phase 5 §7.2 + Phase 7-E W3.3)
// ============================================================
// Two paths:
//   1. Authored program path: when the hypothetical program is
//      already in `session.programs`, run the deterministic
//      `whatIfAudit()` engine against it. Same as Phase 5.
//   2. Unauthored program path (post-pivot): when the hypothetical
//      program isn't in the authored catalog, return a structured
//      "best-effort estimate" envelope that tells the student
//      we don't have rigorous rules for the hypothetical program
//      and points them at search_policy / their adviser. The
//      reply carries a non-removable disclaimer enforced via the
//      existing Step 15 verbatimText mechanism.
//
// Just-in-time bulletin extraction (the LLM-driven path that
// extracts a Program spec from bulletin chunks on-the-fly) is a
// W3.3 P2 follow-up. The minimal version here keeps the system
// honest: it never invents an audit verdict for a program we
// don't have structured rules for; it surfaces a clear estimate
// + caveat.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import { whatIfAudit } from "../../audit/whatIfAudit.js";
import type { WhatIfResult } from "../../audit/whatIfAudit.js";
import type { ProgramDeclaration } from "@nyupath/shared";

interface UnauthoredProgramEstimate {
    kind: "unauthored_program_estimate";
    requestedProgramIds: string[];
    /** Verbatim disclaimer the validator's verbatim_drift check
     *  enforces in the LLM's reply. */
    disclaimer: string;
    /** What the student CAN learn from the DPR + RAG corpus,
     *  even without rigorous rules for the hypothetical. */
    guidance: string;
}

type WhatIfOutput =
    | (WhatIfResult & { kind?: undefined })
    | UnauthoredProgramEstimate;

const DISCLAIMER =
    "This estimate is based on AI-extracted requirements from NYU's bulletin. " +
    "Verify with an academic adviser before applying for an internal transfer or program change.";

export const whatIfAuditTool = buildTool({
    name: "what_if_audit",
    description:
        "Runs a hypothetical audit with a different set of declared programs " +
        "(read-only — does NOT modify the student's profile). When the " +
        "hypothetical program is in the authored catalog, returns a " +
        "deterministic comparison. When it isn't, returns a structured " +
        "estimate with a non-removable disclaimer pointing the student " +
        "at the bulletin and an adviser. Use for 'what if I switched to X', " +
        "'compare X vs Y', 'should I add a minor in Z'.",
    inputSchema: z.object({
        hypotheticalPrograms: z.array(z.string())
            .describe("Program ids to hypothetically declare, e.g., ['cas_econ_ba', 'cas_math_minor']."),
        compareWithCurrent: z.boolean().default(true)
            .describe("If true, also runs the current declarations and produces a diff."),
    }),
    maxResultChars: 3000,
    // Phase 7-E W3.3 — semi_hardened: when we return an unauthored
    // estimate, the disclaimer must appear verbatim in the reply.
    outputMode: "semi_hardened",
    async validateInput(input, { session }) {
        if (!session.student) return { ok: false, userMessage: "I need your transcript / profile first." };
        if (input.hypotheticalPrograms.length === 0) {
            return { ok: false, userMessage: "hypotheticalPrograms must be non-empty." };
        }
        return { ok: true };
    },
    prompt: () =>
        `Run a hypothetical audit. Required: hypotheticalPrograms (array of program ids). ` +
        `Optional: compareWithCurrent (default true). Read-only — never modifies the profile. ` +
        `Returns deterministic comparison when programs are in the authored catalog; ` +
        `otherwise returns an estimate envelope with a non-removable disclaimer.`,
    async call(input, { session }): Promise<WhatIfOutput> {
        const allInCatalog = input.hypotheticalPrograms.every(
            (id) => session.programs?.has(id) ?? false,
        );

        // ---- Authored program path ----
        if (allInCatalog && session.programs && session.courses) {
            return whatIfAudit(
                session.student!,
                input.hypotheticalPrograms,
                session.programs,
                session.courses,
                session.schoolConfig ?? null,
                input.compareWithCurrent ?? true,
            );
        }

        // ---- Unauthored program path ----
        // Identify which requested IDs we lack and what we can offer
        // the student deterministically anyway (RAG over the bulletin
        // for the program's policy text + the student's DPR for
        // current state).
        const missing = input.hypotheticalPrograms.filter(
            (id) => !session.programs?.has(id),
        );

        let guidance = "";
        if (session.degreeProgressReport) {
            const dpr = session.degreeProgressReport;
            const credits = dpr.cumulative.creditsUsed ?? 0;
            const gpa = dpr.cumulative.cumulativeGpa ?? 0;
            const transfer = dpr.courseHistory.filter((c) => c.type === "TE").length;
            guidance =
                `Your current state from the DPR: ${credits} credits earned, ` +
                `cumulative GPA ${gpa.toFixed(3)}, ${transfer} transfer-credit row(s) recorded. ` +
                `Run search_policy for the hypothetical program's bulletin requirements; ` +
                `cross-reference your earned credits against those requirements; consult an adviser for the official audit.`;
        } else {
            guidance =
                `No DPR loaded — use search_policy to look up the hypothetical program's requirements ` +
                `in the bulletin, and consult an adviser for the official audit.`;
        }

        return {
            kind: "unauthored_program_estimate",
            requestedProgramIds: missing,
            disclaimer: DISCLAIMER,
            guidance,
        };
    },
    summarizeResult(result) {
        if ("kind" in result && result.kind === "unauthored_program_estimate") {
            const lines: string[] = [];
            lines.push(`WHAT-IF (estimate, no structured rules available)`);
            lines.push(`  Requested programs without authored rules: ${result.requestedProgramIds.join(", ")}`);
            lines.push(`  Guidance: ${result.guidance}`);
            // The disclaimer is also returned via extractVerbatim; it's
            // included in the summary so the model can see the exact
            // text it must include.
            lines.push(`  REQUIRED DISCLAIMER (must appear verbatim in your reply): ${result.disclaimer}`);
            return lines.join("\n");
        }
        // Authored-path result.
        const r = result as WhatIfResult;
        const lines: string[] = [];
        lines.push(`WHAT-IF: ${r.hypothetical.programs.length} program(s) hypothetically declared`);
        for (const entry of r.hypothetical.programs) {
            const a = entry.audit;
            const unmetCount = a.rules.filter((rr: { status: string }) => rr.status !== "satisfied").length;
            const decl = entry.declaration as ProgramDeclaration;
            lines.push(`  ${decl.programType.toUpperCase()} ${a.programName} — ${unmetCount} unmet rules, ${a.totalCreditsCompleted}/${a.totalCreditsRequired} credits`);
        }
        if (r.comparison) {
            const c = r.comparison;
            lines.push(`Comparison to current:`);
            lines.push(`  Courses transferable to hypothetical: ${c.coursesTransferred}`);
            lines.push(`  Net additional requirements remaining: ${c.additionalRequirementsRemaining}`);
            if (c.droppedPrograms.length > 0) lines.push(`  Dropped: ${c.droppedPrograms.join(", ")}`);
            if (c.addedPrograms.length > 0) lines.push(`  Added: ${c.addedPrograms.join(", ")}`);
        }
        if (r.warnings.length > 0) {
            lines.push(`Warnings: ${r.warnings.slice(0, 3).join(" | ")}`);
        }
        return lines.join("\n");
    },
    extractVerbatim(result) {
        // Only the unauthored-estimate path enforces a verbatim
        // disclaimer; authored-path results don't need one because
        // the verdict is deterministic.
        if ("kind" in result && result.kind === "unauthored_program_estimate") {
            return result.disclaimer;
        }
        return null;
    },
});
