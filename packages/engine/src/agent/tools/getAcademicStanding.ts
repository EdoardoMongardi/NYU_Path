// ============================================================
// get_academic_standing (Phase 7-A P-3 / §7.1)
// ============================================================
// Returns the student's current academic-standing snapshot:
//   - cumulative GPA + semester GPAs
//   - SAP / probation / dismissal level (per-school thresholds)
//   - whether the student is at risk of failing the school's tiered
//     GPA floor (when present)
//
// Wraps the existing `calculateStanding` engine helper. Per §7.1 +
// Appendix A rule #5 ("Before discussing CREDIT COUNTS, GPA, …,
// call at minimum: get_academic_standing → get_credit_caps"), this
// is the canonical first call for any GPA / progress / standing
// query. The agent's system prompt routes those questions here.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import { calculateStanding } from "../../audit/academicStanding.js";

export const getAcademicStandingTool = buildTool({
    name: "get_academic_standing",
    description:
        "Returns the student's SAP / probation / dismissal standing level " +
        "per the home school's thresholds, computed from their DPR-derived " +
        "coursework. Requires a Degree Progress Report (DPR) to be loaded; " +
        "refuses otherwise. For authoritative GPA, cumulative credits, and " +
        "requirement status, prefer `run_full_audit` (it reads the DPR's " +
        "pre-computed numbers directly). Use this tool for probation / " +
        "academic-standing detail. Read-only.",
    inputSchema: z.object({}),
    isReadOnly: true,
    maxResultChars: 1500,
    async validateInput(_input, { session }) {
        if (!session.student) return { ok: false, userMessage: "No student profile loaded." };
        // DPR-only: standing is computed from the student's DPR-derived
        // coursework. With no DPR there is no authoritative record to
        // read, so refuse and ask for it (no transcript fallback).
        if (!session.degreeProgressReport) {
            return {
                ok: false,
                userMessage:
                    "I need your Albert Degree Progress Report (DPR) to report academic standing. " +
                    "Please upload your DPR and try again.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        `Compute the student's academic standing from their courses + ` +
        `the home-school's GPA thresholds. Returns cumulative GPA, ` +
        `standing level, and per-semester GPAs.`,
    async call(_input, { session }) {
        const student = session.student!;
        const dpr = session.degreeProgressReport;
        // PLAN-11: count distinct semesters the student has completed
        // (not declaredPrograms.length, which is an unrelated count).
        // Exclude IP rows (no final grade yet) and null-grade rows.
        // Also exclude transfer credits (TR) and test credits (TE) —
        // those are not semesters the student completed at NYU.
        const semestersCompleted = new Set(
            student.coursesTaken
                .filter(
                    (c) =>
                        !c.isInProgress &&
                        c.grade !== null &&
                        c.grade !== "TR" &&
                        c.grade !== "TE",
                )
                .map((c) => c.semester),
        ).size;
        const standing = calculateStanding(
            student.coursesTaken,
            semestersCompleted,
            session.schoolConfig ?? null,
            dpr?.cumulative.cumulativeGpaRequired ?? null,
        );
        return {
            // DPR-1: return the DPR's pre-computed cumulative GPA as the
            // authoritative value. Fall back to calculateStanding's local
            // recompute only when no DPR is present (validateInput already
            // requires a DPR, so the fallback path is unreachable in
            // production — kept here for defensive completeness).
            cumulativeGPA: dpr?.cumulative.cumulativeGpa ?? standing.cumulativeGPA,
            level: standing.level,
            inGoodStanding: standing.inGoodStanding,
            semesterGPA: standing.semesterGPA ?? null,
            completionRate: standing.completionRate,
            message: standing.message,
            warnings: standing.warnings,
            schoolFloor: dpr?.cumulative.cumulativeGpaRequired ?? null,
        };
    },
    summarizeResult(out) {
        const lines: string[] = [];
        lines.push(`STANDING: ${out.level} (cumulative GPA ${out.cumulativeGPA.toFixed(2)})`);
        lines.push(`In good standing: ${out.inGoodStanding}`);
        if (out.semesterGPA !== null) {
            lines.push(`Most recent semester GPA: ${out.semesterGPA.toFixed(2)}`);
        }
        lines.push(`Credit completion rate: ${(out.completionRate * 100).toFixed(0)}%`);
        if (out.schoolFloor !== null) lines.push(`School minimum GPA floor: ${out.schoolFloor}`);
        lines.push(`Summary: ${out.message}`);
        if (out.warnings.length > 0) {
            lines.push(`Warnings:`);
            for (const w of out.warnings) lines.push(`  - ${w}`);
        }
        return lines.join("\n");
    },
});
