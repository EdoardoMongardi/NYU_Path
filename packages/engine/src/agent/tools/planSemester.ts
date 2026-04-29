// ============================================================
// plan_semester (Phase 5 §7.2 + Phase 7-E W3.2)
// ============================================================
// Two paths:
//   1. DPR primary (post-pivot): read not-satisfied requirements
//      from session.degreeProgressReport, extract candidate
//      course IDs from each requirement's description text,
//      filter to ones the student hasn't already taken, and
//      return as ranked SuggestionEntry[]. Honors prereq graph
//      when session.prereqs is present.
//   2. Authored-rules fallback: legacy planNextSemester driver.
//
// Known V1 limitations of the DPR path (P2 follow-ups):
//   - Doesn't call FOSE (`searchAvailability`) to filter to
//     currently-open sections. The agent can do that as a
//     follow-up step if the student asks.
//   - Doesn't run the priority scorer; emits suggestions in
//     the order they appear in the DPR with priority=1 each.
//     Ranking by graduation impact is a P2.
//   - Course-ID extraction from prose is a regex; programs
//     whose requirements describe the option pool in narrative
//     form (e.g., "any 300-level Math elective") will produce
//     a single placeholder suggestion pointing the student at
//     `search_courses`.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import { planNextSemester } from "../../planner/semesterPlanner.js";
import type { CourseSuggestion, GraduationRisk, SemesterPlan } from "@nyupath/shared";
import {
    notSatisfiedRequirements,
    type DPRRequirement,
} from "../../dpr/schema.js";

interface PlanSemesterOutput extends SemesterPlan {
    /** Phase 7-E — flags whether the plan came from the DPR primary
     *  path or the authored-rules fallback. */
    source: "dpr" | "authored";
}

export const planSemesterTool = buildTool({
    name: "plan_semester",
    description:
        "Recommends courses for a target semester. When the student's " +
        "Degree Progress Report (DPR) is loaded, walks NYU's pre-computed " +
        "not-satisfied requirements and surfaces the specific courses " +
        "still needed.\n\n" +
        "Use this for:\n" +
        "  • \"What should I take next semester / this fall / spring 2027?\"\n" +
        "  • \"Plan the rest of my degree\"\n" +
        "  • \"How do I finish my major?\"\n" +
        "BEFORE calling, pair with `run_full_audit` so you have current\n" +
        "GPA + credits + remaining requirements. If the user asks for a\n" +
        "SPECIFIC term, pass that as targetSemester (use the `nextTerm`\n" +
        "from the temporal-context block when in doubt).\n\n" +
        "DO NOT call this for elective discovery (\"suggest a CS elective " +
        "I haven't taken\"). plan_semester only surfaces courses that " +
        "satisfy not-yet-satisfied requirements; it doesn't enumerate " +
        "the broader catalog. For elective discovery use `search_courses` " +
        "with `excludeCompleted: true`.\n\n" +
        "BULLETIN SAMPLE-PLAN ANCHORING (Phase 9.5): every CAS program " +
        "page in the bulletin contains a 'Sample Plan of Study' table " +
        "showing which semester each requirement is recommended for. " +
        "When you propose a course for a major requirement, ALWAYS call " +
        "`search_policy` with \"<major name> sample plan of study\" once " +
        "and reference the suggested semester back to the student (e.g., " +
        "\"the bulletin's sample plan places CSCI-UA 421 in 7th " +
        "semester\"). Anchors student expectations and surfaces sequencing " +
        "constraints (some courses MUST come before others per the plan).",
    inputSchema: z.object({
        targetSemester: z.string().describe("Semester to plan, e.g. '2025-fall'."),
        maxCourses: z.number().int().positive().optional(),
        maxCredits: z.number().positive().optional(),
        programId: z.string().optional()
            .describe("Optional: plan against a specific declared program."),
    }),
    maxResultChars: 3500,
    async validateInput(input, { session }) {
        if (!session.student) return { ok: false, userMessage: "I need your transcript or Degree Progress Report first." };
        // DPR path: only needs DPR + student.
        if (session.degreeProgressReport) return { ok: true };
        // Authored-rules fallback: needs full data trio.
        if (!session.courses || !session.prereqs || !session.programs) {
            return { ok: false, userMessage: "Required engine data not loaded." };
        }
        const declared = session.student.declaredPrograms;
        if (declared.length === 0 && !input.programId) {
            return {
                ok: false,
                userMessage:
                    "You haven't declared a program. Either declare one first or pass an explicit programId.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        `Recommend courses for one upcoming semester. Required input: targetSemester ` +
        `(e.g., "2025-fall"). Optional: maxCourses (default 5), maxCredits (default 18), programId. ` +
        `Reads from the DPR when present; otherwise falls back to the local planner.`,
    async call(input, { session }): Promise<PlanSemesterOutput> {
        const maxCourses = input.maxCourses ?? 5;
        const maxCredits = input.maxCredits ?? 18;

        // ---- DPR primary path ----
        if (session.degreeProgressReport && session.student) {
            const dpr = session.degreeProgressReport;
            const ns = notSatisfiedRequirements(dpr.requirementGroups);
            const takenIds = new Set(
                dpr.courseHistory
                    .filter((c) => c.type !== "TE" || (c.grade ?? "") !== "")
                    .map((c) => `${c.subject} ${c.catalogNbr}`),
            );

            const suggestions: CourseSuggestion[] = [];
            for (const req of ns) {
                if (suggestions.length >= maxCourses) break;
                const candidates = extractCandidateCourseIds(req);
                const fresh = candidates.filter((id) => !takenIds.has(id));
                if (fresh.length === 0) {
                    // Fall back to a guidance suggestion when the DPR
                    // describes the pool in narrative form.
                    suggestions.push({
                        courseId: "(see search_courses)",
                        title: req.title,
                        credits: 4,
                        priority: 5,
                        blockedCount: 0,
                        satisfiesRules: [req.rId],
                        category: "required",
                        reason:
                            `Requirement "${req.rId}" still needs ${counterRemainingText(req)}. ` +
                            `Use search_courses to find courses matching: "${(req.description ?? "").slice(0, 120)}".`,
                    });
                    continue;
                }
                for (const courseId of fresh.slice(0, 3)) {
                    if (suggestions.length >= maxCourses) break;
                    suggestions.push({
                        courseId,
                        title: req.title,
                        credits: 4,
                        priority: 1,
                        blockedCount: 0,
                        satisfiesRules: [req.rId],
                        category: "required",
                        reason: `Required for ${req.rId} (${req.title}). ${counterRemainingText(req)}`,
                    });
                }
            }

            // Cross with the prereq graph if it's loaded — flag
            // suggestions whose prereqs aren't yet satisfied.
            if (session.prereqs) {
                const prereqIndex = new Map(
                    session.prereqs.map((p) => [p.course, p] as const),
                );
                for (const s of suggestions) {
                    const prereq = prereqIndex.get(s.courseId);
                    if (!prereq) continue;
                    const need: string[] = [];
                    for (const group of prereq.prereqGroups ?? []) {
                        for (const c of group.courses ?? []) {
                            if (!takenIds.has(c)) need.push(c);
                        }
                    }
                    if (need.length > 0) s.prereqRisk = Array.from(new Set(need));
                }
            }

            const plannedCredits = suggestions.reduce((sum, s) => sum + s.credits, 0);
            const cumulativeCreditsToDate = dpr.cumulative.creditsUsed ?? 0;
            const totalRequired = dpr.cumulative.creditsRequired ?? 128;
            const remainingCredits = Math.max(0, totalRequired - cumulativeCreditsToDate - plannedCredits);
            const estimatedSemestersLeft = Math.max(1, Math.ceil(remainingCredits / Math.max(1, maxCredits)));

            return {
                studentId: session.student.id,
                targetSemester: input.targetSemester,
                suggestions,
                risks: [] as GraduationRisk[],
                estimatedSemestersLeft,
                plannedCredits,
                projectedTotalCredits: cumulativeCreditsToDate + plannedCredits,
                freeSlots: Math.max(0, maxCourses - suggestions.length),
                enrollmentWarnings: [],
                source: "dpr",
            };
        }

        // ---- Authored-rules fallback ----
        const student = session.student!;
        const programId = input.programId ?? student.declaredPrograms[0]!.programId;
        const program = session.programs!.get(programId);
        if (!program) {
            throw new Error(`plan_semester: program "${programId}" not found in catalog.`);
        }
        const plan = planNextSemester(student, program, session.courses!, session.prereqs!, {
            targetSemester: input.targetSemester,
            maxCourses,
            maxCredits,
        });
        return { ...plan, source: "authored" };
    },
    summarizeResult(plan) {
        const lines: string[] = [];
        const tag = plan.source === "dpr" ? "from your DPR's not-satisfied requirements" : "from authored program rules";
        lines.push(`PLAN for ${plan.targetSemester} (${tag})`);
        lines.push(`  ${plan.suggestions.length} suggestion(s), ${plan.plannedCredits} credits planned, ~${plan.estimatedSemestersLeft} semester(s) left to graduation`);
        for (const s of plan.suggestions.slice(0, 8)) {
            const risk = s.prereqRisk && s.prereqRisk.length > 0 ? ` ⚠ prereqs needed: ${s.prereqRisk.join(", ")}` : "";
            lines.push(`  ${s.courseId} (${s.credits}cr) priority=${s.priority}: ${s.reason}${risk}`);
        }
        if (plan.risks.length > 0) {
            lines.push(`Risks: ${plan.risks.map((r) => `[${r.level}] ${r.message}`).slice(0, 3).join(" | ")}`);
        }
        if (plan.enrollmentWarnings.length > 0) {
            lines.push(`Enrollment warnings: ${plan.enrollmentWarnings.slice(0, 3).join(" | ")}`);
        }
        return lines.join("\n");
    },
});

// ---- helpers ----

const COURSE_ID_RE = /\b([A-Z][A-Z0-9]*-[A-Z]{2,3})\s+(\d{1,4}[A-Z]?)\b/g;

/** Walk a Requirement's description text and pull out concrete
 *  course IDs (e.g., "CSCI-UA 421"). Returns deduped list. */
function extractCandidateCourseIds(req: DPRRequirement): string[] {
    const sources = [req.description ?? "", req.statusText, req.title].join(" ");
    const out = new Set<string>();
    for (const m of sources.matchAll(COURSE_ID_RE)) {
        out.add(`${m[1]} ${m[2]}`);
    }
    return Array.from(out);
}

function counterRemainingText(req: DPRRequirement): string {
    const c = req.counter;
    if (!c) return req.status === "satisfied" ? "no work remaining" : "work remaining";
    if (c.kind === "gpa") {
        return c.completed >= c.required
            ? `GPA threshold met (${c.completed.toFixed(3)} ≥ ${c.required.toFixed(3)})`
            : `Need GPA ≥ ${c.required.toFixed(3)} (currently ${c.completed.toFixed(3)})`;
    }
    if ("needed" in c && c.needed !== undefined) {
        return `Need ${c.needed} more.`;
    }
    const remaining = Math.max(0, c.required - c.used);
    return `Used ${c.used} of ${c.required}; ${remaining} remaining.`;
}
