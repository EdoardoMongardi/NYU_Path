// ============================================================
// Phase 7-E W7 — cohort freeze verification (CI gate)
// ============================================================
// Per ARCHITECTURE.md §12.6.5: "Eval cases are frozen when added
// to a cohort's set. They are not edited or removed."
//
// This test is the CI gate that enforces the freeze. It loads the
// cohort case set, computes a content-addressed sha256, and
// asserts equality against the frozen sourceHash in
// evals/cohorts/<cohort>.frozen.json. Any silent edit to a case
// (add/remove/modify) flips the hash and fails this test.
//
// To intentionally re-freeze the cohort after a reviewed update:
//   npx tsx tools/cohort-freeze/freeze.ts freeze a --note "..."
// ============================================================

import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COHORT_A_CASES } from "../cohorts/cohort_a.js";
import { verifyCohortFrozen, computeCohortHash } from "../cohorts/freeze.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COHORTS_DIR = join(__dirname, "..", "cohorts");

describe("Cohort freeze gate (Phase 7-E W7 / §12.6.5)", () => {
    it("cohort A matches the frozen snapshot (computed sha256 == frozen sourceHash)", () => {
        const result = verifyCohortFrozen("cohort_a", COHORTS_DIR, COHORT_A_CASES);
        if (!result.ok) {
            // Compute current hash for the failure message so the
            // operator can compare against what the freeze would
            // produce.
            const computed = computeCohortHash(COHORT_A_CASES);
            const reason = result.reason === "hash_mismatch"
                ? `hash mismatch (expected ${result.expected}, got ${result.actual})`
                : result.reason === "case_count_mismatch"
                    ? `case_count_mismatch (expected ${result.expected}, got ${result.actual})`
                    : "no freeze meta found";
            throw new Error(
                `Cohort A freeze gate FAILED: ${reason}\n`
                + `Current computed hash: ${computed}\n`
                + `If this change is intentional, re-freeze via:\n`
                + `  npx tsx tools/cohort-freeze/freeze.ts freeze a --note "<reason>"`,
            );
        }
        expect(result.ok).toBe(true);
        expect(result.meta.cohort).toBe("cohort_a");
        expect(result.meta.caseCount).toBe(COHORT_A_CASES.length);
    });

    it("freeze meta lists at least 50 cases (§12.6.5 cohort A floor)", () => {
        const result = verifyCohortFrozen("cohort_a", COHORTS_DIR, COHORT_A_CASES);
        if (!result.ok) throw new Error("freeze meta missing or hash mismatched");
        expect(result.meta.caseCount).toBeGreaterThanOrEqual(50);
    });

    it("hash is deterministic across recomputes (content-addressed, not time-stamped)", () => {
        const a = computeCohortHash(COHORT_A_CASES);
        const b = computeCohortHash(COHORT_A_CASES);
        expect(a).toBe(b);
        expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("editing a case flips the hash (sanity check of the gate)", () => {
        const original = computeCohortHash(COHORT_A_CASES);
        // Mutate one case's userMessage in a non-destructive way (deep
        // copy first to avoid polluting the imported array).
        const mutated = COHORT_A_CASES.map((c) => ({
            ...c,
            turns: c.turns.map((t, i) =>
                i === 0
                    ? { ...t, userMessage: t.userMessage + " ?" }
                    : t,
            ),
        }));
        const mutatedHash = computeCohortHash(mutated);
        expect(mutatedHash).not.toBe(original);
    });
});
