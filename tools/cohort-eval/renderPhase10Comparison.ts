#!/usr/bin/env -S npx tsx
// Render Phase 10 bake-off comparison: Method A v1 (baseline) vs A v2 (anti-fab) vs B.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(REPO_ROOT, "evals/results");

interface QuestionResult {
    questionId: string; section: "A" | "B"; category: string; question: string;
    finalText: string; toolsCalled: string[]; engineKind: string; durationMs: number;
    autoGrade: { score: number; failedChecks: string[] };
    judgeGrade: { composite: number; rationale: string };
    completenessRetried?: boolean;
}

interface Run {
    label: string;
    sectionA: { passRate: number; count: number };
    sectionB: { passRate: number; count: number };
    overall: { passRate: number; count: number };
    results: QuestionResult[];
    totalRetries?: number;
}

function loadRun(label: string, path: string): Run | null {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf-8")) as Run & { results: QuestionResult[] };
    return { ...j, label };
}

function passVerdict(r: QuestionResult): boolean {
    return r.autoGrade.score === 1 && r.judgeGrade.composite >= 4.0;
}

function softPassVerdict(r: QuestionResult): boolean {
    return r.autoGrade.score >= 0.5 && r.judgeGrade.composite >= 3.5;
}

function main(): void {
    const candidates: Array<{ label: string; path: string }> = [
        { label: "BASELINE (pre-Phase-10)", path: join(RESULTS_DIR, "phase10_method_pre_envelope_2026-04-29.json") },
        { label: "Method A v1 (envelope only)", path: join(RESULTS_DIR, "phase10_methodA_v1_2026-04-29.json") },
        { label: "Method A v2 (envelope + anti-fab guard)", path: join(RESULTS_DIR, "phase10_baseline_2026-04-29.json") },
        { label: "Method B (envelope + reviewer+retry)", path: join(RESULTS_DIR, "phase10_methodB_2026-04-29.json") },
    ];
    const runs: Run[] = candidates.map((c) => loadRun(c.label, c.path)).filter((r): r is Run => r !== null);
    if (runs.length === 0) { console.error("No runs found"); process.exit(1); }

    const lines: string[] = [];
    lines.push(`# Phase 10 Stage 4 — Bake-off comparison`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");
    lines.push("## Headline numbers");
    lines.push("");
    lines.push("| Method | Section A | Section B | Overall | Retries |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const r of runs) {
        const a = (r.sectionA.passRate * 100).toFixed(0);
        const b = (r.sectionB.passRate * 100).toFixed(0);
        const o = (r.overall.passRate * 100).toFixed(0);
        const retries = r.totalRetries !== undefined ? r.totalRetries.toString() : "—";
        lines.push(`| ${r.label} | ${a}% | ${b}% | ${o}% | ${retries} |`);
    }
    lines.push("");
    lines.push("**Strict pass criterion:** auto-grade = 1.0 AND judge composite ≥ 4.0.");
    lines.push("");

    lines.push("## Soft pass rate (auto ≥ 0.5 AND judge ≥ 3.5)");
    lines.push("");
    lines.push("Strict 4.0 judge bar can mask real improvements when answers are correct but the judge dings phrasing or structure. The soft bar shows the architectural delta more clearly.");
    lines.push("");
    lines.push("| Method | Section A soft | Section B soft | Overall soft |");
    lines.push("|---|---:|---:|---:|");
    for (const r of runs) {
        const a = r.results.filter((x) => x.section === "A");
        const b = r.results.filter((x) => x.section === "B");
        const aSoft = a.length === 0 ? 0 : a.filter(softPassVerdict).length / a.length;
        const bSoft = b.length === 0 ? 0 : b.filter(softPassVerdict).length / b.length;
        const oSoft = r.results.filter(softPassVerdict).length / r.results.length;
        lines.push(`| ${r.label} | ${(aSoft * 100).toFixed(0)}% | ${(bSoft * 100).toFixed(0)}% | ${(oSoft * 100).toFixed(0)}% |`);
    }
    lines.push("");

    // Average judge composite per section.
    lines.push("## Mean judge composite (1-5 scale)");
    lines.push("");
    lines.push("| Method | Section A judge avg | Section B judge avg | Overall judge avg |");
    lines.push("|---|---:|---:|---:|");
    for (const r of runs) {
        const a = r.results.filter((x) => x.section === "A");
        const b = r.results.filter((x) => x.section === "B");
        const avg = (xs: QuestionResult[]) => xs.length === 0 ? 0 : xs.reduce((s, x) => s + x.judgeGrade.composite, 0) / xs.length;
        lines.push(`| ${r.label} | ${avg(a).toFixed(2)} | ${avg(b).toFixed(2)} | ${avg(r.results).toFixed(2)} |`);
    }
    lines.push("");

    // Per-case grid showing each method's verdict.
    lines.push("## Per-case verdicts (✅ pass / ❌ fail)");
    lines.push("");
    const ids = runs[0]!.results.map((r) => r.questionId);
    lines.push("| ID | " + runs.map((r) => r.label.split(" ")[0] + " " + (r.label.includes("v1") ? "v1" : r.label.includes("v2") ? "v2" : r.label.includes("B") ? "B" : "base")).join(" | ") + " | Question |");
    lines.push("|" + ["---", ...runs.map(() => "---"), "---"].join("|") + "|");
    for (const id of ids) {
        const cells: string[] = [id];
        for (const r of runs) {
            const q = r.results.find((x) => x.questionId === id);
            if (!q) cells.push("—");
            else cells.push(passVerdict(q) ? `✅ ${q.judgeGrade.composite.toFixed(1)}` : `❌ ${q.judgeGrade.composite.toFixed(1)}`);
        }
        const q0 = runs[0]!.results.find((x) => x.questionId === id);
        cells.push((q0?.question ?? "").slice(0, 80).replace(/\|/g, "\\|"));
        lines.push("| " + cells.join(" | ") + " |");
    }
    lines.push("");

    // Improvements: cases that went from FAIL in baseline to PASS in latest.
    if (runs.length >= 2) {
        const base = runs[0]!;
        const latest = runs[runs.length - 1]!;
        const wins = base.results.filter((b) => {
            const l = latest.results.find((x) => x.questionId === b.questionId);
            return l && !passVerdict(b) && passVerdict(l);
        });
        const regressions = base.results.filter((b) => {
            const l = latest.results.find((x) => x.questionId === b.questionId);
            return l && passVerdict(b) && !passVerdict(l);
        });
        lines.push(`## Improvements (baseline → latest)`);
        lines.push("");
        if (wins.length === 0) lines.push("None.");
        else for (const w of wins) lines.push(`- **${w.questionId}** (${w.section}/${w.category}): ${w.question}`);
        lines.push("");
        lines.push(`## Regressions (baseline → latest)`);
        lines.push("");
        if (regressions.length === 0) lines.push("None.");
        else for (const r of regressions) lines.push(`- **${r.questionId}** (${r.section}/${r.category}): ${r.question}`);
        lines.push("");
    }

    const out = join(RESULTS_DIR, "phase10_bakeoff_comparison.md");
    writeFileSync(out, lines.join("\n"));
    console.error(`Wrote ${out}`);
}

main();
