// ============================================================
// Cohort eval-set freeze (Phase 7-E W7 / §12.6.5 line 4127-4128)
// ============================================================
// Per ARCHITECTURE.md §12.6.5: "Eval cases are frozen when added
// to a cohort's set. They are not edited or removed."
//
// The freeze gate works in two pieces:
//
// 1. computeCohortHash(cases) deterministically serializes a
//    canonical projection of every case (id + description +
//    userMessage + requiredCaveats + expectedToolCalls +
//    forbiddenPatterns as strings + degreeProgressReport
//    cumulative-block fingerprint) and returns a sha256.
//
// 2. cohort_a.frozen.json carries `{frozenAt, caseCount,
//    sourceHash}` for the cohort's accepted snapshot. CI runs
//    `verifyCohortFrozen()` which recomputes the hash and asserts
//    equality. Any silent edit to a case (add/remove/modify)
//    flips the hash, fails CI, and forces an explicit
//    `--unfreeze` followed by re-freeze + reviewer approval.
//
// Why we don't move cases out of .ts → .json: the cases hold
// regex patterns, mkDpr() calls, and StudentProfile types that
// don't serialize cleanly. The .ts source stays canonical; the
// hash anchors it.
// ============================================================

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationCase } from "../cohort/runner.js";

export interface CohortFreezeMeta {
    frozenAt: string;
    caseCount: number;
    sourceHash: string;
    cohort: string;
    /** Optional human-readable note about why this version was frozen. */
    note?: string;
}

/**
 * Build the canonical projection of a case that the hash sees.
 * Only the fields that materially affect agent evaluation are
 * included; ad-hoc structural fields (e.g., comments inside
 * the case) don't move the hash.
 */
function projectCase(c: ConversationCase): unknown {
    return {
        id: c.id,
        description: c.description,
        // Student fingerprint: only id + catalogYear + homeSchool +
        // declaredPrograms + visaStatus matter for grading. Course
        // history isn't included because mkDpr() may produce it
        // structurally; the DPR fingerprint below covers it.
        student: {
            id: c.student.id,
            catalogYear: c.student.catalogYear,
            homeSchool: c.student.homeSchool,
            declaredPrograms: c.student.declaredPrograms,
            visaStatus: c.student.visaStatus,
        },
        // DPR fingerprint: when present, the fingerprint already
        // hashes its content (see mkDpr's createHash logic).
        dprFingerprint: c.degreeProgressReport?._meta.sourceFingerprint ?? null,
        // Turn projection: each turn's user message + expected
        // tool calls + required caveats + forbidden patterns as
        // strings. Regexes serialize as their .source.
        turns: c.turns.map((t) => ({
            userMessage: t.userMessage,
            expectedToolCalls: t.expectedToolCalls ?? null,
            forbiddenToolCalls: t.forbiddenToolCalls ?? null,
            requiredCaveats: t.requiredCaveats ?? null,
            forbiddenPatterns: (t.forbiddenPatterns ?? []).map((re) => re.source),
            requiresAdviserCaveat: t.requiresAdviserCaveat ?? false,
        })),
    };
}

/**
 * Stable, content-addressed hash of a case set. Order matters
 * (we hash the cases in their submission order) so a permutation
 * is treated as an edit — preserves the property "this exact set
 * in this exact order was reviewed and frozen".
 */
export function computeCohortHash(cases: ConversationCase[]): string {
    const canonical = JSON.stringify(cases.map(projectCase));
    const sha = createHash("sha256").update(canonical, "utf-8").digest("hex");
    return `sha256:${sha}`;
}

/** Path to the freeze meta sidecar for a cohort. */
function freezeMetaPath(cohort: string, dir: string): string {
    return join(dir, `${cohort}.frozen.json`);
}

/**
 * Read the frozen meta for a cohort. Returns null when the cohort
 * has not yet been frozen (first-time author).
 */
export function loadFreezeMeta(cohort: string, dir: string): CohortFreezeMeta | null {
    const path = freezeMetaPath(cohort, dir);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as CohortFreezeMeta;
}

/**
 * Write a fresh freeze meta for a cohort. Used by the
 * `freeze-cohort.ts` CLI (operator-run, not auto-invoked by tests).
 */
export function writeFreezeMeta(cohort: string, dir: string, cases: ConversationCase[], note?: string): CohortFreezeMeta {
    const meta: CohortFreezeMeta = {
        cohort,
        frozenAt: new Date().toISOString(),
        caseCount: cases.length,
        sourceHash: computeCohortHash(cases),
        ...(note ? { note } : {}),
    };
    writeFileSync(freezeMetaPath(cohort, dir), JSON.stringify(meta, null, 2) + "\n");
    return meta;
}

export type VerifyResult =
    | { ok: true; meta: CohortFreezeMeta; computedHash: string }
    | { ok: false; reason: "no_freeze_meta"; cohort: string }
    | { ok: false; reason: "hash_mismatch"; expected: string; actual: string; meta: CohortFreezeMeta }
    | { ok: false; reason: "case_count_mismatch"; expected: number; actual: number; meta: CohortFreezeMeta };

/**
 * Verify that the current case set matches the frozen snapshot.
 * Called by the eval-set-freeze test in CI; called by the
 * persona-surrogate runner before it executes (refuses to score
 * against an un-frozen cohort).
 */
export function verifyCohortFrozen(
    cohort: string,
    dir: string,
    cases: ConversationCase[],
): VerifyResult {
    const meta = loadFreezeMeta(cohort, dir);
    if (!meta) return { ok: false, reason: "no_freeze_meta", cohort };
    if (meta.caseCount !== cases.length) {
        return { ok: false, reason: "case_count_mismatch", expected: meta.caseCount, actual: cases.length, meta };
    }
    const computed = computeCohortHash(cases);
    if (computed !== meta.sourceHash) {
        return { ok: false, reason: "hash_mismatch", expected: meta.sourceHash, actual: computed, meta };
    }
    return { ok: true, meta, computedHash: computed };
}
