// ============================================================
// Evaluation Metrics — Computation Utilities
// ============================================================

import type {
    IntentResult,
    ConstraintResult,
    AdvisoryResult,
    AbstractionResult,
    EvalIntent,
    EvalRun,
} from "./types.js";

// ---- Intent Classification Metrics ----

export interface IntentMetrics {
    accuracy: number;
    quickClassifyCoverage: number;
    llmFallbackRate: number;
    perIntentF1: Record<string, { precision: number; recall: number; f1: number }>;
    confusionMatrix: Record<string, Record<string, number>>;
    ece: number;
    meanLatencyMs: number;
    p99LatencyMs: number;
}

export function computeIntentMetrics(results: IntentResult[]): IntentMetrics {
    const n = results.length;
    if (n === 0) throw new Error("No intent results to compute metrics from");

    // Accuracy
    const correct = results.filter(r => r.correct).length;
    const accuracy = correct / n;

    // Quick-classify coverage
    const quickHits = results.filter(r => r.quick_classify_hit).length;
    const quickClassifyCoverage = quickHits / n;
    const llmFallbackRate = 1 - quickClassifyCoverage;

    // Confusion matrix
    const intents = [...new Set([
        ...results.map(r => r.expected_intent),
        ...results.map(r => r.predicted_intent),
    ])].sort();

    const confusionMatrix: Record<string, Record<string, number>> = {};
    for (const expected of intents) {
        confusionMatrix[expected] = {};
        for (const predicted of intents) {
            confusionMatrix[expected][predicted] = 0;
        }
    }
    for (const r of results) {
        confusionMatrix[r.expected_intent][r.predicted_intent]++;
    }

    // Per-intent F1
    const perIntentF1: Record<string, { precision: number; recall: number; f1: number }> = {};
    for (const intent of intents) {
        const tp = results.filter(r => r.expected_intent === intent && r.predicted_intent === intent).length;
        const fp = results.filter(r => r.expected_intent !== intent && r.predicted_intent === intent).length;
        const fn = results.filter(r => r.expected_intent === intent && r.predicted_intent !== intent).length;
        const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
        const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
        const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
        perIntentF1[intent] = { precision, recall, f1 };
    }

    // ECE (Expected Calibration Error) — 10 bins
    const ece = computeECE(results.map(r => ({ confidence: r.confidence, correct: r.correct })));

    // Latency stats
    const latencies = results.map(r => r.latency_ms).sort((a, b) => a - b);
    const meanLatencyMs = latencies.reduce((a, b) => a + b, 0) / n;
    const p99LatencyMs = latencies[Math.floor(n * 0.99)] ?? latencies[n - 1];

    return {
        accuracy,
        quickClassifyCoverage,
        llmFallbackRate,
        perIntentF1,
        confusionMatrix,
        ece,
        meanLatencyMs,
        p99LatencyMs,
    };
}

// ---- ECE Computation ----

function computeECE(predictions: { confidence: number; correct: boolean }[]): number {
    const numBins = 10;
    const bins: { confidenceSum: number; correctSum: number; count: number }[] = [];
    for (let i = 0; i < numBins; i++) {
        bins.push({ confidenceSum: 0, correctSum: 0, count: 0 });
    }

    for (const pred of predictions) {
        const binIdx = Math.min(Math.floor(pred.confidence * numBins), numBins - 1);
        bins[binIdx].confidenceSum += pred.confidence;
        bins[binIdx].correctSum += pred.correct ? 1 : 0;
        bins[binIdx].count++;
    }

    let ece = 0;
    const n = predictions.length;
    for (const bin of bins) {
        if (bin.count === 0) continue;
        const avgConf = bin.confidenceSum / bin.count;
        const avgAcc = bin.correctSum / bin.count;
        ece += (bin.count / n) * Math.abs(avgAcc - avgConf);
    }
    return ece;
}

// ---- Constraint Engine Metrics ----

export interface ConstraintMetrics {
    ruleAccuracy: number;
    creditExactMatch: number;
    warningPrecision: number;
    warningRecall: number;
    totalBugs: number;      // F2xx codes
    totalDataGaps: number;  // D2xx codes
}

export function computeConstraintMetrics(results: ConstraintResult[]): ConstraintMetrics {
    const n = results.length;
    if (n === 0) throw new Error("No constraint results");

    const totalRulesCorrect = results.reduce((a, r) => a + r.rules_correct, 0);
    const totalRules = results.reduce((a, r) => a + r.rules_total, 0);

    return {
        ruleAccuracy: totalRules > 0 ? totalRulesCorrect / totalRules : 1,
        creditExactMatch: results.filter(r => r.expected_credits === r.actual_credits).length / n,
        warningPrecision: results.reduce((a, r) => a + r.warnings_precision, 0) / n,
        warningRecall: results.reduce((a, r) => a + r.warnings_recall, 0) / n,
        totalBugs: results.filter(r => r.failure_code !== null).length,
        totalDataGaps: results.filter(r => r.data_gap_code !== null).length,
    };
}

// ---- Advisory Quality Metrics ----

export interface AdvisoryMetrics {
    factualGroundingRate: number;
    hallucinationRate: number;
    contradictionRate: number;
    numericFactAccuracy: number;
    fabricatedIdCount: number;
}

export function computeAdvisoryMetrics(results: AdvisoryResult[]): AdvisoryMetrics {
    const n = results.length;
    if (n === 0) throw new Error("No advisory results");

    const totalClaims = results.reduce((a, r) => a + r.claims_total, 0);
    const totalGrounded = results.reduce((a, r) => a + r.claims_grounded, 0);
    const totalFabricated = results.reduce((a, r) => a + r.claims_fabricated, 0);
    const totalContradicted = results.reduce((a, r) => a + r.claims_contradicted, 0);
    const totalNumericCorrect = results.reduce((a, r) => a + r.numeric_facts_correct, 0);
    const totalNumericFacts = results.reduce((a, r) => a + r.numeric_facts_total, 0);
    const totalFabricatedIds = results.reduce((a, r) => a + r.fabricated_ids.length, 0);

    return {
        factualGroundingRate: totalClaims > 0 ? totalGrounded / totalClaims : 1,
        hallucinationRate: totalClaims > 0 ? totalFabricated / totalClaims : 0,
        contradictionRate: totalClaims > 0 ? totalContradicted / totalClaims : 0,
        numericFactAccuracy: totalNumericFacts > 0 ? totalNumericCorrect / totalNumericFacts : 1,
        fabricatedIdCount: totalFabricatedIds,
    };
}

// ---- Abstention Correctness Metrics ----

export interface AbstentionMetrics {
    abstentionPrecision: number;   // correct_refusals / total_refusals
    abstentionRecall: number;      // correct_refusals / should_have_refused
    clarificationRate: number;     // asked_clarification_when_ambiguous / total_ambiguous
    overconfidenceRate: number;    // answered_when_should_refuse / total_unsupported
}

export function computeAbstentionMetrics(results: AbstractionResult[]): AbstentionMetrics {
    const totalRefusals = results.filter(r => r.actual_behavior === "refuse").length;
    const correctRefusals = results.filter(r =>
        r.actual_behavior === "refuse" && r.expected_behavior === "refuse"
    ).length;
    const shouldHaveRefused = results.filter(r => r.expected_behavior === "refuse").length;

    const ambiguous = results.filter(r => r.support_status === "ambiguous");
    const askedClarification = ambiguous.filter(r => r.actual_behavior === "ask_clarifying").length;

    const unsupported = results.filter(r => r.support_status === "unsupported");
    const answeredWhenShouldRefuse = unsupported.filter(r => r.actual_behavior === "answer").length;

    return {
        abstentionPrecision: totalRefusals > 0 ? correctRefusals / totalRefusals : 1,
        abstentionRecall: shouldHaveRefused > 0 ? correctRefusals / shouldHaveRefused : 1,
        clarificationRate: ambiguous.length > 0 ? askedClarification / ambiguous.length : 1,
        overconfidenceRate: unsupported.length > 0 ? answeredWhenShouldRefuse / unsupported.length : 0,
    };
}

// ---- Cohen's Kappa ----

export function computeCohensKappa(
    labels1: string[],
    labels2: string[],
): { kappa: number; perClass: Record<string, { precision: number; recall: number; f1: number }> } {
    if (labels1.length !== labels2.length) throw new Error("Label arrays must be same length");
    const n = labels1.length;
    const classes = [...new Set([...labels1, ...labels2])].sort();

    // Observed agreement
    let agree = 0;
    for (let i = 0; i < n; i++) {
        if (labels1[i] === labels2[i]) agree++;
    }
    const po = agree / n;

    // Expected agreement by chance
    let pe = 0;
    for (const cls of classes) {
        const count1 = labels1.filter(l => l === cls).length;
        const count2 = labels2.filter(l => l === cls).length;
        pe += (count1 / n) * (count2 / n);
    }

    const kappa = pe < 1 ? (po - pe) / (1 - pe) : 1;

    // Per-class precision/recall/F1 (treating labels1 as ground truth)
    const perClass: Record<string, { precision: number; recall: number; f1: number }> = {};
    for (const cls of classes) {
        const tp = labels1.filter((l, i) => l === cls && labels2[i] === cls).length;
        const fp = labels1.filter((l, i) => l !== cls && labels2[i] === cls).length;
        const fn = labels1.filter((l, i) => l === cls && labels2[i] !== cls).length;
        const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
        const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
        const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
        perClass[cls] = { precision, recall, f1 };
    }

    return { kappa, perClass };
}

// ---- Wilson Score Interval ----

export function wilsonInterval(successes: number, total: number, z = 1.96): { lower: number; upper: number } {
    if (total === 0) return { lower: 0, upper: 1 };
    const p = successes / total;
    const denominator = 1 + z * z / total;
    const center = p + z * z / (2 * total);
    const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
    return {
        lower: Math.max(0, (center - spread) / denominator),
        upper: Math.min(1, (center + spread) / denominator),
    };
}

// ---- Results Table Generation ----

export interface ResultsRow {
    run_id: string;
    timestamp: string;
    system: string;
    metric: string;
    value: number;
    ci_lower: number;
    ci_upper: number;
    n: number;
}

export function generateResultsTable(run: EvalRun): ResultsRow[] {
    const rows: ResultsRow[] = [];
    const base = { run_id: run.run_id, timestamp: run.timestamp, system: run.system };

    // Intent metrics
    if (run.intent_results.length > 0) {
        const im = computeIntentMetrics(run.intent_results);
        const n = run.intent_results.length;
        const accCI = wilsonInterval(run.intent_results.filter(r => r.correct).length, n);
        rows.push({ ...base, metric: "intent_accuracy", value: im.accuracy, ci_lower: accCI.lower, ci_upper: accCI.upper, n });
        rows.push({ ...base, metric: "quick_classify_coverage", value: im.quickClassifyCoverage, ci_lower: 0, ci_upper: 0, n });
        rows.push({ ...base, metric: "ece", value: im.ece, ci_lower: 0, ci_upper: 0, n });
        rows.push({ ...base, metric: "mean_latency_ms", value: im.meanLatencyMs, ci_lower: 0, ci_upper: 0, n });
    }

    // Constraint metrics
    if (run.constraint_results.length > 0) {
        const cm = computeConstraintMetrics(run.constraint_results);
        const n = run.constraint_results.length;
        rows.push({ ...base, metric: "rule_accuracy", value: cm.ruleAccuracy, ci_lower: 0, ci_upper: 0, n });
        rows.push({ ...base, metric: "credit_exact_match", value: cm.creditExactMatch, ci_lower: 0, ci_upper: 0, n });
        rows.push({ ...base, metric: "constraint_bugs", value: cm.totalBugs, ci_lower: 0, ci_upper: 0, n });
        rows.push({ ...base, metric: "data_gaps", value: cm.totalDataGaps, ci_lower: 0, ci_upper: 0, n });
    }

    // Advisory metrics
    if (run.advisory_results.length > 0) {
        const am = computeAdvisoryMetrics(run.advisory_results);
        const n = run.advisory_results.length;
        rows.push({ ...base, metric: "factual_grounding_rate", value: am.factualGroundingRate, ci_lower: 0, ci_upper: 0, n });
        rows.push({ ...base, metric: "hallucination_rate", value: am.hallucinationRate, ci_lower: 0, ci_upper: 0, n });
        rows.push({ ...base, metric: "contradiction_rate", value: am.contradictionRate, ci_lower: 0, ci_upper: 0, n });
        rows.push({ ...base, metric: "numeric_fact_accuracy", value: am.numericFactAccuracy, ci_lower: 0, ci_upper: 0, n });
    }

    // Abstention metrics
    if (run.abstention_results.length > 0) {
        const ab = computeAbstentionMetrics(run.abstention_results);
        const n = run.abstention_results.length;
        rows.push({ ...base, metric: "abstention_precision", value: ab.abstentionPrecision, ci_lower: 0, ci_upper: 0, n });
        rows.push({ ...base, metric: "abstention_recall", value: ab.abstentionRecall, ci_lower: 0, ci_upper: 0, n });
        rows.push({ ...base, metric: "overconfidence_rate", value: ab.overconfidenceRate, ci_lower: 0, ci_upper: 0, n });
    }

    return rows;
}

export function resultsToCSV(rows: ResultsRow[]): string {
    const header = "run_id,timestamp,system,metric,value,ci_lower,ci_upper,n";
    const lines = rows.map(r =>
        `${r.run_id},${r.timestamp},${r.system},${r.metric},${r.value.toFixed(4)},${r.ci_lower.toFixed(4)},${r.ci_upper.toFixed(4)},${r.n}`
    );
    return [header, ...lines].join("\n");
}

// ---- Confusion Matrix to CSV ----

export function confusionMatrixToCSV(matrix: Record<string, Record<string, number>>): string {
    const labels = Object.keys(matrix).sort();
    const header = ["expected\\predicted", ...labels].join(",");
    const rows = labels.map(expected => {
        const counts = labels.map(predicted => matrix[expected][predicted] ?? 0);
        return [expected, ...counts].join(",");
    });
    return [header, ...rows].join("\n");
}
