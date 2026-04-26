// ============================================================
// RAG Corpus Builder (Phase 4 §5.3)
// ============================================================
// Assembles the indexed corpus from `data/bulletin-raw/`. Per §5.3,
// each school's bulletin is chunked separately so the scope filter
// can hard-filter by school. Tag each chunk with:
//   - source (e.g., "CAS Academic Policies")
//   - school (lowercase id)
//   - year (catalogYear)
//   - section (heading)
//
// Default catalog year is "2025-2026" matching the rest of the data
// files. Callers can override.
//
// At v1 this builds the corpus on-demand by reading bulletin markdown.
// In production, the corpus would be pre-embedded and persisted to a
// vector DB; the rebuild path here exists for tests and dev iteration.
// ============================================================

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkMarkdown, type PolicyChunk } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import { VectorStore } from "./vectorStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const BULLETIN_DIR = join(REPO_ROOT, "data", "bulletin-raw");

interface CorpusEntry {
    school: string;
    source: string;
    /** Path relative to data/bulletin-raw/ */
    relPath: string;
}

/**
 * Default mapping of (school, source title) → bulletin file path.
 * Each entry produces one chunked subset of the corpus. Add T3 program
 * pages here as they become available.
 */
const DEFAULT_ENTRIES: CorpusEntry[] = [
    { school: "cas", source: "CAS Academic Policies",
      relPath: "undergraduate/arts-science/academic-policies/_index.md" },
    { school: "stern", source: "Stern Academic Policies",
      relPath: "undergraduate/business/academic-policies/_index.md" },
    { school: "tandon", source: "Tandon Academic Policies",
      relPath: "undergraduate/engineering/academic-policies/_index.md" },
    { school: "tisch", source: "Tisch Academic Policies",
      relPath: "undergraduate/arts/academic-policies/_index.md" },
    { school: "all", source: "NYU-wide Internal Transfer Admissions (CAS)",
      relPath: "undergraduate/arts-science/admissions/_index.md" },
    { school: "stern", source: "Stern Admissions",
      relPath: "undergraduate/business/admissions/_index.md" },
    { school: "cas", source: "CAS EXPOS-UA Course Catalog",
      relPath: "courses/expos_ua/_index.md" },
    { school: "cas", source: "CAS Economics BA",
      relPath: "undergraduate/arts-science/programs/economics-ba/_index.md" },
    // T3 — included so verbatim-quote responses can be served from RAG.
    // Bulletin path note: Gallatin's directory in the scrape is named
    // "individualized-study", not "gallatin". The school config keeps
    // schoolId "gallatin"; only the bulletin file path differs.
    { school: "gallatin", source: "NYU Gallatin School of Individualized Study (overview, T3)",
      relPath: "undergraduate/individualized-study/_index.md" },
    { school: "gallatin", source: "NYU Gallatin Academic Policies (T3)",
      relPath: "undergraduate/individualized-study/academic-policies/_index.md" },
    { school: "liberal_studies", source: "NYU Liberal Studies (overview, T3)",
      relPath: "undergraduate/liberal-studies/_index.md" },
    { school: "liberal_studies", source: "NYU Liberal Studies Academic Policies (T3)",
      relPath: "undergraduate/liberal-studies/academic-policies/_index.md" },
];

export interface BuildCorpusOptions {
    catalogYear?: string;
    /** Override the entry list (tests use this) */
    entries?: CorpusEntry[];
    /** Override the bulletin root (tests use a tmp dir) */
    bulletinDir?: string;
    /** When true, throw if any configured entry's file is missing. Default false. */
    strict?: boolean;
    /** When true (default), log skipped entries via console.warn. */
    warnOnSkip?: boolean;
}

export interface BuildCorpusResult {
    store: VectorStore;
    chunks: PolicyChunk[];
    /** Entries skipped because the file didn't exist */
    skipped: CorpusEntry[];
}

/**
 * Build the full RAG corpus and return a populated VectorStore.
 */
export async function buildCorpus(
    embedder: Embedder,
    options: BuildCorpusOptions = {},
): Promise<BuildCorpusResult> {
    const year = options.catalogYear ?? "2025-2026";
    const entries = options.entries ?? DEFAULT_ENTRIES;
    const bulletinDir = options.bulletinDir ?? BULLETIN_DIR;
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

export { DEFAULT_ENTRIES };
