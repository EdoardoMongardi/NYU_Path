#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 10 Stage 4 — Method B (envelope + completeness reviewer)
// ============================================================
// Same harness as runPhase10Baseline but wires reviewCompleteness
// into validateResponse so dropped envelope content triggers a
// retry (validatorReplayLimit=1). Writes results to a separate
// JSON so Method A and Method B can be compared side-by-side.
// ============================================================

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText } from "unpdf";
import {
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
    validateResponse as baseValidateResponse,
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
import { reviewCompleteness } from "../../packages/engine/src/agent/completenessReviewer.js";
import type { StudentProfile } from "@nyupath/shared";
import {
    PHASE10_EDGE_CASES,
    SECTION_A_IDS,
} from "../../evals/cohorts/phase10_edgeCases.js";
import type { BakeoffQuestion, AutoCheck } from "../../evals/cohorts/bakeoff_25.js";

function buildStudentProfileFromDpr(dpr: import("../../packages/engine/src/dpr/schema.js").DegreeProgressReport, opts: { visaStatus?: "f1" | "domestic" } = {}): StudentProfile {
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(REPO_ROOT, "evals/results");
const DPR_PDF_PATH = join(REPO_ROOT, "SAA_STD_DS.pdf");
const POLICY_CACHE_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const POLICY_META_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");
const COURSE_DESC_PATH = join(REPO_ROOT, "data/course-catalog/course_descriptions.json");
const COURSE_EMB_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.jsonl");
const COURSE_META_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.meta.json");

interface AutoGrade { pass: number; fail: number; total: number; score: number; failedChecks: string[]; }

function applyCheck(text: string, c: AutoCheck): { pass: boolean; detail: string } {
    if (c.kind === "contains") return { pass: text.includes(c.text), detail: `contains "${c.text}"` };
    if (c.kind === "containsAny") return { pass: c.options.some((o) => text.includes(o)), detail: `containsAny [${c.options.join(", ")}]` };
    if (c.kind === "containsAll") {
        const missing = c.texts.filter((t) => !text.includes(t));
        return { pass: missing.length === 0, detail: `containsAll [${c.texts.join(", ")}]` + (missing.length ? ` MISSING: ${missing.join(", ")}` : "") };
    }
    if (c.kind === "notContains") return { pass: !text.includes(c.text), detail: `notContains "${c.text}"` };
    if (c.kind === "matchesRegex") return { pass: new RegExp(c.pattern, c.flags).test(text), detail: `matchesRegex /${c.pattern}/${c.flags ?? ""}` };
    return { pass: false, detail: "unknown" };
}

function autoGrade(q: BakeoffQuestion, finalText: string, toolsCalled: string[]): AutoGrade {
    const failedChecks: string[] = [];
    let pass = 0; let fail = 0;
    for (const c of q.autoChecks) {
        const r = applyCheck(finalText, c);
        if (r.pass) pass++; else { fail++; failedChecks.push(r.detail); }
    }
    if (q.expectsNoTool && toolsCalled.length > 0) { fail++; failedChecks.push(`expectsNoTool but called: ${toolsCalled.join(", ")}`); }
    if (q.requiresTools) {
        for (const t of q.requiresTools) {
            if (!toolsCalled.includes(t)) { fail++; failedChecks.push(`requires "${t}"`); }
            else pass++;
        }
    }
    const total = pass + fail;
    return { pass, fail, total, score: total > 0 ? pass / total : 0, failedChecks };
}

interface JudgeGrade { correctness: number; completeness: number; quality: number; safety: number; composite: number; rationale: string; }

async function llmJudge(judge: LLMClient, q: BakeoffQuestion, finalText: string, toolsCalled: string[], auto: AutoGrade): Promise<JudgeGrade> {
    const judgeSystem = `You are a strict grader for an academic-advising agent. Score 4 axes 1-5. Output JSON only: {"correctness":N,"completeness":N,"quality":N,"safety":N,"rationale":"..."}.

correctness: matches ground truth + rubric.
completeness: answers everything asked.
quality: organized, professional, concise.
safety: no fabricated numbers, appropriate caveats, no fake actions, no hallucinated policy.

5 = excellent, 4 = good with minor issues, 3 = substantively flawed, 1-2 = real failures.`;
    const judgeUser = `QUESTION (${q.category}): ${q.question}

RUBRIC: ${q.judgeRubric}

TOOLS: ${toolsCalled.join(", ") || "(none)"}

ANSWER:
"""
${finalText}
"""

AUTO-GRADE: ${auto.pass}/${auto.total} ${auto.failedChecks.length ? "FAILED: " + auto.failedChecks.join(" | ") : "all-pass"}

JSON only.`;
    try {
        const res = await judge.complete({ system: judgeSystem, messages: [{ role: "user", content: judgeUser }], temperature: 0.1, maxTokens: 400 });
        const m = res.text.trim().match(/\{[\s\S]*\}/);
        if (!m) return { correctness: 0, completeness: 0, quality: 0, safety: 0, composite: 0, rationale: `PARSE_FAIL: ${res.text.slice(0, 200)}` };
        const j = JSON.parse(m[0]) as { correctness: number; completeness: number; quality: number; safety: number; rationale?: string };
        return { correctness: j.correctness, completeness: j.completeness, quality: j.quality, safety: j.safety, composite: (j.correctness + j.completeness + j.quality + j.safety) / 4, rationale: j.rationale ?? "" };
    } catch (e) {
        return { correctness: 0, completeness: 0, quality: 0, safety: 0, composite: 0, rationale: `JUDGE_ERROR: ${e instanceof Error ? e.message : String(e)}` };
    }
}

interface QuestionResult {
    questionId: string; section: "A" | "B"; category: string; question: string;
    finalText: string; toolsCalled: string[]; engineKind: string; durationMs: number;
    autoGrade: AutoGrade; judgeGrade: JudgeGrade;
    completenessRetried: boolean;
}

async function main(): Promise<void> {
    const openaiKey = process.env.OPENAI_API_KEY!;
    const anthropicKey = process.env.ANTHROPIC_API_KEY!;
    const cohereKey = process.env.COHERE_API_KEY;

    const dprBuf = readFileSync(DPR_PDF_PATH);
    const { text, totalPages } = await extractText(new Uint8Array(dprBuf), { mergePages: false });
    const txt = Array.isArray(text) ? text.join("\n") : text;
    const dprParse = parseDpr(txt, { pageCount: totalPages ?? 1 });
    if (!dprParse.ok) throw new Error(`DPR parse: ${dprParse.error}`);
    const dpr = dprParse.report;
    const student = buildStudentProfileFromDpr(dpr, { visaStatus: "f1" });

    const embedder = new OpenAIEmbedder({ apiKey: openaiKey });
    let rag: ToolSession["rag"] = undefined;
    if (existsSync(POLICY_CACHE_PATH)) {
        const { store } = loadPolicyCorpusFromCache({ embedder, cachePath: POLICY_CACHE_PATH, metaPath: POLICY_META_PATH });
        const reranker: Reranker = cohereKey ? new CohereReranker({ apiKey: cohereKey }) : new LocalLexicalReranker();
        const templates = loadPolicyTemplates().templates;
        rag = { store, embedder, reranker, templates, ...(cohereKey ? { confidenceBands: COHERE_CONFIDENCE_BANDS } : {}) };
    }
    let searchCoursesFn: CourseSearchFn | null = null;
    if (existsSync(COURSE_DESC_PATH) && existsSync(COURSE_EMB_PATH)) {
        searchCoursesFn = createSemanticCourseSearchFn({ embedder, descriptionsPath: COURSE_DESC_PATH, embeddingsPath: COURSE_EMB_PATH, embeddingsMetaPath: COURSE_META_PATH });
    }
    const schoolConfig = (() => { try { return loadSchoolConfig(student.homeSchool); } catch { return null; } })();
    const session: ToolSession = { student, degreeProgressReport: dpr, ...(schoolConfig ? { schoolConfig } : {}), ...(rag ? { rag } : {}), ...(searchCoursesFn ? { searchCoursesFn } : {}) } as ToolSession;
    const temporal = deriveTemporalContext(dpr);
    const graduationTerm = normalizeGraduationTarget("spring2027");
    const systemPrompt = buildSystemPrompt({ student, dprLoaded: true, ...(temporal.currentTerm ? { currentTerm: temporal.currentTerm } : {}), ...(temporal.nextTerm ? { nextTerm: temporal.nextTerm } : {}), ...(graduationTerm ? { graduationTerm } : {}) });

    const agentModelId = "claude-haiku-4-5-20251001";
    const agent: LLMClient = new AnthropicEngineClient({ apiKey: anthropicKey, modelId: agentModelId });
    const judge: LLMClient = new AnthropicEngineClient({ apiKey: anthropicKey, modelId: agentModelId });
    console.error(`Method B (envelope + completeness reviewer)\nAgent: ${agent.id}\n`);

    mkdirSync(RESULTS_DIR, { recursive: true });

    const results: QuestionResult[] = [];
    const startMs = Date.now();
    let totalRetries = 0;
    for (const q of PHASE10_EDGE_CASES) {
        const section: "A" | "B" = SECTION_A_IDS.includes(q.id) ? "A" : "B";
        const priorMessages: LLMMessage[] = [];
        if (q.followUpTo) {
            const prev = results.find((r) => r.questionId === q.followUpTo);
            if (prev) {
                priorMessages.push({ role: "user", content: prev.question });
                priorMessages.push({ role: "assistant", content: prev.finalText });
            }
        }
        const t0 = Date.now();
        let retried = false;
        const result = await runAgentTurn(agent, buildDefaultRegistry(), session, q.question, {
            systemPrompt,
            priorMessages,
            maxTurns: 12,
            validatorReplayLimit: 1,
            validateResponse: ({ assistantText, invocations, session: s }) => {
                const baseV = baseValidateResponse({ assistantText, invocations, student: s.student });
                const compl = reviewCompleteness(assistantText, invocations);
                const violations = baseV.violations.map((vi) => ({ kind: vi.kind, detail: vi.detail }));
                if (!compl.pass) {
                    retried = true;
                    violations.push({ kind: "envelope_completeness" as never, detail: compl.retryGuidance });
                }
                return { ok: baseV.ok && compl.pass, violations };
            },
        });
        const durationMs = Date.now() - t0;
        const finalText = result.kind === "ok" ? result.finalText : (result as { finalText?: string }).finalText ?? "";
        const invocations = (result as { invocations?: ToolInvocation[] }).invocations ?? [];
        const toolsCalled = Array.from(new Set(invocations.map((i) => i.toolName)));
        const auto = autoGrade(q, finalText, toolsCalled);
        const judged = await llmJudge(judge, q, finalText, toolsCalled, auto);
        if (retried) totalRetries++;

        const r: QuestionResult = {
            questionId: q.id, section, category: q.category, question: q.question,
            finalText, toolsCalled, engineKind: result.kind, durationMs,
            autoGrade: auto, judgeGrade: judged, completenessRetried: retried,
        };
        results.push(r);
        process.stderr.write(`  ${q.id} [${section}/${q.category}] auto=${auto.score.toFixed(2)} judge=${judged.composite.toFixed(2)} ${durationMs}ms ${retried ? "(retried)" : ""} tools=[${toolsCalled.join(",")}]\n`);
    }
    const totalDurationMs = Date.now() - startMs;
    const aResults = results.filter((r) => r.section === "A");
    const bResults = results.filter((r) => r.section === "B");
    const pass = (r: QuestionResult) => r.autoGrade.score === 1 && r.judgeGrade.composite >= 4.0;
    const aPass = aResults.filter(pass).length / aResults.length;
    const bPass = bResults.filter(pass).length / bResults.length;
    const overall = results.filter(pass).length / results.length;

    const stamp = new Date().toISOString().slice(0, 10);
    writeFileSync(join(RESULTS_DIR, `phase10_methodB_${stamp}.json`), JSON.stringify({
        method: "B",
        agentModel: agentModelId,
        totalDurationMs,
        totalRetries,
        sectionA: { passRate: aPass, count: aResults.length },
        sectionB: { passRate: bPass, count: bResults.length },
        overall: { passRate: overall, count: results.length },
        results,
    }, null, 2));
    console.error(`\nMethod B — Section A: ${(aPass * 100).toFixed(0)}% · Section B: ${(bPass * 100).toFixed(0)}% · Overall: ${(overall * 100).toFixed(0)}% · retries: ${totalRetries}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
