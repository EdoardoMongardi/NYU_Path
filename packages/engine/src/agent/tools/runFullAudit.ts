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
import {
    type Disclaimer,
    type SuggestedFollowUp,
    type EnvelopeMeta,
    renderEnvelopeMeta,
} from "../toolEnvelope.js";

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
    /** Phase 10 F2 — slimmed transcript from the DPR. Exposes
     *  per-course term + grade + type so the agent can answer
     *  "what was my grade in X?", "what's my CS GPA?", "list my
     *  fall 2024 courses". Truncated to the most-recent N entries
     *  (anchored at the top, oldest dropped) to fit the tool-result
     *  budget. The full DPR remains in session.degreeProgressReport
     *  if a deeper introspection becomes necessary later. */
    dprCourseHistory?: Array<{
        term: string;                    // PeopleSoft term, e.g. "2024 Fall"
        courseId: string;                // "CSCI-UA 102"
        title: string;
        units: number;
        grade: string | null;            // null for IP rows + un-graded TE rows
        type: string;                    // "EN" | "IP" | "TE" | other
    }>;
    /** Phase 10 envelope — bulletin facts the agent must surface. */
    disclaimers?: Disclaimer[];
    /** Phase 10 envelope — pre-built next-step tool calls. */
    suggestedFollowUps?: SuggestedFollowUp[];
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
        "student's specific numbers is incomplete.\n\n" +
        "Phase 10 envelope: the result includes structured `disclaimers`, " +
        "`suggestedFollowUps`, and `dprInProgressCourses` fields. Surface " +
        "them — the disclaimers carry the bulletin's grade/P-F rules for " +
        "any unsatisfied major requirement; suggestedFollowUps points at " +
        "search_policy when a requirement's statusText is generic.",
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

            // Phase 10 F2 — slim transcript exposure. Sort by term
            // (most recent first using a coarse key), keep the top
            // N rows so the agent can answer per-course + per-term
            // questions without having to re-prompt. Sorting is
            // deterministic and based on the embedded year + season;
            // PeopleSoft term strings sort lexicographically by
            // accident only — we do it explicitly.
            const dprCourseHistory = sortCourseHistoryRecentFirst(dpr.courseHistory).slice(0, 60).map((c) => ({
                term: c.term,
                courseId: `${c.subject} ${c.catalogNbr}`,
                title: c.courseTitle,
                units: c.units,
                grade: c.grade,
                type: c.type,
            }));
            // Phase 10 envelope — derive disclaimers + suggested
            // follow-ups from the audit data + school config. Tool
            // RESULT carries the rules; the system prompt only carries
            // the posture rule "surface every envelope field".
            const env = deriveAuditEnvelope({
                unsatisfied,
                school: session.schoolConfig ?? null,
                hasMajorRequirementGap: detectMajorRequirementGap(unsatisfied, dpr),
                programLabel: dpr.programs.find((p) => p.programType === "Major Approved")?.label,
            });
            return {
                audits: filtered,
                standing,
                source: "dpr",
                dprPreparedDate: dpr.header.preparedDate,
                dprCumulative: { ...dpr.cumulative },
                dprUnsatisfiedRequirements: unsatisfied,
                ...(inProgress.length > 0 ? { dprInProgressCourses: inProgress } : {}),
                ...(dprCourseHistory.length > 0 ? { dprCourseHistory } : {}),
                ...(env.disclaimers && env.disclaimers.length > 0 ? { disclaimers: env.disclaimers } : {}),
                ...(env.suggestedFollowUps && env.suggestedFollowUps.length > 0 ? { suggestedFollowUps: env.suggestedFollowUps } : {}),
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

        // Phase 9 Stage 5 — when the DPR provides the deduped
        // UNSATISFIED REQUIREMENTS block, that's the canonical list.
        // Skip the per-program iteration in that case (it surfaces
        // R1004 + R1004/10 as separate items even though they're the
        // same requirement, which the agent then double-counts in
        // its summary). Only emit the per-program block when DPR
        // dedup data isn't available (authored-rules fallback path).
        const hasDedupedDprBlock =
            output.source === "dpr" &&
            output.dprUnsatisfiedRequirements !== undefined &&
            output.dprUnsatisfiedRequirements.length > 0;

        if (!hasDedupedDprBlock) {
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
        } else {
            // DPR-primary path — surface program-level credit headlines
            // only (no rule iteration; the deduped block below names
            // every actual unmet requirement once).
            for (const a of output.audits) {
                lines.push(`PROGRAM: ${a.programName} — ${a.totalCreditsCompleted}/${a.totalCreditsRequired} credits, ${a.overallStatus}`);
            }
        }

        // Phase 7-E W8 fix — list unsatisfied requirements with their
        // verbatim status sentence (which often names the missing
        // course, e.g., "Not Satisfied: Complete CSCI-UA 421...").
        // Phase 9 A3 dedup applies here — only one entry per
        // distinct unmet leaf requirement (parent groups whose child
        // rId is also unmet are dropped).
        if (hasDedupedDprBlock) {
            lines.push(`UNSATISFIED REQUIREMENTS (verbatim from DPR; ${output.dprUnsatisfiedRequirements!.length} distinct):`);
            for (const req of output.dprUnsatisfiedRequirements!.slice(0, 10)) {
                const needTag = req.needed ? ` [need ${req.needed} more]` : "";
                lines.push(`  - ${req.rId} ${req.title}${needTag}: ${req.statusText}`);
                if (req.description && req.description.length > 0 && req.description.length < 220) {
                    lines.push(`    ${req.description}`);
                }
            }
        }

        // Phase 10 F2 — slim transcript. Surfacing per-course term +
        // grade + type lets the agent answer "what was my grade in
        // X?", "what are my CS grades?", "list my fall 2024 courses".
        // Bounded at the row level (~60) so the result stays within
        // budget for students with full transcripts.
        if (output.dprCourseHistory && output.dprCourseHistory.length > 0) {
            lines.push(`COURSE HISTORY (most recent first; ${output.dprCourseHistory.length} rows shown):`);
            // Group by term so the agent can scan a semester at a glance.
            const byTerm = new Map<string, typeof output.dprCourseHistory>();
            for (const c of output.dprCourseHistory) {
                if (!byTerm.has(c.term)) byTerm.set(c.term, []);
                byTerm.get(c.term)!.push(c);
            }
            for (const [term, rows] of byTerm) {
                lines.push(`  ${term}:`);
                for (const c of rows) {
                    const gradeTag = c.grade ? `grade ${c.grade}` : (c.type === "IP" ? "IP (no grade yet)" : c.type === "TE" ? "transfer" : c.type);
                    lines.push(`    ${c.courseId} (${c.units}cr, ${gradeTag}) — ${c.title}`);
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

        // Phase 10 envelope rendering — surface disclaimers + suggested
        // follow-ups + bulletin anchors as their own block. The agent
        // sees this text and applies the posture rule "render envelope
        // fields verbatim".
        const envText = renderEnvelopeMeta({
            disclaimers: output.disclaimers,
            suggestedFollowUps: output.suggestedFollowUps,
        });
        if (envText) {
            lines.push("");
            lines.push(envText);
        }
        return lines.join("\n");
    },
    // Phase 7-B Step 15 — verbatim text the LLM must include
    // unchanged. We pin the cumulative GPA verdict (the most common
    // §2.1 violation pattern).
    //
    // Phase 9 Stage 5 LOOSENED: pre-Phase-9 the required text was
    // "Cumulative GPA: 3.402 (from your Degree Progress Report)." —
    // models commonly write "Cumulative GPA: 3.402" without the
    // parenthetical attribution suffix, triggering verbatim_drift on
    // every audit-using turn and surfacing a noisy ⚠ banner to the
    // student. The substring `Cumulative GPA: 3.402` is sufficient
    // to pin the number (the actual Cardinal Rule §2.1 protection);
    // attribution can be enforced separately via the
    // checkInvocations validator if needed.
    extractVerbatim(output) {
        const gpa = output.standing.cumulativeGPA.toFixed(3);
        return `Cumulative GPA: ${gpa}`;
    },
});

// Re-export to expose `walkRequirements` / `notSatisfiedRequirements`
// to other tools when they need to introspect the DPR tree without
// reaching into the dpr/ subpackage directly.
export { walkRequirements, notSatisfiedRequirements };

// ============================================================
// Phase 10 F2 — course-history sort helper
// ============================================================
// PeopleSoft term strings ("2024 Fall", "2025 Spr", "2024 Sum") don't
// lexicographically sort by recency on their own. Convert to a
// numeric key: year * 10 + season-rank, then sort descending. Used
// to take the most-recent 60 rows from courseHistory while preserving
// term order.

function termSortKey(term: string): number {
    const m = term.match(/^(\d{4})\s+(Fall|Spring|Spr|Summer|Sum|J Term|JTerm)$/i);
    if (!m) return 0;
    const yr = parseInt(m[1]!, 10);
    const seasonRaw = m[2]!.toLowerCase();
    // Within a year: Spring (start) < Summer < J Term < Fall (latest).
    // We sort descending later, so larger = more recent.
    const seasonRank =
        seasonRaw.startsWith("fa") ? 4 :
        seasonRaw.startsWith("j") ? 3 :
        seasonRaw.startsWith("su") ? 2 :
        seasonRaw.startsWith("sp") ? 1 : 0;
    return yr * 10 + seasonRank;
}

function sortCourseHistoryRecentFirst<T extends { term: string }>(rows: ReadonlyArray<T>): T[] {
    return rows.slice().sort((a, b) => termSortKey(b.term) - termSortKey(a.term));
}

// ============================================================
// Phase 10 envelope helpers
// ============================================================
// Derive the bulletin facts (disclaimers + suggested follow-ups) that
// must be surfaced for an audit result. These come from school config
// + DPR shape — not from prose rules in the system prompt.

const GENERIC_STATUS_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
    /^complete the following courses:?\s*$/i,
    /^complete the requirements outlined below\.?\s*$/i,
    /^complete\s+\d+\s+course\s+from/i,
    /^select\s+\d+\s+course/i,
    /\bCORE-UA\s+\d{3}-\d{3}\b/i,
];

const MAJOR_GROUP_HINTS: ReadonlyArray<RegExp> = [
    /\bcomputer science\b/i,
    /\bmathematics\b/i,
    /\bmajor\b/i,
    /\bjoint major\b/i,
    /\beconomics\b/i,
    /\bfinance\b/i,
    /\bphilosophy\b/i,
    /\bphysics\b/i,
    /\bbiology\b/i,
    /\bchemistry\b/i,
    /\bengineering\b/i,
];

function isGenericStatusText(statusText: string | undefined, description: string | undefined): boolean {
    const candidates = [statusText ?? "", description ?? ""];
    for (const c of candidates) {
        const trimmed = c.trim();
        if (!trimmed) continue;
        for (const re of GENERIC_STATUS_TEXT_PATTERNS) {
            if (re.test(trimmed)) return true;
        }
    }
    return false;
}

function detectMajorRequirementGap(
    unsatisfied: ReadonlyArray<{ rId: string; title: string; statusText: string; description?: string }>,
    dpr: DegreeProgressReport,
): boolean {
    const major = dpr.programs.find((p) => p.programType === "Major Approved");
    const majorTitle = major?.label ?? "";
    for (const u of unsatisfied) {
        const blob = `${u.title} ${u.statusText} ${u.description ?? ""}`;
        if (majorTitle && blob.toLowerCase().includes(majorTitle.toLowerCase())) return true;
        for (const hint of MAJOR_GROUP_HINTS) {
            if (hint.test(u.title) || hint.test(u.rId)) return true;
        }
    }
    return false;
}

interface AuditEnvelopeInput {
    unsatisfied: ReadonlyArray<{ rId: string; title: string; statusText: string; description?: string; needed?: number }>;
    school: import("@nyupath/shared").SchoolConfig | null;
    hasMajorRequirementGap: boolean;
    programLabel?: string;
}

function deriveAuditEnvelope(input: AuditEnvelopeInput): EnvelopeMeta {
    const disclaimers: Disclaimer[] = [];
    const followUps: SuggestedFollowUp[] = [];

    // Major-grade-rule disclaimers — sourced from school config's
    // gradeThresholds + passFail.countsForMajor, NOT from a prose
    // rule. When the schema lacks the data, we don't fabricate one.
    if (input.hasMajorRequirementGap && input.school) {
        const majorGrade = input.school.gradeThresholds?.major;
        if (majorGrade) {
            disclaimers.push({
                id: "school_major_grade_threshold",
                text: `A grade of ${majorGrade} or better is required in any course used to fulfill major requirements.`,
                reason: "Your reply references an unsatisfied major requirement; the school's bulletin grade-threshold rule applies.",
                bulletinSource: `data/schools/${input.school.schoolId}.json#gradeThresholds.major`,
            });
        }
        if (input.school.passFail && input.school.passFail.countsForMajor === false) {
            disclaimers.push({
                id: "school_pf_no_major",
                text: "Pass/Fail option does not count toward the major.",
                reason: "Your reply references an unsatisfied major requirement; the school's bulletin P/F rule applies.",
                bulletinSource: `data/schools/${input.school.schoolId}.json#passFail.countsForMajor`,
            });
        }
    }

    // Generic-statusText follow-up suggestions. When the DPR's prose
    // doesn't name specific courses, we attach a search_policy call
    // ready to fire.
    const seenQueries = new Set<string>();
    for (const u of input.unsatisfied.slice(0, 3)) {
        if (!isGenericStatusText(u.statusText, u.description)) continue;
        const labelHint = input.programLabel ? `${input.programLabel} ` : "";
        const query = `${labelHint}${u.title}`.trim().slice(0, 120);
        if (seenQueries.has(query)) continue;
        seenQueries.add(query);
        followUps.push({
            tool: "search_policy",
            args: { query },
            why: `Requirement "${u.title}" is described in generic prose; the bulletin program page lists the actual courses.`,
        });
    }

    return { disclaimers, suggestedFollowUps: followUps };
}
