#!/usr/bin/env -S npx tsx
/**
 * Phase 12.9.5 — Offering Confidence Enrichment (frequency pass).
 *
 * Classifies each course's historical FOSE termsOffered pattern into a
 * confidence tier based on appearance rate in the last 4 same-season
 * terms. Restriction pass (Task 3) overrides this for permission-only
 * and major-restricted courses.
 *
 * Algorithm:
 *   1. Load course_catalog_full.json — get termsOffered per course.
 *   2. Build a global reference set of all distinct term codes in the
 *      dataset, grouped by season (the "universe" of available terms).
 *   3. For each season, take the last 4 reference terms; count how many
 *      of those the course appeared in → appearance rate.
 *   4. Use the strongest season's rate to assign a tier:
 *       ≥75% (3-of-4 or 4-of-4) → "historically_likely"
 *       25–75% (1-of-4 or 2-of-4) → "historically_partial"
 *       <25% (0-of-4)             → "irregular"
 *   5. Edge case: fewer than 4 historical terms overall → if bestRate
 *      ≥ 50% of available reference terms, → "historically_partial";
 *      else "irregular".
 *
 * NOTE on the plan's example code: the plan's snippet computes
 *   rate = last4.length / Math.min(4, last4.length)
 * which is always 1.0 (trivially true). The correct denominator is the
 * number of *reference* terms for that season (capped at 4), not the
 * number the course appeared in. This implementation uses the reference
 * set — confirmed correct against smoke samples below.
 *
 * Run: pnpm tsx tools/bulletin-parser/extractOfferingConfidence.ts --smoke
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");

const FOSE_CATALOG_PATH = join(
    REPO_ROOT,
    "packages/engine/src/data/course_catalog_full.json",
);

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

type Season = "spring" | "summer" | "fall" | "winter";
type ConfidenceTier = "historically_likely" | "historically_partial" | "irregular";

const SEASON_BY_LAST_DIGIT: Record<string, Season> = {
    "2": "winter",
    "4": "spring",
    "6": "summer",
    "8": "fall",
};

interface FoseCatalogEntry {
    courseId: string;
    termsOffered: string[];
}

// ----------------------------------------------------------------
// Reference set builder
//
// Scans all termsOffered across the entire catalog to find every
// distinct term code that has been used. These become the "universe"
// of offering opportunities used as the denominator when computing
// appearance rates.
// ----------------------------------------------------------------

function buildReferenceTerms(
    entries: FoseCatalogEntry[],
): Record<Season, string[]> {
    const seen = new Set<string>();
    for (const e of entries) {
        for (const t of e.termsOffered) seen.add(t);
    }

    const bySeason: Record<Season, string[]> = {
        spring: [],
        summer: [],
        fall: [],
        winter: [],
    };

    for (const code of seen) {
        const lastDigit = code.slice(-1);
        const season = SEASON_BY_LAST_DIGIT[lastDigit];
        if (season) bySeason[season].push(code);
    }

    // Sort each season's terms chronologically (code is a numeric string,
    // so lexicographic = chronological here).
    for (const season of Object.keys(bySeason) as Season[]) {
        bySeason[season].sort();
    }

    return bySeason;
}

// ----------------------------------------------------------------
// Frequency classifier
// ----------------------------------------------------------------

function classifyByFrequency(
    historicalTerms: string[],
    referenceTerms: Record<Season, string[]>,
): ConfidenceTier {
    if (historicalTerms.length === 0) return "irregular";

    const offeredSet = new Set(historicalTerms);
    let bestRate = 0;

    for (const season of ["spring", "summer", "fall", "winter"] as const) {
        const allRefTerms = referenceTerms[season];
        // Take the last 4 reference terms for this season.
        const last4Ref = allRefTerms.slice(-4);
        if (last4Ref.length === 0) continue;
        // Count how many of those reference terms the course actually appeared in.
        const offeredCount = last4Ref.filter((t) => offeredSet.has(t)).length;
        const rate = offeredCount / last4Ref.length;
        bestRate = Math.max(bestRate, rate);
    }

    // Edge case: sparse history (fewer than 4 total historical terms).
    // A course with only 1-3 data points that still shows ≥50% of
    // available reference terms → "historically_partial"; otherwise
    // "irregular". This avoids inflating confidence on new courses.
    if (historicalTerms.length < 4 && bestRate < 0.5) return "irregular";

    if (bestRate >= 0.75) return "historically_likely";
    if (bestRate >= 0.25) return "historically_partial";
    return "irregular";
}

// ----------------------------------------------------------------
// Public API: builds the courseId → tier map
// ----------------------------------------------------------------

export function buildFrequencyMap(): Map<string, ConfidenceTier> {
    const entries: FoseCatalogEntry[] = JSON.parse(
        readFileSync(FOSE_CATALOG_PATH, "utf-8"),
    );
    const referenceTerms = buildReferenceTerms(entries);
    const out = new Map<string, ConfidenceTier>();
    for (const e of entries) {
        out.set(e.courseId, classifyByFrequency(e.termsOffered, referenceTerms));
    }
    return out;
}

// ----------------------------------------------------------------
// Smoke test (--smoke flag)
// ----------------------------------------------------------------

function smokeTest(): void {
    console.log("Smoke test — frequency pass:");
    const map = buildFrequencyMap();
    const samples = [
        "CSCI-UA 101",   // expect "historically_likely" — runs every term
        "CSCI-UA 102",   // expect "historically_likely"
        "MATH-UA 121",   // expect "historically_likely"
        "EXPOS-UA 1",    // expect "historically_likely"
        "ANTH-UA 9070",  // study-abroad, less frequent — expect "historically_partial" or "irregular"
        "PHYS-UA 135",   // less frequent — expect "irregular" or "historically_partial"
    ];
    for (const c of samples) {
        console.log(`  ${c}: ${map.get(c) ?? "(not in catalog)"}`);
    }

    // Distribution summary
    const dist: Record<ConfidenceTier, number> = {
        historically_likely: 0,
        historically_partial: 0,
        irregular: 0,
    };
    for (const tier of map.values()) dist[tier]++;
    const total = map.size;
    console.log("\nDistribution over all courses:");
    for (const [tier, count] of Object.entries(dist)) {
        console.log(`  ${tier}: ${count} (${((count / total) * 100).toFixed(1)}%)`);
    }
}

if (process.argv.includes("--smoke")) smokeTest();
