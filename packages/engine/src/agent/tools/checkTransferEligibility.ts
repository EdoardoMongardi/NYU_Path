// ============================================================
// check_transfer_eligibility (Phase 5 §7.2)
// ============================================================
import { z } from "zod";
import { buildTool } from "../tool.js";
import { checkTransferEligibility } from "../../audit/checkTransferEligibility.js";

export const checkTransferEligibilityTool = buildTool({
    name: "check_transfer_eligibility",
    description:
        "Checks INTERNAL-TRANSFER eligibility — i.e., the student moves their " +
        "degree-granting affiliation from their current NYU school to a different " +
        "NYU school. The result is about whether they can BECOME a student of the " +
        "target school, not about whether they can take individual courses or " +
        "programs offered there.\n\n" +
        "USE THIS FOR (student wants to CHANGE which school grants their degree):\n" +
        "  • \"how do I transfer to X\"\n" +
        "  • \"am I eligible to switch from CAS to Stern\"\n" +
        "  • \"can I move to Tisch as my home school\"\n\n" +
        "DO NOT USE THIS FOR (these are NOT internal-transfer questions, even " +
        "though they may name another NYU school):\n" +
        "  • \"can I add a [Stern/Tandon/Tisch] minor\" → minor declaration; call " +
        "    `search_policy` with the minor's name. Cross-school minors are " +
        "    constrained by the home school's non-home-school credit cap, not " +
        "    by the internal-transfer rule.\n" +
        "  • \"can I take a course at [other school]\" → cross-school enrollment; " +
        "    use `search_courses` + `search_policy` for the home school's " +
        "    cross-school credit policy.\n" +
        "  • \"can I count credits from [other school]\" → credit-counting; " +
        "    `get_credit_caps` + `search_policy`.\n" +
        "  • \"do I need to transfer to take [course]\" → almost never; usually " +
        "    cross-school enrollment, not transfer.\n\n" +
        "Returns: status (eligible / not_yet_eligible / ineligible / unsupported), " +
        "entry-year prereq checklist, application deadline, accepted terms, " +
        "missing-prereq detail.\n\n" +
        "Bulletin-grounded constraints this tool enforces:\n" +
        "  • Lower bound: most schools require ~32+ credits before applying.\n" +
        "  • Upper bound (CAS §Internal Transfer Students): seniors (≥96 credits) " +
        "    are ineligible — applications are not accepted during or after the " +
        "    junior year.\n" +
        "  • Same-major rule: students rarely transfer when their intended major " +
        "    has a close analog in their current school. Tool doesn't enforce " +
        "    automatically; surface the rule if applicable.\n\n" +
        "GPA thresholds for internal transfer are not published — the result " +
        "envelope's `gpaNote` field carries this disclaimer; surface it.",
    inputSchema: z.object({
        targetSchool: z.string().describe("Lowercase school id, e.g. 'stern', 'tandon'."),
    }),
    maxResultChars: 2500,
    async validateInput(input, { session }) {
        if (!session.student) return { ok: false, userMessage: "I need your transcript / profile first." };
        if (session.student.homeSchool === input.targetSchool) {
            return {
                ok: false,
                userMessage: `You're already in ${input.targetSchool}. Did you mean to change major within your current school?`,
            };
        }
        // Generic scope guard: if the latest user message keys on a
        // non-transfer concept (minor declaration, cross-school
        // enrollment, course-counting), this tool is the wrong tool.
        // Use deterministic phrase signals — no per-school keyword
        // blacklist — so the guard works for any school combination.
        const lastUser = session.lastUserMessage ?? "";
        if (lastUser.length > 0) {
            const minorIntent = /\bminor(?:s)?\b/i.test(lastUser);
            const transferIntent = /\b(?:transfer|switch (?:to|my)|move to|change (?:my )?school)\b/i.test(lastUser);
            if (minorIntent && !transferIntent) {
                return {
                    ok: false,
                    userMessage:
                        "This question looks like a minor-declaration question, not an internal-transfer question. " +
                        "Internal transfer = changing the degree-granting school. " +
                        "For minors offered by another NYU school, call `search_policy` with the minor's name " +
                        "(plus `get_credit_caps` if the question touches the non-home-school credit cap).",
                };
            }
            const courseEnrollIntent = /\b(?:take a course|take courses|enroll in|register for)\b/i.test(lastUser);
            if (courseEnrollIntent && !transferIntent) {
                return {
                    ok: false,
                    userMessage:
                        "This looks like a cross-school enrollment question, not an internal-transfer question. " +
                        "Use `search_courses` for the catalog + `search_policy` for cross-school credit rules.",
                };
            }
        }
        return { ok: true };
    },
    prompt: () =>
        `Check eligibility for internal transfer to a target NYU school. ` +
        `Required input: targetSchool (lowercase id). Returns deadline, prereq ` +
        `status, missing-prereq list, and the standard 'GPA not published' note.`,
    async call(input, { session }) {
        // When the DPR is loaded, prefer the DPR's authoritative
        // credit-completed total. Without this override, the function
        // sums student.coursesTaken which the DPR primary path leaves
        // empty — producing wrong "you need 32 credits" answers for
        // seniors with 138.
        const creditsOverride = session.degreeProgressReport?.cumulative.creditsUsed ?? undefined;
        const decision = checkTransferEligibility(session.student!, input.targetSchool, {
            ...(creditsOverride !== undefined ? { creditsOverride } : {}),
        });
        return decision;
    },
    summarizeResult(decision) {
        if (decision.status === "unsupported") {
            return `TRANSFER UNSUPPORTED: ${decision.reason} | Contact: ${decision.contact}`;
        }
        if (decision.status === "ineligible") {
            const after = decision.canApplyAfter ? ` (after: ${decision.canApplyAfter})` : "";
            return `TRANSFER INELIGIBLE: ${decision.reason}${after}`;
        }
        const lines: string[] = [];
        lines.push(`TRANSFER ${decision.status.toUpperCase()} (entry: ${decision.entryYear})`);
        lines.push(`Deadline: ${decision.deadline} | Accepted terms: ${decision.acceptedTerms.join(", ")}`);
        for (const p of decision.prereqStatus) {
            lines.push(`  ${p.satisfied ? "✓" : "✗"} ${p.category}: ${p.description}${p.satisfied ? ` (via ${p.courseTaken})` : ""}`);
        }
        if (decision.missingPrereqs.length > 0) {
            lines.push(`Missing: ${decision.missingPrereqs.map((m) => m.category).join(", ")}`);
        }
        lines.push(`Note: ${decision.gpaNote}`);
        return lines.join("\n");
    },
});
