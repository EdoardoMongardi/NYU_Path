#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 10 Stage 1 — baseline measurement
// ============================================================
// Runs the 26-case Phase 10 edge-case bench against the CURRENT
// (post-Phase-9.5) architecture on claude-haiku-4-5. Produces:
//   - Per-case JSON with auto-grade + judge-grade
//   - Markdown summary with PASS/FAIL grid
//   - Section A/B breakdown (known issues vs unseen)
//
// This is the number Phase 10 must beat by ≥15pp (per PHASE_10_PLAN §4.6).
//
// Usage:
//   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... COHERE_API_KEY=... \
//     npx tsx tools/cohort-eval/runPhase10Baseline.ts
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
import type { StudentProfile } from "@nyupath/shared";
import {
    PHASE10_EDGE_CASES,
    SECTION_A_IDS,
    SECTION_B_IDS,
} from "../../evals/cohorts/phase10_edgeCases.js";
import type { BakeoffQuestion, AutoCheck } from "../../evals/cohorts/bakeoff_25.js";

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(REPO_ROOT, "evals/results");
const DPR_PDF_PATH = join(REPO_ROOT, "SAA_STD_DS.pdf");
const POLICY_CACHE_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const POLICY_META_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");
const COURSE_DESC_PATH = join(REPO_ROOT, "data/course-catalog/course_descriptions.json");
const COURSE_EMB_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.jsonl");
const COURSE_META_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.meta.json");

interface AutoGrade {
    pass: number;
    fail: number;
    total: number;
    score: number;
    failedChecks: string[];
}

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
    if (q.expectsNoTool && toolsCalled.length > 0) {
        fail++; failedChecks.push(`expectsNoTool but called: ${toolsCalled.join(", ")}`);
    }
    if (q.requiresTools) {
        for (const t of q.requiresTools) {
            if (!toolsCalled.includes(t)) { fail++; failedChecks.push(`requires "${t}"`); }
            else pass++;
        }
    }
    const total = pass + fail;
    return { pass, fail, total, score: total > 0 ? pass / total : 0, failedChecks };
}

interface JudgeGrade {
    correctness: number;
    completeness: number;
    quality: number;
    safety: number;
    composite: number;
    rationale: string;
}

async function llmJudge(
    judge: LLMClient,
    q: BakeoffQuestion,
    finalText: string,
    toolsCalled: string[],
    auto: AutoGrade,
): Promise<JudgeGrade> {
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
        return {
            correctness: j.correctness,
            completeness: j.completeness,
            quality: j.quality,
            safety: j.safety,
            composite: (j.correctness + j.completeness + j.quality + j.safety) / 4,
            rationale: j.rationale ?? "",
        };
    } catch (e) {
        return { correctness: 0, completeness: 0, quality: 0, safety: 0, composite: 0, rationale: `JUDGE_ERROR: ${e instanceof Error ? e.message : String(e)}` };
    }
}

interface QuestionResult {
    questionId: string;
    section: "A" | "B";
    category: string;
    question: string;
    finalText: string;
    toolsCalled: string[];
    engineKind: string;
    durationMs: number;
    autoGrade: AutoGrade;
    judgeGrade: JudgeGrade;
}

async function main(): Promise<void> {
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!openaiKey || !anthropicKey) {
        console.error("Need OPENAI_API_KEY + ANTHROPIC_API_KEY");
        process.exit(1);
    }

    if (!existsSync(DPR_PDF_PATH)) { console.error(`DPR not found: ${DPR_PDF_PATH}`); process.exit(1); }
    const dprBuf = readFileSync(DPR_PDF_PATH);
    const { text, totalPages } = await extractText(new Uint8Array(dprBuf), { mergePages: false });
    const txt = Array.isArray(text) ? text.join("\n") : text;
    const dprParse = parseDpr(txt, { pageCount: totalPages ?? 1 });
    if (!dprParse.ok) { console.error(`DPR parse: ${dprParse.error}`); process.exit(1); }
    const dpr = dprParse.report;
    const student = buildStudentProfileFromDpr(dpr, { visaStatus: "f1" });

    const cohereKey = process.env.COHERE_API_KEY;
    const embedder = new OpenAIEmbedder({ apiKey: openaiKey });
    let rag: ToolSession["rag"] = undefined;
    if (existsSync(POLICY_CACHE_PATH)) {
        const { store } = loadPolicyCorpusFromCache({ embedder, cachePath: POLICY_CACHE_PATH, metaPath: POLICY_META_PATH });
        const reranker: Reranker = cohereKey ? new CohereReranker({ apiKey: cohereKey }) : new LocalLexicalReranker();
        const templates = loadPolicyTemplates().templates;
        rag = { store, embedder, reranker, templates, ...(cohereKey ? { confidenceBands: COHERE_CONFIDENCE_BANDS } : {}) };
        console.error(`✓ RAG (reranker=${reranker.modelId}, templates=${templates.length})`);
    }
    let searchCoursesFn: CourseSearchFn | null = null;
    if (existsSync(COURSE_DESC_PATH) && existsSync(COURSE_EMB_PATH)) {
        searchCoursesFn = createSemanticCourseSearchFn({
            embedder,
            descriptionsPath: COURSE_DESC_PATH,
            embeddingsPath: COURSE_EMB_PATH,
            embeddingsMetaPath: COURSE_META_PATH,
        });
        console.error("✓ Course catalog");
    }
    const schoolConfig = (() => { try { return loadSchoolConfig(student.homeSchool); } catch { return null; } })();

    const session: ToolSession = {
        student,
        degreeProgressReport: dpr,
        ...(schoolConfig ? { schoolConfig } : {}),
        ...(rag ? { rag } : {}),
        ...(searchCoursesFn ? { searchCoursesFn } : {}),
    } as ToolSession;

    const temporal = deriveTemporalContext(dpr);
    const graduationTerm = normalizeGraduationTarget("spring2027");
    const systemPrompt = buildSystemPrompt({
        student,
        dprLoaded: true,
        ...(temporal.currentTerm ? { currentTerm: temporal.currentTerm } : {}),
        ...(temporal.nextTerm ? { nextTerm: temporal.nextTerm } : {}),
        ...(graduationTerm ? { graduationTerm } : {}),
    });

    const agentModelId = "claude-haiku-4-5-20251001";
    const agent: LLMClient = new AnthropicEngineClient({ apiKey: anthropicKey, modelId: agentModelId });
    const judge: LLMClient = new AnthropicEngineClient({ apiKey: anthropicKey, modelId: agentModelId });
    console.error(`Agent: ${agent.id}\nJudge: ${judge.id}\n`);

    mkdirSync(RESULTS_DIR, { recursive: true });

    const results: QuestionResult[] = [];
    const startMs = Date.now();
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
        const result = await runAgentTurn(agent, buildDefaultRegistry(), session, q.question, {
            systemPrompt,
            priorMessages,
            maxTurns: 10,
            validatorReplayLimit: 1,
            validateResponse: ({ assistantText, invocations, session: s }) => {
                const v = validateResponse({ assistantText, invocations, student: s.student });
                return { ok: v.ok, violations: v.violations.map((vi) => ({ kind: vi.kind, detail: vi.detail })) };
            },
        });
        const durationMs = Date.now() - t0;
        const finalText = result.kind === "ok" ? result.finalText : (result as { finalText?: string }).finalText ?? "";
        const invocations = (result as { invocations?: ToolInvocation[] }).invocations ?? [];
        const toolsCalled = Array.from(new Set(invocations.map((i) => i.toolName)));
        const auto = autoGrade(q, finalText, toolsCalled);
        const judged = await llmJudge(judge, q, finalText, toolsCalled, auto);

        const r: QuestionResult = {
            questionId: q.id, section, category: q.category, question: q.question,
            finalText, toolsCalled, engineKind: result.kind, durationMs,
            autoGrade: auto, judgeGrade: judged,
        };
        results.push(r);
        process.stderr.write(
            `  ${q.id} [${section}/${q.category}] auto=${auto.score.toFixed(2)} judge=${judged.composite.toFixed(2)} ` +
            `${durationMs}ms tools=[${toolsCalled.join(",")}]\n`,
        );
    }
    const totalDurationMs = Date.now() - startMs;

    const aResults = results.filter((r) => r.section === "A");
    const bResults = results.filter((r) => r.section === "B");

    const pass = (r: QuestionResult) => r.autoGrade.score === 1 && r.judgeGrade.composite >= 4.0;
    const aPassRate = aResults.filter(pass).length / aResults.length;
    const bPassRate = bResults.filter(pass).length / bResults.length;
    const overallPassRate = results.filter(pass).length / results.length;
    const aJudgeAvg = aResults.reduce((s, r) => s + r.judgeGrade.composite, 0) / aResults.length;
    const bJudgeAvg = bResults.reduce((s, r) => s + r.judgeGrade.composite, 0) / bResults.length;

    const stamp = new Date().toISOString().slice(0, 10);
    const jsonPath = join(RESULTS_DIR, `phase10_baseline_${stamp}.json`);
    writeFileSync(jsonPath, JSON.stringify({
        agentModel: agentModelId,
        judgeModel: agentModelId,
        totalDurationMs,
        sectionA: { passRate: aPassRate, judgeAvg: aJudgeAvg, count: aResults.length },
        sectionB: { passRate: bPassRate, judgeAvg: bJudgeAvg, count: bResults.length },
        overall: { passRate: overallPassRate, count: results.length },
        results,
    }, null, 2));

    const lines: string[] = [];
    lines.push(`# Phase 10 Stage 1 — Baseline (current architecture)`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Agent: \`${agentModelId}\` · Judge: \`${agentModelId}\``);
    lines.push("");
    lines.push("## Headline numbers");
    lines.push("");
    lines.push("| Section | Pass rate (auto=1.0 AND judge ≥ 4.0) | Judge avg | n |");
    lines.push("|---|---:|---:|---:|");
    lines.push(`| **A — known issues from operator audit** | ${(aPassRate * 100).toFixed(0)}% | ${aJudgeAvg.toFixed(2)} | ${aResults.length} |`);
    lines.push(`| **B — unseen edge cases** | ${(bPassRate * 100).toFixed(0)}% | ${bJudgeAvg.toFixed(2)} | ${bResults.length} |`);
    lines.push(`| **Overall** | **${(overallPassRate * 100).toFixed(0)}%** | — | ${results.length} |`);
    lines.push("");
    lines.push("## Per-case grid");
    lines.push("");
    lines.push("| ID | Sec | Cat | Auto | Judge | Tools | Question |");
    lines.push("|---|---|---|---:|---:|---|---|");
    for (const r of results) {
        const verdict = pass(r) ? "✅" : "❌";
        const auto = r.autoGrade.score.toFixed(2);
        const judge = r.judgeGrade.composite.toFixed(2);
        const tools = r.toolsCalled.join(",");
        const qShort = r.question.length > 70 ? r.question.slice(0, 67) + "..." : r.question;
        lines.push(`| ${verdict} ${r.questionId} | ${r.section} | ${r.category} | ${auto} | ${judge} | ${tools} | ${qShort.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
    lines.push("## Failures (auto < 1.0 OR judge < 4.0)");
    lines.push("");
    for (const r of results) {
        if (pass(r)) continue;
        lines.push(`### ${r.questionId} — ${r.question}`);
        lines.push(`- auto: ${r.autoGrade.score.toFixed(2)} (${r.autoGrade.failedChecks.join("; ") || "—"})`);
        lines.push(`- judge: ${r.judgeGrade.composite.toFixed(2)} — ${r.judgeGrade.rationale.slice(0, 250)}`);
        lines.push(`- final text: ${r.finalText.slice(0, 300)}…`);
        lines.push("");
    }
    const mdPath = join(RESULTS_DIR, `phase10_baseline_${stamp}.md`);
    writeFileSync(mdPath, lines.join("\n"));

    console.error(`\nResults: ${jsonPath}\nReport:  ${mdPath}`);
    console.error(`Section A: ${(aPassRate * 100).toFixed(0)}% pass · Section B: ${(bPassRate * 100).toFixed(0)}% pass · Overall: ${(overallPassRate * 100).toFixed(0)}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
