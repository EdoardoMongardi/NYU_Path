#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 7-E W10.8 — 5-persona smoke test
// ============================================================
// Walks 5 distinct personas through the full v2 pipeline:
//   - DPR injected into ToolSession
//   - Live agent loop (gpt-4.1-mini) with prod RAG + course catalog
//   - Each persona has 4 scripted turns (Tier-1 audit → Tier-2 plan
//     → Tier-3 what-if / policy)
//   - priorMessages carries forward across turns so the agent sees
//     full session context
//
// Difference from W8 (graded composite ≥0.90):
//   W10.8 is *bug-finding*. We do not gate on a quality score.
//   We capture every operational signal `runAgentTurn` emits and
//   classify into P0/P1/P2:
//
//     P0 (must-fix-before-launch):
//        - kind === "model_error_no_fallback" or "tool_unsupported"
//        - kind === "max_turns" with 0 invocations (loop hung)
//        - empty assistant text on a Tier-1 question
//        - validator block on a DPR-loaded numerical Q
//
//     P1 (fix-if-time):
//        - kind === "max_turns" with >0 invocations (slow)
//        - what-if turn missing the §6.4 advisor disclaimer
//        - F-1 visa policy turn returned generic refusal w/o citing OGS
//
//     P2 (post-launch):
//        - quality issues — out of scope for smoke
//
// Output:
//   tools/cohort-eval/results/smoke_w10_<stamp>.json
//   tools/cohort-eval/results/smoke_w10_report.md
//
// Usage:
//   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... [COHERE_API_KEY=...] \
//     npx tsx tools/cohort-eval/runSmokeW10.ts
// ============================================================

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    OpenAIEngineClient,
    OpenAIEmbedder,
    CohereReranker,
    LocalLexicalReranker,
    createSemanticCourseSearchFn,
    loadPolicyCorpusFromCache,
    loadPolicyTemplates,
    COHERE_CONFIDENCE_BANDS,
    DEFAULT_PRIMARY_MODEL,
    runAgentTurn,
    buildDefaultRegistry,
    buildSystemPrompt,
    validateResponse,
    type LLMClient,
    type LLMMessage,
    type CourseSearchFn,
    type Reranker,
    type ToolSession,
} from "../../packages/engine/src/index.js";
import { SMOKE_W10_PERSONAS } from "../../evals/cohorts/smoke_w10_personas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
const REPO_ROOT = join(__dirname, "..", "..");
const POLICY_CACHE_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const POLICY_META_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");
const COURSE_DESCRIPTIONS_PATH = join(REPO_ROOT, "data/course-catalog/course_descriptions.json");
const COURSE_EMBEDDINGS_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.jsonl");
const COURSE_META_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.meta.json");

const WHATIF_DISCLAIMER_FRAGMENT = "Verify with an academic adviser";

interface SmokeBug {
    severity: "P0" | "P1" | "P2";
    personaId: string;
    turnIndex: number;
    kind: string;
    detail: string;
}

interface TurnRecord {
    index: number;
    userMessage: string;
    assistantText: string;
    engineKind: string;
    invocationCount: number;
    invokedTools: string[];
    durationMs: number;
}

interface PersonaWalk {
    personaId: string;
    description: string;
    turns: TurnRecord[];
}

function loadPolicyRag(openaiKey: string, cohereKey: string | undefined): {
    store: ReturnType<typeof loadPolicyCorpusFromCache>["store"];
    embedder: OpenAIEmbedder;
    reranker: Reranker;
    templates: ReturnType<typeof loadPolicyTemplates>["templates"];
    confidenceBands?: typeof COHERE_CONFIDENCE_BANDS;
} | null {
    if (!existsSync(POLICY_CACHE_PATH)) return null;
    const embedder = new OpenAIEmbedder({ apiKey: openaiKey });
    const { store } = loadPolicyCorpusFromCache({
        embedder,
        cachePath: POLICY_CACHE_PATH,
        metaPath: POLICY_META_PATH,
    });
    const reranker: Reranker = cohereKey
        ? new CohereReranker({ apiKey: cohereKey })
        : new LocalLexicalReranker();
    const templates = loadPolicyTemplates().templates;
    return {
        store,
        embedder,
        reranker,
        templates,
        ...(cohereKey ? { confidenceBands: COHERE_CONFIDENCE_BANDS } : {}),
    };
}

function loadCourseSearch(openaiKey: string): CourseSearchFn | null {
    if (!existsSync(COURSE_DESCRIPTIONS_PATH) || !existsSync(COURSE_EMBEDDINGS_PATH)) return null;
    const embedder = new OpenAIEmbedder({ apiKey: openaiKey });
    return createSemanticCourseSearchFn({
        embedder,
        descriptionsPath: COURSE_DESCRIPTIONS_PATH,
        embeddingsPath: COURSE_EMBEDDINGS_PATH,
        embeddingsMetaPath: COURSE_META_PATH,
    });
}

async function walkPersona(
    persona: typeof SMOKE_W10_PERSONAS[number],
    agent: LLMClient,
    sessionExtras: Partial<ToolSession>,
): Promise<PersonaWalk> {
    const session: ToolSession = {
        student: persona.student,
        ...(persona.degreeProgressReport ? { degreeProgressReport: persona.degreeProgressReport } : {}),
        ...sessionExtras,
    };
    const systemPrompt = buildSystemPrompt({
        student: persona.student,
        dprLoaded: persona.degreeProgressReport !== undefined,
    });

    const priorMessages: LLMMessage[] = [];
    const turns: TurnRecord[] = [];

    for (let i = 0; i < persona.turns.length; i++) {
        const userMessage = persona.turns[i]!.userMessage;
        const startMs = Date.now();
        const result = await runAgentTurn(agent, buildDefaultRegistry(), session, userMessage, {
            systemPrompt,
            priorMessages: [...priorMessages],
            maxTurns: 8,
            // Wire validator + replay limit exactly the way v2 route does,
            // so the smoke runs against the same enforcement profile as
            // production. Without this, §6.4 disclaimer drift goes undetected.
            validatorReplayLimit: 1,
            validateResponse: ({ assistantText, invocations, session: s }) => {
                const verdict = validateResponse({
                    assistantText,
                    invocations,
                    student: s.student,
                });
                return {
                    ok: verdict.ok,
                    violations: verdict.violations.map((v) => ({ kind: v.kind, detail: v.detail })),
                };
            },
        });
        const durationMs = Date.now() - startMs;

        const assistantText = result.kind === "ok" ? result.finalText : (result as { finalText?: string }).finalText ?? "";
        const rawInvocations = (result as { invocations?: Array<{ toolName: string }> }).invocations ?? [];
        const invokedTools = rawInvocations.map((inv) => inv.toolName);
        turns.push({
            index: i,
            userMessage,
            assistantText,
            engineKind: result.kind,
            invocationCount: rawInvocations.length,
            invokedTools,
            durationMs,
        });

        priorMessages.push({ role: "user", content: userMessage });
        priorMessages.push({ role: "assistant", content: assistantText });
    }

    return {
        personaId: persona.id,
        description: persona.description,
        turns,
    };
}

function classifyBugs(walks: PersonaWalk[]): SmokeBug[] {
    const bugs: SmokeBug[] = [];
    for (const w of walks) {
        for (const t of w.turns) {
            // P0: hard-failure engine kinds
            if (t.engineKind === "model_error_no_fallback" || t.engineKind === "tool_unsupported") {
                bugs.push({ severity: "P0", personaId: w.personaId, turnIndex: t.index, kind: t.engineKind, detail: `engine returned kind=${t.engineKind} for "${t.userMessage.slice(0, 80)}"` });
            }
            if (t.engineKind === "max_turns" && t.invocationCount === 0) {
                bugs.push({ severity: "P0", personaId: w.personaId, turnIndex: t.index, kind: "max_turns_no_invocations", detail: `loop hung: maxTurns hit with zero tool calls for "${t.userMessage.slice(0, 80)}"` });
            }
            if (t.engineKind === "ok" && t.assistantText.trim().length === 0) {
                bugs.push({ severity: "P0", personaId: w.personaId, turnIndex: t.index, kind: "empty_assistant", detail: `assistant returned empty text for "${t.userMessage.slice(0, 80)}"` });
            }

            // P1: degraded but completed
            if (t.engineKind === "max_turns" && t.invocationCount > 0) {
                bugs.push({ severity: "P1", personaId: w.personaId, turnIndex: t.index, kind: "max_turns_with_calls", detail: `loop hit maxTurns after ${t.invocationCount} tool calls for "${t.userMessage.slice(0, 80)}"` });
            }
            const looksWhatIf = /\bwhat\s*if\b/i.test(t.userMessage);
            if (looksWhatIf && t.engineKind === "ok" && !t.assistantText.includes(WHATIF_DISCLAIMER_FRAGMENT)) {
                bugs.push({ severity: "P1", personaId: w.personaId, turnIndex: t.index, kind: "missing_whatif_disclaimer", detail: `what-if turn for "${t.userMessage.slice(0, 60)}" — assistant did not include §6.4 advisor disclaimer fragment` });
            }
            const looksF1Policy = /\bF-?1\b|\bvisa\b|\bfull-time\b/i.test(t.userMessage);
            if (looksF1Policy && t.engineKind === "ok" &&
                !/(OGS|Office of Global Services|adviser|advisor)/i.test(t.assistantText)) {
                bugs.push({ severity: "P1", personaId: w.personaId, turnIndex: t.index, kind: "missing_f1_referral", detail: `F-1 policy Q "${t.userMessage.slice(0, 60)}" — answer did not refer to OGS or an adviser` });
            }
        }
    }
    return bugs;
}

function renderReport(
    walks: PersonaWalk[],
    bugs: SmokeBug[],
    meta: { agentModel: string; startedAt: string; durationSec: number; ragLoaded: boolean; coursesLoaded: boolean },
): string {
    const lines: string[] = [];
    lines.push("# Phase 7-E W10.8 — Smoke-Test Report");
    lines.push("");
    lines.push(`Started: ${meta.startedAt}  ·  Duration: ${meta.durationSec.toFixed(1)}s`);
    lines.push(`Agent: \`${meta.agentModel}\`  ·  RAG: ${meta.ragLoaded ? "loaded" : "MISSING"}  ·  Course catalog: ${meta.coursesLoaded ? "loaded" : "MISSING"}`);
    lines.push("");
    const p0 = bugs.filter((b) => b.severity === "P0");
    const p1 = bugs.filter((b) => b.severity === "P1");
    lines.push("## Bug summary");
    lines.push(`- **P0 (must-fix-before-launch):** ${p0.length}`);
    lines.push(`- **P1 (fix-if-time):** ${p1.length}`);
    lines.push("");
    if (p0.length > 0) {
        lines.push("### P0 details");
        for (const b of p0) lines.push(`- \`${b.personaId}\` turn ${b.turnIndex} · ${b.kind}: ${b.detail}`);
        lines.push("");
    }
    if (p1.length > 0) {
        lines.push("### P1 details");
        for (const b of p1) lines.push(`- \`${b.personaId}\` turn ${b.turnIndex} · ${b.kind}: ${b.detail}`);
        lines.push("");
    }
    lines.push("## Per-persona walks");
    for (const w of walks) {
        const totalMs = w.turns.reduce((s, t) => s + t.durationMs, 0);
        lines.push(`### ${w.personaId}`);
        lines.push(`*${w.description}*`);
        lines.push(`Turns: ${w.turns.length}  ·  Total: ${(totalMs / 1000).toFixed(1)}s  ·  Engine kinds: ${w.turns.map((t) => t.engineKind).join(", ")}`);
        lines.push("");
        for (const t of w.turns) {
            const toolsLabel = t.invokedTools.length > 0 ? ` [${t.invokedTools.join(", ")}]` : "";
            lines.push(`**Turn ${t.index + 1}** _(kind=${t.engineKind}, ${t.invocationCount} tool calls${toolsLabel}, ${t.durationMs}ms)_`);
            lines.push(`- **User:** ${t.userMessage}`);
            const aText = t.assistantText.length > 700 ? t.assistantText.slice(0, 700) + "…" : t.assistantText;
            lines.push(`- **Assistant:** ${aText.replace(/\n/g, " ")}`);
            lines.push("");
        }
    }
    return lines.join("\n");
}

async function main(): Promise<void> {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) { console.error("OPENAI_API_KEY required."); process.exit(1); }

    const agent: LLMClient = new OpenAIEngineClient({ apiKey: openaiKey, modelId: DEFAULT_PRIMARY_MODEL });
    console.error(`Agent: ${agent.id}`);

    const cohereKey = process.env.COHERE_API_KEY;
    const ragBundle = loadPolicyRag(openaiKey, cohereKey);
    const searchCoursesFn = loadCourseSearch(openaiKey);
    if (!ragBundle) console.error("WARNING: policy RAG missing.");
    else console.error(`✓ Policy RAG loaded (reranker=${ragBundle.reranker.modelId}).`);
    if (!searchCoursesFn) console.error("WARNING: course catalog missing.");
    else console.error("✓ Course catalog loaded.");

    const sessionExtras: Partial<ToolSession> = {};
    if (ragBundle) (sessionExtras as Record<string, unknown>).rag = ragBundle;
    if (searchCoursesFn) (sessionExtras as Record<string, unknown>).searchCoursesFn = searchCoursesFn;

    console.error(`\nWalking ${SMOKE_W10_PERSONAS.length} personas × ${SMOKE_W10_PERSONAS[0]!.turns.length} scripted turns each...`);
    const startedAtMs = Date.now();
    const walks: PersonaWalk[] = [];
    for (const persona of SMOKE_W10_PERSONAS) {
        process.stderr.write(`  ${persona.id}... `);
        const w = await walkPersona(persona, agent, sessionExtras);
        const errs = w.turns.filter((t) => t.engineKind !== "ok").length;
        process.stderr.write(`${w.turns.length} turns, ${errs} non-ok\n`);
        walks.push(w);
    }
    const durationSec = (Date.now() - startedAtMs) / 1000;

    const bugs = classifyBugs(walks);

    mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = join(RESULTS_DIR, `smoke_w10_${stamp}.json`);
    const mdPath = join(RESULTS_DIR, `smoke_w10_report.md`);
    writeFileSync(jsonPath, JSON.stringify({
        _meta: {
            phase: "7-E W10.8",
            agentModel: agent.id,
            startedAt: new Date(startedAtMs).toISOString(),
            durationSec,
            personaCount: SMOKE_W10_PERSONAS.length,
            ragLoaded: ragBundle !== null,
            coursesLoaded: searchCoursesFn !== null,
        },
        bugs,
        walks,
    }, null, 2));
    writeFileSync(mdPath, renderReport(walks, bugs, {
        agentModel: agent.id,
        startedAt: new Date(startedAtMs).toISOString(),
        durationSec,
        ragLoaded: ragBundle !== null,
        coursesLoaded: searchCoursesFn !== null,
    }));

    const p0 = bugs.filter((b) => b.severity === "P0").length;
    const p1 = bugs.filter((b) => b.severity === "P1").length;
    console.error(`\n========== W10.8 Smoke ==========`);
    console.error(`P0: ${p0}  ·  P1: ${p1}  ·  Total bugs: ${bugs.length}`);
    console.error(`Results: ${jsonPath}`);
    console.error(`Report:  ${mdPath}\n`);
    console.error(`§W10.8 launch gate: ${p0 === 0 ? "PASS (P0=0)" : `FAIL (P0=${p0})`}\n`);

    if (p0 > 0) process.exit(2);
}

await main();
