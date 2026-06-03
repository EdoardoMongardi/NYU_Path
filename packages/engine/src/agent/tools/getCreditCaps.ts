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
import type { SuggestedFollowUp } from "../toolEnvelope.js";
import {
    DEFAULT_F1_FULLTIME_MIN_CREDITS,
    perSemesterCeilingFor,
    schoolDisplayName,
} from "../../data/schoolDefaults.js";

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
        // Phase E (de-CAS) — no longer hard-require schoolConfig. The
        // authoritative caps (degree total, GPA floor, residency, P/F cap,
        // cross-school cap, time limit) come from the student's DPR, which
        // is already specialized to their school + catalog year. The two
        // DPR-absent registration constants (per-semester ceiling, F-1
        // floor) fall back to a shared NYU-undergrad default. So the tool
        // runs with EITHER a schoolConfig OR a DPR; only reject when both
        // are missing (no source for any cap at all).
        if (!session.schoolConfig && !session.degreeProgressReport) {
            return { ok: false, userMessage: "No school config or DPR loaded — I can't determine your credit caps." };
        }
        return { ok: true };
    },
    prompt: () =>
        `Return the home-school credit caps (per-semester ceiling, ` +
        `cross-school cap, transfer cap) plus the F-1 floor when the ` +
        `student is on an F-1 visa. Read-only data lookup.`,
    async call(_input, { session }) {
        const student = session.student!;
        const cfg = session.schoolConfig ?? null;
        const dpr = session.degreeProgressReport?.cumulative ?? null;
        const isF1 = student.visaStatus === "f1";

        // Per-semester ceiling + F-1 floor are NOT in the DPR — keep them
        // from the authored config when present, else the shared
        // NYU-undergrad default (school-agnostic).
        const perSemesterCeiling = cfg?.maxCreditsPerSemester ?? perSemesterCeilingFor(student.homeSchool);
        const overloadRequirements = cfg?.overloadRequirements ?? [];
        const creditCaps = cfg?.creditCaps ?? [];
        const transferCreditLimits = cfg?.transferCreditLimits ?? null;

        // Phase E — degree total + GPA floor come from the DPR cumulative
        // block FIRST (per-student, authoritative, already specialized to
        // the student's school + catalog year), falling back to the
        // authored config only when the DPR omits the field.
        const totalCreditsRequired = dpr?.creditsRequired ?? cfg?.totalCreditsRequired ?? null;
        const overallGpaMin = dpr?.cumulativeGpaRequired ?? cfg?.overallGpaMin ?? null;
        const capsSource = dpr ? (cfg ? "dpr+config" : "dpr") : "config";

        const result: {
            schoolId: string;
            schoolName: string;
            perSemesterCeiling: number | null;
            f1FullTimeFloor: number | null;
            visaStatus: string;
            overloadRequirements: typeof overloadRequirements;
            crossSchoolCaps: typeof creditCaps;
            transferCreditLimits: typeof transferCreditLimits;
            totalCreditsRequired: number | null;
            overallGpaMin: number | null;
            // Phase E — caps the DPR carries per-student (school-agnostic).
            residencyRequired: number | null;
            passFailCapUnits: number | null;
            outsideHomeCapUnits: number | null;
            timeLimitYears: number | null;
            capsSource: string;
            suggestedFollowUps?: SuggestedFollowUp[];
        } = {
            schoolId: cfg?.schoolId ?? student.homeSchool,
            schoolName: cfg?.name ?? schoolDisplayName(student.homeSchool),
            perSemesterCeiling,
            f1FullTimeFloor: isF1 ? (cfg?.f1FullTimeMinCredits ?? DEFAULT_F1_FULLTIME_MIN_CREDITS) : null,
            visaStatus: student.visaStatus ?? "domestic",
            overloadRequirements,
            crossSchoolCaps: creditCaps,
            transferCreditLimits,
            totalCreditsRequired,
            overallGpaMin,
            residencyRequired: dpr?.residencyRequired ?? null,
            passFailCapUnits: dpr?.passFailCapUnits ?? null,
            outsideHomeCapUnits: dpr?.outsideHomeCapUnits ?? null,
            timeLimitYears: dpr?.timeLimitYears ?? null,
            capsSource,
        };

        // Phase 12.5 Task 5 — when DPR is loaded, the bulletin + OGS policy
        // text is the authoritative source for F-1 floor and credit-cap
        // *explanations* (this tool returns the numbers, but bulletin language
        // carries the policy detail). Suggest a follow-up so the agent chains
        // automatically instead of receiving a hard rejection and retrying.
        if (session.degreeProgressReport) {
            result.suggestedFollowUps = [
                {
                    tool: "search_policy",
                    args: { query: "F-1 full-time minimum credit-load policy" },
                    why: "Bulletin + OGS policy text covers F-1 minimum, RCL, and per-semester ceiling questions in detail. This tool returned the numeric caps; search_policy provides the policy reasoning.",
                },
            ];
        }

        return result;
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
        if (out.overallGpaMin !== null) {
            lines.push(`Overall GPA min: ${out.overallGpaMin}`);
        }
        // Phase E — per-student caps the DPR carries (school-agnostic).
        if (out.residencyRequired !== null) {
            lines.push(`Residency required: ${out.residencyRequired} credits in residence`);
        }
        if (out.passFailCapUnits !== null) {
            lines.push(`Pass/Fail career cap: ${out.passFailCapUnits} units`);
        }
        if (out.outsideHomeCapUnits !== null) {
            lines.push(`Outside-home-school cap: ${out.outsideHomeCapUnits} units`);
        }
        if (out.timeLimitYears !== null) {
            lines.push(`Degree time limit: ${out.timeLimitYears} years`);
        }
        lines.push(`(caps source: ${out.capsSource})`);
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
