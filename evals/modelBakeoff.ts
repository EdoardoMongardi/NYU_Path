// ============================================================
// Model Bakeoff Harness — Phase 0 SKELETON
// (ARCHITECTURE.md §6.5.1)
// ============================================================
// Phase 0 deliverable: directory + skeleton interfaces + scoring math.
// THIS FILE DOES NOT RUN A REAL BAKEOFF YET.
//
// What's here at Phase 0:
//   - the three test-set type definitions (TS-Tool, TS-Synthesis, TS-Decomp)
//   - the AgentScore composite scoring function
//   - the gate logic (≥0.85 score, ≤2.5s P50 latency, top-of-pack ≤5%)
//   - file I/O scaffolding for evals/results/bakeoff-YYYY-MM-DD.json
//
// What's NOT here (deferred to Phase 5):
//   - actual model invocation (OpenAI, Anthropic, Google clients)
//   - the 50/50/30 frozen test cases
//   - judge-model scoring of synthesis outputs (different model from agent)
//
// To run a bakeoff: implement runCandidate() and populate the test sets,
// then `pnpm tsx evals/modelBakeoff.ts`.
// ============================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Types
// ============================================================

export interface ModelCandidate {
    /** Vendor-qualified name, e.g. "openai:gpt-4o", "anthropic:claude-sonnet-4-6" */
    readonly id: string;
    readonly displayName: string;
    /** Implementation note: a runner per candidate is wired in Phase 5. */
    readonly runnerKey: string;
}

export interface ToolSelectionCase {
    readonly id: string;
    readonly userMessage: string;
    readonly expectedToolName: string;
    readonly expectedArgsShape: Record<string, unknown>;
}

export interface SynthesisCase {
    readonly id: string;
    readonly userMessage: string;
    readonly frozenToolResults: ReadonlyArray<{
        readonly toolName: string;
        readonly result: unknown;
    }>;
    /** Appendix D rubric expectations populated for this case. */
    readonly rubric: AppendixDRubric;
}

export interface DecompCase {
    readonly id: string;
    readonly userMessage: string;
    /** Number of distinct sub-questions the response should address. */
    readonly subQuestionCount: number;
    /** Substring fragments that signal each sub-question is answered. */
    readonly subQuestionMarkers: ReadonlyArray<string>;
}

export interface AppendixDRubric {
    /** Required tool names that MUST appear in evidence (Appendix D §D.1). */
    readonly requiredToolNames: ReadonlyArray<string>;
    /** Required substrings/caveats that MUST appear in response (§D.2). */
    readonly requiredCaveats: ReadonlyArray<string>;
    /** Forbidden claims (e.g. "all done", a specific GPA) (§D.4). */
    readonly forbiddenClaims: ReadonlyArray<string>;
}

export interface CandidateScores {
    readonly tsToolScore: number; // 0..1
    readonly tsSynthesisScore: number; // 0..1
    readonly tsDecompScore: number; // 0..1
    readonly p50LatencyMs: number;
    readonly costPerThousandTurnsUsd: number;
}

export interface BakeoffResult {
    readonly runDate: string; // ISO yyyy-mm-dd
    readonly candidates: ReadonlyArray<{
        readonly candidate: ModelCandidate;
        readonly scores: CandidateScores;
        readonly agentScore: number;
        readonly gatesPassed: GateReport;
    }>;
    readonly winner: string | null;
    readonly nextReviewDate: string;
}

export interface GateReport {
    readonly minAgentScorePassed: boolean;
    readonly maxLatencyPassed: boolean;
    readonly within5PctOfTopPassed: boolean;
}

// ============================================================
// Scoring (PURE — safe to unit test)
// ============================================================

export function agentScore(s: CandidateScores): number {
    return (
        0.4 * s.tsToolScore +
        0.4 * s.tsSynthesisScore +
        0.2 * s.tsDecompScore
    );
}

export const GATES = Object.freeze({
    minAgentScore: 0.85,
    maxP50LatencyMs: 2500,
    topPackToleranceFraction: 0.05,
});

export function gateReport(
    candidate: { agentScore: number; p50LatencyMs: number },
    topAgentScore: number,
): GateReport {
    return {
        minAgentScorePassed: candidate.agentScore >= GATES.minAgentScore,
        maxLatencyPassed: candidate.p50LatencyMs <= GATES.maxP50LatencyMs,
        within5PctOfTopPassed:
            candidate.agentScore >= topAgentScore - GATES.topPackToleranceFraction,
    };
}

// ============================================================
// Bakeoff runner — SKELETON
// ============================================================

export type CandidateRunner = (
    candidate: ModelCandidate,
    cases: {
        toolCases: ReadonlyArray<ToolSelectionCase>;
        synthesisCases: ReadonlyArray<SynthesisCase>;
        decompCases: ReadonlyArray<DecompCase>;
    },
) => Promise<CandidateScores>;

export interface RunBakeoffOptions {
    /**
     * Relax the §6.5.1 50/50/30 minimum case counts. ONLY for the
     * Phase-5-prep bakeoff — Phase 5 proper enforces full minimums.
     */
    relaxedMinimums?: boolean;
}

export async function runBakeoff(
    candidates: ReadonlyArray<ModelCandidate>,
    cases: {
        toolCases: ReadonlyArray<ToolSelectionCase>;
        synthesisCases: ReadonlyArray<SynthesisCase>;
        decompCases: ReadonlyArray<DecompCase>;
    },
    runner: CandidateRunner,
    outDir: string = join(__dirname, "results"),
    options: RunBakeoffOptions = {},
): Promise<BakeoffResult> {
    if (!options.relaxedMinimums) {
        if (cases.toolCases.length < 50)
            throw new Error("Phase 5 requirement: TS-Tool needs ≥50 cases.");
        if (cases.synthesisCases.length < 50)
            throw new Error("Phase 5 requirement: TS-Synthesis needs ≥50 cases.");
        if (cases.decompCases.length < 30)
            throw new Error("Phase 5 requirement: TS-Decomp needs ≥30 cases.");
    }

    const evaluated: Array<{
        candidate: ModelCandidate;
        scores: CandidateScores;
        agentScoreVal: number;
    }> = [];
    for (const c of candidates) {
        const scores = await runner(c, cases);
        evaluated.push({
            candidate: c,
            scores,
            agentScoreVal: agentScore(scores),
        });
    }

    const top = Math.max(...evaluated.map((e) => e.agentScoreVal));
    const survivors = evaluated.map((e) => ({
        candidate: e.candidate,
        scores: e.scores,
        agentScore: e.agentScoreVal,
        gatesPassed: gateReport(
            { agentScore: e.agentScoreVal, p50LatencyMs: e.scores.p50LatencyMs },
            top,
        ),
    }));

    // Pick winner: cheapest among those passing all gates.
    const eligible = survivors.filter(
        (s) =>
            s.gatesPassed.minAgentScorePassed &&
            s.gatesPassed.maxLatencyPassed &&
            s.gatesPassed.within5PctOfTopPassed,
    );
    eligible.sort(
        (a, b) =>
            a.scores.costPerThousandTurnsUsd - b.scores.costPerThousandTurnsUsd,
    );
    const winner = eligible[0]?.candidate.id ?? null;

    const today = new Date().toISOString().slice(0, 10);
    const next = new Date();
    next.setDate(next.getDate() + 90);
    const result: BakeoffResult = {
        runDate: today,
        candidates: survivors,
        winner,
        nextReviewDate: next.toISOString().slice(0, 10),
    };

    mkdirSync(outDir, { recursive: true });
    writeFileSync(
        join(outDir, `bakeoff-${today}.json`),
        JSON.stringify(result, null, 2),
        "utf-8",
    );
    return result;
}
