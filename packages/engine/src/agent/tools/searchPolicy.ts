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
        "Looks up NYU policy via the RAG corpus + curated templates. Use this " +
        "for any policy question (P/F rules, credit overload, residency, F-1 " +
        "visa, double-counting, withdrawal deadlines, transfer credits, etc.). " +
        "Default-hard scope: returns only the student's home-school chunks " +
        "plus NYU-wide chunks. If the user EXPLICITLY mentions another school " +
        "by name, the override admits that school's chunks too.",
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
        if (result.kind === "template") {
            const t = result.template!.template;
            return `TEMPLATE MATCH${transferTag}: ${t.id} (school=${t.school}, last verified ${t.lastVerified})\nSource: ${t.source}\n\n${t.body}`;
        }
        if (result.kind === "escalate") {
            return `POLICY UNCERTAINTY${transferTag}: confidence=${result.confidence}. ${result.notes.join(" | ")}\nRecommend: contact your academic adviser.`;
        }
        const lines: string[] = [];
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
