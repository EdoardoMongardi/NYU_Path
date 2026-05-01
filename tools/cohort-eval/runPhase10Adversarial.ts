#!/usr/bin/env -S npx tsx
// Phase 10 Stage 5 — adversarial generalization probe.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText } from "unpdf";
import {
    AnthropicEngineClient, OpenAIEmbedder, CohereReranker, LocalLexicalReranker,
    createSemanticCourseSearchFn, loadPolicyCorpusFromCache, loadPolicyTemplates,
    loadSchoolConfig, COHERE_CONFIDENCE_BANDS, runAgentTurn, buildDefaultRegistry,
    buildSystemPrompt, validateResponse, parseDpr, deriveTemporalContext,
    normalizeGraduationTarget, type LLMClient, type CourseSearchFn, type Reranker,
    type ToolSession, type ToolInvocation,
} from "../../packages/engine/src/index.js";
import type { StudentProfile } from "@nyupath/shared";
import { PHASE10_ADVERSARIAL } from "../../evals/cohorts/phase10_adversarial.js";
import type { AutoCheck, BakeoffQuestion } from "../../evals/cohorts/bakeoff_25.js";

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
        catalogYear: "2024-2025", homeSchool,
        declaredPrograms: [{ programId, programType: "major" }],
        coursesTaken: [], ...(opts.visaStatus ? { visaStatus: opts.visaStatus } : {}),
    };
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

function autoGrade(q: BakeoffQuestion, finalText: string, toolsCalled: string[]): { score: number; failedChecks: string[] } {
    const failedChecks: string[] = []; let pass = 0; let fail = 0;
    for (const c of q.autoChecks) { const r = applyCheck(finalText, c); if (r.pass) pass++; else { fail++; failedChecks.push(r.detail); } }
    if (q.expectsNoTool && toolsCalled.length > 0) { fail++; failedChecks.push(`expectsNoTool but called: ${toolsCalled.join(", ")}`); }
    if (q.requiresTools) for (const t of q.requiresTools) { if (!toolsCalled.includes(t)) { fail++; failedChecks.push(`requires "${t}"`); } else pass++; }
    const total = pass + fail;
    return { score: total > 0 ? pass / total : 0, failedChecks };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(REPO_ROOT, "evals/results");
const DPR_PDF_PATH = join(REPO_ROOT, "SAA_STD_DS.pdf");

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
    const POLICY_CACHE_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
    const POLICY_META_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");
    const COURSE_DESC_PATH = join(REPO_ROOT, "data/course-catalog/course_descriptions.json");
    const COURSE_EMB_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.jsonl");
    const COURSE_META_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.meta.json");
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
    const agent: LLMClient = new AnthropicEngineClient({ apiKey: anthropicKey, modelId: "claude-haiku-4-5-20251001" });
    console.error(`Adversarial probe — agent: ${agent.id}\n`);
    mkdirSync(RESULTS_DIR, { recursive: true });

    const results: Array<{ id: string; question: string; finalText: string; tools: string[]; auto: ReturnType<typeof autoGrade>; durationMs: number }> = [];
    for (const q of PHASE10_ADVERSARIAL) {
        const t0 = Date.now();
        const result = await runAgentTurn(agent, buildDefaultRegistry(), session, q.question, {
            systemPrompt, priorMessages: [], maxTurns: 10, validatorReplayLimit: 1,
            validateResponse: ({ assistantText, invocations, session: s }) => {
                const v = validateResponse({ assistantText, invocations, student: s.student });
                return { ok: v.ok, violations: v.violations.map((vi) => ({ kind: vi.kind, detail: vi.detail })) };
            },
        });
        const durationMs = Date.now() - t0;
        const finalText = result.kind === "ok" ? result.finalText : (result as { finalText?: string }).finalText ?? "";
        const invocations = (result as { invocations?: ToolInvocation[] }).invocations ?? [];
        const tools = Array.from(new Set(invocations.map((i) => i.toolName)));
        const auto = autoGrade(q, finalText, tools);
        results.push({ id: q.id, question: q.question, finalText, tools, auto, durationMs });
        process.stderr.write(`  ${q.id} auto=${auto.score.toFixed(2)} ${durationMs}ms tools=[${tools.join(",")}]\n`);
        if (auto.failedChecks.length > 0) process.stderr.write(`     failed: ${auto.failedChecks.join("; ")}\n`);
    }
    const passed = results.filter((r) => r.auto.score === 1).length;
    const stamp = new Date().toISOString().slice(0, 10);
    writeFileSync(join(RESULTS_DIR, `phase10_adversarial_${stamp}.json`), JSON.stringify({ passed, total: results.length, results }, null, 2));
    console.error(`\nAdversarial: ${passed}/${results.length} passed`);
    for (const r of results) {
        console.error(`\n--- ${r.id} ---\n${r.finalText.slice(0, 600)}…`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
