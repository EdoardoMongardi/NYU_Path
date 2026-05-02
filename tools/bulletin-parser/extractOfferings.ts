#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 12.8 Task 3 — Offerings extractor (deterministic, no LLM)
// ============================================================
//
// PURPOSE
// -------
// Walks data/bulletin-raw/courses/<dept>_<suffix>/_index.md for the 8
// in-scope undergrad suffixes (ua, ub, ue, uf, uh, ut, uy, shu),
// regex-splits each dept page into per-course chunks at the bulletin's
// heading pattern, extracts the "Typically offered" line and parses it
// into a Term[]. Emits a structured map to:
//
//     packages/engine/src/data/courses-offerings.json
//
// Pure data work. NO LLM calls. NO API key usage. The prereqs half of
// Phase 12.8 (Task 4) is the LLM piece; this file is the regex piece.
//
// HOW TO RUN
// ----------
//     pnpm tsx tools/bulletin-parser/extractOfferings.ts
//   or:
//     npx tsx tools/bulletin-parser/extractOfferings.ts
//
// OUTPUT KEY FORMAT
// -----------------
// Output keys use the unpadded course-id form, matching the bulletin
// heading exactly: "CSCI-UA 2", "MATH-UA 121", "INTM-SHU 140T-A".
//
// Phase 13's solver looks up offerings by this form. (The 16 curated
// prereqs.json entries' top-level `course` field also uses the unpadded
// form, so this stays consistent. Inner prereqGroups[].courses zero-pads
// to 4 digits — that's a prereqs-only convention; offerings uses the
// bulletin's natural form.)
//
// HEADING / TYPICALLY-OFFERED FORMAT (verified 2026-05-02)
// --------------------------------------------------------
// Course-heading delimiter: "**<COURSE-ID>**" at start-of-line, where
// COURSE-ID = "<DEPT>-<SUFFIX> <NUM[+TAIL]>". Confirmed against 5 sample
// dept pages: csci_ua, math_ua, acct_ub, cs_uy, csci_shu. Pattern is
// "**ID**  **TITLE**  **(N Credits)**" (two-space-separated bold
// segments). Some headings have variable-credit forms like
// "(1-4 Credits)" (e.g. CS-UY 394X) — the heading regex only anchors on
// the leading "**ID**" so credit/title formatting variants don't break
// the split.
//
// "Typically offered" line format:
//
//     **Typically offered* Fall, Spring, and Summer terms*
//
// That's NOT a typo. The bulletin emits `**` to open bold, then `*` to
// start an italic-inside-bold span, then the term descriptors, then `*`
// to close italic. Visible result is bold "Typically offered" followed
// by italic terms. Variants observed in-corpus:
//   - "**Typically offered* Fall, Spring, and Summer terms*"
//   - "**Typically offered* Fall and Spring*"
//   - "**Typically offered* Fall*"
//   - "**Typically offered* Spring*"
//   - "**Typically offered* occasionally*"
//   - "*Typically offered Fall*"  (some pages, pure italic)
//   - (no line at all — fall back to default; see below)
//
// DEFAULT WHEN NO LINE
// --------------------
// termsOffered = ["fall", "spring"], inferred: true. Most undergraduate
// CAS courses run fall+spring; this is the safest assumption when the
// bulletin is silent. The `inferred` flag lets downstream consumers (the
// Phase 13 solver, eval pipelines) treat inferred rows differently.
//
// 27 STUB DEPT DIRS — SKIPPED
// ----------------------------
// Phase 12.7's verifier (verify_coverage.py) flagged 27 dept dirs whose
// _index.md exists but contains no parseable course-heading lines
// (header + title only). They are depts the bulletin still indexes but
// no longer publishes course content for. We skip them so empty rows
// don't dilute downstream coverage validation. The verifier's STUBS
// section is the authoritative source for this list.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

// resolve repo root from this file's location (tools/bulletin-parser/...)
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const BULLETIN_DIR = join(REPO_ROOT, "data/bulletin-raw/courses");
const OUTPUT_PATH = join(
    REPO_ROOT,
    "packages/engine/src/data/courses-offerings.json",
);

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

type Term = "fall" | "spring" | "summer" | "january";

interface OfferingEntry {
    termsOffered: Term[];
    /** Original "Typically offered ..." line for audit. Empty if no line found and `inferred` is true. */
    rawLine: string;
    /** True when no offering line was present (or had no parseable terms) and we used the default. */
    inferred: boolean;
}

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

const IN_SCOPE_SUFFIXES = [
    "ua",
    "ub",
    "ue",
    "uf",
    "uh",
    "ut",
    "uy",
    "shu",
] as const;

// Phase 12.7 verifier output (verify_coverage.py STUBS section): dept
// dirs whose _index.md has no parseable course content. AUTHORITATIVE
// SOURCE — do not edit by hand. If the bulletin gets re-scraped and the
// stub set changes, re-run verify_coverage.py and update this list.
const STUB_DEPT_DIRS = new Set<string>([
    // UF (Gallatin)
    "cwp_uf",
    "livn_uf",
    // UH (Abu Dhabi)
    "afrst_uh",
    "ah_uh",
    "arabm_uh",
    "desgn_uh",
    "lead_uh",
    "mcc_uh",
    "musst_uh",
    // UT (Tisch)
    "ispec_ut",
    // UY (Tandon)
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
    // SHU (Shanghai)
    "ccsc_shu",
    "ciii_shu",
    "engl_shu",
    "lwso_shu",
    "mcc_shu",
    "rels_shu",
]);

// Dept-dir name matcher: lowercase, may contain digits, then _<suffix>.
// (Phase 12.7's recognizer was: ^[a-z][a-z0-9]*_(ua|ub|ue|uf|uh|ut|uy|shu)$)
const DEPT_DIR_RE = new RegExp(
    `^([a-z][a-z0-9]*)_(${IN_SCOPE_SUFFIXES.join("|")})$`,
);

// Course-heading delimiter: "**<COURSE-ID>**" at the start of a line.
// COURSE-ID = "<DEPT>-<SUFFIX> <NUM[+TAIL]>" — the tail captures
// multi-segment numbers like "140T-A". \S+ stops at whitespace, which
// is fine because the heading uses two spaces between bold segments.
//
// Multiline + global so we can iterate matches and use match.index for
// chunk boundaries.
const HEADING_RE =
    /^\*\*([A-Z][A-Z0-9]*-(?:UA|UB|UE|UF|UH|UT|UY|SHU) \S+)\*\*/gm;

// "Typically offered" line. The bulletin mixes bold+italic
// (e.g. "**Typically offered* Fall, Spring, and Summer terms*"), and a
// minority of pages use a pure-italic form ("*Typically offered Fall*").
// The regex tolerates either by allowing 1-2 leading asterisks, an
// optional trailing asterisk after "offered", and 1-2 closing asterisks.
// Captured group 1 is the term descriptors.
const TYPICAL_RE =
    /\*{1,2}\s*Typically\s+offered\*?\s*([^*\n]+?)\s*\*{1,2}/i;

// ----------------------------------------------------------------
// Term parser
// ----------------------------------------------------------------

function parseTerms(text: string): Term[] {
    const t = text.toLowerCase();

    // "not typically offered" — explicit negative; defer to default and
    // mark inferred (caller checks for empty array).
    if (/\bnot\s+typically\s+offered\b/.test(t)) return [];

    // "all terms" / "every term" — full year coverage. Bulletin uses
    // both phrasings; treat them as fall+spring+summer+january.
    if (/\ball\s+terms\b/.test(t) || /\bevery\s+terms?\b/.test(t)) {
        return ["fall", "spring", "summer", "january"];
    }

    // "every year" / "annually" — yearly cadence with no specific term
    // breakdown. Treat as fall+spring (the standard academic year), as
    // the bulletin uses this phrasing for courses that run both
    // semesters but doesn't itemize them.
    if (/\bevery\s+years?\b/.test(t) || /\bannually\b/.test(t)) {
        return ["fall", "spring"];
    }

    // Per-term keyword scan. This is the dominant path — most lines
    // are explicit lists like "Fall, Spring, and Summer terms".
    const out: Term[] = [];
    if (/\bfall\b/.test(t)) out.push("fall");
    if (/\bspring\b/.test(t)) out.push("spring");
    if (/\bsummer\b/.test(t)) out.push("summer");
    if (/\bjanuary\b|\bj-?term\b|\bintersession\b/.test(t)) {
        out.push("january");
    }
    return out;
}

// ----------------------------------------------------------------
// Chunk splitter
// ----------------------------------------------------------------

function splitChunks(
    content: string,
): Array<{ courseId: string; body: string }> {
    const chunks: Array<{ courseId: string; body: string }> = [];
    // Reset lastIndex on the global regex before iterating (matchAll
    // returns a fresh iterator, but being explicit avoids surprises).
    HEADING_RE.lastIndex = 0;
    const matches = [...content.matchAll(HEADING_RE)];
    for (let i = 0; i < matches.length; i++) {
        const start = matches[i]!.index!;
        const end =
            i + 1 < matches.length ? matches[i + 1]!.index! : content.length;
        chunks.push({
            courseId: matches[i]![1]!,
            body: content.slice(start, end),
        });
    }
    return chunks;
}

// ----------------------------------------------------------------
// Per-chunk extractor
// ----------------------------------------------------------------

function extractOffering(chunkBody: string): {
    terms: Term[];
    raw: string;
    inferred: boolean;
} {
    const m = TYPICAL_RE.exec(chunkBody);
    if (!m) {
        return { terms: ["fall", "spring"], raw: "", inferred: true };
    }
    const terms = parseTerms(m[1]!);
    if (terms.length === 0) {
        // Line was present but had no recognizable term word
        // (e.g. "occasionally"). Fall back to default; preserve raw for
        // audit so the inferred% diagnostic is debuggable.
        return { terms: ["fall", "spring"], raw: m[0]!, inferred: true };
    }
    return { terms, raw: m[0]!, inferred: false };
}

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

function main(): void {
    const out: Record<string, OfferingEntry> = {};
    let totalCourses = 0;
    let inferredCount = 0;
    let skippedStubs = 0;
    let skippedOutOfScope = 0;
    let deptsRead = 0;

    const dirs = readdirSync(BULLETIN_DIR, { withFileTypes: true }).filter(
        (d) => d.isDirectory(),
    );

    for (const dir of dirs) {
        if (STUB_DEPT_DIRS.has(dir.name)) {
            skippedStubs++;
            continue;
        }
        const m = DEPT_DIR_RE.exec(dir.name);
        if (!m) {
            // Out-of-scope suffix (e.g. _ga, _ug, _md, _uc, ...).
            skippedOutOfScope++;
            continue;
        }
        const indexPath = join(BULLETIN_DIR, dir.name, "_index.md");
        let content = "";
        try {
            content = readFileSync(indexPath, "utf8");
        } catch {
            // _index.md missing for this dept dir — skip silently.
            continue;
        }
        deptsRead++;
        const chunks = splitChunks(content);
        for (const chunk of chunks) {
            const off = extractOffering(chunk.body);
            // Overwrite is fine; bulletin should not list the same
            // course twice in one dept page.
            out[chunk.courseId] = {
                termsOffered: off.terms,
                rawLine: off.raw,
                inferred: off.inferred,
            };
            totalCourses++;
            if (off.inferred) inferredCount++;
        }
    }

    writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n");
    const inferredPct =
        totalCourses === 0 ? 0 : (inferredCount / totalCourses) * 100;
    console.log(`Wrote ${OUTPUT_PATH}`);
    console.log(`  Dept _index.md files read: ${deptsRead}`);
    console.log(`  Total courses: ${totalCourses}`);
    console.log(
        `  Inferred (default fall+spring): ${inferredCount} (${inferredPct.toFixed(1)}%)`,
    );
    console.log(
        `  Stub dept dirs skipped: ${skippedStubs} (Phase 12.7 verifier authoritative)`,
    );
    console.log(`  Out-of-scope dept dirs skipped: ${skippedOutOfScope}`);
}

main();
