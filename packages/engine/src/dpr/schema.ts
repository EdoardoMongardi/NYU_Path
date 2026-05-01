// ============================================================
// DegreeProgressReport — Zod schema (Phase 7-E W1.1)
// ============================================================
// The structured shape produced by tools/dpr-parser/ from an
// Albert "Degree Progress Report" PDF (Oracle Analytics Publisher
// output, PeopleSoft Academic Advisement Report under the hood).
//
// All numerical fields preserve PeopleSoft's two-decimal-place
// convention so downstream tools can render values exactly as
// they appear in the source. The shape is the canonical input
// for the post-pivot agent: run_full_audit, plan_semester, and
// what_if_audit all consume from this object via session.degreeProgressReport.
//
// Cardinal Rule §2.1 compliance: every numerical claim the agent
// surfaces must trace back to a field on this object (or to an
// AuditResult produced from extracted bulletin rules in the
// what_if_audit just-in-time path). No LLM synthesis on top.
// ============================================================

import { z } from "zod";

// ---- Course rows ----

/**
 * A single row from a "Courses Used" table or the "Course History"
 * block. The Type column indicates how the course is counted:
 *   - EN: enrolled at NYU, completed
 *   - TE: transfer or test credit (AP, IB, etc.)
 *   - IP: in progress (no grade yet)
 * Other Type codes (Audit, Withdrawal-with-W, etc.) are surfaced
 * as the raw string so the agent can render them faithfully.
 */
export const dprCourseRowSchema = z.object({
    term: z.string(), // "2023 Fall", "2024 Spr", "2026 Fall", etc.
    subject: z.string(), // "CSCI-UA", "MATH-UA", "MPAJZ-UE"
    catalogNbr: z.string(), // "101", "120", "9121", "200XG"
    courseTitle: z.string(),
    grade: z.string().nullable(), // null when type === "IP"
    units: z.number(), // 4.00, 2.00, 0.00
    type: z.string(), // "EN" | "TE" | "IP" | other (preserved verbatim)
    repeatCode: z.string().optional(), // "RI" | "R" | other
    courseTopic: z.string().optional(), // "24 - Wine and Feasting in the Anci"
});
export type DPRCourseRow = z.infer<typeof dprCourseRowSchema>;

// ---- Requirement counters ----

/**
 * The "X required, Y used, Z needed" line that appears under most
 * Requirement nodes. Three flavors:
 *   - units:   "Units: 128.00 required, 138.00 used"
 *   - courses: "Courses: 1.00 required, 1.00 used"
 *   - gpa:     "GPA: 2.000 required, 3.402 completed"
 * For the gpa flavor `used === completed` (PeopleSoft's wording differs).
 */
export const dprCounterSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("units"),
        required: z.number(),
        used: z.number(),
        needed: z.number().optional(),
    }),
    z.object({
        kind: z.literal("courses"),
        required: z.number(),
        used: z.number(),
        needed: z.number().optional(),
    }),
    z.object({
        kind: z.literal("gpa"),
        required: z.number(),
        completed: z.number(),
    }),
]);
export type DPRCounter = z.infer<typeof dprCounterSchema>;

// ---- Status ----

/**
 * Three status flags PeopleSoft surfaces:
 *   - "satisfied"             — `Satisfied: …`
 *   - "not_satisfied"         — `Not Satisfied: …`
 *   - "overall_not_satisfied" — `Overall Requirement Not Satisfied: …`
 *     (used when a parent group has multiple child requirements and
 *      at least one child is unsatisfied)
 */
export const dprStatusSchema = z.enum(["satisfied", "not_satisfied", "overall_not_satisfied"]);
export type DPRStatus = z.infer<typeof dprStatusSchema>;

// ---- Requirement (leaf) ----

/**
 * Leaf requirement with id like `R1142/20`. Holds the status,
 * descriptive sentence, optional counter, and the courses applied.
 */
export const dprRequirementSchema = z.object({
    rId: z.string(), // "R1142/20"
    title: z.string(), // "Computer Science: Required Courses"
    status: dprStatusSchema,
    statusText: z.string(), // verbatim status sentence
    description: z.string().optional(), // verbatim description following the status line
    counter: dprCounterSchema.optional(),
    coursesUsed: z.array(dprCourseRowSchema),
});
export type DPRRequirement = z.infer<typeof dprRequirementSchema>;

// ---- Requirement Group (recursive) ----

/**
 * Requirement Group with id like `RG5076`. Can contain other
 * Requirement Groups OR leaf Requirements. The recursive shape
 * mirrors the DPR's actual tree structure.
 */
export interface DPRRequirementGroup {
    rgId: string;
    title: string;
    status: DPRStatus;
    statusText: string;
    description?: string;
    children: Array<DPRRequirementGroup | DPRRequirement>;
}

export const dprRequirementGroupSchema: z.ZodType<DPRRequirementGroup> = z.lazy(() =>
    z.object({
        rgId: z.string(), // "RG5076"
        title: z.string(),
        status: dprStatusSchema,
        statusText: z.string(),
        description: z.string().optional(),
        children: z.array(z.union([dprRequirementGroupSchema, dprRequirementSchema])),
    }),
);

// ---- Top-level header ----

/**
 * The student-identifying header that appears at the top of the
 * report. preparedDate is verbatim ("04/27/2026") so the agent
 * can surface staleness ("your DPR is from 4 days ago — re-upload?").
 */
export const dprHeaderSchema = z.object({
    studentName: z.string(),
    preparedDate: z.string(), // "04/27/2026" — keep verbatim
    requestedBy: z.string().optional(),
});
export type DPRHeader = z.infer<typeof dprHeaderSchema>;

// ---- Programs ----

/**
 * The Programs block lists every active career/program/major with
 * its requirement-term (catalog year start) and rollup status.
 * `programType` mirrors PeopleSoft's labels: Undergraduate Career,
 * Program, Major, Minor, Concentration.
 */
export const dprProgramSchema = z.object({
    programType: z.string(), // "Undergraduate Career" | "Program" | "Major" | etc.
    label: z.string(), // "UA-Coll of Arts & Sci", "Computer Science/Math Major Approved"
    requirementTerm: z.string(), // "Fall 2024"
    requirementStatus: dprStatusSchema,
});
export type DPRProgram = z.infer<typeof dprProgramSchema>;

// ---- Advisor Notations ----

/**
 * Manual exceptions and waivers entered by advisers, e.g.:
 *   "Request id 0000013777 Test Credit. Permission to apply 32 credits
 *    from AP Exam. T. Gurstel  09/17/2024"
 * The full sentence is preserved as `note` so the agent can quote it
 * verbatim; the structured fields are best-effort extractions.
 */
export const dprAdvisorNotationSchema = z.object({
    requestId: z.string().optional(), // "0000013777"
    note: z.string(), // full verbatim sentence
    advisor: z.string().optional(), // "T. Gurstel"
    date: z.string().optional(), // "09/17/2024" verbatim
});
export type DPRAdvisorNotation = z.infer<typeof dprAdvisorNotationSchema>;

// ---- Cumulative metrics ----

/**
 * Top-line metrics the agent reads to answer "what's my GPA / how
 * many credits do I have / am I on track" without walking the
 * Requirement Group tree. Every field maps to a specific Requirement
 * in the DPR (R1001/10, R1001/20, R1001/35, R1680/10, R1680/30).
 *
 * - creditsRequired:    R1001/10 — degree-credit floor (typically 128)
 * - creditsUsed:        R1001/10 — credits earned + in-progress + transfer
 * - cumulativeGpa:      R1001/20 — overall GPA across all NYU letter-graded courses
 * - residencyRequired:  R1001/35 — CAS residency floor (typically 64)
 * - residencyUsed:      R1001/35 — credits taken in residence at the home school
 * - passFailUsedUnits:  R1680/10 — units taken with the P/F option
 * - outsideHomeUsedUnits: R1680/30 — units taken outside the home school (cap typically 16)
 * - timeLimitYears:     R1680/60 — degree time limit (typically 8 years)
 *
 * All numeric fields are optional because PeopleSoft sometimes omits
 * them for students with custom programs; the parser surfaces null
 * rather than guessing.
 */
export const dprCumulativeSchema = z.object({
    creditsRequired: z.number().nullable(),
    creditsUsed: z.number().nullable(),
    cumulativeGpa: z.number().nullable(),
    cumulativeGpaRequired: z.number().nullable(),
    residencyRequired: z.number().nullable(),
    residencyUsed: z.number().nullable(),
    passFailUsedUnits: z.number().nullable(),
    passFailCapUnits: z.number().nullable(), // 32 in CAS
    outsideHomeUsedUnits: z.number().nullable(),
    outsideHomeCapUnits: z.number().nullable(), // 16 in CAS
    timeLimitYears: z.number().nullable(),
});
export type DPRCumulative = z.infer<typeof dprCumulativeSchema>;

// ---- Top-level DPR ----

/**
 * The root document. `_meta.sourceFingerprint` is a sha256 of the
 * raw extracted PDF text — used by the agent to detect when a stored
 * DPR is stale relative to the upload, and by the cohort-A
 * observability dashboard to dedupe re-uploads.
 *
 * `_meta.parserVersion` is bumped whenever the parser's output shape
 * changes (e.g., new field added). Lets caches detect a schema drift
 * and re-parse rather than silently serve old structure.
 */
export const dprMetaSchema = z.object({
    parserVersion: z.string(), // semver: "1.0.0"
    parsedAt: z.string(), // ISO timestamp
    sourceFingerprint: z.string(), // "sha256:..."
    sourcePdfPageCount: z.number(),
    parseDurationMs: z.number(),
    /** Non-fatal warnings the parser raised (e.g., unknown counter
     *  format, malformed advisor notation). Surfaced to ops; not
     *  shown to the student. */
    warnings: z.array(z.string()),
});
export type DPRMeta = z.infer<typeof dprMetaSchema>;

export const degreeProgressReportSchema = z.object({
    _meta: dprMetaSchema,
    header: dprHeaderSchema,
    programs: z.array(dprProgramSchema),
    advisorNotations: z.array(dprAdvisorNotationSchema),
    cumulative: dprCumulativeSchema,
    requirementGroups: z.array(dprRequirementGroupSchema),
    courseHistory: z.array(dprCourseRowSchema),
});
export type DegreeProgressReport = z.infer<typeof degreeProgressReportSchema>;

// ---- Helpers used by the parser + downstream consumers ----

/** Walk every Requirement leaf in the tree (depth-first, left-to-right). */
export function walkRequirements(
    groups: DPRRequirementGroup[],
): DPRRequirement[] {
    const out: DPRRequirement[] = [];
    const visit = (node: DPRRequirementGroup | DPRRequirement): void => {
        if ("rId" in node) {
            out.push(node);
            return;
        }
        for (const child of node.children) visit(child);
    };
    for (const g of groups) visit(g);
    return out;
}

/** Filter to requirements whose status indicates work remains.
 *
 *  Phase 8 A3 — DEDUPED parent-vs-leaf. PeopleSoft DPRs sometimes
 *  mark a parent group AND its leaf both `not_satisfied` (e.g.,
 *  R1004 "Texts & Ideas" parent + R1004/10 leaf). The pre-Phase-8
 *  walker reported both, so the agent counted "Texts & Ideas" twice.
 *
 *  Phase 9 Stage 5 — also drop "_summary" roll-up markers. The
 *  parser synthesizes "<rgId>/_summary" requirements when a group
 *  has a counter directly attached (e.g., RG5076's "Computer
 *  Science/Math Joint Major (summary)" — total credits across the
 *  whole major). These are aggregate trackers, not actionable
 *  requirements; dropping them prevents the agent from treating
 *  "joint major summary" as a separate course-needed item.
 *
 *  We dedupe by rId-prefix relationship: if rId "X/n" is in the
 *  result, drop any "X" parent. */
export function notSatisfiedRequirements(
    groups: DPRRequirementGroup[],
): DPRRequirement[] {
    const all = walkRequirements(groups)
        .filter((r) => r.status !== "satisfied")
        // Phase 9 — drop synthetic _summary roll-ups; they're not
        // course-actionable items, just aggregate counters.
        .filter((r) => !r.rId.endsWith("/_summary"));
    const leafRIds = new Set(all.map((r) => r.rId));
    return all.filter((r) => {
        // Keep the requirement unless some other unmet requirement's
        // rId is "thisRId/<suffix>" — i.e., a more specific child.
        for (const other of leafRIds) {
            if (other === r.rId) continue;
            if (other.startsWith(`${r.rId}/`)) return false;
        }
        return true;
    });
}

/** Find a requirement by exact rId (e.g., "R1142/20"). */
export function findRequirementById(
    groups: DPRRequirementGroup[],
    rId: string,
): DPRRequirement | undefined {
    return walkRequirements(groups).find((r) => r.rId === rId);
}
