#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 13 prereq-fix — grade-threshold extractor (regex-only)
// ============================================================
//
// REVERSES Decision #4
// --------------------
// Decision #4 previously said: "trust DPR; the prereq solver
// checks `coursesTaken[i]` membership but does NOT verify the
// student's grade against the bulletin's threshold." That gamble
// is wrong. The bulletin actually annotates ~210 prereq pairings
// with explicit minimum grades:
//
//   C   158  (75%)   — DPR usually flags sub-C as unmet, low risk
//   D    39  (19%)   — passing = D, basically free
//   C-    9  ( 4%)
//   B     2  ( 1%)   — silent-bug risk: solver could green-light
//   B+    1  (~0.5%)   downstream courses the student cannot
//   A-    1  (~0.5%)   actually register for
//
// This script extracts those annotations from the bulletin
// markdown and writes them into prereqs.json as an ENTRY-LEVEL
// `minGrades: Record<courseId, grade>` map (sibling of
// `prereqGroups` and `coreqs`). The PrereqGroup shape stays
// unchanged — additive only. Phase 13's solver will look up the
// student's grade for the matched prereq and call
// `meetsGradeThreshold()` from packages/engine/src/dpr/gradeComparison.ts.
//
// SCOPE
// -----
// Walks `data/bulletin-raw/courses/<dept>_<sfx>/_index.md` for
// the same 7 in-scope suffixes used by extractPrereqs.ts (UA,
// UB, UE, UH, UT, UY, SHU) and skips the same 25 stub
// directories. Per-course chunking uses the same regex
// (`^\*\*([A-Z][A-Z0-9]*-... \S+)\*\*`).
//
// PATTERNS
// --------
// 1. Trailing form (most common):
//      [CSCI-UA 102](...) with a Minimum Grade of C
//      ECE-UY 2024 with a Minimum Grade of C-
//      [CE-UY 2112] with a grade of C or better          (no "Minimum")
//      [CSCI-UA 201] with a Grade of C or Higher          (no "Minimum"; "or higher" tail)
//
// 2. Prefix form (less common):
//      Minimum grade of A- in [MATH-UA 122]
//      A grade of C or better in MA-UY 1022               (no "Minimum")
//
// Both forms accept an optional "Minimum" prefix and an optional
// "or better/higher/above" tail (which we ignore — the threshold
// letter is what counts). Case-insensitive on "Minimum"/"Grade".
// Course IDs are zero-padded to 4 digits (Decision A) so the keys
// align with `prereqGroups[].courses[]`.
//
// Limitation (acknowledged): the prefix form's "in <COURSE>" clause
// can be followed by an OR-chain of additional courses that all
// inherit the same grade ("A grade of C or better in [X] or [Y] or [Z]").
// We capture only the first courseId in such chains; the few entries
// that depend on this stay unaugmented and would need hand-curation
// if the threshold matters for those particular courses.
//
// VALIDATION
// ----------
// Every key in any `minGrades` map should appear in at least one
// of that entry's `prereqGroups[].courses[]`. Mismatches surface
// as warnings (regex picked up a course the LLM didn't include
// — usually means a scope difference, not a regex bug). The script
// does NOT fail on warnings — they're informational.
//
// USAGE
// -----
//   pnpm tsx tools/bulletin-parser/extractGradeThresholds.ts
// ============================================================

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");

const BULLETIN_DIR = join(REPO_ROOT, "data/bulletin-raw/courses");
const PREREQS_JSON_PATH = join(
    REPO_ROOT,
    "packages/engine/src/data/prereqs.json",
);

const IN_SCOPE_SUFFIXES = ["ua", "ub", "ue", "uh", "ut", "uy", "shu"] as const;

// Mirrors extractPrereqs.ts STUB_DEPT_DIRS exactly.
const STUB_DEPT_DIRS = new Set<string>([
    "afrst_uh",
    "ah_uh",
    "arabm_uh",
    "desgn_uh",
    "lead_uh",
    "mcc_uh",
    "musst_uh",
    "ispec_ut",
    "ah_uy",
    "an_uy",
    "ec_uy",
    "fl_uy",
    "gs_uy",
    "hu_uy",
    "la_uy",
    "ls_uy",
    "mu_uy",
    "pl_uy",
    "rsk_uy",
    "ccsc_shu",
    "ciii_shu",
    "engl_shu",
    "lwso_shu",
    "mcc_shu",
    "rels_shu",
]);

const SUFFIX_GROUP = "(?:UA|UB|UE|UH|UT|UY|SHU)";

// Grade-letter pattern: tolerates optional whitespace between letter and
// sign (the bulletin occasionally writes "B + " or "C - " with a space).
const GRADE_LETTER = `[A-Z](?:\\s*[+\\-])?`;

// Trailing form: <courseId> [...up to 80 chars...] with a [Minimum] [Gg]rade(s) of <X> [or better/higher/above]
const TRAILING_GRADE_RE = new RegExp(
    `\\[?([A-Z][A-Z0-9]*-${SUFFIX_GROUP})\\s+(\\d+[A-Z0-9]*)\\]?(?:\\([^)]*\\))?[^\\n\\[\\]]{0,80}?with a (?:[Mm]inimum )?[Gg]rades? of\\s+(${GRADE_LETTER})(?:\\s+or\\s+(?:better|higher|above))?`,
    "g",
);

// Prefix marker only (no course capture here). After a match, the
// surrounding logic walks forward through the next ~250 chars and
// applies the grade to every in-scope courseId encountered until a
// hard delimiter (`.`, `;`, `\n`, " and ", " with ") — this captures
// "A grade of C or better in (X or Y) and Z" patterns where the chain
// inside parens (and inheritance across "or") all share the threshold.
const PREFIX_MARKER_RE = new RegExp(
    `(?:^|[\\s.,;(])(?:[Aa]\\s+)?(?:[Mm]inimum\\s+)?[Gg]rades? of\\s+(${GRADE_LETTER})(?:\\s+or\\s+(?:better|higher|above))?\\s+in\\s+`,
    "g",
);

// Course-ID scanner used by the prefix-context loop.
const COURSE_ID_SCAN = new RegExp(
    `\\[?([A-Z][A-Z0-9]*-${SUFFIX_GROUP})\\s+(\\d+[A-Z0-9]*)\\]?`,
    "g",
);

// Hard delimiters that terminate a prefix-context window.
const PREFIX_TERMINATORS = /[\.;\n]|\s+and\s+a\s+grade|\s+with\s+/i;

const PREREQ_LINE_RE = /\*\*Prerequisites?:\*\*\s*(.+?)(?=\n\n|\n\*\*|$)/is;
const COURSE_HEADING_RE = /^\*\*([A-Z][A-Z0-9]*-[A-Z]+\s+\S+)\*\*/gm;

const VALID_GRADES = new Set([
    "A", "A-", "B+", "B", "B-",
    "C+", "C", "C-", "D+", "D",
]);

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

interface PrereqGroup {
    type: "AND" | "OR" | "NOT";
    courses: string[];
    notCourses?: string[];
    requiresPetition?: boolean;
}

interface Prerequisite {
    course: string;
    prereqGroups: PrereqGroup[];
    coreqs: string[];
    minGrades?: Record<string, string>;
}

interface OrphanWarning {
    course: string;
    pairedCourseId: string;
    grade: string;
    reason: string;
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Zero-pad numeric course IDs to 4 digits (Decision A consistency
 * with extractPrereqs.ts). Pass through letter-suffixed numbers and
 * already-4-digit numbers unchanged.
 *
 *   "CSCI-UA 102"   → "CSCI-UA 0102"
 *   "MATH-UA 121Q"  → "MATH-UA 0121Q"
 *   "CS-UY 1134"    → "CS-UY 1134"
 */
function zeroPad(dept: string, num: string, suffix: string): string {
    return `${dept} ${num.padStart(4, "0")}${suffix}`;
}

/**
 * Split `<num>[<suffix>]` apart so the digits can be padded
 * independently. Returns `[digits, suffix]`.
 */
function splitNumberSuffix(s: string): [string, string] {
    const m = /^(\d+)([A-Z0-9-]*)$/.exec(s);
    if (!m) return [s, ""];
    return [m[1], m[2]];
}

function extractPrereqLine(chunk: string): string | null {
    const m = PREREQ_LINE_RE.exec(chunk);
    if (!m) return null;
    return m[1].trim();
}

interface CourseChunk {
    courseId: string;
    chunk: string;
}

function extractCourseChunks(filePath: string): CourseChunk[] {
    const raw = readFileSync(filePath, "utf-8");
    const chunks: CourseChunk[] = [];
    const matches: Array<{ courseId: string; idx: number }> = [];
    // Reset regex (it's `g`-flagged so state persists across calls).
    COURSE_HEADING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COURSE_HEADING_RE.exec(raw)) !== null) {
        matches.push({ courseId: m[1], idx: m.index });
    }
    for (let i = 0; i < matches.length; i++) {
        const startIdx = matches[i].idx;
        const endIdx = i + 1 < matches.length ? matches[i + 1].idx : raw.length;
        chunks.push({
            courseId: matches[i].courseId,
            chunk: raw.substring(startIdx, endIdx),
        });
    }
    return chunks;
}

/**
 * Extract `{paddedCourseId: grade}` pairings from a single prereq
 * line. Both trailing and prefix patterns are tried; later writes
 * win on collision (extremely rare — a single line both prefix-
 * and trailing-pairing the same course).
 */
function normalizeGrade(raw: string): string | null {
    // Strip whitespace inside the grade ("B + " → "B+") and uppercase.
    const g = raw.replace(/\s+/g, "").toUpperCase();
    return VALID_GRADES.has(g) ? g : null;
}

function extractPairings(prereqLine: string): Record<string, string> {
    const out: Record<string, string> = {};

    // Trailing form
    TRAILING_GRADE_RE.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = TRAILING_GRADE_RE.exec(prereqLine)) !== null) {
        const dept = tm[1];
        const numWithSuffix = tm[2];
        const grade = normalizeGrade(tm[3]);
        if (!grade) continue;
        const [num, sfx] = splitNumberSuffix(numWithSuffix);
        out[zeroPad(dept, num, sfx)] = grade;
    }

    // Prefix-context loop: locate every "<grade> in" marker, then walk
    // forward applying the grade to every in-scope courseId until a hard
    // delimiter. Captures "A grade of C or better in (X or Y) and Z"
    // patterns where parenthesized chains and OR-chains share a threshold.
    PREFIX_MARKER_RE.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = PREFIX_MARKER_RE.exec(prereqLine)) !== null) {
        const grade = normalizeGrade(pm[1]);
        if (!grade) continue;
        const windowStart = pm.index + pm[0].length;
        const window = prereqLine.slice(windowStart, windowStart + 250);
        const termMatch = PREFIX_TERMINATORS.exec(window);
        const scope = termMatch
            ? window.slice(0, termMatch.index)
            : window;
        COURSE_ID_SCAN.lastIndex = 0;
        let cm: RegExpExecArray | null;
        while ((cm = COURSE_ID_SCAN.exec(scope)) !== null) {
            const dept = cm[1];
            const numWithSuffix = cm[2];
            const [num, sfx] = splitNumberSuffix(numWithSuffix);
            const padded = zeroPad(dept, num, sfx);
            // Don't overwrite a more-specific trailing-form pairing.
            if (!(padded in out)) out[padded] = grade;
        }
    }

    return out;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

function main(): void {
    // 1. Walk in-scope bulletin dirs and build courseId → pairings.
    const allPairings = new Map<string, Record<string, string>>();

    const dirs = readdirSync(BULLETIN_DIR).sort();
    for (const d of dirs) {
        const isInScope = IN_SCOPE_SUFFIXES.some((sfx) => d.endsWith(`_${sfx}`));
        if (!isInScope) continue;
        if (STUB_DEPT_DIRS.has(d)) continue;
        const filePath = join(BULLETIN_DIR, d, "_index.md");
        if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;

        const chunks = extractCourseChunks(filePath);
        for (const { courseId, chunk } of chunks) {
            const prereqLine = extractPrereqLine(chunk);
            if (!prereqLine) continue;
            const pairings = extractPairings(prereqLine);
            if (Object.keys(pairings).length === 0) continue;
            allPairings.set(courseId, pairings);
        }
    }

    // 2. Load existing prereqs.json and patch each entry.
    const prereqs = JSON.parse(
        readFileSync(PREREQS_JSON_PATH, "utf-8"),
    ) as Prerequisite[];

    let augmented = 0;
    let totalPairings = 0;
    const perGrade: Record<string, number> = {};
    const orphanWarnings: OrphanWarning[] = [];

    for (const entry of prereqs) {
        const pairings = allPairings.get(entry.course);
        if (!pairings || Object.keys(pairings).length === 0) {
            // No grade thresholds → leave entry untouched.
            // (If a prior `minGrades` slipped in from a previous run,
            // explicitly remove it to keep the file canonical.)
            if ("minGrades" in entry) delete entry.minGrades;
            continue;
        }

        // Validate: every key should appear in at least one
        // prereqGroups[].courses[]. Orphans → warn (don't drop —
        // they're still real bulletin info; the LLM may have
        // dropped a course we want to record).
        const knownCourses = new Set<string>();
        for (const g of entry.prereqGroups) {
            for (const c of g.courses ?? []) knownCourses.add(c);
            for (const c of g.notCourses ?? []) knownCourses.add(c);
        }

        const cleaned: Record<string, string> = {};
        for (const [cid, grade] of Object.entries(pairings)) {
            if (!knownCourses.has(cid)) {
                orphanWarnings.push({
                    course: entry.course,
                    pairedCourseId: cid,
                    grade,
                    reason: "courseId not in any prereqGroup of this entry",
                });
                // Still record it — the bulletin says so.
            }
            cleaned[cid] = grade;
            perGrade[grade] = (perGrade[grade] ?? 0) + 1;
            totalPairings++;
        }

        entry.minGrades = cleaned;
        augmented++;
    }

    // 3. Write back. Match the existing prereqs.json format
    // (2-space indent, no trailing newline) so the diff stays minimal.
    writeFileSync(
        PREREQS_JSON_PATH,
        JSON.stringify(prereqs, null, 2),
    );

    // 4. Summary.
    console.log("");
    console.log(
        `Augmented ${augmented} entries with minGrades (out of ${prereqs.length} total).`,
    );
    console.log(`Pairings: ${totalPairings} total`);
    const grades = Object.keys(perGrade).sort(
        (a, b) => perGrade[b] - perGrade[a],
    );
    for (const g of grades) {
        console.log(`  ${g}: ${perGrade[g]}`);
    }
    if (orphanWarnings.length > 0) {
        console.log("");
        console.log(
            `WARN: ${orphanWarnings.length} orphan-pairings (regex picked up a course not in this entry's prereqGroups[].courses[]):`,
        );
        for (const w of orphanWarnings.slice(0, 20)) {
            console.log(
                `  ${w.course}: ${w.pairedCourseId} -> ${w.grade}  (${w.reason})`,
            );
        }
        if (orphanWarnings.length > 20) {
            console.log(`  ... and ${orphanWarnings.length - 20} more`);
        }
    }
}

main();
