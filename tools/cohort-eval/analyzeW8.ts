#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 7-E W8.3 — surrogate-run analysis
// ============================================================
// Reads the JSON written by runSurrogateW8.ts and produces:
//   - composite_summary.md  → human-readable per-case + per-domain
//                              breakdown with PASS/FAIL annotations
//   - failures.md           → detailed per-failure transcripts +
//                              diagnostic notes
//
// Usage:
//   npx tsx tools/cohort-eval/analyzeW8.ts <results.json>
// or (defaults to most-recent results file):
//   npx tsx tools/cohort-eval/analyzeW8.ts
// ============================================================

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

interface CaseRow {
    caseId: string;
    description: string;
    composite: number;
    transcript: Array<{ role: "user" | "assistant"; content: string }>;
    errors: string[];
}

interface SurrogateReport {
    _meta: {
        cohort: string;
        cohortHash: string;
        agentModel: string;
        personaModel: string;
        runStartedAt: string;
        runDurationSec: number;
        caseCount: number;
    };
    cases: CaseRow[];
    cohortComposite: number;
    dimensions: { grounding: number; completeness: number; uncertainty: number; nonFabrication: number };
}

function pickLatestResults(): string {
    const candidates = readdirSync(RESULTS_DIR)
        .filter((f) => f.startsWith("cohort_a_surrogate_") && f.endsWith(".json"))
        .sort();
    if (candidates.length === 0) {
        console.error(`No results in ${RESULTS_DIR}; run runSurrogateW8.ts first.`);
        process.exit(1);
    }
    return join(RESULTS_DIR, candidates[candidates.length - 1]!);
}

function classifyDomain(caseId: string): string {
    if (caseId.startsWith("cohortA-real-")) return "real-DPR";
    if (caseId.startsWith("cohortA-dpr-1")) return "audit-reads";
    if (caseId.startsWith("cohortA-dpr-2")) return "remaining-reqs";
    if (caseId.startsWith("cohortA-dpr-3")) return "plan-semester";
    if (caseId.startsWith("cohortA-dpr-4")) return "pf-outside-cas";
    if (caseId.startsWith("cohortA-dpr-5")) return "whatif-major";
    if (caseId.startsWith("cohortA-dpr-6")) return "whatif-minor";
    if (caseId.startsWith("cohortA-dpr-7")) return "policy-rag";
    if (caseId.startsWith("cohortA-dpr-8")) return "transfer";
    if (caseId.startsWith("cohortA-001") || caseId.startsWith("cohortA-002")) return "legacy-cs";
    if (caseId.startsWith("cohortA-003")) return "legacy-f1";
    if (caseId.startsWith("cohortA-004") || caseId.startsWith("cohortA-005")) return "legacy-pf";
    if (caseId.startsWith("cohortA-006")) return "legacy-transfer";
    if (caseId.startsWith("cohortA-007")) return "legacy-econ";
    if (caseId.startsWith("cohortA-008")) return "legacy-low-conf";
    if (caseId.startsWith("cohortA-009")) return "legacy-cardinal";
    if (caseId.startsWith("cohortA-010")) return "legacy-cross-school";
    return "other";
}

function summary(report: SurrogateReport, sourcePath: string): string {
    const lines: string[] = [];
    lines.push(`# Phase 7-E W8 — Cohort A Surrogate Composite`);
    lines.push("");
    lines.push(`**Source**: ${sourcePath}`);
    lines.push(`**Cohort**: ${report._meta.cohort} (frozen at sourceHash ${report._meta.cohortHash})`);
    lines.push(`**Agent model**: ${report._meta.agentModel}`);
    lines.push(`**Persona model**: ${report._meta.personaModel}`);
    lines.push(`**Run duration**: ${report._meta.runDurationSec.toFixed(1)} s`);
    lines.push(`**Cases**: ${report.cases.length}`);
    lines.push("");
    lines.push(`## Headline`);
    lines.push("");
    lines.push(`**Cohort composite: ${report.cohortComposite.toFixed(3)}**`);
    lines.push("");
    const gate = report.cohortComposite >= 0.90 ? "✅ PASS" : "❌ FAIL";
    lines.push(`**§12.6.5 0.90 gate (surrogate, upper-bound)**: ${gate}`);
    lines.push("");
    if (report.cohortComposite >= 0.90) {
        lines.push(`Surrogate composite cleared the §12.6.5 floor. Real cohort A will likely score lower per the line-4134 upper-bound caveat (0.85–0.92 range). System is unblocked from the engineering side; remaining gates: W11 reviewer + W12 auth.`);
    } else if (report.cohortComposite >= 0.85) {
        lines.push(`Below the 0.90 gate but above 0.85. Triage failing cases (see below); decide whether per-case fixes can lift the composite, or whether the gap is structural.`);
    } else {
        lines.push(`Significantly below the 0.90 gate. Real cohort A will not pass. Pause cohort A pilot recruitment; remediate the failure modes surfaced below before measurement re-run.`);
    }
    lines.push("");
    lines.push(`## Per-dimension breakdown`);
    lines.push("");
    lines.push(`| Dimension | Score |`);
    lines.push(`|---|---|`);
    lines.push(`| Grounding (numbers traced to tool results) | ${report.dimensions.grounding.toFixed(3)} |`);
    lines.push(`| Completeness (required caveats present) | ${report.dimensions.completeness.toFixed(3)} |`);
    lines.push(`| Uncertainty (hedges when unknown) | ${report.dimensions.uncertainty.toFixed(3)} |`);
    lines.push(`| Non-fabrication (no synthesized data) | ${report.dimensions.nonFabrication.toFixed(3)} |`);
    lines.push("");

    // Per-domain composite.
    const byDomain: Record<string, number[]> = {};
    for (const c of report.cases) {
        const d = classifyDomain(c.caseId);
        (byDomain[d] ??= []).push(c.composite);
    }
    lines.push(`## Per-domain composite`);
    lines.push("");
    lines.push(`| Domain | n | mean composite |`);
    lines.push(`|---|---|---|`);
    const sortedDomains = Object.entries(byDomain).sort((a, b) => {
        const meanA = a[1].reduce((s, v) => s + v, 0) / a[1].length;
        const meanB = b[1].reduce((s, v) => s + v, 0) / b[1].length;
        return meanA - meanB;
    });
    for (const [d, scores] of sortedDomains) {
        const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
        lines.push(`| ${d} | ${scores.length} | ${mean.toFixed(3)} |`);
    }
    lines.push("");

    // Distribution.
    const buckets = { ge_95: 0, ge_90: 0, ge_85: 0, ge_75: 0, lt_75: 0 };
    for (const c of report.cases) {
        if (c.composite >= 0.95) buckets.ge_95 += 1;
        else if (c.composite >= 0.90) buckets.ge_90 += 1;
        else if (c.composite >= 0.85) buckets.ge_85 += 1;
        else if (c.composite >= 0.75) buckets.ge_75 += 1;
        else buckets.lt_75 += 1;
    }
    lines.push(`## Composite distribution`);
    lines.push("");
    lines.push(`- ≥ 0.95: ${buckets.ge_95}`);
    lines.push(`- 0.90 – 0.95: ${buckets.ge_90}`);
    lines.push(`- 0.85 – 0.90: ${buckets.ge_85}`);
    lines.push(`- 0.75 – 0.85: ${buckets.ge_75}`);
    lines.push(`- < 0.75: ${buckets.lt_75}`);
    lines.push("");

    // Failures
    const failing = [...report.cases].filter((c) => c.composite < 0.85)
        .sort((a, b) => a.composite - b.composite);
    lines.push(`## Cases below 0.85 (${failing.length} of ${report.cases.length})`);
    lines.push("");
    if (failing.length === 0) {
        lines.push("No cases fell below the 0.85 floor. 🎉");
    } else {
        lines.push(`| caseId | composite | description |`);
        lines.push(`|---|---|---|`);
        for (const c of failing.slice(0, 30)) {
            lines.push(`| ${c.caseId} | ${c.composite.toFixed(3)} | ${c.description.slice(0, 60)} |`);
        }
    }
    return lines.join("\n");
}

function failureDetail(report: SurrogateReport): string {
    const failing = [...report.cases].filter((c) => c.composite < 0.85)
        .sort((a, b) => a.composite - b.composite);
    const lines: string[] = [];
    lines.push(`# Phase 7-E W8 — Failure Detail`);
    lines.push("");
    lines.push(`${failing.length} cases below 0.85 composite.`);
    lines.push("");
    for (const c of failing) {
        lines.push(`## ${c.caseId} — composite ${c.composite.toFixed(3)}`);
        lines.push(`**Description**: ${c.description}`);
        lines.push(`**Domain**: ${classifyDomain(c.caseId)}`);
        if (c.errors.length > 0) {
            lines.push(`**Errors**:`);
            for (const e of c.errors) lines.push(`  - ${e}`);
        }
        lines.push("");
        lines.push(`### Transcript`);
        for (const t of c.transcript) {
            lines.push(`**${t.role}**: ${t.content.replace(/\n/g, " ").slice(0, 600)}${t.content.length > 600 ? "…" : ""}`);
            lines.push("");
        }
        lines.push("---");
        lines.push("");
    }
    return lines.join("\n");
}

const sourcePath = process.argv[2] ?? pickLatestResults();
const report = JSON.parse(readFileSync(sourcePath, "utf-8")) as SurrogateReport;

const summaryPath = sourcePath.replace(/\.json$/, "_summary.md");
writeFileSync(summaryPath, summary(report, sourcePath));
console.log(`Wrote ${summaryPath}`);

const failPath = sourcePath.replace(/\.json$/, "_failures.md");
writeFileSync(failPath, failureDetail(report));
console.log(`Wrote ${failPath}`);

console.log("");
console.log(`Composite: ${report.cohortComposite.toFixed(3)}`);
console.log(`§12.6.5 gate (≥0.90): ${report.cohortComposite >= 0.90 ? "PASS" : "FAIL"}`);
