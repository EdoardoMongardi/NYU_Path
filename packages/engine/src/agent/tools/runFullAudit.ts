// ============================================================
// run_full_audit (Phase 5 §7.2 + Phase 7-E W3.1)
// ============================================================
// Two paths:
//   1. DPR primary (post-pivot): when session.degreeProgressReport
//      is present, return NYU's pre-computed audit numbers as the
//      authoritative answer. The LLM does wording, not computation.
//   2. Authored-rules fallback: when no DPR is loaded, run the
//      deterministic rule engine against authored Program JSON
//      files. Used by the legacy onboarding path (transcript
//      upload), the just-in-time what-if backend, and the test
//      suite. Same shape returned to the agent either way.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import { degreeAudit } from "../../audit/degreeAudit.js";
import { calculateStanding, type StandingResult } from "../../audit/academicStanding.js";
import type { AuditResult } from "@nyupath/shared";
import {
    notSatisfiedRequirements,
    walkRequirements,
    type DegreeProgressReport,
} from "../../dpr/schema.js";
import { dprToAuditResults } from "../../dpr/dprToAuditResult.js";

interface RunFullAuditOutput {
    audits: AuditResult[];
    standing: StandingResult;
    /** Phase 7-E — flags whether the result came from the DPR primary
     *  path or the authored-rules fallback. The summarizer uses this
     *  to render different headlines + verbatim text. */
    source: "dpr" | "authored";
    /** When source=dpr, the DPR header date so the summarizer can
     *  surface staleness. */
    dprPreparedDate?: string;
    /** When source=dpr, the structured cumulative block from the DPR
     *  (residency, P/F, outside-CAS, time limit). Lets the summarizer
     *  + the agent surface specific budget numbers without rooting
     *  through the requirement tree. */
    dprCumulative?: {
        creditsRequired: number | null;
        creditsUsed: number | null;
        cumulativeGpa: number | null;
        residencyRequired: number | null;
        residencyUsed: number | null;
        passFailUsedUnits: number | null;
        passFailCapUnits: number | null;
        outsideHomeUsedUnits: number | null;
        outsideHomeCapUnits: number | null;
        timeLimitYears: number | null;
    };
    /** When source=dpr, the leaf Requirements that are NOT satisfied,
     *  rendered as { rId, title, description, counter }. Lets the
     *  summarizer name specific missing courses (e.g., "CSCI-UA 421")
     *  rather than just counting them. */
    dprUnsatisfiedRequirements?: Array<{
        rId: string;
        title: string;
        statusText: string;
        description?: string;
        needed?: number;
    }>;
    /** Phase 8 A2 — when source=dpr, the courses the student is
     *  currently enrolled in (DPR rows with type="IP"). Lets the agent
     *  answer "what classes am I taking now?" / "am I currently
     *  enrolled in [X]?" without saying "the audit doesn't list them". */
    dprInProgressCourses?: Array<{
        term: string;        // PeopleSoft term, e.g. "2026 Fall"
        courseId: string;    // "CSCI-UA 473"
        courseTitle: string;
        units: number;
    }>;
}

export const runFullAuditTool = buildTool({
    name: "run_full_audit",
    description:
        "Returns the student's degree audit. When their Albert Degree " +
        "Progress Report (DPR) is loaded, returns NYU's pre-computed " +
        "audit verdicts (deterministic, authoritative). Otherwise runs " +
        "the local rule engine against authored programs.\n\n" +
        "Use this for ANY of these question types (Cardinal Rule §2.1):\n" +
        "  • GPA, cumulative credits, credits-required, credits-remaining\n" +
        "  • Requirements satisfied / remaining / unmet for any program\n" +
        "  • Pass/Fail used + cap, outside-CAS used + cap, residency met/short\n" +
        "  • Academic standing (good standing / probation), time limit\n" +
        "  • \"Am I on track to graduate?\", \"can I graduate this/next term?\"\n" +
        "  • Currently-enrolled / in-progress courses (DPR carries these)\n" +
        "  • What is my profile, what programs am I declared in\n\n" +
        "PREFER THIS OVER `get_academic_standing` and `get_credit_caps` " +
        "whenever the DPR is loaded — those tools can't see the DPR and " +
        "return defaults like GPA 0.00. Their validateInput will refuse " +
        "and tell you to call this tool instead.\n\n" +
        "If the user references themselves (\"how many credits do I have?\", " +
        "\"have I met X?\"), call this. Quoting bulletin policy without the " +
        "student's specific numbers is incomplete.",
    inputSchema: z.object({
        programId: z.string().optional()
            .describe("Optional: limit the audit to a specific program id (e.g., 'cs_major_ba')."),
    }),
    // Phase 8 A2 — bumped from 3500 to 5000 because the new
    // CURRENTLY ENROLLED block pushed STANDING past the truncation
    // edge for students with 7+ in-progress courses (truncating the
    // most critical fact). The audit summary is now the single
    // largest tool result we surface; budget accordingly.
    maxResultChars: 5000,
    // Phase 7-B Step 15 — semi_hardened: GPA + cumulative credits are
    // deterministic verdicts the validator must guard against drift.
    outputMode: "semi_hardened",
    async validateInput(_input, { session }) {
        // DPR primary path requires only a DPR + the synthesized
        // student profile (which W2's buildStudentProfileFromDpr
        // gives us). Authored fallback needs the full student +
        // courses + programs trio.
        if (session.degreeProgressReport && session.student) return { ok: true };
        if (!session.student) {
            return { ok: false, userMessage: "I need your transcript or Degree Progress Report loaded before I can run an audit." };
        }
        if (!session.courses || session.courses.length === 0) {
            return { ok: false, userMessage: "Course catalog is not loaded; cannot run audit." };
        }
        if (!session.programs || session.programs.size === 0) {
            return { ok: false, userMessage: "Program data is not loaded; cannot run audit." };
        }
        return { ok: true };
    },
    prompt: () =>
        `Run a degree audit. Returns rules, courses-satisfying, remaining counts, ` +
        `cumulative GPA, total credits completed, and warnings. Optional input ` +
        `'programId' restricts to one program. Reads from the DPR when present; ` +
        `otherwise falls back to the local rule engine.`,
    async call(input, { session }): Promise<RunFullAuditOutput> {
        // ---- DPR primary path ----
        if (session.degreeProgressReport && session.student) {
            const dpr: DegreeProgressReport = session.degreeProgressReport;
            const audits = dprToAuditResults(dpr, {
                studentId: session.student.id,
                timestamp: new Date().toISOString(),
            });
            // Filter to a specific program if requested. The DPR's
            // programIdFromLabel slug rarely lines up exactly with
            // authored-catalog ids (e.g., "computer_science_math_major"
            // vs the engine's "cs_major_ba"), so the match is loose.
            // When the user passes a programId that doesn't match any
            // DPR program, return an empty audits[] array rather than
            // silently falling back to all programs (which would mask
            // the mismatch and surface the wrong major's verdict).
            let filtered = audits;
            if (input.programId) {
                const needle = input.programId.toLowerCase().replace(/-/g, "_");
                filtered = audits.filter((a) => a.programId.includes(needle));
            }
            // Standing comes straight from the DPR's cumulative block.
            // We synthesize a StandingResult rather than running
            // calculateStanding (which expects coursesTaken with grades).
            const cumGpa = dpr.cumulative.cumulativeGpa ?? 0;
            const completion = dpr.cumulative.creditsRequired && dpr.cumulative.creditsRequired > 0
                ? Math.min(1, (dpr.cumulative.creditsUsed ?? 0) / dpr.cumulative.creditsRequired)
                : 0;
            const inGoodStanding = cumGpa >= 2.0;
            const standing: StandingResult = {
                level: inGoodStanding ? "good_standing" : "academic_concern",
                cumulativeGPA: cumGpa,
                completionRate: completion,
                inGoodStanding,
                message: inGoodStanding
                    ? `Cumulative GPA ${cumGpa.toFixed(3)} ≥ 2.0; you're in good standing per the DPR.`
                    : `Cumulative GPA ${cumGpa.toFixed(3)} is below the 2.0 floor; the DPR flags academic concern.`,
                warnings: [],
            };
            const unsatisfied = notSatisfiedRequirements(dpr.requirementGroups).map((req) => ({
                rId: req.rId,
                title: req.title,
                statusText: req.statusText,
                ...(req.description ? { description: req.description } : {}),
                ...(req.counter && "needed" in req.counter && req.counter.needed !== undefined
                    ? { needed: req.counter.needed }
                    : {}),
            }));
            // Phase 8 A2 — surface in-progress (currently-enrolled)
            // courses from the DPR. The student needs to be able to ask
            // "what am I taking now?" and get a specific answer.
            const inProgress = dpr.courseHistory
                .filter((c) => c.type === "IP")
                .map((c) => ({
                    term: c.term,
                    // PeopleSoft splits the course code as subject="CSCI-UA",
                    // catalogNbr="473" — the canonical NYU display form is
                    // "CSCI-UA 473" (space, not hyphen).
                    courseId: `${c.subject} ${c.catalogNbr}`,
                    courseTitle: c.courseTitle,
                    units: c.units,
                }));
            return {
                audits: filtered,
                standing,
                source: "dpr",
                dprPreparedDate: dpr.header.preparedDate,
                dprCumulative: { ...dpr.cumulative },
                dprUnsatisfiedRequirements: unsatisfied,
                ...(inProgress.length > 0 ? { dprInProgressCourses: inProgress } : {}),
            };
        }

        // ---- Authored-rules fallback (legacy) ----
        const student = session.student!;
        const declared = student.declaredPrograms;
        const targetIds = input.programId ? [input.programId] : declared.map((d) => d.programId);
        const audits: AuditResult[] = [];
        for (const id of targetIds) {
            const program = session.programs!.get(id);
            if (!program) continue;
            audits.push(degreeAudit(student, program, session.courses!, session.schoolConfig ?? null));
        }
        const standing = calculateStanding(student.coursesTaken, declared.length, session.schoolConfig ?? null);
        return { audits, standing, source: "authored" };
    },
    summarizeResult(output) {
        const lines: string[] = [];
        const sourceTag = output.source === "dpr"
            ? `from your Degree Progress Report (prepared ${output.dprPreparedDate ?? "recently"})`
            : "from the authored program rules";
        lines.push(`AUDIT (${sourceTag}):`);

        // Phase 7-E W8 fix — surface DPR cumulative budgets explicitly
        // so the agent has a verbatim source for residency / P/F /
        // outside-CAS questions without rooting through the rule tree.
        if (output.source === "dpr" && output.dprCumulative) {
            const c = output.dprCumulative;
            lines.push(`CUMULATIVE (DPR-verified):`);
            if (c.creditsRequired !== null && c.creditsUsed !== null) {
                lines.push(`  Credits earned: ${c.creditsUsed} of ${c.creditsRequired} required`);
            }
            if (c.cumulativeGpa !== null) {
                lines.push(`  Cumulative GPA: ${c.cumulativeGpa.toFixed(3)}`);
            }
            if (c.residencyRequired !== null && c.residencyUsed !== null) {
                lines.push(`  Residency credits (CAS): ${c.residencyUsed} of ${c.residencyRequired} required`);
            }
            if (c.passFailUsedUnits !== null && c.passFailCapUnits !== null) {
                lines.push(`  Pass/Fail units used: ${c.passFailUsedUnits} of ${c.passFailCapUnits} cap`);
            }
            if (c.outsideHomeUsedUnits !== null && c.outsideHomeCapUnits !== null) {
                lines.push(`  Outside-home credits used: ${c.outsideHomeUsedUnits} of ${c.outsideHomeCapUnits} cap`);
            }
            if (c.timeLimitYears !== null) {
                lines.push(`  Degree time limit: ${c.timeLimitYears} years from matriculation`);
            }
        }

        for (const a of output.audits) {
            lines.push(`PROGRAM: ${a.programName} (${a.programId}) — ${a.overallStatus}`);
            lines.push(`  Credits: ${a.totalCreditsCompleted} / ${a.totalCreditsRequired}`);
            const unmet = a.rules.filter((r) => r.status !== "satisfied");
            lines.push(`  Unmet requirements: ${unmet.length}`);
            for (const r of unmet.slice(0, 10)) {
                const remaining = r.remaining > 0 ? `${r.remaining} remaining` : "outstanding";
                lines.push(`    - ${r.label}: ${remaining}`);
                if (r.coursesSatisfying.length > 0 && r.coursesSatisfying.length <= 6) {
                    lines.push(`      already applied: ${r.coursesSatisfying.join(", ")}`);
                }
            }
            if (a.warnings.length > 0) {
                lines.push(`  Warnings: ${a.warnings.slice(0, 3).join("; ")}`);
            }
        }

        // Phase 7-E W8 fix — list unsatisfied requirements with their
        // verbatim status sentence (which often names the missing
        // course, e.g., "Not Satisfied: Complete CSCI-UA 421...").
        if (output.source === "dpr" && output.dprUnsatisfiedRequirements && output.dprUnsatisfiedRequirements.length > 0) {
            lines.push(`UNSATISFIED REQUIREMENTS (verbatim from DPR):`);
            for (const req of output.dprUnsatisfiedRequirements.slice(0, 10)) {
                const needTag = req.needed ? ` [need ${req.needed} more]` : "";
                lines.push(`  - ${req.rId} ${req.title}${needTag}: ${req.statusText}`);
                if (req.description && req.description.length > 0 && req.description.length < 220) {
                    lines.push(`    ${req.description}`);
                }
            }
        }

        // Phase 8 A2 — currently-enrolled (in-progress) courses from
        // the DPR. Lets the agent answer "what am I taking now?" /
        // "am I currently enrolled in [X]?" without saying "the audit
        // doesn't list them" (a real bug from the 20-question sweep).
        if (output.dprInProgressCourses && output.dprInProgressCourses.length > 0) {
            lines.push(`CURRENTLY ENROLLED (in-progress per DPR):`);
            // Group by term so the agent can answer term-specific questions cleanly.
            const byTerm = new Map<string, typeof output.dprInProgressCourses>();
            for (const c of output.dprInProgressCourses) {
                if (!byTerm.has(c.term)) byTerm.set(c.term, []);
                byTerm.get(c.term)!.push(c);
            }
            for (const [term, courses] of byTerm) {
                lines.push(`  ${term}:`);
                for (const c of courses) {
                    lines.push(`    - ${c.courseId} (${c.units}u) — ${c.courseTitle}`);
                }
            }
        }

        lines.push(`STANDING: ${output.standing.level} (cumulative GPA ${output.standing.cumulativeGPA.toFixed(3)}, completion ${(output.standing.completionRate * 100).toFixed(0)}%)`);
        return lines.join("\n");
    },
    // Phase 7-B Step 15 — verbatim text the LLM must include
    // unchanged. We pin the cumulative GPA verdict (the most common
    // §2.1 violation pattern). Reasonable synthesis around it stays
    // allowed; only this clause must appear unchanged.
    extractVerbatim(output) {
        const gpa = output.standing.cumulativeGPA.toFixed(3);
        const grounding = output.source === "dpr"
            ? "(from your Degree Progress Report)"
            : "(computed from your transcript)";
        return `Cumulative GPA: ${gpa} ${grounding}.`;
    },
});

// Re-export to expose `walkRequirements` / `notSatisfiedRequirements`
// to other tools when they need to introspect the DPR tree without
// reaching into the dpr/ subpackage directly.
export { walkRequirements, notSatisfiedRequirements };
