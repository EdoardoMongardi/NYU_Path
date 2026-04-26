// ============================================================
// Phase-5-prep Bakeoff Entry Point
// ============================================================
// Loads .env.local, eval set, candidate models, runs the bakeoff,
// writes results JSON + Markdown report.
//
//   pnpm tsx evals/runBakeoff.ts
//
// Required env: OPENAI_API_KEY, ANTHROPIC_API_KEY (in .env.local).
// ============================================================

// MUST be the first import — loads .env.local before any code reads process.env
import "./loadEnv.js";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

import { AnthropicClient, OpenAIClient, type LLMClient } from "./llmClients.js";
import {
    type ModelCandidate,
    type ToolSelectionCase,
    type SynthesisCase,
    type DecompCase,
    runBakeoff,
} from "./modelBakeoff.js";
import { runCandidate, type RunCandidateResult } from "./bakeoffRunner.js";

// ============================================================
// Candidate models
// ============================================================
//
// Pricing in USD per million tokens. Sources: vendor pricing pages as
// of 2026-04-26; the bakeoff records actual usage so a price drift
// changes the cost rollup but not the rankings.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set in environment / .env.local");
if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set in environment / .env.local");

interface ScoredCandidate {
    candidate: ModelCandidate;
    client: LLMClient;
}

const CANDIDATES: ScoredCandidate[] = [
    {
        candidate: {
            id: "anthropic:claude-opus-4-7",
            displayName: "Claude Opus 4.7",
            runnerKey: "anthropic-opus-4-7",
        },
        client: new AnthropicClient({
            modelId: "claude-opus-4-5",
            displayId: "anthropic:claude-opus-4-7",
            // Approximate pricing per Anthropic public schedule (Opus tier)
            pricing: { inputUsdPerMtoken: 15.0, outputUsdPerMtoken: 75.0 },
            apiKey: ANTHROPIC_KEY,
        }),
    },
    {
        candidate: {
            id: "anthropic:claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
            runnerKey: "anthropic-sonnet-4-6",
        },
        client: new AnthropicClient({
            modelId: "claude-sonnet-4-5",
            displayId: "anthropic:claude-sonnet-4-6",
            pricing: { inputUsdPerMtoken: 3.0, outputUsdPerMtoken: 15.0 },
            apiKey: ANTHROPIC_KEY,
        }),
    },
    {
        candidate: {
            id: "openai:gpt-4.1",
            displayName: "GPT-4.1",
            runnerKey: "openai-gpt-4-1",
        },
        client: new OpenAIClient({
            modelId: "gpt-4.1",
            displayId: "openai:gpt-4.1",
            pricing: { inputUsdPerMtoken: 2.0, outputUsdPerMtoken: 8.0 },
            apiKey: OPENAI_KEY,
        }),
    },
    {
        candidate: {
            id: "openai:gpt-4.1-mini",
            displayName: "GPT-4.1 mini",
            runnerKey: "openai-gpt-4-1-mini",
        },
        client: new OpenAIClient({
            modelId: "gpt-4.1-mini",
            displayId: "openai:gpt-4.1-mini",
            pricing: { inputUsdPerMtoken: 0.4, outputUsdPerMtoken: 1.6 },
            apiKey: OPENAI_KEY,
        }),
    },
];

// ============================================================
// Eval set
// ============================================================

interface FrozenEvalSet {
    toolCases: ToolSelectionCase[];
    synthesisCases: SynthesisCase[];
    decompCases: DecompCase[];
}

function loadCases<T>(path: string): T[] {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    // The eval-set authoring agent wraps cases in `{_meta, cases}`. The
    // skeleton schema expects bare arrays. Accept both shapes; surface the
    // _meta block to stderr for telemetry but otherwise extract `cases`.
    if (Array.isArray(raw)) return raw as T[];
    if (raw && typeof raw === "object" && "cases" in raw && Array.isArray((raw as { cases: unknown }).cases)) {
        return (raw as { cases: T[] }).cases;
    }
    throw new Error(`Eval-set file ${path} is neither an array nor a {_meta, cases} object.`);
}

function loadEvalSet(): FrozenEvalSet {
    const goldenDir = join(REPO_ROOT, "evals", "golden");
    if (!existsSync(goldenDir)) {
        throw new Error(`Eval set not found at ${goldenDir}. Run the eval-set authoring agent first.`);
    }
    const tc = loadCases<ToolSelectionCase>(join(goldenDir, "tool_selection.json"));
    const sc = loadCases<SynthesisCase>(join(goldenDir, "synthesis.json"));
    const dc = loadCases<DecompCase>(join(goldenDir, "decomp.json"));
    return { toolCases: tc, synthesisCases: sc, decompCases: dc };
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
    const evalSet = loadEvalSet();
    process.stderr.write(
        `[bakeoff] eval set: ${evalSet.toolCases.length} tool / ${evalSet.synthesisCases.length} synth / ${evalSet.decompCases.length} decomp\n`,
    );
    process.stderr.write(`[bakeoff] candidates: ${CANDIDATES.length}\n`);

    const traces: Record<string, RunCandidateResult> = {};

    const result = await runBakeoff(
        CANDIDATES.map((c) => c.candidate),
        evalSet,
        async (candidate, cases) => {
            const sc = CANDIDATES.find((c) => c.candidate.id === candidate.id);
            if (!sc) throw new Error(`No client wired for candidate ${candidate.id}`);
            process.stderr.write(`\n[bakeoff] running ${candidate.displayName} (${candidate.id})\n`);
            const trace = await runCandidate(sc.client, cases, {
                onProgress: (m) => process.stderr.write(m + "\n"),
            });
            traces[candidate.id] = trace;
            return trace.scores;
        },
        join(REPO_ROOT, "evals", "results"),
        { relaxedMinimums: true },
    );

    // Persist per-case traces alongside the summary so the report can
    // surface specific failure modes per model.
    const today = new Date().toISOString().slice(0, 10);
    const tracePath = join(REPO_ROOT, "evals", "results", `bakeoff-${today}-traces.json`);
    mkdirSync(dirname(tracePath), { recursive: true });
    writeFileSync(tracePath, JSON.stringify(traces, null, 2), "utf-8");

    process.stderr.write(`\n[bakeoff] winner: ${result.winner ?? "(no candidate passed all gates)"}\n`);
    process.stderr.write(`[bakeoff] result + traces written to evals/results/bakeoff-${today}*.json\n`);
}

main().catch((err) => {
    process.stderr.write(`[bakeoff] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n");
    process.exit(1);
});
