// ============================================================
// get_credit_caps (Phase 6 WS7b — §7.1)
// ============================================================
// Returns the home-school's per-semester + cumulative credit caps,
// the F-1 full-time floor (when applicable), and the cross-school /
// transfer caps. Pure data lookup; no LLM, no tool-chaining.
//
// Architecture §7.1 lists `get_credit_caps` as a high-traffic helper
// the agent should call before any "credit load" / "overload" /
// "minimum credits" question (Appendix A rule #5: before discussing
// CREDIT COUNTS, GPA, GRADUATION PROGRESS, or SEMESTER PLANNING,
// call at minimum: get_academic_standing → get_credit_caps).
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";

const F1_FULLTIME_MIN_CREDITS = 12;

export const getCreditCapsTool = buildTool({
    name: "get_credit_caps",
    description:
        "Returns the home school's per-semester credit ceiling, the F-1 " +
        "full-time floor (when applicable), and any school-specific caps " +
        "(e.g., non-home-school credit cap, transfer-credit cap). Call " +
        "this before answering ANY question about credit load, overload " +
        "permissions, or full-time / part-time status (Appendix A rule #5).",
    inputSchema: z.object({}),
    isReadOnly: true,
    maxResultChars: 1500,
    // Phase 7-B Step 15 — semi_hardened: the per-semester ceiling and
    // F-1 floor are deterministic numbers the validator must guard.
    outputMode: "semi_hardened",
    async validateInput(_input, { session }) {
        if (!session.student) return { ok: false, userMessage: "No student profile loaded." };
        if (!session.schoolConfig) return { ok: false, userMessage: "School config not loaded." };
        return { ok: true };
    },
    prompt: () =>
        `Return the home-school credit caps (per-semester ceiling, ` +
        `cross-school cap, transfer cap) plus the F-1 floor when the ` +
        `student is on an F-1 visa. Read-only data lookup.`,
    async call(_input, { session }) {
        const student = session.student!;
        const cfg = session.schoolConfig!;
        const isF1 = student.visaStatus === "f1";

        const perSemesterCeiling = cfg.maxCreditsPerSemester ?? null;
        const overloadRequirements = cfg.overloadRequirements ?? [];
        const creditCaps = cfg.creditCaps ?? [];
        const transferCreditLimits = cfg.transferCreditLimits ?? null;

        return {
            schoolId: cfg.schoolId,
            schoolName: cfg.name,
            perSemesterCeiling,
            f1FullTimeFloor: isF1 ? F1_FULLTIME_MIN_CREDITS : null,
            visaStatus: student.visaStatus ?? "domestic",
            overloadRequirements,
            crossSchoolCaps: creditCaps,
            transferCreditLimits,
            totalCreditsRequired: cfg.totalCreditsRequired,
            overallGpaMin: cfg.overallGpaMin,
        };
    },
    summarizeResult(out) {
        const lines: string[] = [];
        lines.push(`SCHOOL: ${out.schoolName} (${out.schoolId})`);
        if (out.perSemesterCeiling !== null) {
            lines.push(`Per-semester ceiling: ${out.perSemesterCeiling} credits`);
        } else {
            lines.push(`Per-semester ceiling: not published — confirm with adviser`);
        }
        if (out.f1FullTimeFloor !== null) {
            lines.push(`F-1 full-time floor: ${out.f1FullTimeFloor} credits/semester (visaStatus=${out.visaStatus})`);
        }
        if (out.overloadRequirements.length > 0) {
            for (const req of out.overloadRequirements) {
                lines.push(`Overload requirement: ${JSON.stringify(req)}`);
            }
        }
        for (const cap of out.crossSchoolCaps) {
            lines.push(`Credit cap (${cap.type}): max ${cap.maxCredits} credits`);
        }
        if (out.transferCreditLimits) {
            lines.push(`Transfer credit limits: ${JSON.stringify(out.transferCreditLimits)}`);
        }
        if (out.totalCreditsRequired !== null) {
            lines.push(`Degree total: ${out.totalCreditsRequired} credits required`);
        }
        lines.push(`Overall GPA min: ${out.overallGpaMin}`);
        return lines.join("\n");
    },
    // Phase 7-B Step 15 — verbatim text the LLM must include
    // unchanged when it answers a credit-load question. We pin the
    // single most-load-bearing sentence (the ceiling); reasonable
    // synthesis around it is still allowed.
    extractVerbatim(out) {
        const fragments: string[] = [];
        if (out.perSemesterCeiling !== null) {
            fragments.push(
                `${out.schoolName} per-semester ceiling: ${out.perSemesterCeiling} credits.`,
            );
        }
        if (out.f1FullTimeFloor !== null) {
            fragments.push(
                `F-1 full-time floor: ${out.f1FullTimeFloor} credits per semester.`,
            );
        }
        return fragments.length > 0 ? fragments.join(" ") : null;
    },
});
