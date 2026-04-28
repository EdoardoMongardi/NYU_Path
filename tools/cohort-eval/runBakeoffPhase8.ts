#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 8 Workstream B — 5-model bake-off runner
// ============================================================
// Drives the 25-question set (BAKEOFF_25) through the post-Phase-8
// architecture against multiple LLM agent models. For each model:
//   - Constructs the right client (OpenAIEngineClient / AnthropicEngineClient)
//   - Wires production RAG + course catalog + DPR (operator's real DPR)
//   - Runs each question once, captures tools invoked + final text +
//     latency
//   - Auto-grades against per-question deterministic checks
//   - Writes per-model JSON + a comparison-table markdown
//
// Selection criteria from PHASE_8_PLAN.md §B5:
//   1. Reject any model whose floor score < 3.0
//   2. Among the rest, reject any with composite < 4.0
//   3. Among the rest, pick the cheapest
//
// Usage:
//   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... COHERE_API_KEY=... \
//     npx tsx tools/cohort-eval/runBakeoffPhase8.ts \
//     [--models gpt-4.1-mini,gpt-4.1,claude-sonnet-4-6,claude-haiku-4-5,gpt-5]
// ============================================================

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText } from "unpdf";
import {
    OpenAIEngineClient,
    AnthropicEngineClient,
    OpenAIEmbedder,
    CohereReranker,
    LocalLexicalReranker,
    createSemanticCourseSearchFn,
    loadPolicyCorpusFromCache,
    loadPolicyTemplates,
    loadSchoolConfig,
    COHERE_CONFIDENCE_BANDS,
    runAgentTurn,
    buildDefaultRegistry,
    buildSystemPrompt,
    validateResponse,
    parseDpr,
    deriveTemporalContext,
    normalizeGraduationTarget,
    type LLMClient,
    type LLMMessage,
    type CourseSearchFn,
    type Reranker,
    type ToolSession,
    type ToolInvocation,
} from "../../packages/engine/src/index.js";
// Inlined to avoid cross-package .js / .ts resolution friction under tsx.
// Mirrors apps/web/lib/buildSession.ts → buildStudentProfileFromDpr.
import type { StudentProfile } from "@nyupath/shared";
function buildStudentProfileFromDpr(
    dpr: import("../../packages/engine/src/dpr/schema.js").DegreeProgressReport,
    opts: { visaStatus?: "f1" | "domestic" } = {},
): StudentProfile {
    const labelLower = (dpr.programs.find((p) => p.programType === "Program")?.label ?? "").toLowerCase();
    let homeSchool: string = "cas";
    if (labelLower.includes("steinhardt")) homeSchool = "steinhardt";
    else if (labelLower.includes("tisch")) homeSchool = "tisch";
    else if (labelLower.includes("stern")) homeSchool = "stern";
    else if (labelLower.includes("tandon")) homeSchool = "tandon";
    else if (labelLower.includes("gallatin")) homeSchool = "gallatin";
    else if (labelLower.includes("liberal studies") || labelLower.includes("ls ")) homeSchool = "ls";
    const major = dpr.programs.find((p) => p.programType === "Major Approved");
    const programId = (major?.label ?? "unknown_major").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return {
        id: dpr.header.studentName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40),
        catalogYear: "2024-2025",
        homeSchool,
        declaredPrograms: [{ programId, programType: "major" }],
        coursesTaken: [],
        ...(opts.visaStatus ? { visaStatus: opts.visaStatus } : {}),
    };
}
import { BAKEOFF_25, type BakeoffQuestion, type AutoCheck } from "../../evals/cohorts/bakeoff_25.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
const REPO_ROOT = join(__dirname, "..", "..");
const DPR_PDF_PATH = join(REPO_ROOT, "SAA_STD_DS.pdf");
const POLICY_CACHE_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const POLICY_META_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");
const COURSE_DESC_PATH = join(REPO_ROOT, "data/course-catalog/course_descriptions.json");
const COURSE_EMB_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.jsonl");
const COURSE_META_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.meta.json");

interface ModelSpec {
    id: string;
    family: "openai" | "anthropic";
    pricePerMTokensIn: number;
    pricePerMTokensOut: number;
}

const ALL_MODELS: ModelSpec[] = [
    { id: "gpt-4.1-mini",                   family: "openai",    pricePerMTokensIn: 0.15, pricePerMTokensOut: 0.60 },
    { id: "gpt-4.1",                        family: "openai",    pricePerMTokensIn: 2.00, pricePerMTokensOut: 8.00 },
    { id: "gpt-5",                          family: "openai",    pricePerMTokensIn: 1.25, pricePerMTokensOut: 10.0 },
    { id: "claude-sonnet-4-6",              family: "anthropic", pricePerMTokensIn: 3.00, pricePerMTokensOut: 15.0 },
    { id: "claude-haiku-4-5-20251001",      family: "anthropic", pricePerMTokensIn: 1.00, pricePerMTokensOut: 5.00 },
];

// ----------------------------------------------------------------
// Auto-grader — deterministic checks against the assistant text
// ----------------------------------------------------------------

interface AutoGrade {
    pass: number;
    fail: number;
    total: number;
    score: number; // 0..1
    failedChecks: string[];
}

function applyCheck(text: string, c: AutoCheck): { pass: boolean; detail: string } {
    const lower = text.toLowerCase();
    if (c.kind === "contains") {
        const ok = text.includes(c.text);
        return { pass: ok, detail: `contains "${c.text}"` };
    }
    if (c.kind === "containsAny") {
        const ok = c.options.some((opt) => text.includes(opt));
        return { pass: ok, detail: `containsAny [${c.options.map((s) => `"${s}"`).join(", ")}]` };
    }
    if (c.kind === "containsAll") {
        const missing = c.texts.filter((t) => !text.includes(t));
        return { pass: missing.length === 0, detail: `containsAll [${c.texts.map((s) => `"${s}"`).join(", ")}]` + (missing.length ? ` MISSING: ${missing.join(", ")}` : "") };
    }
    if (c.kind === "notContains") {
        const ok = !text.includes(c.text);
        return { pass: ok, detail: `notContains "${c.text}"` };
    }
    if (c.kind === "matchesRegex") {
        const ok = new RegExp(c.pattern, c.flags).test(text);
        return { pass: ok, detail: `matchesRegex /${c.pattern}/${c.flags ?? ""}` };
    }
    return { pass: false, detail: "unknown check" };
}

function autoGrade(q: BakeoffQuestion, finalText: string, toolsCalled: string[]): AutoGrade {
    const failedChecks: string[] = [];
    let pass = 0;
    let fail = 0;
    for (const c of q.autoChecks) {
        const r = applyCheck(finalText, c);
        if (r.pass) pass++; else { fail++; failedChecks.push(r.detail); }
    }
    // Tool requirement checks
    if (q.expectsNoTool && toolsCalled.length > 0) {
        fail++;
        failedChecks.push(`expectsNoTool but called: ${toolsCalled.join(", ")}`);
    }
    if (q.requiresTools && q.requiresTools.length > 0) {
        for (const t of q.requiresTools) {
            if (!toolsCalled.includes(t)) {
                fail++;
                failedChecks.push(`requires tool "${t}" but it wasn't called`);
            } else {
                pass++;
            }
        }
    }
    const total = pass + fail;
    return { pass, fail, total, score: total > 0 ? pass / total : 0, failedChecks };
}

// ----------------------------------------------------------------
// LLM-judge — qualitative score by claude-haiku-4-5 (different from
// any candidate so no self-grading inflation).
// ----------------------------------------------------------------

interface JudgeGrade {
    correctness: number;     // 1-5
    completeness: number;    // 1-5
    quality: number;         // 1-5
    safety: number;          // 1-5
    composite: number;       // mean
    rationale: string;
}

async function llmJudge(
    judge: LLMClient,
    q: BakeoffQuestion,
    finalText: string,
    toolsCalled: string[],
    autoGradeResult: AutoGrade,
): Promise<JudgeGrade> {
    const judgeSystem = `You are a strict, fair grader for an AI academic-advising tool's response quality. Score on 4 axes from 1 (terrible) to 5 (excellent). Output ONLY a JSON object on a single line: {"correctness":N,"completeness":N,"quality":N,"safety":N,"rationale":"..."}.

Rubrics:
- correctness: Does the answer match the ground truth + the question's rubric?
- completeness: Does it answer EVERYTHING the user asked, and use available tools fully?
- quality: Well-organized, professional, helpful tone, no unnecessary verbosity?
- safety: No fabricated numbers, appropriate caveats on hypotheticals, no overconfidence on uncertain policy, no fake actions?

Be strict. Reserve 5 for genuinely excellent answers. A 4 is "good with minor issues". A 3 is "substantively flawed but mostly OK". 1-2 are real failures.`;

    const judgeUser = `QUESTION (category=${q.category}): ${q.question}

EXPECTED RUBRIC: ${q.judgeRubric}

TOOLS CALLED: ${toolsCalled.join(", ") || "(none)"}

ASSISTANT'S ANSWER:
"""
${finalText}
"""

DETERMINISTIC AUTO-GRADE: pass=${autoGradeResult.pass}/${autoGradeResult.total} score=${autoGradeResult.score.toFixed(2)} ${autoGradeResult.failedChecks.length > 0 ? "FAILED: " + autoGradeResult.failedChecks.join(" | ") : "(all auto-checks passed)"}

Score and explain. JSON only.`;

    const res = await judge.complete({
        system: judgeSystem,
        messages: [{ role: "user", content: judgeUser }],
        temperature: 0.1,
        maxTokens: 400,
    });
    const text = res.text.trim();
    // Extract JSON (judges sometimes add prose around it)
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) {
        return { correctness: 0, completeness: 0, quality: 0, safety: 0, composite: 0, rationale: `JUDGE_PARSE_FAIL: ${text.slice(0, 200)}` };
    }
    try {
        const j = JSON.parse(m[0]) as { correctness: number; completeness: number; quality: number; safety: number; rationale?: string };
        const composite = (j.correctness + j.completeness + j.quality + j.safety) / 4;
        return {
            correctness: j.correctness,
            completeness: j.completeness,
            quality: j.quality,
            safety: j.safety,
            composite,
            rationale: j.rationale ?? "",
        };
    } catch {
        return { correctness: 0, completeness: 0, quality: 0, safety: 0, composite: 0, rationale: `JUDGE_JSON_FAIL: ${m[0].slice(0, 200)}` };
    }
}

// ----------------------------------------------------------------
// Per-model run
// ----------------------------------------------------------------

interface QuestionResult {
    questionId: string;
    category: string;
    question: string;
    finalText: string;
    toolsCalled: string[];
    engineKind: string;
    durationMs: number;
    autoGrade: AutoGrade;
    judgeGrade: JudgeGrade;
}

interface ModelRun {
    model: ModelSpec;
    questions: QuestionResult[];
    totalDurationMs: number;
    composite: number;
    floor: number;
}

function makeAgentClient(spec: ModelSpec, openaiKey: string, anthropicKey: string): LLMClient {
    if (spec.family === "openai") {
        return new OpenAIEngineClient({ apiKey: openaiKey, modelId: spec.id });
    }
    return new AnthropicEngineClient({ apiKey: anthropicKey, modelId: spec.id });
}

async function runOneQuestion(
    agent: LLMClient,
    judge: LLMClient,
    session: ToolSession,
    systemPrompt: string,
    q: BakeoffQuestion,
    priorMessages: LLMMessage[],
): Promise<QuestionResult> {
    const startMs = Date.now();
    const result = await runAgentTurn(agent, buildDefaultRegistry(), session, q.question, {
        systemPrompt,
        priorMessages,
        maxTurns: 8,
        validatorReplayLimit: 1,
        validateResponse: ({ assistantText, invocations, session: s }) => {
            const v = validateResponse({ assistantText, invocations, student: s.student });
            return { ok: v.ok, violations: v.violations.map((vi) => ({ kind: vi.kind, detail: vi.detail })) };
        },
    });
    const durationMs = Date.now() - startMs;
    const finalText = result.kind === "ok" ? result.finalText : (result as { finalText?: string }).finalText ?? "";
    const invocations = (result as { invocations?: ToolInvocation[] }).invocations ?? [];
    const toolsCalled = Array.from(new Set(invocations.map((i) => i.toolName)));

    const auto = autoGrade(q, finalText, toolsCalled);
    let judged: JudgeGrade;
    try {
        judged = await llmJudge(judge, q, finalText, toolsCalled, auto);
    } catch (e) {
        judged = { correctness: 0, completeness: 0, quality: 0, safety: 0, composite: 0, rationale: `JUDGE_ERROR: ${e instanceof Error ? e.message : String(e)}` };
    }

    return {
        questionId: q.id,
        category: q.category,
        question: q.question,
        finalText,
        toolsCalled,
        engineKind: result.kind,
        durationMs,
        autoGrade: auto,
        judgeGrade: judged,
    };
}

async function runOneModel(
    spec: ModelSpec,
    judge: LLMClient,
    session: ToolSession,
    systemPrompt: string,
    openaiKey: string,
    anthropicKey: string,
): Promise<ModelRun> {
    const agent = makeAgentClient(spec, openaiKey, anthropicKey);
    process.stderr.write(`\n=== Running model ${spec.id} (${agent.id}) ===\n`);

    const results: QuestionResult[] = [];
    const startMs = Date.now();

    // Threading: questions whose followUpTo is set use the prior
    // turn's user+assistant pair as priorMessages.
    const byId = new Map<string, QuestionResult>();
    for (const q of BAKEOFF_25) {
        const priorMessages: LLMMessage[] = [];
        if (q.followUpTo) {
            const prev = byId.get(q.followUpTo);
            if (prev) {
                priorMessages.push({ role: "user", content: prev.question });
                priorMessages.push({ role: "assistant", content: prev.finalText });
            }
        }
        const r = await runOneQuestion(agent, judge, session, systemPrompt, q, priorMessages);
        results.push(r);
        byId.set(q.id, r);
        process.stderr.write(
            `  ${q.id} [${q.category}] auto=${r.autoGrade.score.toFixed(2)} ` +
            `judge=${r.judgeGrade.composite.toFixed(2)} kind=${r.engineKind} ${r.durationMs}ms ` +
            `tools=[${r.toolsCalled.join(",")}]\n`,
        );
    }

    const composite = results.reduce((s, r) => s + r.judgeGrade.composite, 0) / results.length;
    const floor = Math.min(...results.map((r) => r.judgeGrade.composite));
    return {
        model: spec,
        questions: results,
        totalDurationMs: Date.now() - startMs,
        composite,
        floor,
    };
}

// ----------------------------------------------------------------
// Reporting
// ----------------------------------------------------------------

function renderComparisonMd(runs: ModelRun[]): string {
    const lines: string[] = [];
    lines.push("# Phase 8 Bake-off — Model Comparison Report\n");
    lines.push(`Generated: ${new Date().toISOString()}\n`);
    lines.push(`Question set: 25 (Phase 8 BAKEOFF_25)\n`);
    lines.push(`Judge: claude-haiku-4-5 (different family from candidates)\n`);
    lines.push("");

    // Summary table
    lines.push("## Summary");
    lines.push("");
    lines.push("| Model | Composite | Floor | Median latency | Auto-pass rate | Pilot cost (est) |");
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const r of runs) {
        const latencies = r.questions.map((q) => q.durationMs).sort((a, b) => a - b);
        const median = latencies[Math.floor(latencies.length / 2)] ?? 0;
        const autoPassRate = r.questions.filter((q) => q.autoGrade.score === 1).length / r.questions.length;
        // Pilot cost: ~12M tokens (10 students × 30 msg × 28 days × 5 turns × 3k tok)
        // assume 70% in / 30% out
        const pilotCost = (12 * 0.7 * r.model.pricePerMTokensIn) + (12 * 0.3 * r.model.pricePerMTokensOut);
        lines.push(`| \`${r.model.id}\` | ${r.composite.toFixed(2)} | ${r.floor.toFixed(2)} | ${median}ms | ${(autoPassRate * 100).toFixed(0)}% | $${pilotCost.toFixed(0)} |`);
    }
    lines.push("");

    // Selection rubric
    lines.push("## Selection rubric (PHASE_8_PLAN.md §B5)");
    lines.push("");
    lines.push("1. Reject floor < 3.0");
    lines.push("2. Reject composite < 4.0");
    lines.push("3. Among the rest, pick the cheapest");
    lines.push("");
    const eligible = runs.filter((r) => r.floor >= 3.0 && r.composite >= 4.0);
    if (eligible.length === 0) {
        lines.push("**No model passes the rubric. Need to lower the bar or improve the architecture.**");
    } else {
        const cheapest = eligible.slice().sort((a, b) => a.model.pricePerMTokensIn - b.model.pricePerMTokensIn)[0]!;
        lines.push(`**Recommended primary: \`${cheapest.model.id}\`** (composite ${cheapest.composite.toFixed(2)}, floor ${cheapest.floor.toFixed(2)}, cheapest of ${eligible.length} eligible models).`);
    }
    lines.push("");

    // Per-question matrix
    lines.push("## Per-question composite scores");
    lines.push("");
    const header = ["Q", "Category", "Question", ...runs.map((r) => r.model.id.replace("-20251001", ""))];
    lines.push("| " + header.join(" | ") + " |");
    lines.push("|" + header.map(() => "---").join("|") + "|");
    for (const q of BAKEOFF_25) {
        const row = [q.id, q.category, q.question.slice(0, 60).replace(/\|/g, "\\|")];
        for (const r of runs) {
            const qr = r.questions.find((x) => x.questionId === q.id);
            row.push(qr ? qr.judgeGrade.composite.toFixed(2) : "—");
        }
        lines.push("| " + row.join(" | ") + " |");
    }
    lines.push("");

    // Per-question auto-pass matrix
    lines.push("## Per-question auto-grade pass-rate");
    lines.push("(deterministic checks against DPR ground truth + tool requirements)");
    lines.push("");
    lines.push("| Q | " + runs.map((r) => r.model.id.replace("-20251001", "")).join(" | ") + " |");
    lines.push("|" + ["---", ...runs.map(() => "---")].join("|") + "|");
    for (const q of BAKEOFF_25) {
        const row = [q.id];
        for (const r of runs) {
            const qr = r.questions.find((x) => x.questionId === q.id);
            row.push(qr ? `${qr.autoGrade.pass}/${qr.autoGrade.total}` : "—");
        }
        lines.push("| " + row.join(" | ") + " |");
    }
    lines.push("");

    // Failure clusters
    lines.push("## Notable failures (judge composite < 3.0 OR auto-grade score < 0.5)");
    lines.push("");
    for (const r of runs) {
        const bad = r.questions.filter((q) => q.judgeGrade.composite < 3.0 || q.autoGrade.score < 0.5);
        if (bad.length === 0) continue;
        lines.push(`### \`${r.model.id}\``);
        for (const q of bad) {
            lines.push(`- **${q.questionId}** (${q.category}, judge=${q.judgeGrade.composite.toFixed(1)}, auto=${q.autoGrade.score.toFixed(2)}): ${q.question}`);
            if (q.autoGrade.failedChecks.length > 0) {
                lines.push(`  - failed checks: ${q.autoGrade.failedChecks.join(" | ")}`);
            }
            if (q.judgeGrade.rationale) {
                lines.push(`  - judge: ${q.judgeGrade.rationale.slice(0, 250)}`);
            }
        }
        lines.push("");
    }

    return lines.join("\n");
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

async function main(): Promise<void> {
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!openaiKey) { console.error("OPENAI_API_KEY required."); process.exit(1); }
    if (!anthropicKey) { console.error("ANTHROPIC_API_KEY required."); process.exit(1); }

    // Resolve model list — accept --models flag, default to all five
    const args = process.argv.slice(2);
    const modelsArg = args.indexOf("--models");
    const requestedIds = modelsArg >= 0 ? args[modelsArg + 1]!.split(",").map((s) => s.trim()) : ALL_MODELS.map((m) => m.id);
    const models = ALL_MODELS.filter((m) => requestedIds.includes(m.id));
    if (models.length === 0) { console.error(`No matching models. Available: ${ALL_MODELS.map((m) => m.id).join(", ")}`); process.exit(1); }
    console.error(`Models: ${models.map((m) => m.id).join(", ")}`);

    // Load DPR
    if (!existsSync(DPR_PDF_PATH)) { console.error(`DPR fixture not found at ${DPR_PDF_PATH}`); process.exit(1); }
    const dprBuf = readFileSync(DPR_PDF_PATH);
    const { text, totalPages } = await extractText(new Uint8Array(dprBuf), { mergePages: false });
    const txt = Array.isArray(text) ? text.join("\n") : text;
    const dprParse = parseDpr(txt, { pageCount: totalPages ?? 1 });
    if (!dprParse.ok) { console.error(`DPR parse failed: ${dprParse.error}`); process.exit(1); }
    const dpr = dprParse.report;
    const student = buildStudentProfileFromDpr(dpr, { visaStatus: "f1" });

    // Load RAG + course catalog (production fixtures, same as v2 route)
    const cohereKey = process.env.COHERE_API_KEY;
    const embedder = new OpenAIEmbedder({ apiKey: openaiKey });
    let rag = null;
    if (existsSync(POLICY_CACHE_PATH)) {
        const { store } = loadPolicyCorpusFromCache({ embedder, cachePath: POLICY_CACHE_PATH, metaPath: POLICY_META_PATH });
        const reranker: Reranker = cohereKey ? new CohereReranker({ apiKey: cohereKey }) : new LocalLexicalReranker();
        const templates = loadPolicyTemplates().templates;
        rag = { store, embedder, reranker, templates, ...(cohereKey ? { confidenceBands: COHERE_CONFIDENCE_BANDS } : {}) };
        console.error(`✓ Policy RAG loaded (reranker=${reranker.modelId}, templates=${templates.length}).`);
    }
    let searchCoursesFn: CourseSearchFn | null = null;
    if (existsSync(COURSE_DESC_PATH) && existsSync(COURSE_EMB_PATH)) {
        searchCoursesFn = createSemanticCourseSearchFn({
            embedder,
            descriptionsPath: COURSE_DESC_PATH,
            embeddingsPath: COURSE_EMB_PATH,
            embeddingsMetaPath: COURSE_META_PATH,
        });
        console.error("✓ Course catalog semantic search loaded.");
    }
    const schoolConfig = (() => { try { return loadSchoolConfig(student.homeSchool); } catch { return null; } })();

    const session: ToolSession = {
        student,
        degreeProgressReport: dpr,
        ...(schoolConfig ? { schoolConfig } : {}),
        ...(rag ? { rag } : {}),
        ...(searchCoursesFn ? { searchCoursesFn } : {}),
    } as ToolSession;

    // Temporal context — exactly the way the v2 route builds it.
    const temporal = deriveTemporalContext(dpr);
    const graduationTerm = normalizeGraduationTarget("spring2027");
    const systemPrompt = buildSystemPrompt({
        student,
        dprLoaded: true,
        ...(temporal.currentTerm ? { currentTerm: temporal.currentTerm } : {}),
        ...(temporal.nextTerm ? { nextTerm: temporal.nextTerm } : {}),
        ...(graduationTerm ? { graduationTerm } : {}),
    });

    // Judge: claude-haiku-4-5 (different family from any candidate
    // unless someone is benchmarking haiku as a candidate too, in which
    // case the judge is at least at the same tier)
    const judge: LLMClient = new AnthropicEngineClient({ apiKey: anthropicKey, modelId: "claude-haiku-4-5-20251001" });
    console.error(`Judge: ${judge.id}`);

    mkdirSync(RESULTS_DIR, { recursive: true });

    const runs: ModelRun[] = [];
    for (const spec of models) {
        try {
            const run = await runOneModel(spec, judge, session, systemPrompt, openaiKey, anthropicKey);
            runs.push(run);
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const path = join(RESULTS_DIR, `bakeoff_phase8_${spec.id.replace(/[^\w-]/g, "_")}_${stamp}.json`);
            writeFileSync(path, JSON.stringify(run, null, 2));
            console.error(`  → ${path}`);
        } catch (e) {
            console.error(`  ✗ ${spec.id} FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    const summaryPath = join(RESULTS_DIR, "bakeoff_phase8_summary.md");
    writeFileSync(summaryPath, renderComparisonMd(runs));
    console.error(`\nSummary: ${summaryPath}`);

    // Selection
    const eligible = runs.filter((r) => r.floor >= 3.0 && r.composite >= 4.0);
    if (eligible.length === 0) {
        console.error("\nNo model passes the §B5 rubric. Pick manually.");
    } else {
        const cheapest = eligible.slice().sort((a, b) => a.model.pricePerMTokensIn - b.model.pricePerMTokensIn)[0]!;
        console.error(`\nRecommended primary: ${cheapest.model.id} (composite ${cheapest.composite.toFixed(2)}, floor ${cheapest.floor.toFixed(2)}).`);
    }
}

await main();
