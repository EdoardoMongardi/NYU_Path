#!/usr/bin/env -S npx tsx
// ============================================================
// Live RAG agent test — pure-RAG end-to-end
// ============================================================
// Loads the OpenAI-embedded policy corpus + the real Claude agent loop
// and runs a set of multi-section questions (OGS visa, school transfer,
// add/drop major/minor). Prints each question + the agent's final
// answer + which tools it called, so the run can be compared against an
// independently-reasoned ground truth.
//
// Usage:
//   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... COHERE_API_KEY=... \
//     npx tsx tools/live-rag-test.ts
// ============================================================

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIEmbedder } from "../packages/engine/src/rag/embedder.js";
import { loadPolicyCorpusFromCache } from "../packages/engine/src/rag/policyCorpusCache.js";
import { CohereReranker, LocalLexicalReranker, type Reranker } from "../packages/engine/src/rag/reranker.js";
import {
    buildDefaultRegistry,
    buildSystemPrompt,
    runAgentTurn,
    createPrimaryClient,
    type ToolSession,
} from "../packages/engine/src/agent/index.js";
import { loadCourses, loadPrereqs, loadPrograms } from "../packages/engine/src/dataLoader.js";
import type { Program } from "@nyupath/shared";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const META = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");

interface Q {
    label: string;
    student: ToolSession["student"];
    transferIntent?: boolean;
    question: string;
}

const CAS_SOPH = {
    id: "live-cas-soph", catalogYear: "2025-2026", homeSchool: "cas",
    declaredPrograms: [], coursesTaken: [],
} as const;

const QUESTIONS: Q[] = [
    {
        label: "OGS / F-1 (final-semester RCL + CPT)",
        student: { ...CAS_SOPH, id: "live-f1", visaStatus: "f1" },
        question:
            "I'm an F-1 undergraduate in my final semester. I only have one 3-credit course " +
            "left to finish my degree, which is below full-time. (a) Can I just register for " +
            "that one course and keep my F-1 status? (b) I also lined up a paid spring " +
            "internship and want to use CPT — given I'll be on a reduced course load this " +
            "final semester, am I still eligible for CPT, and are there limits on hours?",
    },
    {
        label: "School transfer (CAS sophomore → Stern internal transfer)",
        student: { ...CAS_SOPH, declaredPrograms: [{ programId: "economics_ba", programType: "major" }] },
        transferIntent: true,
        question:
            "I'm a CAS sophomore and I want to internally transfer into Stern. What are the " +
            "requirements and the deadline, which courses should I have completed, and which " +
            "of my NYU courses count toward Stern's prerequisites?",
    },
    {
        label: "Add/drop major+minor (CAS declaration + double-counting)",
        student: { ...CAS_SOPH, declaredPrograms: [{ programId: "economics_ba", programType: "major" }] },
        question:
            "I'm a CAS student majoring in Economics. (a) How do I add a minor or declare a " +
            "second major, and is there a credit threshold by which I must declare? (b) Can a " +
            "single course count toward both my Economics major and a Mathematics minor, and " +
            "if so, how many courses can overlap?",
    },
];

async function main() {
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!openaiKey || !anthropicKey) {
        console.error("Need OPENAI_API_KEY + ANTHROPIC_API_KEY.");
        process.exit(1);
    }

    console.error("Loading corpus…");
    const embedder = new OpenAIEmbedder({ apiKey: openaiKey });
    const { store } = loadPolicyCorpusFromCache({ embedder, cachePath: CACHE, metaPath: META });
    const cohereKey = process.env.COHERE_API_KEY;
    const reranker: Reranker = cohereKey ? new CohereReranker({ apiKey: cohereKey }) : new LocalLexicalReranker();
    console.error(`Corpus loaded: ${store.size} chunks. Reranker: ${reranker.modelId}.`);

    const programs = new Map<string, Program>();
    for (const p of loadPrograms()) programs.set(p.programId, p);
    const courses = loadCourses();
    const prereqs = loadPrereqs();

    const client = createPrimaryClient();
    if (!client) { console.error("No LLM client (ANTHROPIC_API_KEY?)."); process.exit(1); }
    console.error(`Model: ${client.id}`);

    for (const q of QUESTIONS) {
        const session: ToolSession = {
            student: q.student,
            rag: { store, embedder, reranker },
            programs, courses, prereqs,
            ...(q.transferIntent ? { transferIntent: true } : {}),
        };
        const systemPrompt = buildSystemPrompt({ student: q.student });
        console.log("\n\n================================================================");
        console.log(`QUESTION [${q.label}] · model=${client.id}:`);
        console.log(q.question);
        console.log("----------------------------------------------------------------");
        const result = await runAgentTurn(client, buildDefaultRegistry(), session, q.question, {
            systemPrompt, maxTurns: 12,
        });
        if (result.kind !== "ok") {
            console.log(`AGENT NON-OK (${result.kind}). Tool calls made (${result.invocations.length}):`);
            for (const inv of result.invocations) {
                const q = (inv.args as { query?: string })?.query ?? JSON.stringify(inv.args).slice(0, 80);
                console.log(`  - ${inv.toolName}${inv.error ? "✗ERR" : inv.rejected ? "✗REJ" : ""}: ${q}`);
            }
            continue;
        }
        // Per-invocation status — a "✗ERR" marker flags any tool that
        // surfaced an error to the model (e.g., a rate-limited RAG call),
        // which is exactly what truncated retrieval before the backoff fix.
        const toolLine = result.invocations
            .map((i) => `${i.toolName}${i.error ? "✗ERR" : i.rejected ? "✗REJ" : ""}`)
            .join(", ") || "(none)";
        const erroredTools = result.invocations.filter((i) => i.error);
        console.log(`TOOLS CALLED (${result.invocations.length}): ${toolLine}`);
        if (erroredTools.length > 0) {
            console.log(`TOOL ERRORS: ${erroredTools.map((i) => `${i.toolName}: ${i.error?.message?.slice(0, 120)}`).join(" | ")}`);
        }
        console.log("----------------------------------------------------------------");
        // Print the FULL narrative the model produced across every turn,
        // not just `finalText`. Stronger models interleave substantive
        // prose with tool calls, so the user-facing answer can span
        // several assistant turns; `finalText` is only the last one.
        const assistantText = result.turnMessages
            .filter((m) => m.role === "assistant" && m.content.trim().length > 0)
            .map((m) => m.content.trim());
        if (assistantText.length > 1) {
            console.log(`AGENT ANSWER (${assistantText.length} assistant turns; full narrative):`);
            assistantText.forEach((t, i) => console.log(`\n--- turn ${i + 1} ---\n${t}`));
        } else {
            console.log("AGENT ANSWER:");
            console.log(result.finalText);
        }
    }
}

await main();
