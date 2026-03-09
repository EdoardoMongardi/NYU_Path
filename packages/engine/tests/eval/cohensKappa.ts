#!/usr/bin/env npx tsx
// ============================================================
// Cohen's Kappa Calculator — Layer C Calibration (§11)
// Reads calibration_sheet.csv with human_label filled in,
// computes inter-rater agreement between judge and human.
// ============================================================

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(__dirname, "calibration_sheet.csv");

interface Row {
    scenario_id: string;
    query: string;
    claim_text: string;
    judge_label: string;
    human_label: string;
    evidence: string;
    notes: string;
}

const LABELS = ["grounded", "hallucinated", "contradicted", "insufficient_evidence"];

function parseCSV(content: string): Row[] {
    const lines = content.split("\n").filter(l => l.trim());
    const header = lines[0];
    const rows: Row[] = [];

    for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);
        if (fields.length < 7) continue;
        rows.push({
            scenario_id: fields[0],
            query: fields[1],
            claim_text: fields[2],
            judge_label: fields[3],
            human_label: fields[4],
            evidence: fields[5],
            notes: fields[6] || "",
        });
    }
    return rows;
}

/** Parse a CSV line respecting quoted fields */
function parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === "," && !inQuotes) {
            fields.push(current.trim());
            current = "";
        } else {
            current += char;
        }
    }
    fields.push(current.trim());
    return fields;
}

/**
 * Compute Cohen's Kappa for two raters.
 * κ = (po - pe) / (1 - pe)
 * where po = observed agreement, pe = expected agreement by chance
 */
function cohensKappa(rater1: string[], rater2: string[], labels: string[]): number {
    const n = rater1.length;
    if (n === 0) return 0;

    // Build confusion matrix
    const matrix: Record<string, Record<string, number>> = {};
    for (const l1 of labels) {
        matrix[l1] = {};
        for (const l2 of labels) {
            matrix[l1][l2] = 0;
        }
    }

    for (let i = 0; i < n; i++) {
        const l1 = rater1[i];
        const l2 = rater2[i];
        if (matrix[l1] && matrix[l1][l2] !== undefined) {
            matrix[l1][l2]++;
        }
    }

    // Observed agreement (po)
    let agree = 0;
    for (const l of labels) {
        agree += matrix[l][l];
    }
    const po = agree / n;

    // Expected agreement (pe)
    let pe = 0;
    for (const l of labels) {
        const r1Count = rater1.filter(x => x === l).length;
        const r2Count = rater2.filter(x => x === l).length;
        pe += (r1Count / n) * (r2Count / n);
    }

    if (pe === 1) return 1;
    return (po - pe) / (1 - pe);
}

/**
 * Compute per-class precision and recall.
 * Treats judge as "predicted" and human as "gold".
 */
function perClassMetrics(judge: string[], human: string[], labels: string[]) {
    const metrics: Array<{
        label: string;
        precision: number;
        recall: number;
        f1: number;
        support: number;
    }> = [];

    for (const label of labels) {
        const tp = judge.filter((j, i) => j === label && human[i] === label).length;
        const fp = judge.filter((j, i) => j === label && human[i] !== label).length;
        const fn = judge.filter((j, i) => j !== label && human[i] === label).length;
        const support = human.filter(h => h === label).length;

        const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
        const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
        const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

        metrics.push({ label, precision, recall, f1, support });
    }

    return metrics;
}

function main() {
    console.log("=".repeat(60));
    console.log("  Cohen's κ — Judge Calibration Report");
    console.log("=".repeat(60));

    const csv = readFileSync(CSV_PATH, "utf-8");
    const rows = parseCSV(csv);

    // Filter to only rows with human labels filled
    const labeled = rows.filter(r => r.human_label && LABELS.includes(r.human_label));
    const unlabeled = rows.filter(r => !r.human_label || !LABELS.includes(r.human_label));

    console.log(`\n  Total rows: ${rows.length}`);
    console.log(`  Human-labeled: ${labeled.length}`);
    console.log(`  Unlabeled: ${unlabeled.length}`);

    if (labeled.length === 0) {
        console.log("\n  ❌ No human labels found. Fill the 'human_label' column first.");
        return;
    }

    const judgeLabels = labeled.map(r => r.judge_label);
    const humanLabels = labeled.map(r => r.human_label);

    // Cohen's κ
    const kappa = cohensKappa(judgeLabels, humanLabels, LABELS);
    console.log(`\n  Cohen's κ = ${kappa.toFixed(3)}`);

    if (kappa >= 0.85) {
        console.log("  ✅ κ ≥ 0.85 — judge is TRUSTED for scale-up");
    } else if (kappa >= 0.7) {
        console.log("  ⚠️ κ ≥ 0.7 — judge is usable WITH CAVEAT");
    } else {
        console.log("  ❌ κ < 0.7 — iterate on judge prompt before scaling");
    }

    // Per-class metrics
    console.log("\n  Per-Class Metrics (Judge vs Human):");
    console.log("  " + "-".repeat(58));
    console.log("  Label                  Prec   Rec    F1     Support");
    console.log("  " + "-".repeat(58));

    const classMetrics = perClassMetrics(judgeLabels, humanLabels, LABELS);
    for (const m of classMetrics) {
        const label = m.label.padEnd(24);
        console.log(`  ${label} ${m.precision.toFixed(2)}   ${m.recall.toFixed(2)}   ${m.f1.toFixed(2)}   ${m.support}`);
    }

    // Agreement matrix
    console.log("\n  Confusion Matrix (rows=judge, cols=human):");
    console.log("  " + "-".repeat(58));
    const header = "  " + "".padEnd(24) + LABELS.map(l => l.slice(0, 6).padStart(8)).join("");
    console.log(header);

    for (const l1 of LABELS) {
        const row = LABELS.map(l2 => {
            const count = judgeLabels.filter((j, i) => j === l1 && humanLabels[i] === l2).length;
            return String(count).padStart(8);
        }).join("");
        console.log(`  ${l1.padEnd(24)}${row}`);
    }

    // Overall metrics
    const totalClaims = labeled.length;
    const groundedByHuman = humanLabels.filter(l => l === "grounded").length;
    const hallucinatedByHuman = humanLabels.filter(l => l === "hallucinated").length;
    const contradictedByHuman = humanLabels.filter(l => l === "contradicted").length;

    console.log("\n  Overall Metrics (from human labels):");
    console.log(`    Grounding Rate:     ${((groundedByHuman / totalClaims) * 100).toFixed(1)}%`);
    console.log(`    Hallucination Rate: ${((hallucinatedByHuman / totalClaims) * 100).toFixed(1)}%`);
    console.log(`    Contradiction Rate: ${((contradictedByHuman / totalClaims) * 100).toFixed(1)}%`);

    // Save report
    const reportPath = join(__dirname, "calibration_report.md");
    const report = `# Judge Calibration Report

**Date**: ${new Date().toISOString().split("T")[0]}
**Total claims evaluated**: ${labeled.length}
**Cohen's κ**: ${kappa.toFixed(3)}
**Status**: ${kappa >= 0.85 ? "✅ Trusted" : kappa >= 0.7 ? "⚠️ Usable with caveat" : "❌ Needs iteration"}

## Per-Class Metrics

| Label | Precision | Recall | F1 | Support |
|-------|-----------|--------|-----|---------|
${classMetrics.map(m => `| ${m.label} | ${m.precision.toFixed(2)} | ${m.recall.toFixed(2)} | ${m.f1.toFixed(2)} | ${m.support} |`).join("\n")}

## Overall Quality (Human Labels)

| Metric | Value | Target |
|--------|-------|--------|
| Grounding Rate | ${((groundedByHuman / totalClaims) * 100).toFixed(1)}% | ≥ 95% |
| Hallucination Rate | ${((hallucinatedByHuman / totalClaims) * 100).toFixed(1)}% | ≤ 3% |
| Contradiction Rate | ${((contradictedByHuman / totalClaims) * 100).toFixed(1)}% | 0% |
`;

    writeFileSync(reportPath, report, "utf-8");
    console.log(`\n📄 Report saved: ${reportPath}`);
}

main();
