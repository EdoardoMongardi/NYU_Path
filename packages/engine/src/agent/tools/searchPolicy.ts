// ============================================================
// search_policy (Phase 5 §7.2 + §5)
// ============================================================
import { z } from "zod";
import { buildTool } from "../tool.js";
import { policySearch } from "../../rag/policySearch.js";
import { matchTemplate } from "../../rag/policyTemplate.js";

export const searchPolicyTool = buildTool({
    name: "search_policy",
    description:
        "Looks up NYU policy via the RAG corpus + curated templates. " +
        "Returns BOTH (when both apply): a curated operator-verified " +
        "verbatim bulletin quote (\"CURATED TEMPLATE\") AND the top RAG " +
        "chunks for additional context. The agent decides what to quote.\n\n" +
        "Use this for any policy / rule question:\n" +
        "  • Pass/Fail rules (per-term limit, career cap, deadline, eligibility)\n" +
        "  • Credit caps + overload, residency, time limit\n" +
        "  • F-1 / J-1 visa enrollment requirements\n" +
        "  • Withdrawal deadlines, W vs Y, drop windows\n" +
        "  • Double-counting / cross-school credit / transfer credit\n" +
        "  • Major/minor declaration, internal transfer, study-away\n\n" +
        "When the user asks about themselves AND a policy (e.g. \"how many P/F " +
        "have I used? what's the cap?\"), pair this with `run_full_audit` so " +
        "you can quote the policy AND surface the student's specific numbers.\n\n" +
        "Default-hard scope: returns only the student's home-school chunks " +
        "plus NYU-wide chunks. If the user EXPLICITLY mentions another school " +
        "by name, the override admits that school's chunks too. If you get " +
        "back \"POLICY UNCERTAINTY\" or no high-confidence hit AND no template, " +
        "say \"I couldn't find a specific policy on [X]\" and recommend the " +
        "student contact their adviser — do NOT synthesize from training data.",
    inputSchema: z.object({
        query: z.string().min(2).describe("Natural-language policy question."),
    }),
    maxResultChars: 2500,
    async validateInput(_input, { session }) {
        if (!session.rag) return { ok: false, userMessage: "RAG corpus not loaded." };
        if (!session.student) {
            return { ok: false, userMessage: "I need your home school before I can scope a policy lookup." };
        }
        return { ok: true };
    },
    prompt: () =>
        `Look up NYU policy by natural-language query. The system applies a ` +
        `default-hard school scope filter (home school + NYU-wide); explicit ` +
        `school names in the query trigger cross-school inclusion.`,
    async call(input, { session }) {
        const rag = session.rag!;
        const result = await policySearch(
            input.query,
            {
                homeSchool: session.student!.homeSchool,
                catalogYear: session.student!.catalogYear,
                allowExplicitOverride: true,
                templates: rag.templates,
                ...(rag.confidenceBands ? { confidenceBands: rag.confidenceBands } : {}),
            },
            {
                store: rag.store,
                embedder: rag.embedder,
                reranker: rag.reranker,
                matchTemplate,
            },
        );
        // Per §7.2: when the session is in `transferIntent` mode, the
        // tool flags it on the returned result so the chat layer +
        // response validator can relax the home-school caveat and
        // surface target-school policies. The flag is metadata; the
        // policySearch core stays scoped per its hard-filter contract.
        return {
            ...result,
            transferIntent: session.transferIntent === true,
        };
    },
    summarizeResult(result) {
        const transferTag = result.transferIntent ? " (transferIntent=on)" : "";
        const lines: string[] = [];

        // Phase 8 A1: when a template matched, surface it FIRST (it's
        // operator-verified verbatim bulletin text). Then surface RAG
        // hits as additional context the agent can pull from. The
        // agent decides: quote the template verbatim, blend with RAG,
        // or skip if the template is adjacent-but-imperfect for the
        // specific question asked.
        if (result.kind === "template") {
            const t = result.template!.template;
            lines.push(`CURATED TEMPLATE${transferTag}: ${t.id} (school=${t.school}, last verified ${t.lastVerified})`);
            lines.push(`Source: ${t.source}`);
            lines.push(``);
            lines.push(t.body);
            // If the policySearch core also returned RAG hits, render
            // them below as extra context.
            const ragHits = (result.hits ?? []).slice(0, 3);
            if (ragHits.length > 0) {
                lines.push(``);
                lines.push(`-- ADDITIONAL RAG HITS (for context; not necessarily what the user asked) --`);
                for (const h of ragHits) {
                    const snippet = h.chunk.text.slice(0, 240).replace(/\s+/g, " ");
                    lines.push(`  [${h.chunk.meta.school}/${h.chunk.meta.section}] (rerank ${h.rerankScore.toFixed(2)})`);
                    lines.push(`    ${snippet}…`);
                    lines.push(`    Source: ${h.chunk.meta.source} (${h.chunk.meta.sourcePath}:${h.chunk.meta.sourceLine})`);
                }
            }
            if (result.notes.length > 0) lines.push(``, `Notes: ${result.notes.join(" | ")}`);
            return lines.join("\n");
        }
        if (result.kind === "escalate") {
            return `POLICY UNCERTAINTY${transferTag}: confidence=${result.confidence}. ${result.notes.join(" | ")}\nRecommend: contact your academic adviser.`;
        }
        lines.push(`RAG hits${transferTag} (confidence=${result.confidence}; scope=${result.scopedSchools.join(",")}; override=${result.overrideTriggered})`);
        for (const h of (result.hits ?? []).slice(0, 3)) {
            const snippet = h.chunk.text.slice(0, 280).replace(/\s+/g, " ");
            lines.push(`  [${h.chunk.meta.school}/${h.chunk.meta.section}] (rerank ${h.rerankScore.toFixed(2)})`);
            lines.push(`    ${snippet}…`);
            lines.push(`    Source: ${h.chunk.meta.source} (${h.chunk.meta.sourcePath}:${h.chunk.meta.sourceLine})`);
        }
        if (result.notes.length > 0) lines.push(`Notes: ${result.notes.join(" | ")}`);
        if (result.transferIntent) {
            lines.push(`Notes: User is exploring an internal transfer — target-school catalog rules may also apply; consider check_transfer_eligibility.`);
        }
        return lines.join("\n");
    },
});
