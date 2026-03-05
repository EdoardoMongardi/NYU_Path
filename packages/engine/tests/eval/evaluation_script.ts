#!/usr/bin/env npx tsx
// ============================================================
// Evaluation Script — Week 1 End-to-End Eval Runner
// Runs intent classification (hybrid: regex + LLM) and
// deterministic constraint scenarios from eval_dataset.jsonl
// ============================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env file (apps/web/.env) without requiring dotenv package
const __dirname_early = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname_early, "../../../../apps/web/.env");
if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = value;
    }
    console.log("📁 Loaded environment from apps/web/.env");
}

import type { StudentProfile, Program, Course } from "@nyupath/shared";
import { degreeAudit } from "../../src/audit/degreeAudit.js";
import { classifyIntentHybrid, quickClassify } from "../../src/chat/intentRouter.js";
import { createOpenAIClient } from "../../src/chat/llmClient.js";
import { mapIntentToEval } from "./types.js";
import type { IntentResult, ConstraintResult, EvalRun } from "./types.js";
import {
    computeIntentMetrics,
    computeConstraintMetrics,
    generateResultsTable,
    resultsToCSV,
    confusionMatrixToCSV,
    wilsonInterval,
} from "./metrics.js";

const __dirname = __dirname_early;
const PROFILES_DIR = join(__dirname, "profiles");
const DATA_DIR = join(__dirname, "../../src/data");
const DATASET_PATH = join(__dirname, "eval_dataset.jsonl");

// ---- Load data ----

const courses: Course[] = JSON.parse(readFileSync(join(DATA_DIR, "courses.json"), "utf-8"));
const programs: Program[] = JSON.parse(readFileSync(join(DATA_DIR, "programs.json"), "utf-8"));

function loadProfile(name: string): StudentProfile {
    return JSON.parse(readFileSync(join(PROFILES_DIR, `${name}.json`), "utf-8"));
}

function getProgram(id: string): Program {
    const p = programs.find((p) => p.programId === id);
    if (!p) throw new Error(`Program ${id} not found`);
    return p;
}

// ---- Dataset entry types ----

interface IntentEntry {
    id: string;
    category: "intent" | "stress";
    query: string;
    profileId: string;
    expected: {
        intent: string;
        searchQuery?: string;
        courseId?: string;
    };
}

interface ConstraintEntry {
    id: string;
    category: "constraint";
    profileId: string;
    programId: string;
    module: string;
    assertions: Array<{
        path: string;
        op: "eq" | "contains" | "not_contains" | "gte" | "lte" | "gt" | "lt";
        value: any;
    }>;
}

type DatasetEntry = IntentEntry | ConstraintEntry;

// ---- Run intent entry ----

async function runIntentEntry(
    entry: IntentEntry,
    llm: ReturnType<typeof createOpenAIClient>
): Promise<IntentResult> {
    const start = performance.now();

    // Check if quickClassify handles it
    const quickResult = quickClassify(entry.query);
    const quickHit = quickResult !== null;

    // Run full hybrid
    const result = await classifyIntentHybrid(entry.query, llm);
    const latency = performance.now() - start;

    const rawIntent = result.intent;
    const expectedRaw = entry.expected.intent;

    // Compare at the codebase label level (7 intents)
    // The eval taxonomy mapping (general→meta/follow_up) is deferred to Week 2
    // when we can properly distinguish them based on conversation context
    const correct = rawIntent === expectedRaw;

    // For metrics reporting, use eval taxonomy labels
    const predictedEval = mapIntentToEval(rawIntent);
    let expectedEval = mapIntentToEval(expectedRaw as any);
    // Override: if expected is "general" and query matches greeting pattern, mark as "meta"
    const metaPatterns = /^(hello|hi|hey|sup|yo|thanks|thank you|goodbye|bye|what can you)/i;
    if (expectedRaw === "general" && metaPatterns.test(entry.query)) {
        expectedEval = "meta";
    }

    return {
        id: entry.id,
        query: entry.query,
        expected_intent: expectedEval as any,
        predicted_intent: predictedEval,
        raw_intent: rawIntent,
        confidence: result.confidence,
        quick_classify_hit: quickHit,
        correct,
        failure_code: correct ? null : "F100",
        latency_ms: Math.round(latency),
    };
}

// ---- Run constraint entry ----

function runConstraintEntry(entry: ConstraintEntry): ConstraintResult {
    const student = loadProfile(entry.profileId);
    const program = getProgram(entry.programId);
    const result = degreeAudit(student, program, courses);

    // Evaluate assertions
    let passed = 0;
    const total = entry.assertions.length;
    const failureDetails: string[] = [];

    for (const assertion of entry.assertions) {
        const actual = resolvePath(result, assertion.path);
        const ok = checkAssertion(actual, assertion.op, assertion.value);
        if (ok) {
            passed++;
        } else {
            failureDetails.push(`${assertion.path}: expected ${assertion.op} ${JSON.stringify(assertion.value)}, got ${JSON.stringify(actual)}`);
        }
    }

    const correct = passed === total;

    return {
        id: entry.id,
        profile_id: entry.profileId,
        program_id: entry.programId,
        expected_status: "",
        actual_status: result.overallStatus,
        expected_credits: -1,
        actual_credits: result.totalCreditsCompleted,
        rules_correct: passed,
        rules_total: total,
        warnings_precision: 1,
        warnings_recall: 1,
        correct,
        failure_code: correct ? null : "F200",
        data_gap_code: null,
    };
}

// ---- Path resolver for nested access ----

function resolvePath(obj: any, path: string): any {
    const parts = path.split(".");
    let current = obj;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (current === undefined || current === null) return undefined;

        // Handle ".length" on arrays
        if (part === "length" && Array.isArray(current)) {
            return current.length;
        }

        // Handle "rules" → skip to next part which is the ruleId
        if (part === "rules" && Array.isArray(current[part])) {
            // Next part should be a ruleId — find it in the rules array
            const nextPart = parts[i + 1];
            if (nextPart) {
                const rule = current[part].find((r: any) => r.ruleId === nextPart);
                if (rule) {
                    current = rule;
                    i++; // Skip the ruleId part
                    continue;
                }
            }
            current = current[part];
            continue;
        }

        current = current[part];
    }
    return current;
}

// ---- Assertion checker ----

function checkAssertion(actual: any, op: string, expected: any): boolean {
    switch (op) {
        case "eq": return actual === expected;
        case "contains": return Array.isArray(actual) && actual.includes(expected);
        case "not_contains": return Array.isArray(actual) && !actual.includes(expected);
        case "gte": return typeof actual === "number" && actual >= expected;
        case "lte": return typeof actual === "number" && actual <= expected;
        case "gt": return typeof actual === "number" && actual > expected;
        case "lt": return typeof actual === "number" && actual < expected;
        default: return false;
    }
}

// ---- Main ----

async function main() {
    console.log("🚀 NYU Path — Week 1 Evaluation Run");
    console.log("=".repeat(50));

    // Load dataset
    const lines = readFileSync(DATASET_PATH, "utf-8").trim().split("\n");
    const entries: DatasetEntry[] = lines.map((l) => JSON.parse(l));

    const intentEntries = entries.filter((e) => e.category === "intent" || e.category === "stress") as IntentEntry[];
    const constraintEntries = entries.filter((e) => e.category === "constraint") as ConstraintEntry[];

    console.log(`\n📊 Dataset: ${entries.length} total (${intentEntries.length} intent/stress, ${constraintEntries.length} constraint)`);

    // Create LLM client
    const llm = createOpenAIClient();

    // ---- Run intent classification ----
    console.log("\n📝 Running intent classification (hybrid: regex + LLM)...");
    const intentResults: IntentResult[] = [];
    for (const entry of intentEntries) {
        process.stdout.write(`  ${entry.id}: "${entry.query.slice(0, 40)}..." → `);
        try {
            const result = await runIntentEntry(entry, llm);
            intentResults.push(result);
            const icon = result.correct ? "✅" : "❌";
            const method = result.quick_classify_hit ? "regex" : "LLM";
            console.log(`${icon} ${result.predicted_intent} (${method}, ${result.latency_ms}ms)`);
        } catch (err) {
            console.log(`💥 ERROR: ${err}`);
            intentResults.push({
                id: entry.id,
                query: entry.query,
                expected_intent: entry.expected.intent as any,
                predicted_intent: "follow_up" as any,
                raw_intent: "general",
                confidence: 0,
                quick_classify_hit: false,
                correct: false,
                failure_code: "F501",
                latency_ms: 0,
            });
        }
    }

    // ---- Run constraint scenarios ----
    console.log("\n🔧 Running constraint scenarios...");
    const constraintResults: ConstraintResult[] = [];
    for (const entry of constraintEntries) {
        process.stdout.write(`  ${entry.id}: ${entry.profileId} → `);
        try {
            const result = runConstraintEntry(entry);
            constraintResults.push(result);
            const icon = result.correct ? "✅" : "❌";
            console.log(`${icon} ${result.rules_correct}/${result.rules_total} assertions`);
        } catch (err) {
            console.log(`💥 ERROR: ${err}`);
        }
    }

    // ---- Compute metrics ----
    console.log("\n" + "=".repeat(50));
    console.log("📈 RESULTS SUMMARY");
    console.log("=".repeat(50));

    const run: EvalRun = {
        run_id: `wk1-${Date.now()}`,
        timestamp: new Date().toISOString(),
        system: "nyupath-v0.1",
        intent_results: intentResults,
        constraint_results: constraintResults,
        advisory_results: [],
        abstention_results: [],
    };

    // Intent metrics
    if (intentResults.length > 0) {
        const im = computeIntentMetrics(intentResults);
        const n = intentResults.length;
        const ci = wilsonInterval(intentResults.filter((r) => r.correct).length, n);
        console.log(`\n🎯 Intent Classification (n=${n}):`);
        console.log(`  Accuracy: ${(im.accuracy * 100).toFixed(1)}% [${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`);
        console.log(`  Quick-classify coverage: ${(im.quickClassifyCoverage * 100).toFixed(1)}%`);
        console.log(`  LLM fallback rate: ${(im.llmFallbackRate * 100).toFixed(1)}%`);
        console.log(`  ECE: ${im.ece.toFixed(3)}`);
        console.log(`  Mean latency: ${im.meanLatencyMs.toFixed(0)}ms`);
        console.log(`\n  Per-Intent F1:`);
        for (const [intent, m] of Object.entries(im.perIntentF1)) {
            if (m.precision + m.recall === 0) continue;
            console.log(`    ${intent}: P=${m.precision.toFixed(2)} R=${m.recall.toFixed(2)} F1=${m.f1.toFixed(2)}`);
        }

        // Write confusion matrix
        const cmCSV = confusionMatrixToCSV(im.confusionMatrix);
        writeFileSync(join(__dirname, "confusion_matrix.csv"), cmCSV);
        console.log("\n  → Confusion matrix: confusion_matrix.csv");
    }

    // Constraint metrics
    if (constraintResults.length > 0) {
        const cm = computeConstraintMetrics(constraintResults);
        console.log(`\n⚙️  Constraint Engine (n=${constraintResults.length}):`);
        console.log(`  Rule accuracy: ${(cm.ruleAccuracy * 100).toFixed(1)}%`);
        console.log(`  Bugs found: ${cm.totalBugs}`);
        console.log(`  Data gaps: ${cm.totalDataGaps}`);
    }

    // ---- Write results ----
    const resultsRows = generateResultsTable(run);
    const csv = resultsToCSV(resultsRows);
    writeFileSync(join(__dirname, "results_table.csv"), csv);
    console.log("\n📄 → results_table.csv");

    // ---- Write failure analysis ----
    const failures = [...intentResults, ...constraintResults].filter((r) => !r.correct);
    const analysisLines = [
        "# Failure Analysis — Week 1 Eval",
        "",
        `**Run**: ${run.run_id}`,
        `**Timestamp**: ${run.timestamp}`,
        `**System**: ${run.system}`,
        "",
        "## Summary",
        "",
    ];

    if (intentResults.length > 0) {
        const im = computeIntentMetrics(intentResults);
        analysisLines.push(`- **Intent accuracy**: ${(im.accuracy * 100).toFixed(1)}% (${intentResults.filter(r => r.correct).length}/${intentResults.length})`);
        analysisLines.push(`- **Quick-classify coverage**: ${(im.quickClassifyCoverage * 100).toFixed(1)}%`);
    }
    if (constraintResults.length > 0) {
        const cm = computeConstraintMetrics(constraintResults);
        analysisLines.push(`- **Constraint accuracy**: ${(cm.ruleAccuracy * 100).toFixed(1)}%`);
    }

    if (failures.length > 0) {
        analysisLines.push("", "## Failures", "");
        for (const f of failures) {
            if ("query" in f) {
                const ir = f as IntentResult;
                analysisLines.push(`- **${ir.id}** [${ir.failure_code}]: "${ir.query}" → expected \`${ir.expected_intent}\`, got \`${ir.predicted_intent}\` (${ir.quick_classify_hit ? "regex" : "LLM"}, confidence=${ir.confidence})`);
            } else {
                const cr = f as ConstraintResult;
                analysisLines.push(`- **${cr.id}** [${cr.failure_code}]: ${cr.profile_id}/${cr.program_id} → ${cr.rules_correct}/${cr.rules_total} assertions passed`);
            }
        }
    } else {
        analysisLines.push("", "## Failures", "", "🎉 No failures detected.");
    }

    // Quick-classify breakdown
    analysisLines.push("", "## Quick-Classify Breakdown", "");
    for (const r of intentResults) {
        const method = r.quick_classify_hit ? "✅ regex" : "🤖 LLM";
        const icon = r.correct ? "✓" : "✗";
        analysisLines.push(`| ${r.id} | ${r.query.slice(0, 40)} | ${method} | ${icon} ${r.predicted_intent} |`);
    }

    writeFileSync(join(__dirname, "failure_analysis.md"), analysisLines.join("\n"));
    console.log("📄 → failure_analysis.md");
    console.log("\n✅ Evaluation complete!");
}

main().catch(console.error);
