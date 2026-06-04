#!/usr/bin/env -S npx tsx
// ============================================================
// Step 8d — Course catalog extractor (deterministic, no LLM)
// ============================================================
//
// Walks data/bulletin-raw/courses/<dept>/_index.md, regex-splits each
// dept page into per-course chunks, and extracts the structured fields
// the forward planner needs (title, credits, terms) plus extras recorded
// for future use (grading, repeatable-for-credit). Emits an undergrad-
// scoped Course[] to:
//
//     packages/engine/src/data/courses.json
//
// Pure data work. NO LLM calls. Prereqs are intentionally skipped — they
// are parsed separately into prereqs.json.
//
// HOW TO RUN
//     npx tsx tools/bulletin-parser/extractCourses.ts
// ============================================================

import type { Course } from "@nyupath/shared";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Term = "fall" | "spring" | "summer" | "january";

/** Default catalog-year span for bulletin-sourced courses (no consumers; cosmetic). */
const DEFAULT_CATALOG_YEARS: [string, string] = ["2020", "2026"];

export interface CreditParse {
    credits: number;
    creditsMin: number;
    creditsMax: number;
}

/** Bulletin-derived course fields (the subset the bulletin carries). */
export interface ParsedCourse {
    id: string;
    title: string;
    credits: number;
    creditsMin: number;
    creditsMax: number;
    departments: string[];
    termsOffered: Term[];
    grading?: string;
    repeatableForCredit?: boolean;
}

/**
 * Parse a bulletin credit token ("4", "1-4", "0", "1.5") into the
 * solver's single `credits` (the MAX of a range) plus the min/max bracket.
 */
export function parseCreditRange(raw: string): CreditParse {
    const t = raw.trim();
    const dash = t.indexOf("-");
    if (dash > 0) {
        const lo = parseFloat(t.slice(0, dash));
        const hi = parseFloat(t.slice(dash + 1));
        return { credits: hi, creditsMin: lo, creditsMax: hi };
    }
    const v = parseFloat(t);
    return { credits: v, creditsMin: v, creditsMax: v };
}

/** Derive the department(s) from a course id, e.g. "CSCI-UA 101" → ["CSCI-UA"]. */
export function departmentsFromId(id: string): string[] {
    const subject = id.trim().split(/\s+/)[0];
    return subject ? [subject] : [];
}

/**
 * U-vs-G undergrad scope: undergrad = school segment starts with "U"
 * (UA/UB/UC/UE/UF/UG/UH/UT/UY…) or is "SHU". Excludes graduate (G*) and
 * professional schools (LW/MD/DN/…).
 */
export function isUndergradCourseId(id: string): boolean {
    const subject = id.trim().split(/\s+/)[0] ?? "";
    const school = subject.split("-")[1] ?? "";
    return school === "SHU" || /^U[A-Z0-9]*$/.test(school);
}

/**
 * Complete a ParsedCourse into the engine `Course` shape, defaulting the
 * fields the bulletin doesn't carry. An optional `overlay` (the curated
 * entry from the existing stub) preserves hand-authored
 * crossListed/exclusions/catalogYearsActive; bulletin values still win for
 * title/credits/terms.
 */
export function toCourse(parsed: ParsedCourse, overlay?: Partial<Course>): Course {
    const course: Course = {
        id: parsed.id,
        title: parsed.title,
        credits: parsed.credits,
        departments: parsed.departments,
        crossListed: overlay?.crossListed ?? [],
        exclusions: overlay?.exclusions ?? [],
        termsOffered: parsed.termsOffered,
        catalogYearsActive: overlay?.catalogYearsActive ?? DEFAULT_CATALOG_YEARS,
        creditsMin: parsed.creditsMin,
        creditsMax: parsed.creditsMax,
    };
    if (parsed.grading) course.grading = parsed.grading;
    if (parsed.repeatableForCredit !== undefined) {
        course.repeatableForCredit = parsed.repeatableForCredit;
    }
    return course;
}

/**
 * Union two catalogs: every bulletin course, plus any prior-catalog course
 * whose id the bulletin doesn't carry (so a re-parse never drops a curated
 * course the solver already had). Bulletin entries win on id collision.
 */
export function mergeCatalog(bulletin: Course[], prior: Course[]): Course[] {
    const byId = new Map<string, Course>();
    for (const c of bulletin) byId.set(c.id, c);
    for (const c of prior) if (!byId.has(c.id)) byId.set(c.id, c);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// Course heading: "**<ID>**  **<TITLE>**  **(<credits> Credits)**".
// Subject prefix allows a trailing digit (REAL1, TCHT1); school segment
// is any alnum run (UA/UC/GB/SHU…); the catalog number captures
// multi-segment tails like "140T-A" via \S+.
const COURSE_HEADER_RE =
    /\*\*([A-Z][A-Z0-9]*-[A-Z0-9]+ \S+)\*\*\s+\*\*(.+?)\*\*\s+\*\*\(\s*([0-9.]+(?:\s*-\s*[0-9.]+)?)\s*Credits?\s*\)\*\*/gi;

// "Typically offered" line (bold+italic or pure-italic variants).
const TYPICAL_RE = /\*{1,2}\s*Typically\s+offered\*?\s*([^*\n]+?)\s*\*{1,2}/i;
const GRADING_RE = /\*\*Grading:\*\*\s*([^\n*]+?)\s*(?:\*|\n|$)/i;
const REPEATABLE_RE = /\*\*Repeatable for additional credit:\*\*\s*(Yes|No)/i;

function parseTerms(text: string): Term[] {
    const t = text.toLowerCase();
    if (/\bnot\s+typically\s+offered\b/.test(t)) return [];
    if (/\ball\s+terms\b/.test(t) || /\bevery\s+terms?\b/.test(t)) {
        return ["fall", "spring", "summer", "january"];
    }
    if (/\bevery\s+years?\b/.test(t) || /\bannually\b/.test(t)) {
        return ["fall", "spring"];
    }
    const out: Term[] = [];
    if (/\bfall\b/.test(t)) out.push("fall");
    if (/\bspring\b/.test(t)) out.push("spring");
    if (/\bsummer\b/.test(t)) out.push("summer");
    if (/\bjanuary\b|\bj-?term\b|\bintersession\b/.test(t)) out.push("january");
    return out;
}

/**
 * Split a dept `_index.md` into per-course chunks and extract the
 * bulletin fields for each. Prereqs are intentionally not parsed.
 */
export function parseCoursesFromMarkdown(md: string): ParsedCourse[] {
    COURSE_HEADER_RE.lastIndex = 0;
    const matches = [...md.matchAll(COURSE_HEADER_RE)];
    const out: ParsedCourse[] = [];
    for (let i = 0; i < matches.length; i++) {
        const m = matches[i]!;
        const id = m[1]!.trim();
        const title = m[2]!.trim();
        const { credits, creditsMin, creditsMax } = parseCreditRange(m[3]!);
        const body = md.slice(m.index!, matches[i + 1]?.index ?? md.length);

        const typical = TYPICAL_RE.exec(body);
        // Default to the academic-year fall+spring when no line is present or
        // the line is unparseable ("occasionally"), matching extractOfferings.
        let termsOffered = typical ? parseTerms(typical[1]!) : [];
        if (termsOffered.length === 0) termsOffered = ["fall", "spring"];
        const gradingMatch = GRADING_RE.exec(body);
        const repeatMatch = REPEATABLE_RE.exec(body);

        const course: ParsedCourse = {
            id,
            title,
            credits,
            creditsMin,
            creditsMax,
            departments: departmentsFromId(id),
            termsOffered,
        };
        if (gradingMatch) course.grading = gradingMatch[1]!.trim();
        if (repeatMatch) course.repeatableForCredit = /yes/i.test(repeatMatch[1]!);
        out.push(course);
    }
    return out;
}

// ----------------------------------------------------------------
// Main — glob → parse → undergrad-filter → overlay → write JSON
// ----------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const BULLETIN_DIR = join(REPO_ROOT, "data/bulletin-raw/courses");
const OUTPUT_PATH = join(REPO_ROOT, "packages/engine/src/data/courses.json");

export function main(): void {
    // Overlay source: the existing courses.json. Preserves the handful of
    // curated crossListed/exclusions the bulletin doesn't carry. Idempotent
    // across re-runs (the first run writes them back into the output).
    let prior: Course[] = [];
    try {
        prior = JSON.parse(readFileSync(OUTPUT_PATH, "utf8")) as Course[];
    } catch {
        // No prior catalog on disk — proceed without overlay/union.
    }
    const overlay = new Map<string, Course>();
    for (const c of prior) overlay.set(c.id, c);

    const byId = new Map<string, Course>();
    let deptFiles = 0;
    let parsedCount = 0;
    let keptUndergrad = 0;
    let skippedNonUndergrad = 0;
    let dupes = 0;

    const dirs = readdirSync(BULLETIN_DIR, { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
    );
    for (const dir of dirs) {
        let content = "";
        try {
            content = readFileSync(join(BULLETIN_DIR, dir.name, "_index.md"), "utf8");
        } catch {
            continue; // _index.md missing for this dept dir
        }
        deptFiles++;
        for (const pc of parseCoursesFromMarkdown(content)) {
            parsedCount++;
            if (!isUndergradCourseId(pc.id)) {
                skippedNonUndergrad++;
                continue;
            }
            if (byId.has(pc.id)) {
                dupes++;
                continue;
            }
            byId.set(pc.id, toCourse(pc, overlay.get(pc.id)));
            keptUndergrad++;
        }
    }

    // Union with the prior catalog so a re-parse never drops a curated course
    // (e.g. CSCI-UA 471, CORE-UA *) the bulletin scrape happens to omit.
    const bulletinCourses = [...byId.values()];
    const courses = mergeCatalog(bulletinCourses, prior);
    const carriedStubOnly = courses.length - bulletinCourses.length;
    writeFileSync(OUTPUT_PATH, JSON.stringify(courses, null, 2) + "\n");

    console.log(`Wrote ${OUTPUT_PATH}`);
    console.log(`  Dept _index.md read:    ${deptFiles}`);
    console.log(`  Course headers parsed:  ${parsedCount}`);
    console.log(`  Undergrad kept:         ${keptUndergrad}`);
    console.log(`  Non-undergrad skipped:  ${skippedNonUndergrad} (grad/professional)`);
    console.log(`  Duplicate ids skipped:  ${dupes}`);
    console.log(`  Prior-only carried:     ${carriedStubOnly}`);
    console.log(`  Total written:          ${courses.length}`);
}

// Only run when invoked directly (e.g. `npx tsx tools/bulletin-parser/extractCourses.ts`),
// never on import — the unit test imports this module and main() writes courses.json.
const invokedDirectly =
    !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
