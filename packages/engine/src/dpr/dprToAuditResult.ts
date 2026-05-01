// ============================================================
// DPR → AuditResult adapter (Phase 7-E W1.5)
// ============================================================
// Converts a `DegreeProgressReport` into the shape the agent's
// existing `runFullAudit` summarizer + tests already understand.
// This lets the tool refactor in W3.1 swap data sources without
// changing every downstream consumer at the same time.
//
// Mapping rules:
//   - one DPR program → one AuditResult (multi-program DPRs produce
//     one AuditResult per program; the caller picks which to surface)
//   - DPR's per-Requirement counter → RuleAuditResult.remaining
//   - DPR's "Courses Used" rows → RuleAuditResult.coursesSatisfying
//     (rendered as "<subject> <catalogNbr>")
//   - DPR's status flags map to the legacy RuleStatus enum:
//       "satisfied"             → "satisfied"
//       "not_satisfied"         → "not_started" (no courses applied)
//                                 OR "in_progress" (when some courses applied)
//       "overall_not_satisfied" → "in_progress" (parent groups with
//                                 mixed-status children fall here)
//   - DPR's cumulative.creditsRequired/creditsUsed → totalCredits*
//
// Round-trip note: this is a one-way conversion. AuditResult is a
// flat list of rules; the DPR's nested RG → R tree gets flattened
// to leaf Requirements only. RG-level status survives implicitly
// via per-rule status. RGs themselves are dropped because the legacy
// engine has no concept of grouping.
// ============================================================

import type {
    AuditResult,
    RuleAuditResult,
    RuleStatus,
} from "@nyupath/shared";
import {
    type DegreeProgressReport,
    type DPRRequirement,
    type DPRStatus,
    type DPRCourseRow,
    walkRequirements,
} from "./schema.js";

export interface DprToAuditOptions {
    /** Which program to surface (default: the first declared major or the first program). */
    targetProgramId?: string;
    /** Override for the AuditResult.studentId field. */
    studentId?: string;
    /** Override for AuditResult.timestamp (deterministic tests). */
    timestamp?: string;
}

/**
 * Convert a DPR into one AuditResult per declared program. Most callers
 * want only the major's audit — `audits[0]` is typically that result
 * because PeopleSoft lists programs in declared order.
 */
export function dprToAuditResults(
    dpr: DegreeProgressReport,
    opts: DprToAuditOptions = {},
): AuditResult[] {
    const studentId = opts.studentId ?? dpr.header.studentName.replace(/\s+/g, "_").toLowerCase();
    const timestamp = opts.timestamp ?? new Date().toISOString();
    const allReqs = walkRequirements(dpr.requirementGroups);

    // For now we emit one AuditResult per declared program. PeopleSoft
    // doesn't tag each Requirement with its owning program, so the
    // mapping is heuristic: every requirement applies to every program
    // (which is approximately true — the audit walks every R against
    // your transcript regardless of which major declared it). We
    // include all leaf requirements in every AuditResult.
    const results: AuditResult[] = [];
    for (const program of dpr.programs) {
        const programName = `${program.label} (${program.programType})`;
        const programId =
            opts.targetProgramId
            ?? programIdFromLabel(program.label, program.programType);

        results.push({
            studentId,
            programId,
            programName,
            catalogYear: program.requirementTerm,
            timestamp,
            overallStatus: dprStatusToRuleStatus(program.requirementStatus, /*hasAnyCourse*/ true),
            totalCreditsCompleted: dpr.cumulative.creditsUsed ?? 0,
            totalCreditsRequired: dpr.cumulative.creditsRequired ?? 0,
            rules: allReqs.map(reqToRuleAuditResult),
            warnings: dpr._meta.warnings.slice(),
        });
    }
    return results;
}

/**
 * Convenience: return the AuditResult corresponding to the first major
 * in the DPR, or `null` when no major is declared. The agent's
 * `runFullAudit` tool uses this when the user asks "how am I doing in
 * my major" without naming one.
 */
export function dprToPrimaryAuditResult(
    dpr: DegreeProgressReport,
    opts: DprToAuditOptions = {},
): AuditResult | null {
    const all = dprToAuditResults(dpr, opts);
    if (all.length === 0) return null;
    // Prefer the first row labeled "Major" or "Major Approved".
    const major = all.find((a) =>
        a.programName.includes("Major"),
    );
    return major ?? all[0]!;
}

// ---- helpers ----

function reqToRuleAuditResult(req: DPRRequirement): RuleAuditResult {
    const courses = req.coursesUsed.map(formatCourseId);
    const remaining = computeRemaining(req);
    return {
        ruleId: req.rId,
        label: req.title,
        status: dprStatusToRuleStatus(req.status, courses.length > 0),
        coursesSatisfying: courses,
        remaining,
        coursesRemaining: [], // DPR doesn't enumerate; leave empty
    };
}

function dprStatusToRuleStatus(s: DPRStatus, hasAnyCourse: boolean): RuleStatus {
    if (s === "satisfied") return "satisfied";
    // overall_not_satisfied → mixed-status parent → call it in_progress
    if (s === "overall_not_satisfied") return "in_progress";
    // not_satisfied → in_progress if any course applied, else not_started
    return hasAnyCourse ? "in_progress" : "not_started";
}

function computeRemaining(req: DPRRequirement): number {
    if (!req.counter) return req.status === "satisfied" ? 0 : 1;
    if (req.counter.kind === "gpa") {
        return req.counter.completed >= req.counter.required ? 0 : 1;
    }
    if ("needed" in req.counter && req.counter.needed !== undefined) {
        return req.counter.needed;
    }
    const remaining = req.counter.required - req.counter.used;
    return remaining > 0 ? remaining : 0;
}

function formatCourseId(c: DPRCourseRow): string {
    return `${c.subject} ${c.catalogNbr}`.replace(/\s+/g, " ").trim();
}

/**
 * Heuristic program-id from PeopleSoft's free-form label. Examples:
 *   - "Computer Science/Math" + "Major Approved" → "computer_science_math_major"
 *   - "UA-Coll of Arts & Sci" + "Program" → "ua_coll_of_arts_sci_program"
 * The result is purely a label — not a reference to any authored
 * Program JSON. Tools that need the canonical program id (e.g., to
 * cross-reference the engine's bundled cs_major_ba spec) should
 * resolve via the agent's `programs` map separately.
 */
function programIdFromLabel(label: string, programType: string): string {
    const slug = (s: string): string =>
        s.toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
    const typeSlug = slug(programType);
    const labelSlug = slug(label);
    if (!typeSlug) return labelSlug;
    if (!labelSlug) return typeSlug;
    return `${labelSlug}_${typeSlug}`;
}
