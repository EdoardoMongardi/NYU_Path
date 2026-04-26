// ============================================================
// Bakeoff Runner — Phase 5 prep (ARCHITECTURE.md §6.5.1)
// ============================================================
// Implements `CandidateRunner` for the model bakeoff. Given a candidate
// LLM client + frozen eval cases, produces `CandidateScores` per
// modelBakeoff.ts.
//
// Scoring:
//   - TS-Tool: did the model emit the right tool name AND a JSON-shape
//     compatible with `expectedArgsShape`? Per case: 1.0 (exact tool +
//     compatible shape), 0.5 (right tool, shape mismatch), 0.0 (wrong
//     tool or no tool when one was expected).
//   - TS-Synthesis: rubric-based (see scoreSynthesisCase below) — checks
//     `requiredCaveats` substrings present, no `forbiddenClaims`
//     substrings, and toolCalls includes every `requiredToolNames`. The
//     rubric is deterministic substring-match scoring, NOT a judge
//     model — keeps the bakeoff reproducible across runs and saves the
//     extra round-trip. (The architecture's spec also accepts a judge
//     model for synthesis; we use deterministic scoring at v1 for cost
//     + reproducibility, will add a judge in Phase 5 proper.)
//   - TS-Decomp: every `subQuestionMarker` substring must appear in the
//     reply. Score = (markers found / subQuestionCount), clamped [0,1].
// ============================================================

import type { LLMClient, BakeoffToolDef, BakeoffMessage } from "./llmClients.js";
import { tokensCostUsd } from "./llmClients.js";
import type {
    CandidateRunner,
    CandidateScores,
    DecompCase,
    SynthesisCase,
    ToolSelectionCase,
} from "./modelBakeoff.js";

// ============================================================
// System prompt for tool-selection cases
// ============================================================
//
// Keep it short — the bakeoff measures the MODEL, not our prompt
// engineering. A long system prompt would advantage the model with
// stronger instruction-following over the model with stronger raw
// reasoning. Fixed system prompt across candidates per §6.5.1.
const TOOL_SELECTION_SYSTEM_PROMPT =
    `You are an academic-advising agent for NYU. The user is an undergraduate. ` +
    `When the user asks a question that needs the engine's deterministic data ` +
    `(audits, plans, transfer eligibility, what-if comparisons, profile updates) ` +
    `or a policy lookup, call the appropriate tool. Do NOT synthesize numerical ` +
    `claims (GPA, credit counts, requirement counts) without a tool call — ` +
    `that violates the project's Cardinal Rules. Available tools are listed in ` +
    `the tools array; pick the most specific one.`;

const SYNTHESIS_SYSTEM_PROMPT =
    `You are an academic-advising agent for NYU. The frozen tool results are ` +
    `the AUTHORITATIVE source for any numbers or rule lists in the conversation. ` +
    `Quote them exactly. Surface caveats the tool flagged (e.g., low confidence, ` +
    `F-1 visa implications). Do NOT invent or paraphrase numerical values.`;

const DECOMP_SYSTEM_PROMPT =
    `You are an academic-advising agent for NYU. The user has just asked a ` +
    `multi-part question. Your job here is to RESPOND IN TEXT ONLY — do not ` +
    `call tools at this step. Acknowledge each sub-question explicitly in your ` +
    `text reply, even if a real answer would require data lookup. The point is ` +
    `to demonstrate that you parsed the question's structure: name each part, ` +
    `say what tool you would call for it, and signal that you'll address each ` +
    `one. Do not skip sub-questions.`;

// ============================================================
// Tool definitions exposed to the model during TS-Tool scoring
// ============================================================
//
// Per §7.2. Schemas are minimal — the bakeoff is testing tool selection,
// not full validation. Production tool definitions will carry richer
// JSONSchema bodies.
export const BAKEOFF_TOOLS: BakeoffToolDef[] = [
    {
        name: "run_full_audit",
        description:
            "Runs a deterministic degree audit against the student's declared programs. " +
            "Returns: rule status, courses satisfying each rule, GPA, credit totals, warnings.",
        parameters: {
            type: "object",
            properties: {
                programId: {
                    type: "string",
                    description: "Optional: limit the audit to a specific program id.",
                },
            },
        },
    },
    {
        name: "plan_semester",
        description:
            "Recommends courses for a target semester. Returns: ranked suggestions, " +
            "graduation risks, enrollment warnings.",
        parameters: {
            type: "object",
            properties: {
                targetSemester: {
                    type: "string",
                    description: "Semester to plan, e.g. '2025-fall'.",
                },
                maxCourses: { type: "integer" },
                maxCredits: { type: "integer" },
            },
            required: ["targetSemester"],
        },
    },
    {
        name: "check_transfer_eligibility",
        description:
            "Checks internal-transfer eligibility from the student's home school to a target school.",
        parameters: {
            type: "object",
            properties: {
                targetSchool: {
                    type: "string",
                    description: "Lowercase school id, e.g. 'stern', 'tandon'.",
                },
            },
            required: ["targetSchool"],
        },
    },
    {
        name: "what_if_audit",
        description:
            "Runs a hypothetical audit with a different set of declared programs (read-only). " +
            "Optionally compares to current declarations.",
        parameters: {
            type: "object",
            properties: {
                hypotheticalPrograms: {
                    type: "array",
                    items: { type: "string" },
                    description: "Program ids to hypothetically declare.",
                },
                compareWithCurrent: { type: "boolean", default: true },
            },
            required: ["hypotheticalPrograms"],
        },
    },
    {
        name: "search_policy",
        description:
            "Searches NYU bulletin policy text via the RAG corpus. Use for policy questions " +
            "(P/F rules, residency, credit caps, F-1 visa, etc.).",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string" },
            },
            required: ["query"],
        },
    },
    {
        name: "update_profile",
        description:
            "Updates the student's stored profile (declared programs, catalog year, visa status, etc.).",
        parameters: {
            type: "object",
            properties: {
                field: { type: "string" },
                value: {},
            },
            required: ["field", "value"],
        },
    },
];

// ============================================================
// TS-Tool scoring
// ============================================================

export interface ToolCaseResult {
    caseId: string;
    score: number;
    actualToolName?: string;
    expectedToolName: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    notes: string;
}

export async function scoreToolCase(
    client: LLMClient,
    tc: ToolSelectionCase,
): Promise<ToolCaseResult> {
    const messages: BakeoffMessage[] = [{ role: "user", content: tc.userMessage }];
    const completion = await client.complete({
        system: TOOL_SELECTION_SYSTEM_PROMPT,
        messages,
        tools: BAKEOFF_TOOLS,
        maxTokens: 512,
        temperature: 0,
    });

    const promptTokens = completion.usage?.promptTokens ?? 0;
    const completionTokens = completion.usage?.completionTokens ?? 0;
    const tc0 = completion.toolCalls[0];
    if (!tc0) {
        return {
            caseId: tc.id,
            score: 0,
            expectedToolName: tc.expectedToolName,
            latencyMs: completion.latencyMs,
            promptTokens, completionTokens,
            notes: `no tool call (text reply: ${completion.text.slice(0, 80)}…)`,
        };
    }
    if (tc0.name !== tc.expectedToolName) {
        return {
            caseId: tc.id,
            score: 0,
            actualToolName: tc0.name,
            expectedToolName: tc.expectedToolName,
            latencyMs: completion.latencyMs,
            promptTokens, completionTokens,
            notes: `wrong tool: got ${tc0.name}, expected ${tc.expectedToolName}`,
        };
    }
    const shapeOk = matchesShape(tc0.args, tc.expectedArgsShape);
    return {
        caseId: tc.id,
        score: shapeOk ? 1.0 : 0.5,
        actualToolName: tc0.name,
        expectedToolName: tc.expectedToolName,
        latencyMs: completion.latencyMs,
        promptTokens, completionTokens,
        notes: shapeOk ? "tool + shape match" : "tool match, shape mismatch",
    };
}

/**
 * Loose shape match between an `actual` argument object the model produced
 * and an `expected` shape from the eval set.
 *
 * Two `expected` formats are accepted (the eval-set authoring agent
 * defaulted to format B; existing callers use format A):
 *
 *   A. Flat key→value/type-spec map:
 *        { targetSchool: "stern" }                  // exact-string match
 *        { targetSemester: { type: "string" } }     // type-only match
 *
 *   B. JSONSchema-style object descriptor:
 *        { type: "object",
 *          properties: { programFilter: { type: "string", optional: true } },
 *          required: ["programFilter"] }
 *
 *      In format B, every key in `properties` whose `optional !== true`
 *      and whose name appears in `required` (or in `properties` when no
 *      `required` is provided) must appear in `actual` with a compatible
 *      type. Optional properties may be absent. Properties that are
 *      present must match the declared type.
 *
 * Extra keys in `actual` are allowed in both formats.
 */
export function matchesShape(
    actual: Record<string, unknown>,
    expected: Record<string, unknown>,
): boolean {
    // Format B detection: top-level `type: "object"` + `properties` block.
    if (
        expected.type === "object" &&
        expected.properties !== undefined &&
        typeof expected.properties === "object"
    ) {
        const props = expected.properties as Record<string, Record<string, unknown>>;
        const required = Array.isArray(expected.required)
            ? (expected.required as string[])
            : Object.keys(props).filter((k) => props[k]?.optional !== true);
        for (const k of required) {
            if (!(k in actual)) return false;
            const spec = props[k];
            if (!spec) continue;
            if (!valueMatchesSpec(actual[k], spec)) return false;
        }
        // Optional properties present in `actual`: type-check them too.
        for (const [k, spec] of Object.entries(props)) {
            if (k in actual && !valueMatchesSpec(actual[k], spec)) return false;
        }
        return true;
    }

    // Format A — flat key→value/type-spec map
    for (const [k, want] of Object.entries(expected)) {
        if (k.startsWith("_")) continue; // skip annotation fields like "_note"
        if (!(k in actual)) return false;
        const got = actual[k];
        if (typeof want === "string") {
            if (got !== want) return false;
        } else if (
            typeof want === "object" &&
            want !== null &&
            "type" in (want as Record<string, unknown>)
        ) {
            if (!valueMatchesSpec(got, want as Record<string, unknown>)) return false;
        } else {
            if (JSON.stringify(got) !== JSON.stringify(want)) return false;
        }
    }
    return true;
}

function valueMatchesSpec(got: unknown, spec: Record<string, unknown>): boolean {
    const t = spec.type as string | undefined;
    if (!t) return true; // no type constraint
    const actualType = Array.isArray(got) ? "array" : typeof got;
    if (t === "integer") {
        return typeof got === "number" && Number.isInteger(got);
    }
    if (t === "number") return typeof got === "number";
    return actualType === t;
}

// ============================================================
// TS-Synthesis scoring
// ============================================================

export interface SynthesisCaseResult {
    caseId: string;
    score: number;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    requiredCaveatsMissing: string[];
    forbiddenClaimsPresent: string[];
    requiredToolNamesMissing: string[];
}

export async function scoreSynthesisCase(
    client: LLMClient,
    sc: SynthesisCase,
): Promise<SynthesisCaseResult> {
    const toolResultsBlock = sc.frozenToolResults.length
        ? `Tool results so far:\n` +
          sc.frozenToolResults
              .map(
                  (t) =>
                      `- ${t.toolName} returned: ${JSON.stringify(t.result, null, 2)}`,
              )
              .join("\n")
        : `No tool calls have been made yet.`;
    const userContent = `${sc.userMessage}\n\n[Frozen context for synthesis test]\n${toolResultsBlock}`;

    const completion = await client.complete({
        system: SYNTHESIS_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        tools: BAKEOFF_TOOLS,
        maxTokens: 1024,
        temperature: 0,
    });

    const reply = completion.text.toLowerCase();
    const requiredCaveatsMissing = sc.rubric.requiredCaveats.filter(
        (c) => !reply.includes(c.toLowerCase()),
    );
    const forbiddenClaimsPresent = sc.rubric.forbiddenClaims.filter((c) =>
        reply.includes(c.toLowerCase()),
    );
    const issuedToolNames = new Set(completion.toolCalls.map((t) => t.name));
    const requiredToolNamesMissing = sc.rubric.requiredToolNames.filter(
        (n) => !issuedToolNames.has(n),
    );

    // Score components: each rubric category contributes 1/3 of the case
    // score; deductions are proportional to violations.
    const totalCheckpoints = Math.max(
        1,
        sc.rubric.requiredCaveats.length +
            sc.rubric.forbiddenClaims.length +
            sc.rubric.requiredToolNames.length,
    );
    const violations =
        requiredCaveatsMissing.length +
        forbiddenClaimsPresent.length +
        requiredToolNamesMissing.length;
    const score = Math.max(0, 1 - violations / totalCheckpoints);

    return {
        caseId: sc.id,
        score,
        latencyMs: completion.latencyMs,
        promptTokens: completion.usage?.promptTokens ?? 0,
        completionTokens: completion.usage?.completionTokens ?? 0,
        requiredCaveatsMissing,
        forbiddenClaimsPresent,
        requiredToolNamesMissing,
    };
}

// ============================================================
// TS-Decomp scoring
// ============================================================

export interface DecompCaseResult {
    caseId: string;
    score: number;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    markersHit: number;
    markersExpected: number;
}

export async function scoreDecompCase(
    client: LLMClient,
    dc: DecompCase,
): Promise<DecompCaseResult> {
    // Decomp tests text-decomposition: did the model address every part of
    // the multi-part question? Pass `tools: undefined` so the model emits
    // a text reply (not a tool call) we can scan for sub-question markers.
    const completion = await client.complete({
        system: DECOMP_SYSTEM_PROMPT,
        messages: [{ role: "user", content: dc.userMessage }],
        maxTokens: 1024,
        temperature: 0,
    });

    const reply = completion.text.toLowerCase();
    let hits = 0;
    for (const marker of dc.subQuestionMarkers) {
        if (reply.includes(marker.toLowerCase())) hits += 1;
    }
    const score = Math.min(1, hits / dc.subQuestionCount);
    return {
        caseId: dc.id,
        score,
        latencyMs: completion.latencyMs,
        promptTokens: completion.usage?.promptTokens ?? 0,
        completionTokens: completion.usage?.completionTokens ?? 0,
        markersHit: hits,
        markersExpected: dc.subQuestionCount,
    };
}

// ============================================================
// CandidateRunner: ties the three test sets together
// ============================================================

export interface PerCaseTrace {
    tool: ToolCaseResult[];
    synthesis: SynthesisCaseResult[];
    decomp: DecompCaseResult[];
    totalPromptTokens: number;
    totalCompletionTokens: number;
}

export interface RunCandidateResult {
    scores: CandidateScores;
    trace: PerCaseTrace;
}

/**
 * Run a single candidate against all three test sets. Returns the
 * `CandidateScores` shape that `runBakeoff` consumes, plus a per-case
 * trace for the report.
 */
export async function runCandidate(
    client: LLMClient,
    cases: {
        toolCases: ReadonlyArray<ToolSelectionCase>;
        synthesisCases: ReadonlyArray<SynthesisCase>;
        decompCases: ReadonlyArray<DecompCase>;
    },
    opts: { onProgress?: (msg: string) => void } = {},
): Promise<RunCandidateResult> {
    const log = opts.onProgress ?? (() => undefined);
    const tool: ToolCaseResult[] = [];
    const synth: SynthesisCaseResult[] = [];
    const decomp: DecompCaseResult[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for (const tc of cases.toolCases) {
        log(`[${client.id}] tool ${tc.id}`);
        const r = await scoreToolCase(client, tc);
        tool.push(r);
        promptTokens += r.promptTokens;
        completionTokens += r.completionTokens;
    }
    for (const sc of cases.synthesisCases) {
        log(`[${client.id}] synth ${sc.id}`);
        const r = await scoreSynthesisCase(client, sc);
        synth.push(r);
        promptTokens += r.promptTokens;
        completionTokens += r.completionTokens;
    }
    for (const dc of cases.decompCases) {
        log(`[${client.id}] decomp ${dc.id}`);
        const r = await scoreDecompCase(client, dc);
        decomp.push(r);
        promptTokens += r.promptTokens;
        completionTokens += r.completionTokens;
    }

    // Aggregate
    const tsToolScore = avg(tool.map((t) => t.score));
    const tsSynthesisScore = avg(synth.map((t) => t.score));
    const tsDecompScore = avg(decomp.map((t) => t.score));
    const allLatencies = [
        ...tool.map((t) => t.latencyMs),
        ...synth.map((t) => t.latencyMs),
        ...decomp.map((t) => t.latencyMs),
    ].sort((a, b) => a - b);
    const p50LatencyMs = allLatencies[Math.floor(allLatencies.length / 2)] ?? 0;

    // Cost rollup: extrapolate per-1000-turns from the actual tokens used.
    // Average prompt+completion tokens per turn × 1000 × pricing.
    const totalCalls = tool.length + synth.length + decomp.length;
    const avgPrompt = totalCalls > 0 ? promptTokens / totalCalls : 0;
    const avgCompletion = totalCalls > 0 ? completionTokens / totalCalls : 0;
    const costPerThousandTurnsUsd = tokensCostUsd(
        { prompt: avgPrompt * 1000, completion: avgCompletion * 1000 },
        client.pricing,
    );

    return {
        scores: {
            tsToolScore,
            tsSynthesisScore,
            tsDecompScore,
            p50LatencyMs,
            costPerThousandTurnsUsd,
        },
        trace: {
            tool, synthesis: synth, decomp,
            totalPromptTokens: promptTokens,
            totalCompletionTokens: completionTokens,
        },
    };
}

function avg(xs: number[]): number {
    if (xs.length === 0) return 0;
    return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Convenience adapter to plug a single LLMClient into runBakeoff's
 * `CandidateRunner` signature. Used by the entry script.
 */
export function makeCandidateRunner(client: LLMClient): CandidateRunner {
    return async (_candidate, cases) => {
        const r = await runCandidate(client, cases, {
            onProgress: (m) => process.stderr.write(m + "\n"),
        });
        return r.scores;
    };
}
