#!/usr/bin/env -S npx tsx
// ============================================================
// cohort-freeze CLI (Phase 7-E W7)
// ============================================================
// Operator command: freeze a cohort's eval-set snapshot. Run when
// you have reviewed the cases, agree they're ready to lock, and
// want subsequent silent edits to fail CI.
//
// Usage:
//   npx tsx tools/cohort-freeze/freeze.ts a [--note "post-W6"]
//   npx tsx tools/cohort-freeze/freeze.ts verify a
//
// The first form writes evals/cohorts/a.frozen.json with the
// current case set's sha256. The second recomputes the hash and
// reports any mismatch.
// ============================================================

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COHORT_A_CASES } from "../../evals/cohorts/cohort_a.js";
import {
    writeFreezeMeta,
    verifyCohortFrozen,
    computeCohortHash,
} from "../../evals/cohorts/freeze.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COHORTS_DIR = join(__dirname, "..", "..", "evals", "cohorts");

const COHORT_REGISTRY: Record<string, () => { cases: typeof COHORT_A_CASES; cohort: string }> = {
    a: () => ({ cases: COHORT_A_CASES, cohort: "cohort_a" }),
};

function exitWithUsage(msg?: string): never {
    if (msg) console.error("error:", msg);
    console.error("usage: freeze.ts <freeze|verify> <cohort> [--note '...']");
    console.error("       cohorts: " + Object.keys(COHORT_REGISTRY).join(", "));
    process.exit(1);
}

const [verb, cohortKey, ...rest] = process.argv.slice(2);
if (!verb || !cohortKey) exitWithUsage();
const reg = COHORT_REGISTRY[cohortKey!];
if (!reg) exitWithUsage(`unknown cohort: ${cohortKey}`);
const { cases, cohort } = reg();

if (verb === "freeze") {
    const noteArgIdx = rest.indexOf("--note");
    const note = noteArgIdx >= 0 ? rest[noteArgIdx + 1] : undefined;
    const meta = writeFreezeMeta(cohort, COHORTS_DIR, cases, note);
    console.log(`✓ Froze cohort "${cohort}" at ${meta.frozenAt}`);
    console.log(`  caseCount: ${meta.caseCount}`);
    console.log(`  sourceHash: ${meta.sourceHash}`);
    if (note) console.log(`  note: ${note}`);
    console.log(`  meta path: ${join(COHORTS_DIR, cohort + ".frozen.json")}`);
    process.exit(0);
}

if (verb === "verify") {
    const result = verifyCohortFrozen(cohort, COHORTS_DIR, cases);
    if (result.ok) {
        console.log(`✓ Cohort "${cohort}" matches frozen snapshot`);
        console.log(`  caseCount: ${result.meta.caseCount}`);
        console.log(`  sourceHash: ${result.computedHash}`);
        process.exit(0);
    }
    console.error(`✗ Cohort "${cohort}" does NOT match frozen snapshot`);
    if (result.reason === "no_freeze_meta") {
        console.error(`  reason: no freeze meta found. Run \`freeze.ts freeze ${cohortKey}\` to create one.`);
    } else if (result.reason === "hash_mismatch") {
        console.error(`  reason: hash_mismatch`);
        console.error(`    expected: ${result.expected}`);
        console.error(`    actual:   ${result.actual}`);
        const computed = computeCohortHash(cases);
        console.error(`  to accept the new cases as the frozen state, re-run:`);
        console.error(`    freeze.ts freeze ${cohortKey} --note 'why this snapshot supersedes ${result.meta.frozenAt}'`);
        console.error(`  (Verified hash: ${computed})`);
    } else if (result.reason === "case_count_mismatch") {
        console.error(`  reason: case_count_mismatch (expected ${result.expected}, got ${result.actual})`);
    }
    process.exit(1);
}

exitWithUsage(`unknown verb: ${verb}`);
