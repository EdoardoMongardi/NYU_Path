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
import {
    verifyPlanFeasibility,
    type FeasibilityViolation,
} from "../verifiers/planFeasibility.js";
import { renderEnvelopeMeta, type Disclaimer } from "../toolEnvelope.js";

/**
 * Phase 10 F1 — already-registered courses for the target term.
 * Sourced deterministically from `dpr.courseHistory` IP rows whose
 * `term` matches the requested `targetSemester`. Lets the agent open
 * with "you already have X / Y / Z = N credits in [term]" before
 * suggesting anything new.
 */
interface AlreadyRegisteredCourse {
    courseId: string;       // "CSCI-UA 473"
    title: string;
    units: number;
    /** PeopleSoft-formatted term string from the DPR, e.g. "2026 Fall". */
    term: string;
}

interface PlanSemesterOutput extends SemesterPlan {
    /** Phase 7-E — flags whether the plan came from the DPR primary
     *  path or the authored-rules fallback. */
    source: "dpr" | "authored";
    /** Phase 10 F1 — courses already in the student's IP rows for the
     *  target term. Empty when no IP rows match. */
    alreadyRegisteredForTarget?: AlreadyRegisteredCourse[];
    /** Phase 10 F1 — sum of `units` across alreadyRegisteredForTarget. */
    creditsAlreadyInTarget?: number;
    /** Phase 10 F1 — when the student has visaStatus="f1" and a school
     *  config with `f1FullTimeMinCredits`, surface the gap so the agent
     *  can answer "do I need more credits to keep my visa?". */
    remainingCreditsToReachF1Floor?: number | null;
    /** Phase 11 follow-up — requirements the planner could have
     *  suggested for this term but pruned because adding them would
     *  push the plan past the school's per-semester ceiling. The
     *  agent surfaces them as "deferred to a later term" so the
     *  student knows the full picture. Generic across all programs. */
    deferredToFutureTerms?: Array<{
        courseId: string;
        title: string;
        credits: number;
        reason: string;
    }>;
    /** Phase 11 S2 — deterministic feasibility-check disclaimers
     *  derived from school config + DPR + prereq graph. The agent
     *  surfaces these via the Phase 10 envelope-rendering posture. */
    disclaimers?: Disclaimer[];
    /** Phase 11 S2 — raw verifier violations for downstream debugging. */
    feasibilityViolations?: FeasibilityViolation[];
}

/**
 * Normalize a target-semester string ("2026-fall", "Fall 2026",
 * "2026 fall") into the PeopleSoft format used in DPR rows
 * ("2026 Fall"). Accepts a forgiving set of inputs and returns null
 * when it can't recognize the shape — caller falls back to surfacing
 * no IP rows rather than guessing wrong.
 */
function normalizeToDprTerm(input: string): string | null {
    const trimmed = input.trim();
    // "2026 Fall", "2024 Spr", "2025 Sum"
    const peopleSoft = trimmed.match(/^(\d{4})\s+(Fall|Spring|Spr|Summer|Sum|J Term|JTerm)$/i);
    if (peopleSoft) {
        const yr = peopleSoft[1]!;
        const seasonRaw = peopleSoft[2]!.toLowerCase();
        const season =
            seasonRaw.startsWith("fa") ? "Fall" :
            seasonRaw.startsWith("sp") ? "Spring" :
            seasonRaw.startsWith("su") ? "Summer" :
            seasonRaw.startsWith("j") ? "J Term" : null;
        return season ? `${yr} ${season}` : null;
    }
    // "2026-fall", "2027-spring", "2026-summer"
    const dashed = trimmed.match(/^(\d{4})-(fall|spring|summer|jterm)$/i);
    if (dashed) {
        const yr = dashed[1]!;
        const season =
            dashed[2]!.toLowerCase() === "fall" ? "Fall" :
            dashed[2]!.toLowerCase() === "spring" ? "Spring" :
            dashed[2]!.toLowerCase() === "summer" ? "Summer" :
            "J Term";
        return `${yr} ${season}`;
    }
    // "Fall 2026", "Spring 2027"
    const seasonFirst = trimmed.match(/^(Fall|Spring|Summer|J Term)\s+(\d{4})$/i);
    if (seasonFirst) {
        const season =
            seasonFirst[1]!.toLowerCase() === "fall" ? "Fall" :
            seasonFirst[1]!.toLowerCase() === "spring" ? "Spring" :
            seasonFirst[1]!.toLowerCase() === "summer" ? "Summer" :
            "J Term";
        return `${seasonFirst[2]} ${season}`;
    }
    return null;
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
        "WORKLOAD-BALANCED PLANNING (Phase 11.2):\n" +
        "ALWAYS pass `graduationTerm` (from the temporal-context block) " +
        "when the student has a stated graduation target. The planner then " +
        "spreads remaining 'hard' requirements (school core, CAS Core " +
        "Curriculum, major required, major electives) evenly across the " +
        "semesters between targetSemester and graduationTerm so no single " +
        "term is overloaded AND no last term is left empty. Free-elective " +
        "slots fill the remaining schedule capacity. The student can ask " +
        "for `loadStyle: 'frontload'` to take everything now or " +
        "`'backload'` to defer; default 'balanced'.\n\n" +
        "OFFERING-PATTERN CHECK (Phase 11.2):\n" +
        "When `searchAvailabilityFn` is wired (production route), the " +
        "planner verifies each candidate course against the target term " +
        "via FOSE before adding it. Courses not offered that term are " +
        "deferred. Courses offered ONLY once before graduation become " +
        "MUST-take for that term — surface that constraint clearly.\n\n" +
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
            .describe(
                "The student's program ID (e.g. 'computer_science_math'). " +
                "If the student has exactly one declared program, omit this and validateInput will fill it in. " +
                "If the student has multiple programs, this is REQUIRED — the planner will refuse without it.",
            ),
        graduationTerm: z.string().optional()
            .describe(
                "Optional: e.g. '2027-spring'. When set, the planner spreads " +
                "remaining hard requirements (school core, major required, major " +
                "electives) evenly across the semesters between targetSemester " +
                "and graduationTerm so no single term is overloaded.",
            ),
        loadStyle: z.enum(["balanced", "frontload", "backload"]).optional()
            .describe(
                "Distribution style for hard requirements when graduationTerm is " +
                "set. Default 'balanced' = equal split. 'frontload' = prefer " +
                "this term. 'backload' = prefer later terms.",
            ),
    }),
    maxResultChars: 3500,
    async validateInput(input, { session }) {
        if (!session.student) return { ok: false, userMessage: "I need your transcript or Degree Progress Report first." };

        // Phase 12 Task 4 — programId auto-default + multi-program guard.
        // Runs BEFORE the DPR-vs-authored split so both paths get the same
        // behavior. When the student has exactly one declared program and
        // the agent omitted programId, we fill it in so the DPR path can
        // scope its requirement walk. When the student has multiple
        // declared programs and no explicit programId was passed, we
        // reject early — the agent must be explicit about which program
        // to plan for, otherwise the DPR walk is ambiguous.
        const declared = session.student.declaredPrograms ?? [];
        if (!input.programId) {
            if (declared.length === 0) {
                return {
                    ok: false,
                    userMessage:
                        "You haven't declared a program. Either declare one first or pass an explicit programId.",
                };
            }
            if (declared.length === 1) {
                // Auto-default to the single declared program. This
                // makes the agent's life easier — it doesn't have to
                // remember to pass programId for single-program
                // students — while still failing loud on ambiguous
                // multi-declared cases.
                input.programId = declared[0]!.programId;
            } else {
                return {
                    ok: false,
                    userMessage:
                        `Student has ${declared.length} declared programs (${declared.map(p => p.programId).join(", ")}) — ` +
                        `pass programId explicitly to scope the plan.`,
                };
            }
        }

        // DPR path: only needs DPR + student (programId now guaranteed set above).
        if (session.degreeProgressReport) return { ok: true };
        // Authored-rules fallback: needs full data trio.
        if (!session.courses || !session.prereqs || !session.programs) {
            return { ok: false, userMessage: "Required engine data not loaded." };
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
        const loadStyle = input.loadStyle ?? "balanced";

        // ---- DPR primary path ----
        if (session.degreeProgressReport && session.student) {
            const dpr = session.degreeProgressReport;
            const ns = notSatisfiedRequirements(dpr.requirementGroups);
            const takenIds = new Set(
                dpr.courseHistory
                    .filter((c) => c.type !== "TE" || (c.grade ?? "") !== "")
                    .map((c) => `${c.subject} ${c.catalogNbr}`),
            );

            // Phase 11 follow-up — compute the credit budget BEFORE
            // generating suggestions. The effective ceiling is the
            // tighter of (input.maxCredits) and (school per-semester
            // ceiling), reduced by what's already in the target term's
            // IP rows. This prevents the planner from suggesting more
            // courses than the student can actually register for.
            // Generic: works for any school + any term + any major.
            const targetDprTermPreview = normalizeToDprTerm(input.targetSemester);
            const ipForTarget = targetDprTermPreview
                ? dpr.courseHistory.filter((c) => c.type === "IP" && c.term === targetDprTermPreview)
                : [];
            const ipCreditsForTarget = ipForTarget.reduce((s, c) => s + c.units, 0);
            const ceilingFromConfig = session.schoolConfig?.maxCreditsPerSemester ?? maxCredits;
            const ceiling = Math.min(maxCredits, ceilingFromConfig);
            const planBudget = Math.max(0, ceiling - ipCreditsForTarget);

            // Phase 12 Task 4 — scope the DPR walk to the requested
            // program. DPR requirements in this schema are school-level
            // (DPRRequirement has no programId field — only rId, title,
            // status, statusText, description, counter, coursesUsed).
            // The filter is therefore a no-op; left as a placeholder so
            // future DPR shapes with per-program scope wire through
            // cleanly. If NYU's parser ever emits a programId field on
            // leaf requirements, replace the `= ns` assignment with:
            //   ns.filter(req => {
            //       const rp = (req as { programId?: string }).programId;
            //       if (!rp) return true; // school-level requirement
            //       return rp === input.programId;
            //   })
            const scopedRequirements = ns;

            // Phase 11.2 — workload-balanced quota computation.
            // When `graduationTerm` is supplied, count the semesters
            // remaining (target → graduation inclusive) and divide
            // total hard-requirement courses across them. This stops
            // the planner from frontloading a heavy term + leaving an
            // empty senior semester (which is also bad: it forces the
            // student into low-credit electives or violates F-1
            // floor). Generic — works for any major and any
            // graduation horizon.
            const remainingHardRequirements = scopedRequirements.filter((req) => isHardRequirement(req));
            const semestersUntilGrad = input.graduationTerm
                ? countTermsBetween(input.targetSemester, input.graduationTerm)
                : 1;
            const hardQuotaForThisTerm = computeHardQuota(
                remainingHardRequirements.length,
                semestersUntilGrad,
                loadStyle,
                ipForTarget.filter((c) => isHardCourseId(`${c.subject} ${c.catalogNbr}`)).length,
            );

            const suggestions: CourseSuggestion[] = [];
            const deferredToFutureTerms: NonNullable<PlanSemesterOutput["deferredToFutureTerms"]> = [];
            let suggestedCredits = 0;
            let hardSuggested = 0;

            // Phase 11.2 — offering-pattern check helper. When
            // session.searchAvailabilityFn is wired (production
            // route), this lets the planner verify a candidate
            // course is offered in the target term BEFORE adding it
            // to suggestions. Generic — works for any course/term;
            // courses with a single offering window before
            // graduation are flagged as MUST-take.
            const sessionExt = session as unknown as { searchAvailabilityFn?: (termCode: string, keyword: string) => Promise<unknown[]> };
            const targetTermCode = encodeTermCodeForFose(input.targetSemester);
            async function isOfferedInTargetTerm(courseId: string): Promise<boolean | "unknown"> {
                if (!sessionExt.searchAvailabilityFn || !targetTermCode) return "unknown";
                try {
                    const results = await sessionExt.searchAvailabilityFn(targetTermCode, courseId);
                    return Array.isArray(results) && results.length > 0;
                } catch {
                    return "unknown";
                }
            }

            for (const req of scopedRequirements) {
                if (suggestions.length >= maxCourses) break;
                const isHard = isHardRequirement(req);
                // Phase 11.2 — respect the hard-quota cap. Once we
                // have enough hard courses for THIS term per the
                // balanced split, push the rest to deferred.
                if (isHard && hardSuggested >= hardQuotaForThisTerm) {
                    const candidates = extractCandidateCourseIds(req).filter((id) => !takenIds.has(id));
                    for (const cid of candidates.slice(0, 1)) {
                        deferredToFutureTerms.push({
                            courseId: cid,
                            title: req.title,
                            credits: 4,
                            reason:
                                `Hard requirement spread: with ${remainingHardRequirements.length} hard course(s) ` +
                                `across ${semestersUntilGrad} remaining term(s) (loadStyle=${loadStyle}), the balanced quota for ` +
                                `${input.targetSemester} is ${hardQuotaForThisTerm}. Take ${cid} in a later term to keep ` +
                                `the workload even and leave room for free electives this term.`,
                        });
                    }
                    continue;
                }
                const candidates = extractCandidateCourseIds(req);
                const fresh = candidates.filter((id) => !takenIds.has(id));
                if (fresh.length === 0) {
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
                    const credits = 4;

                    // Phase 11.2 — offering-pattern check. If the
                    // FOSE search returns 0 sections for this
                    // course in the target term, defer it.
                    const offered = await isOfferedInTargetTerm(courseId);
                    if (offered === false) {
                        deferredToFutureTerms.push({
                            courseId,
                            title: req.title,
                            credits,
                            reason:
                                `${courseId} is not offered in ${input.targetSemester} per the FOSE search. ` +
                                `Plan it for a different term in which it is offered.`,
                        });
                        continue;
                    }

                    if (suggestedCredits + credits > planBudget) {
                        deferredToFutureTerms.push({
                            courseId,
                            title: req.title,
                            credits,
                            reason:
                                `Adding ${courseId} (${credits} cr) would push ${input.targetSemester} past the ` +
                                `${ceiling}-credit ceiling (already-registered ${ipCreditsForTarget} cr + previously-suggested ${suggestedCredits} cr). ` +
                                `Plan it for a later term instead.`,
                        });
                        continue;
                    }
                    suggestions.push({
                        courseId,
                        title: req.title,
                        credits,
                        priority: isHard ? 1 : 3,
                        blockedCount: 0,
                        satisfiesRules: [req.rId],
                        category: "required",
                        reason: `Required for ${req.rId} (${req.title}). ${counterRemainingText(req)}`,
                    });
                    suggestedCredits += credits;
                    if (isHard) hardSuggested++;
                }
            }

            // Phase 11.2 — when the hard quota is filled but the
            // ceiling has room left, suggest free-elective slots
            // explicitly so the agent doesn't either (a) overload
            // with another hard course or (b) leave the term short.
            const remainingBudget = planBudget - suggestedCredits;
            if (remainingBudget >= 4 && hardSuggested >= hardQuotaForThisTerm && semestersUntilGrad > 1) {
                const slotsAvailable = Math.min(maxCourses - suggestions.length, Math.floor(remainingBudget / 4));
                for (let i = 0; i < slotsAvailable; i++) {
                    suggestions.push({
                        courseId: "(free elective — your choice)",
                        title: "Free elective",
                        credits: 4,
                        priority: 4,
                        blockedCount: 0,
                        satisfiesRules: [],
                        category: "elective",
                        reason:
                            `Hard-requirement quota for ${input.targetSemester} is met (${hardSuggested} of ${hardQuotaForThisTerm}). ` +
                            `Use this slot for a free elective — typically a lower-workload course you find interesting. ` +
                            `Use search_courses to discover options.`,
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

            // Phase 10 F1 — surface what the student is ALREADY
            // registered for in the target term, computed from the
            // DPR's IP rows. The agent uses this to open with "you
            // already have X / Y / Z = N credits in this term" so it
            // doesn't propose redundant or impossible plans.
            const targetDprTerm = normalizeToDprTerm(input.targetSemester);
            const alreadyRegisteredForTarget: AlreadyRegisteredCourse[] = targetDprTerm
                ? dpr.courseHistory
                    .filter((c) => c.type === "IP" && c.term === targetDprTerm)
                    .map((c) => ({
                        courseId: `${c.subject} ${c.catalogNbr}`,
                        title: c.courseTitle,
                        units: c.units,
                        term: c.term,
                    }))
                : [];
            const creditsAlreadyInTarget = alreadyRegisteredForTarget.reduce((s, c) => s + c.units, 0);

            // F-1 floor gap — derived from school config (data, not
            // a hardcoded constant). Null when the student isn't on
            // F-1 or no school config is loaded.
            const isF1 = session.student.visaStatus === "f1";
            const f1Min = isF1 ? (session.schoolConfig?.f1FullTimeMinCredits ?? 12) : null;
            const remainingCreditsToReachF1Floor = f1Min !== null
                ? Math.max(0, f1Min - creditsAlreadyInTarget - plannedCredits)
                : null;

            // Phase 11 S2 — run the deterministic feasibility verifier
            // and convert each violation into a Disclaimer that the
            // agent surfaces via the Phase 10 envelope-rendering rule.
            const feasibilityVerdict = verifyPlanFeasibility({
                suggestions,
                plannedCredits,
                targetSemester: input.targetSemester,
                creditsAlreadyInTarget,
                alreadyRegisteredForTargetIds: alreadyRegisteredForTarget.map((c) => c.courseId),
                schoolConfig: session.schoolConfig ?? null,
                visaStatus: session.student.visaStatus,
                dpr,
                prereqs: session.prereqs,
            });
            const planDisclaimers: Disclaimer[] = feasibilityVerdict.violations.map((v) => ({
                id: `plan_feasibility_${v.kind}${v.courseId ? `_${v.courseId.replace(/\s+/g, "_")}` : ""}`,
                text: v.detail,
                reason:
                    `Plan-feasibility verifier flagged a ${v.kind.replace(/_/g, " ")} violation. ` +
                    `Surface this verbatim — the student needs to know before acting.`,
            }));

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
                ...(alreadyRegisteredForTarget.length > 0 ? { alreadyRegisteredForTarget } : {}),
                creditsAlreadyInTarget,
                ...(remainingCreditsToReachF1Floor !== null ? { remainingCreditsToReachF1Floor } : {}),
                ...(deferredToFutureTerms.length > 0 ? { deferredToFutureTerms } : {}),
                ...(planDisclaimers.length > 0 ? { disclaimers: planDisclaimers } : {}),
                ...(feasibilityVerdict.violations.length > 0 ? { feasibilityViolations: feasibilityVerdict.violations } : {}),
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

        // Phase 10 F1 — surface already-registered courses for the
        // target term FIRST so the agent never proposes a redundant
        // plan or miscalculates credits.
        const ipForTarget = plan.alreadyRegisteredForTarget ?? [];
        const ipCredits = plan.creditsAlreadyInTarget ?? 0;
        if (ipForTarget.length > 0) {
            lines.push(`ALREADY REGISTERED FOR ${plan.targetSemester} (${ipCredits} credits — these are ALREADY in the student's schedule):`);
            for (const c of ipForTarget) {
                lines.push(`  ${c.courseId} (${c.units}cr) — ${c.title}`);
            }
        } else {
            lines.push(`ALREADY REGISTERED FOR ${plan.targetSemester}: (none — student has no IP rows in this term)`);
        }
        if (typeof plan.remainingCreditsToReachF1Floor === "number") {
            const gap = plan.remainingCreditsToReachF1Floor;
            if (gap > 0) {
                lines.push(`F-1 floor gap: ${gap} more credit(s) needed in ${plan.targetSemester} to keep full-time status (already-registered ${ipCredits} cr + planned ${plan.plannedCredits} cr).`);
            } else {
                lines.push(`F-1 floor: already met (already-registered ${ipCredits} cr + planned ${plan.plannedCredits} cr ≥ floor).`);
            }
        }

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
        // Phase 11 follow-up — deferred-to-future-term suggestions.
        // Surfaces requirements that didn't fit this term so the
        // agent doesn't simply hide them or recommend an overload.
        if (plan.deferredToFutureTerms && plan.deferredToFutureTerms.length > 0) {
            lines.push(`Deferred to a later term (would have exceeded the per-semester ceiling for ${plan.targetSemester}):`);
            for (const d of plan.deferredToFutureTerms) {
                lines.push(`  ${d.courseId} (${d.credits}cr): ${d.title}`);
                lines.push(`    Reason: ${d.reason}`);
            }
        }

        // Phase 11 S2 — render feasibility-verifier disclaimers via the
        // shared envelope renderer so the agent surfaces them per the
        // Phase 10 posture rule.
        const env = renderEnvelopeMeta({
            disclaimers: (plan as { disclaimers?: Disclaimer[] }).disclaimers,
        });
        if (env) {
            lines.push("");
            lines.push(env);
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

// ============================================================
// Phase 11.2 — workload-balancing helpers
// ============================================================
// All deterministic. Generic across all majors / programs / schools.
// "Hard" requirements = school-required + CAS Core (CORE-UA) + major
// required + major electives. The signal is the requirement's title /
// rId / description — we look for keywords that name the category in
// any program. No per-major branching.

const HARD_REQ_TITLE_RE = /\b(?:major|core curriculum|college core|required course|school requirement|university requirement|texts and ideas|cultures and contexts|expressive culture|societies and the social sciences|writing the essay|foreign language|natural science|quantitative reasoning)\b/i;
const HARD_REQ_RID_RE = /\b(?:CORE|MAJOR|MJREQ|REQ|MIN)\b/i;
const HARD_COURSE_PREFIX_RE = /^(?:CSCI-UA|MATH-UA|CORE-UA|EXPOS-UA|WRTG-UA|CHEM-UA|BIOL-UA|PHYS-UA|ECON-UA|FINC-UB|MGMT-UB)\s+/i;

function isHardRequirement(req: { title?: string; rId?: string; description?: string }): boolean {
    const blob = `${req.title ?? ""} ${req.rId ?? ""} ${req.description ?? ""}`;
    return HARD_REQ_TITLE_RE.test(blob) || HARD_REQ_RID_RE.test(blob);
}

function isHardCourseId(courseId: string): boolean {
    return HARD_COURSE_PREFIX_RE.test(courseId);
}

/**
 * Count semesters between targetSemester and graduationTerm
 * (inclusive of both endpoints). Generic for any term-format input
 * the planner accepts.
 */
function countTermsBetween(targetSemester: string, graduationTerm: string): number {
    const a = parseTermLoose(targetSemester);
    const b = parseTermLoose(graduationTerm);
    if (!a || !b) return 1;
    // Map (year, season) → an ordinal integer. Spring < Summer < Fall.
    const ord = (year: number, season: "spring" | "summer" | "fall") =>
        year * 3 + (season === "spring" ? 0 : season === "summer" ? 1 : 2);
    const diff = ord(b.year, b.season) - ord(a.year, a.season);
    if (diff < 0) return 1;
    // Ignore summer terms by default — most students don't take a
    // full load in summer. Count spring + fall only.
    let count = 0;
    let yr = a.year;
    let sn = a.season;
    while (true) {
        if (sn !== "summer") count++;
        if (yr === b.year && sn === b.season) break;
        if (sn === "spring") sn = "summer";
        else if (sn === "summer") sn = "fall";
        else { sn = "spring"; yr++; }
        if (yr > b.year + 6) break; // sanity bound
    }
    return Math.max(1, count);
}

function parseTermLoose(input: string): { year: number; season: "spring" | "summer" | "fall" } | null {
    const dprForm = normalizeToDprTerm(input);
    if (!dprForm) return null;
    const m = dprForm.match(/^(\d{4})\s+(Fall|Spring|Summer|J Term)$/);
    if (!m) return null;
    const yr = parseInt(m[1]!, 10);
    const seasonRaw = m[2]!.toLowerCase();
    const season =
        seasonRaw.startsWith("fa") ? "fall" :
        seasonRaw.startsWith("sp") ? "spring" :
        seasonRaw.startsWith("su") ? "summer" :
        null;
    if (!season) return null;
    return { year: yr, season };
}

/**
 * Compute how many hard-requirement courses to schedule for THIS
 * term given the total remaining + the semesters available + the
 * requested loadStyle.
 *
 *   - balanced (default): ceil(total / semesters), minus any hard
 *     courses already in this term's IP rows (we don't double-count).
 *   - frontload: take as many as the ceiling allows, capped at
 *     ceil(total / 1) for THIS term.
 *   - backload: take floor(total / semesters); spillover goes to
 *     later terms.
 *
 * Returns 0 when no hard requirements remain.
 */
function computeHardQuota(
    totalHardRemaining: number,
    semestersAvailable: number,
    style: "balanced" | "frontload" | "backload",
    hardAlreadyInTerm: number,
): number {
    if (totalHardRemaining <= 0) return 0;
    const semesters = Math.max(1, semestersAvailable);
    let target: number;
    if (style === "frontload") {
        target = totalHardRemaining; // try to take everything now
    } else if (style === "backload") {
        target = Math.floor(totalHardRemaining / semesters);
    } else {
        target = Math.ceil(totalHardRemaining / semesters);
    }
    // Subtract hard courses already in this term's IP rows so we
    // don't suggest more than the balanced quota.
    return Math.max(0, target - hardAlreadyInTerm);
}

/**
 * Map the targetSemester input to a FOSE 4-digit term code so the
 * offering-pattern check can call searchAvailability. Reuses the
 * Phase 10 Stage 2 deterministic encoder. Returns null if the
 * input shape is unrecognized — caller falls back to "unknown".
 */
function encodeTermCodeForFose(targetSemester: string): string | null {
    const dprTerm = parseTermLoose(targetSemester);
    if (!dprTerm) return null;
    if (dprTerm.season === "summer") {
        // FOSE summer codes ending in 6 — same encoding helper handles this.
    }
    if (dprTerm.season !== "spring" && dprTerm.season !== "summer" && dprTerm.season !== "fall") return null;
    const lastTwo = dprTerm.year % 100;
    const suffix = dprTerm.season === "spring" ? 4 : dprTerm.season === "summer" ? 6 : 8;
    return `1${lastTwo}${suffix}`;
}
