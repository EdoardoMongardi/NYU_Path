// ============================================================
// RAG Corpus Builder — full bulletin walk
// ============================================================
// Assembles the indexed policy corpus from `data/bulletin-raw/`. The
// "nothing hardcoded" pass replaced the hand-authored entry list +
// per-section discovery functions with ONE walk of the whole
// undergraduate bulletin tree (+ the NYU-wide internal-transfer, OGS,
// and nyu trees). Every `.md` page is ingested and auto-tagged by
// school + category from its path, so the agent can RAG-explore any
// undergraduate bulletin page — no curated subset.
//
// Excluded by design: `graduate/` (undergrad scope) and `courses/`
// (the full course catalog is embedded SEPARATELY for search_courses;
// duplicating it here would bloat the policy corpus).
//
// Each chunk is tagged with source title, school (lowercase id), year,
// section heading, and a category. Default catalog year is "2025-2026".
// ============================================================

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkMarkdown, type PolicyChunk } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import { VectorStore } from "./vectorStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const BULLETIN_DIR = join(REPO_ROOT, "data", "bulletin-raw");

type CorpusCategory = "academic_policy" | "admissions" | "program" | "core_curriculum" | "course_catalog" | "school_overview";

interface CorpusEntry {
    school: string;
    source: string;
    /** Path relative to data/bulletin-raw/ */
    relPath: string;
    /** Category tag so the agent + reranker can prefer the right kind
     *  of source (e.g. `program` pages for curriculum questions). */
    category?: CorpusCategory;
}

export interface BuildCorpusOptions {
    catalogYear?: string;
    /** Override the entry list (tests use this to ingest a fixed set). */
    entries?: CorpusEntry[];
    /** Override the bulletin root (tests use a tmp dir). */
    bulletinDir?: string;
    /** When true, throw if any configured entry's file is missing. Default false. */
    strict?: boolean;
    /** When true (default), log skipped entries via console.warn. */
    warnOnSkip?: boolean;
}

// Bulletin `undergraduate/<dir>` → engine school id (matches the
// SchoolConfig / DPR-derived convention). Dirs not listed fall back to
// the dir name with dashes → underscores.
const SCHOOL_DIR_TO_ID: Record<string, string> = {
    "arts-science": "cas",
    "business": "stern",
    "engineering": "tandon",
    "arts": "tisch",
    "culture-education-human-development": "steinhardt",
    "individualized-study": "gallatin",
    "liberal-studies": "liberal_studies",
    "professional-studies": "sps",
    "nursing": "nursing",
    "social-work": "social_work",
    "public-service": "public_service",
    "dentistry": "dentistry",
    "abu-dhabi": "nyuad",
    "shanghai": "shanghai",
};

/** Derive a human-readable program label from a directory slug, e.g.
 *  "mathematics-computer-science-ba" → "CAS Mathematics Computer Science (BA)". */
function programSlugToLabel(slug: string, schoolId: string): string {
    const degreeMatch = slug.match(/-(ba|bs|minor|ma|ms|phd|cert)$/);
    const degree = degreeMatch ? degreeMatch[1] : null;
    const base = degreeMatch ? slug.slice(0, -degreeMatch[0].length) : slug;
    const title = base
        .split("-")
        .map((p) => (p === "and" || p === "of" || p === "in" ? p : (p[0]?.toUpperCase() ?? "") + p.slice(1)))
        .join(" ");
    const degreeLabel = degree ? ` (${degree.toUpperCase()})` : "";
    return `${schoolDisplayPrefix(schoolId)} ${title}${degreeLabel}`.trim();
}

function schoolDisplayPrefix(schoolId: string): string {
    const map: Record<string, string> = {
        cas: "CAS", stern: "Stern", tandon: "Tandon", tisch: "Tisch",
        steinhardt: "Steinhardt", gallatin: "Gallatin", liberal_studies: "Liberal Studies",
        sps: "SPS", nursing: "Nursing", social_work: "Silver Social Work",
        public_service: "Public Service", dentistry: "Dentistry",
        nyuad: "NYU Abu Dhabi", shanghai: "NYU Shanghai", all: "NYU",
    };
    return map[schoolId] ?? schoolId;
}

/** Recursively collect every `.md` file under `dir`, returned as paths
 *  relative to `bulletinDir`. Depth-first; unreadable entries skipped. */
function walkMarkdownRelPaths(dir: string, bulletinDir: string): string[] {
    const out: string[] = [];
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of names) {
        const full = join(dir, name);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            out.push(...walkMarkdownRelPaths(full, bulletinDir));
        } else if (name.endsWith(".md")) {
            out.push(relative(bulletinDir, full));
        }
    }
    return out;
}

/** Title-case the directory that owns a page (or the filename), e.g.
 *  ".../student-visa-and-immigration/_index.md" → "Student Visa And Immigration". */
function pathLabel(relPath: string): string {
    const parts = relPath.split(/[\\/]/);
    const file = parts[parts.length - 1]!;
    const slug = file === "_index.md" ? (parts[parts.length - 2] ?? parts[0]!) : file.replace(/\.md$/, "");
    return slug.split("-").map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join(" ");
}

/** Infer the category for a bulletin page from its path. */
function categoryFor(relPath: string): CorpusCategory {
    const p = relPath.toLowerCase();
    if (p.includes("/programs/")) return "program";
    if (p.includes("college-core-curriculum")) return "core_curriculum";
    if (p.includes("/admissions") || p.includes("internal-transfer")) return "admissions";
    if (p.includes("academic-polic")) return "academic_policy";
    // OGS visa/immigration rules read as policy.
    if (p.startsWith("ogs/")) return "academic_policy";
    return "school_overview";
}

/** Walk the entire undergraduate bulletin tree + the NYU-wide trees and
 *  produce one CorpusEntry per `.md` page, auto-tagged by school +
 *  category. This is the "ingest all" entry list. */
function discoverAllEntries(bulletinDir: string): CorpusEntry[] {
    const out: CorpusEntry[] = [];

    // 1. Per-school undergraduate tree.
    const ugRoot = join(bulletinDir, "undergraduate");
    if (existsSync(ugRoot)) {
        for (const schoolDir of readdirSync(ugRoot)) {
            const schoolRoot = join(ugRoot, schoolDir);
            try {
                if (!statSync(schoolRoot).isDirectory()) continue;
            } catch { continue; }
            const schoolId = SCHOOL_DIR_TO_ID[schoolDir] ?? schoolDir.replace(/-/g, "_");
            for (const relPath of walkMarkdownRelPaths(schoolRoot, bulletinDir)) {
                const category = categoryFor(relPath);
                const source = category === "program"
                    ? programSlugToLabel(relPath.split(/[\\/]/).slice(-2)[0]!, schoolId)
                    : `${schoolDisplayPrefix(schoolId)} — ${pathLabel(relPath)}`;
                out.push({ school: schoolId, source, relPath, category });
            }
        }
    }

    // 2. NYU-wide trees → school "all" (in scope for every student).
    const wideTrees: Array<{ dir: string; prefix: string }> = [
        { dir: "internal-transfer-equivalencies", prefix: "NYU Internal Transfer" },
        { dir: "ogs", prefix: "NYU OGS (Global Services)" },
        { dir: "nyu", prefix: "NYU-wide" },
    ];
    for (const tree of wideTrees) {
        const root = join(bulletinDir, tree.dir);
        if (!existsSync(root)) continue;
        for (const relPath of walkMarkdownRelPaths(root, bulletinDir)) {
            out.push({
                school: "all",
                source: `${tree.prefix}: ${pathLabel(relPath)}`,
                relPath,
                category: categoryFor(relPath),
            });
        }
    }

    return out;
}

export interface BuildCorpusResult {
    store: VectorStore;
    chunks: PolicyChunk[];
    /** Entries skipped because the file didn't exist. */
    skipped: CorpusEntry[];
}

/**
 * Build the full RAG corpus and return a populated VectorStore.
 * By default ingests the ENTIRE undergraduate bulletin tree + the
 * NYU-wide trees (`options.entries` overrides for tests).
 */
export async function buildCorpus(
    embedder: Embedder,
    options: BuildCorpusOptions = {},
): Promise<BuildCorpusResult> {
    const year = options.catalogYear ?? "2025-2026";
    const bulletinDir = options.bulletinDir ?? BULLETIN_DIR;
    const entries = options.entries ?? discoverAllEntries(bulletinDir);

    const store = new VectorStore(embedder);
    const allChunks: PolicyChunk[] = [];
    const skipped: CorpusEntry[] = [];

    for (const entry of entries) {
        const fullPath = join(bulletinDir, entry.relPath);
        if (!existsSync(fullPath)) {
            skipped.push(entry);
            continue;
        }
        const md = readFileSync(fullPath, "utf-8");
        const chunks = chunkMarkdown(md, {
            source: entry.source,
            school: entry.school,
            year,
            sourcePath: entry.relPath,
            ...(entry.category ? { category: entry.category } : {}),
        });
        allChunks.push(...chunks);
    }

    if (skipped.length > 0) {
        if (options.strict) {
            throw new Error(
                `buildCorpus: ${skipped.length} configured entr${skipped.length === 1 ? "y is" : "ies are"} ` +
                `missing from bulletin: ${skipped.map((s) => s.relPath).join(", ")}. ` +
                `Pass strict:false to ignore.`,
            );
        }
        if (options.warnOnSkip ?? true) {
            // eslint-disable-next-line no-console
            console.warn(
                "[buildCorpus]",
                JSON.stringify({
                    kind: "corpus_entries_skipped",
                    count: skipped.length,
                    paths: skipped.map((s) => s.relPath),
                }),
            );
        }
    }

    await store.addChunks(allChunks);
    return { store, chunks: allChunks, skipped };
}
