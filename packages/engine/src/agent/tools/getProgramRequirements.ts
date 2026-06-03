// ============================================================
// get_program_requirements (Improvement Plan — Phase B)
// ============================================================
// Whole-PAGE retrieval for curriculum questions. Where `search_policy`
// returns the top-K best-matching *fragments*, this tool answers the
// adviser-style question "what are ALL the requirements for program X?"
// by locating the program's bulletin page and handing the agent the
// ENTIRE reassembled page — every section, in order — so it can reason
// over the complete requirements block instead of one ~500-token
// fragment.
//
// Flow (see rag/sectionRetrieval.ts):
//   locate best-matching source (scope → vector → rerank, biased toward
//   `program` / `core_curriculum` / `school_overview` pages)
//   → reassemble that whole source → return full page + a confidence
//   band derived from the locate score.
//
// Grounding posture: this is a Tier-2 (bulletin-cited, confidence-
// scored) source, NOT a Tier-1 authoritative audit. The page is quoted
// from the indexed bulletin; the confidence band tells the agent how
// sure the locate step is that this is the right program page.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import {
    locateBestSource,
    reassembleSource,
    type ReassembledUnit,
} from "../../rag/sectionRetrieval.js";
import { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM } from "../../rag/policySearch.js";
import {
    type Disclaimer,
    type EnvelopeConfidence,
    renderEnvelopeMeta,
} from "../toolEnvelope.js";

interface FoundOutput {
    kind: "found";
    unit: ReassembledUnit;
    /** Locate score in [0,1] — how sure we are this is the right page. */
    topScore: number;
    scopedSchools: string[];
    overrideTriggered: boolean;
    disclaimers: Disclaimer[];
    confidence: EnvelopeConfidence;
}

interface NotFoundOutput {
    kind: "not_found";
    query: string;
    scopedSchools: string[];
    disclaimers: Disclaimer[];
    confidence: EnvelopeConfidence;
}

type GetProgramRequirementsOutput = FoundOutput | NotFoundOutput;

export const getProgramRequirementsTool = buildTool<
    z.ZodObject<{ program: z.ZodString }>,
    GetProgramRequirementsOutput
>({
    name: "get_program_requirements",
    description:
        "Returns the FULL bulletin page for a degree program, major, " +
        "minor, or the College Core Curriculum — every requirement " +
        "section reassembled in order, not just the single best-matching " +
        "fragment. Use this whenever the student asks what a program " +
        "REQUIRES as a whole, e.g.:\n" +
        "  • \"What are all the requirements for the Economics major?\"\n" +
        "  • \"What do I need to declare the CS minor?\"\n" +
        "  • \"Lay out the whole Math/CS joint major.\"\n" +
        "  • \"What's the full College Core Curriculum?\"\n\n" +
        "Prefer this over `search_policy` when the question is about a " +
        "program's COMPLETE requirement set (you want to read the whole " +
        "page like an adviser would). Prefer `search_policy` for a " +
        "narrow policy lookup (one rule, deadline, or cap).\n\n" +
        "Returns the reassembled page tagged with a CONFIDENCE band: " +
        "`high` = the located page is almost certainly the right program; " +
        "`medium` = likely right, verify the program name; `low` = the " +
        "best match was weak, treat as a lead and confirm with the " +
        "student or their adviser. This is a bulletin-cited ESTIMATE " +
        "(Tier-2), not the authoritative DPR audit (Tier-1) — quote it " +
        "as 'per the bulletin' and pair with `run_full_audit` when the " +
        "student asks how far along THEY are.\n\n" +
        "Scope: default-hard to the student's home school + NYU-wide " +
        "pages. Naming another school explicitly (e.g. \"Stern\", " +
        "\"Tandon\") admits that school's program pages too.",
    inputSchema: z.object({
        program: z
            .string()
            .min(2)
            .describe(
                "The program/major/minor to pull the full page for, e.g. " +
                "\"Computer Science BA\", \"Economics minor\", \"College Core Curriculum\".",
            ),
    }),
    // Program pages reassemble to whole documents (multiple KB). A
    // generous cap is the entire point of this tool — it must hand the
    // agent the complete requirements block, not a truncated head.
    maxResultChars: 12000,
    async validateInput(_input, { session }) {
        if (!session.rag) return { ok: false, userMessage: "RAG corpus not loaded." };
        if (!session.student) {
            return {
                ok: false,
                userMessage: "I need your home school before I can scope a program lookup.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        `Pull the COMPLETE bulletin page for a program/major/minor (every ` +
        `requirement section, reassembled in order) so you can reason over ` +
        `the whole requirement set. Honors the default-hard home-school ` +
        `scope; explicit school names in the query admit cross-school pages.`,
    async call(input, { session }) {
        const rag = session.rag!;
        const student = session.student!;
        const bands = rag.confidenceBands ?? { high: CONFIDENCE_HIGH, medium: CONFIDENCE_MEDIUM };

        const located = await locateBestSource(
            input.program,
            {
                homeSchool: student.homeSchool,
                catalogYear: student.catalogYear,
                allowExplicitOverride: true,
                preferCategories: ["program", "core_curriculum", "school_overview"],
            },
            { store: rag.store, embedder: rag.embedder, reranker: rag.reranker },
        );

        if (!located) {
            return {
                kind: "not_found",
                query: input.program,
                scopedSchools: [student.homeSchool, "all"],
                confidence: "uncertain",
                disclaimers: [
                    {
                        id: "program_page_not_found",
                        text:
                            `I couldn't find a bulletin page for "${input.program.slice(0, 80)}" ` +
                            `in scope. Double-check the program name, or contact your academic adviser.`,
                        reason:
                            "locateBestSource returned no in-scope source. Surface this instead of " +
                            "inventing requirements.",
                    },
                ],
            };
        }

        const unit = reassembleSource(rag.store, located.sourcePath);
        if (!unit) {
            // Defensive: locate found a path but reassembly hit no chunks
            // (should be impossible — locate's chunk came FROM the store).
            return {
                kind: "not_found",
                query: input.program,
                scopedSchools: located.scopedSchools,
                confidence: "uncertain",
                disclaimers: [
                    {
                        id: "program_page_not_found",
                        text:
                            `I located a possible match for "${input.program.slice(0, 80)}" but ` +
                            `couldn't reassemble its page. Contact your academic adviser.`,
                        reason: "reassembleSource returned null for a path locate produced.",
                    },
                ],
            };
        }

        // Confidence band from the locate score. We ALWAYS return the
        // located page (an adviser would still show you the page they
        // think you mean) but caveat hard when the match was weak.
        let confidence: EnvelopeConfidence;
        const disclaimers: Disclaimer[] = [];
        if (located.topScore >= bands.high) {
            confidence = "high";
        } else if (located.topScore >= bands.medium) {
            confidence = "medium";
            disclaimers.push({
                id: "program_page_medium_confidence",
                text:
                    `This looks like the right page for "${input.program.slice(0, 60)}", ` +
                    `but double-check the program name matches what you meant.`,
                reason:
                    `Locate score ${located.topScore.toFixed(2)} is in the medium band; the page is ` +
                    `likely but not certainly the intended program.`,
            });
        } else {
            confidence = "low";
            disclaimers.push({
                id: "program_page_low_confidence",
                text:
                    `I'm not confident this is the page for "${input.program.slice(0, 60)}". ` +
                    `Treat it as a lead and confirm the exact program with your adviser before relying on it.`,
                reason:
                    `Locate score ${located.topScore.toFixed(2)} is below the medium band; the best ` +
                    `match was weak. Do NOT present these requirements as authoritative.`,
            });
        }

        return {
            kind: "found",
            unit,
            topScore: located.topScore,
            scopedSchools: located.scopedSchools,
            overrideTriggered: located.overrideTriggered,
            confidence,
            disclaimers,
        };
    },
    summarizeResult(result) {
        if (result.kind === "not_found") {
            const env = renderEnvelopeMeta({
                disclaimers: result.disclaimers,
                confidence: result.confidence,
            });
            return [
                `PROGRAM PAGE NOT FOUND: nothing in scope (${result.scopedSchools.join(", ")}) ` +
                `matched "${result.query}".`,
                `Recommend: verify the program name or contact your academic adviser.`,
                env,
            ].filter((s) => s.length > 0).join("\n");
        }

        const u = result.unit;
        const lines: string[] = [];
        lines.push(
            `PROGRAM REQUIREMENTS — FULL PAGE (confidence=${result.confidence}; ` +
            `scope=${result.scopedSchools.join(",")}; override=${result.overrideTriggered})`,
        );
        lines.push(`Program: ${u.source} [school=${u.school}, year=${u.year}]`);
        lines.push(`Source: ${u.sourcePath} (${u.chunkCount} sections reassembled)`);
        if (u.sections.length > 0) {
            lines.push(`Sections: ${u.sections.join(" · ")}`);
        }
        lines.push("");
        lines.push(u.text);

        const env = renderEnvelopeMeta({
            disclaimers: result.disclaimers,
            confidence: result.confidence,
        });
        if (env) lines.push("", env);
        return lines.join("\n");
    },
});
