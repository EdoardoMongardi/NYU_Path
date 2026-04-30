// ============================================================
// search_policy (Phase 5 §7.2 + §5)
// ============================================================
import { z } from "zod";
import { buildTool } from "../tool.js";
import { policySearch } from "../../rag/policySearch.js";
import { matchTemplate } from "../../rag/policyTemplate.js";
import {
    detectCoreUaReferences,
    detectRequirementReferences,
    type CoreUaClassification,
    type CoreUaRange,
} from "../../data/coreUaRanges.js";
import {
    type Disclaimer,
    type EnvelopeConfidence,
    renderEnvelopeMeta,
} from "../toolEnvelope.js";

export const searchPolicyTool = buildTool({
    name: "search_policy",
    description:
        "Looks up NYU policy + bulletin curriculum via the RAG corpus + " +
        "curated templates. Phase 9 expanded the corpus to index ALL CAS " +
        "program pages (Math BA, CS BA, the Math/CS joint major, every minor) " +
        "+ the College Core Curriculum + Stern, Tandon, Tisch, Gallatin, " +
        "Liberal Studies, Abu Dhabi, Shanghai program pages. The agent now " +
        "calls this tool for BOTH policy questions AND curriculum questions.\n\n" +
        "Returns BOTH (when both apply): a curated operator-verified verbatim " +
        "bulletin quote (\"CURATED TEMPLATE\") AND the top RAG chunks for " +
        "additional context. The agent decides what to quote.\n\n" +
        "Use this for:\n" +
        "  POLICY QUESTIONS:\n" +
        "    • Pass/Fail rules (per-term limit, career cap, deadline, eligibility)\n" +
        "    • Credit caps + overload, residency, time limit\n" +
        "    • F-1 / J-1 visa enrollment requirements\n" +
        "    • Withdrawal deadlines, W vs Y, drop windows\n" +
        "    • Double-counting / cross-school credit / transfer credit\n" +
        "    • Major/minor declaration, internal transfer, study-away\n" +
        "  CURRICULUM / MAJOR QUESTIONS (Phase 9):\n" +
        "    • \"Which CS courses are required for the Math/CS joint major?\"\n" +
        "    • \"What advanced math electives count for the joint major?\"\n" +
        "    • \"What is CORE-UA 400-499 — what does the range mean?\"\n" +
        "    • \"What does CORE-UA 700 satisfy?\"\n" +
        "    • \"What's the C-or-better-for-major rule?\"\n" +
        "    • \"What courses are in the [program X] requirements?\"\n\n" +
        "MANDATORY FOLLOW-UP: when `run_full_audit` returns an unsatisfied " +
        "requirement with generic text (\"Complete the following courses:\", " +
        "\"complete 1 course from CORE-UA 400-499\"), call this tool with the " +
        "program label + the requirement category to fetch the bulletin's " +
        "actual list, then quote the relevant sentence back to the student.\n\n" +
        "When the user asks about themselves AND a policy/curriculum (e.g. " +
        "\"how many P/F have I used? what's the cap?\"), pair this with " +
        "`run_full_audit` so you can quote the policy AND surface the student's " +
        "specific numbers.\n\n" +
        "Default-hard scope: returns only the student's home-school chunks " +
        "plus NYU-wide chunks. If the user EXPLICITLY mentions another school " +
        "by name, the override admits that school's chunks too. If you get " +
        "back \"POLICY UNCERTAINTY\" or no high-confidence hit AND no template, " +
        "say \"I couldn't find a specific policy on [X]\" and recommend the " +
        "student contact their adviser — do NOT synthesize from training data.\n\n" +
        "When the query references a CORE-UA course id or a College Core " +
        "Curriculum requirement name, the result envelope's " +
        "`coreUaClassifications` and `coreUaRequirements` fields carry the " +
        "deterministic bulletin mapping; surface those fields to the student.",
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
        // Phase 10 Stage 2 — attach deterministic CORE-UA range
        // classifications when the query references CORE-UA codes or
        // College Core Curriculum requirement names. The agent surfaces
        // these via posture rather than via a per-case prose rule.
        const coreUaClassifications: CoreUaClassification[] = detectCoreUaReferences(input.query);
        const coreUaRequirements: CoreUaRange[] = detectRequirementReferences(input.query);

        // Phase 10 envelope — anti-hallucination guard. When the
        // search returns no template AND no high-confidence RAG hit,
        // we attach a disclaimer that the agent must surface. This
        // structurally prevents the "agent invents a §-quote" failure
        // mode (P10_A08, P10_B05 from the baseline). The rule lives
        // in DATA, not prose: when retrieval is uncertain, the
        // envelope says so.
        const disclaimers: Disclaimer[] = [];
        let envelopeConfidence: EnvelopeConfidence = "high";
        if (result.kind === "escalate") {
            envelopeConfidence = "uncertain";
            disclaimers.push({
                id: "policy_no_match_no_fabrication",
                text:
                    `I couldn't find a specific bulletin policy on "${input.query.slice(0, 80)}". ` +
                    `Please contact your academic adviser for confirmation.`,
                reason:
                    "search_policy returned uncertainty (no template + low RAG confidence). " +
                    "Surface this verbatim instead of inventing a bulletin quote.",
            });
        } else if (result.kind === "rag" && (result.confidence ?? 0) < 0.5) {
            envelopeConfidence = "low";
            disclaimers.push({
                id: "policy_low_confidence_no_fabrication",
                text:
                    "I found related bulletin text but my confidence is moderate; " +
                    "treat the citation below as approximate and verify with your academic adviser before relying on it.",
                reason:
                    `RAG confidence is ${(result.confidence ?? 0).toFixed(2)}; do NOT format the snippet as a § verbatim quote.`,
            });
        } else if (result.kind === "rag" && (result.confidence ?? 0) < 0.7) {
            envelopeConfidence = "medium";
        }

        return {
            ...result,
            transferIntent: session.transferIntent === true,
            coreUaClassifications,
            coreUaRequirements,
            disclaimers,
            confidence: envelopeConfidence,
        };
    },
    summarizeResult(result) {
        const transferTag = result.transferIntent ? " (transferIntent=on)" : "";
        const lines: string[] = [];

        // Phase 10 Stage 2 — emit deterministic CORE-UA classifications
        // FIRST when present. The agent must surface these per posture
        // rule (no per-case prose rule needed).
        const cls = (result as { coreUaClassifications?: CoreUaClassification[] }).coreUaClassifications ?? [];
        const reqs = (result as { coreUaRequirements?: CoreUaRange[] }).coreUaRequirements ?? [];
        if (cls.length > 0 || reqs.length > 0) {
            lines.push(`CORE-UA CLASSIFICATIONS (deterministic; from CAS College Core Curriculum bulletin):`);
            for (const c of cls) {
                if (c.range) {
                    lines.push(`  ${c.courseId} → ${c.range.requirement} (${c.range.lo}-${c.range.hi} range)`);
                    lines.push(`    Source: ${c.range.bulletinSource}`);
                } else {
                    lines.push(`  ${c.courseId} → not in any known College Core Curriculum range`);
                }
            }
            for (const r of reqs) {
                lines.push(`  ${r.requirement} → CORE-UA ${r.lo}-${r.hi}`);
                lines.push(`    Source: ${r.bulletinSource}`);
            }
            lines.push(``);
        }

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
            // Phase 10 envelope rendering — disclaimers + confidence
            const env = renderEnvelopeMeta({
                disclaimers: (result as { disclaimers?: Disclaimer[] }).disclaimers,
                confidence: (result as { confidence?: EnvelopeConfidence }).confidence,
            });
            if (env) lines.push("", env);
            return lines.join("\n");
        }
        if (result.kind === "escalate") {
            const env = renderEnvelopeMeta({
                disclaimers: (result as { disclaimers?: Disclaimer[] }).disclaimers,
                confidence: (result as { confidence?: EnvelopeConfidence }).confidence,
            });
            return [
                `POLICY UNCERTAINTY${transferTag}: confidence=${result.confidence}. ${result.notes.join(" | ")}`,
                `Recommend: contact your academic adviser.`,
                env,
            ].filter((s) => s.length > 0).join("\n");
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
        // Phase 10 envelope rendering — disclaimers + confidence on
        // the RAG-only path. The anti-hallucination guard fires here
        // when confidence < 0.5.
        const env = renderEnvelopeMeta({
            disclaimers: (result as { disclaimers?: Disclaimer[] }).disclaimers,
            confidence: (result as { confidence?: EnvelopeConfidence }).confidence,
        });
        if (env) lines.push("", env);
        return lines.join("\n");
    },
});
