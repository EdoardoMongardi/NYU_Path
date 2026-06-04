// ============================================================
// search_policy — pure RAG over the NYU bulletin corpus
// ============================================================
// Curated FAQ templates + the deterministic CORE-UA range table were
// removed (the "nothing hardcoded" pass): search_policy now answers
// purely from the embedded bulletin corpus — scope filter → vector
// top-K → rerank → confidence gate, plus a whole-section reassembly of
// the top hit so the agent reads the complete rule, not a fragment.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import { policySearch } from "../../rag/policySearch.js";
import { reassembleSection, type ReassembledUnit } from "../../rag/sectionRetrieval.js";
import {
    type Disclaimer,
    type EnvelopeConfidence,
    renderEnvelopeMeta,
} from "../toolEnvelope.js";

export const searchPolicyTool = buildTool({
    name: "search_policy",
    description:
        "Looks up NYU policy + bulletin curriculum via the RAG corpus. The " +
        "corpus indexes every undergraduate school's program pages, the " +
        "College Core Curriculum, academic-policy pages, admissions / " +
        "internal-transfer pages, and the OGS visa/immigration (F-1/J-1/RCL/" +
        "CPT/OPT) pages. Call this for BOTH policy questions AND curriculum " +
        "questions.\n\n" +
        "Returns the top RAG chunks PLUS the top hit's FULL bulletin section " +
        "(\"FULL SECTION\") so you read the complete rule, not just the matched " +
        "~500-token fragment. For a program's ENTIRE requirement set (a whole " +
        "major/minor/core-curriculum page), prefer the dedicated " +
        "`get_program_requirements` tool instead.\n\n" +
        "Use this for:\n" +
        "  POLICY QUESTIONS:\n" +
        "    • Pass/Fail rules (per-term limit, career cap, deadline, eligibility)\n" +
        "    • Credit caps + overload, residency, time limit\n" +
        "    • F-1 / J-1 visa enrollment, reduced course load (RCL), CPT/OPT\n" +
        "    • Withdrawal deadlines, W vs Y, drop windows\n" +
        "    • Double-counting / cross-school credit / transfer credit\n" +
        "    • Major/minor declaration, internal transfer, study-away\n" +
        "    • CORE-UA ranges + what a College Core Curriculum requirement means\n" +
        "  CURRICULUM / MAJOR QUESTIONS:\n" +
        "    • \"Which CS courses are required for the Math/CS joint major?\"\n" +
        "    • \"What advanced math electives count for the joint major?\"\n" +
        "    • \"What courses are in the [program X] requirements?\"\n\n" +
        "When the student asks about themselves AND a policy/curriculum (e.g. " +
        "\"how many P/F have I used? what's the cap?\"), pair this with " +
        "`run_full_audit` so you can quote the policy AND surface the student's " +
        "specific numbers.\n\n" +
        "Default-hard scope: returns only the student's home-school chunks plus " +
        "NYU-wide chunks. If the user EXPLICITLY mentions another school by " +
        "name, the override admits that school's chunks too. If you get back " +
        "\"POLICY UNCERTAINTY\" or only a low-confidence hit, say \"I couldn't " +
        "find a specific policy on [X]\" and recommend the student contact " +
        "their adviser — do NOT synthesize from training data.",
    inputSchema: z.object({
        query: z.string().min(2).describe("Natural-language policy question."),
    }),
    // Program / minor / curriculum chunks are often 3KB+; a generous cap
    // lets the load-bearing course codes reach the agent intact.
    maxResultChars: 6000,
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
                ...(rag.confidenceBands ? { confidenceBands: rag.confidenceBands } : {}),
            },
            {
                store: rag.store,
                embedder: rag.embedder,
                reranker: rag.reranker,
            },
        );

        // Anti-hallucination envelope — banded on the NUMERIC top rerank
        // score. escalate → uncertain; weak hit → low + disclaimer;
        // moderate → medium; strong → high.
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
                    "search_policy returned uncertainty (low RAG confidence). " +
                    "Surface this verbatim instead of inventing a bulletin quote.",
            });
        } else if (result.kind === "rag" && (result.topScore ?? 0) < 0.5) {
            envelopeConfidence = "low";
            disclaimers.push({
                id: "policy_low_confidence_no_fabrication",
                text:
                    "I found related bulletin text but my confidence is moderate; " +
                    "treat the citation below as approximate and verify with your academic adviser before relying on it.",
                reason:
                    `RAG top rerank score is ${(result.topScore ?? 0).toFixed(2)}; do NOT format the snippet as a § verbatim quote.`,
            });
        } else if (result.kind === "rag" && (result.topScore ?? 0) < 0.7) {
            envelopeConfidence = "medium";
        }

        // Whole-section expansion — reassemble the top hit's FULL section
        // so the agent reasons over the complete rule, not a fragment.
        let wholeSection: ReassembledUnit | null = null;
        const topHit = result.hits?.[0];
        if (topHit) {
            wholeSection = reassembleSection(
                rag.store,
                topHit.chunk.meta.sourcePath,
                topHit.chunk.meta.section,
            );
        }

        return {
            ...result,
            transferIntent: session.transferIntent === true,
            disclaimers,
            confidence: envelopeConfidence,
            wholeSection,
        };
    },
    summarizeResult(result) {
        const transferTag = result.transferIntent ? " (transferIntent=on)" : "";
        const lines: string[] = [];

        // Top hit's FULL reassembled section (capped so it can't crowd out
        // the per-hit fragments + the envelope under the result-char cap).
        const ws = (result as { wholeSection?: ReassembledUnit | null }).wholeSection;
        const renderWholeSection = (): string[] => {
            if (!ws) return [];
            const CAP = 3000;
            const body = ws.text.length > CAP ? ws.text.slice(0, CAP) + "… (section truncated)" : ws.text;
            return [
                ``,
                `-- FULL SECTION (top hit, reassembled — read this for the complete rule) --`,
                `${ws.source} › ${ws.sections.join(" / ")} [${ws.school}]`,
                body,
                `   Source: ${ws.sourcePath} (${ws.chunkCount} chunk${ws.chunkCount === 1 ? "" : "s"})`,
            ];
        };

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
            const snippet = h.chunk.text.slice(0, 1400).replace(/\s+/g, " ");
            lines.push(`  [${h.chunk.meta.school}/${h.chunk.meta.section}] (rerank ${h.rerankScore.toFixed(2)})`);
            lines.push(`    ${snippet}…`);
            lines.push(`    Source: ${h.chunk.meta.source} (${h.chunk.meta.sourcePath}:${h.chunk.meta.sourceLine})`);
        }
        lines.push(...renderWholeSection());
        if (result.notes.length > 0) lines.push(`Notes: ${result.notes.join(" | ")}`);
        if (result.transferIntent) {
            lines.push(`Notes: User is exploring an internal transfer — target-school catalog rules may also apply; consider check_transfer_eligibility.`);
        }
        const env = renderEnvelopeMeta({
            disclaimers: (result as { disclaimers?: Disclaimer[] }).disclaimers,
            confidence: (result as { confidence?: EnvelopeConfidence }).confidence,
        });
        if (env) lines.push("", env);
        return lines.join("\n");
    },
});
