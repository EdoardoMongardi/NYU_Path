#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 12.8 Task 5 — validatePrereqs.ts (standalone CLI)
// ============================================================
//
// Invariant locked by this script
// -------------------------------
// The 16 curated prereq entries (the parser's "ground truth"
// regression set) MUST be byte-equivalent under normalization to
// the snapshot at `/tmp/prereqs.curated.snapshot.json` (or a path
// passed as argv[2]). If the parser is ever re-run, or someone
// hand-edits `packages/engine/src/data/prereqs.json`, anything
// other than a 16/16 MATCH is a parser regression.
//
// Normalization
// -------------
//   - `courses[]` and `notCourses[]` are sorted (set semantics).
//   - `coreqs[]` is sorted (set semantics).
//   - `requiresPetition: false` ≡ unset (defaulted).
//   - Group order is preserved (the curated snapshot's group order
//     is canonical — re-ordering the AND/OR groups would change
//     planner-side semantics if precedence is reinterpreted, so
//     we treat order as load-bearing).
//
// Pure TypeScript: NO LLM calls.
//
// CLI
// ---
//   pnpm tsx tools/bulletin-parser/validatePrereqs.ts [snapshot.json]
//
// Default snapshot path: /tmp/prereqs.curated.snapshot.json
//
// Exit codes
// ----------
//   0 — every snapshot entry matches live prereqs.json under
//       normalization.
//   1 — at least one entry differs (mismatch or missing). The
//       table prints expected vs actual JSON for each MISMATCH so
//       the regression is debuggable in one place.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PrereqGroup {
    type: "AND" | "OR" | "NOT";
    courses?: string[];
    notCourses?: string[];
    requiresPetition?: boolean;
}

interface PrereqEntry {
    course: string;
    prereqGroups: PrereqGroup[];
    coreqs: string[];
    minGrades?: Record<string, string>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PREREQS_PATH = join(
    REPO_ROOT,
    "packages",
    "engine",
    "src",
    "data",
    "prereqs.json"
);
const DEFAULT_SNAPSHOT = "/tmp/prereqs.curated.snapshot.json";

/**
 * Normalize a prereq group:
 *   - Sort `courses[]` (set semantics).
 *   - Sort `notCourses[]` (set semantics) when present, else omit.
 *   - Drop `requiresPetition` when falsy/unset (false ≡ unset).
 *   - Preserve `type`.
 */
function normalizeGroup(g: PrereqGroup): {
    type: "AND" | "OR" | "NOT";
    courses: string[];
    notCourses?: string[];
    requiresPetition?: true;
} {
    const out: ReturnType<typeof normalizeGroup> = {
        type: g.type,
        courses: [...(g.courses ?? [])].sort(),
    };
    if (g.notCourses && g.notCourses.length > 0) {
        out.notCourses = [...g.notCourses].sort();
    }
    if (g.requiresPetition === true) {
        out.requiresPetition = true;
    }
    return out;
}

/**
 * Sort minGrades keys for stable normalization. Empty/missing maps
 * collapse to `undefined` so a snapshot without `minGrades` matches a
 * live entry that also lacks any grade thresholds.
 */
function normalizeMinGrades(
    m: Record<string, string> | undefined,
): Record<string, string> | undefined {
    if (!m) return undefined;
    const keys = Object.keys(m);
    if (keys.length === 0) return undefined;
    const sorted: Record<string, string> = {};
    for (const k of keys.sort()) sorted[k] = m[k];
    return sorted;
}

/**
 * Normalize a prereq entry: normalize each group, sort coreqs, sort
 * minGrades keys. Group order is preserved (load-bearing for AND/OR
 * precedence).
 */
function normalizeEntry(e: PrereqEntry): {
    course: string;
    prereqGroups: ReturnType<typeof normalizeGroup>[];
    coreqs: string[];
    minGrades?: Record<string, string>;
} {
    const out: {
        course: string;
        prereqGroups: ReturnType<typeof normalizeGroup>[];
        coreqs: string[];
        minGrades?: Record<string, string>;
    } = {
        course: e.course,
        prereqGroups: (e.prereqGroups ?? []).map(normalizeGroup),
        coreqs: [...(e.coreqs ?? [])].sort(),
    };
    const mg = normalizeMinGrades(e.minGrades);
    if (mg) out.minGrades = mg;
    return out;
}

function entriesEqual(a: PrereqEntry, b: PrereqEntry): boolean {
    return (
        JSON.stringify(normalizeEntry(a)) === JSON.stringify(normalizeEntry(b))
    );
}

function truncate(s: string, max = 600): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + "...[truncated]";
}

function main(): void {
    const snapshotPath = process.argv[2] ?? DEFAULT_SNAPSHOT;

    if (!existsSync(PREREQS_PATH)) {
        console.error(`ERROR: live prereqs.json not found at ${PREREQS_PATH}`);
        process.exit(2);
    }
    if (!existsSync(snapshotPath)) {
        console.error(`ERROR: snapshot not found at ${snapshotPath}`);
        process.exit(2);
    }

    const live = JSON.parse(readFileSync(PREREQS_PATH, "utf-8")) as PrereqEntry[];
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as PrereqEntry[];

    const liveByCourse = new Map<string, PrereqEntry>();
    for (const e of live) liveByCourse.set(e.course, e);

    console.log("");
    console.log(`validatePrereqs.ts — ${snapshot.length} curated entries vs live`);
    console.log(`  live:     ${PREREQS_PATH}`);
    console.log(`  snapshot: ${snapshotPath}`);
    console.log("");

    let matches = 0;
    let mismatches = 0;
    let missing = 0;
    const mismatchDetails: Array<{
        course: string;
        expected: string;
        actual: string;
    }> = [];

    // Per-entry MATCH/MISMATCH table.
    const widthCourse = Math.max(
        ...snapshot.map((e) => e.course.length),
        "course".length
    );
    const header = `  ${"#".padStart(3)}  ${"course".padEnd(widthCourse)}  status`;
    console.log(header);
    console.log("  " + "-".repeat(header.length - 2));

    snapshot.forEach((expected, idx) => {
        const actual = liveByCourse.get(expected.course);
        const idxStr = String(idx + 1).padStart(3);
        const courseStr = expected.course.padEnd(widthCourse);

        if (!actual) {
            console.log(`  ${idxStr}  ${courseStr}  MISSING`);
            missing++;
            mismatchDetails.push({
                course: expected.course,
                expected: JSON.stringify(normalizeEntry(expected), null, 2),
                actual: "<not present in live prereqs.json>",
            });
            return;
        }

        if (entriesEqual(expected, actual)) {
            console.log(`  ${idxStr}  ${courseStr}  MATCH`);
            matches++;
        } else {
            console.log(`  ${idxStr}  ${courseStr}  MISMATCH`);
            mismatches++;
            mismatchDetails.push({
                course: expected.course,
                expected: JSON.stringify(normalizeEntry(expected), null, 2),
                actual: JSON.stringify(normalizeEntry(actual), null, 2),
            });
        }
    });

    console.log("");
    console.log(
        `  summary: ${matches} match, ${mismatches} mismatch, ${missing} missing of ${snapshot.length}`
    );

    // Per-mismatch detail block.
    if (mismatchDetails.length > 0) {
        console.log("");
        console.log("=== MISMATCH DETAILS ===");
        for (const d of mismatchDetails) {
            console.log("");
            console.log(`---- ${d.course} ----`);
            console.log("expected (snapshot, normalized):");
            console.log(truncate(d.expected));
            console.log("actual (live, normalized):");
            console.log(truncate(d.actual));
        }
    }

    if (matches === snapshot.length) {
        console.log("");
        console.log("OK — all curated entries match snapshot under normalization.");
        process.exit(0);
    } else {
        console.log("");
        console.log(
            "FAIL — curated/snapshot drift detected. Investigate before proceeding."
        );
        process.exit(1);
    }
}

main();
