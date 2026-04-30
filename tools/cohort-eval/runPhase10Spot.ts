#!/usr/bin/env -S npx tsx
// Phase 10 spot-check — run a subset of the bench to validate envelope wiring.
import { writeFileSync, existsSync, readFileSync } from "node:fs";
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
    validateResponse,
    parseDpr,
    deriveTemporalContext,
    normalizeGraduationTarget,
    type LLMClient,
    type CourseSearchFn,
    type Reranker,
    type ToolSession,
    type ToolInvocation,
} from "../../packages/engine/src/index.js";
import type { StudentProfile } from "@nyupath/shared";

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
const DPR_PDF_PATH = join(REPO_ROOT, "SAA_STD_DS.pdf");
const POLICY_CACHE_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const POLICY_META_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");
const COURSE_DESC_PATH = join(REPO_ROOT, "data/course-catalog/course_descriptions.json");
const COURSE_EMB_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.jsonl");
const COURSE_META_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.meta.json");

const QUESTIONS = [
    "Does CORE-UA 700 satisfy Texts and Ideas?",
    "Does CORE-UA 800 satisfy Societies and the Social Sciences?",
    "What requirements am I still missing? What grade do I need?",
    "What courses am I currently registered for?",
    "Can I use P/F for my major?",
];

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

    const agent: LLMClient = new AnthropicEngineClient({ apiKey: anthropicKey, modelId: "claude-haiku-4-5-20251001" });
    console.error(`Spot check — agent: ${agent.id}\n`);

    for (const q of QUESTIONS) {
        const t0 = Date.now();
        const result = await runAgentTurn(agent, buildDefaultRegistry(), session, q, {
            systemPrompt,
            priorMessages: [],
            maxTurns: 10,
            validatorReplayLimit: 1,
            validateResponse: ({ assistantText, invocations, session: s }) => {
                const v = validateResponse({ assistantText, invocations, student: s.student });
                return { ok: v.ok, violations: v.violations.map((vi) => ({ kind: vi.kind, detail: vi.detail })) };
            },
        });
        const ms = Date.now() - t0;
        const finalText = result.kind === "ok" ? result.finalText : (result as { finalText?: string }).finalText ?? "";
        const tools = (result as { invocations?: ToolInvocation[] }).invocations?.map((i) => i.toolName) ?? [];
        console.error(`\n--- "${q}" (${ms}ms, kind=${result.kind}, tools=[${tools.join(",")}]) ---`);
        console.error(finalText);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
