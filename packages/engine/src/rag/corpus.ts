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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
    /** Phase 9 — category tag so the agent + ranker can prefer the
     *  right kind of source. Optional for back-compat. */
    category?: "academic_policy" | "admissions" | "program" | "core_curriculum" | "course_catalog" | "school_overview";
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
    /** Phase 9 Stage 1 — when true, the corpus also includes every
     *  CAS program page (BA / BS / minor) under undergraduate/arts-
     *  science/programs/ + the College Core Curriculum page. Also
     *  pulls similar program directories under arts/business/
     *  engineering/individualized-study/liberal-studies for what-if
     *  questions. Defaults to false for back-compat — the embed
     *  script flips it on. */
    includeProgramPages?: boolean;
}

/** Phase 9 Stage 1 — map a program-directory location → school id.
 *  Mirrors the schoolId convention used elsewhere in the engine
 *  (see SchoolConfig + buildStudentProfileFromDpr). */
const PROGRAM_DIR_TO_SCHOOL: Record<string, string> = {
    "arts-science": "cas",
    "arts": "tisch",
    "business": "stern",
    "engineering": "tandon",
    "individualized-study": "gallatin",
    "liberal-studies": "liberal_studies",
    "abu-dhabi": "nyuad",
    "shanghai": "shanghai",
};

/** Phase 9 Stage 1 — derive a human-readable program label from the
 *  directory slug. E.g. "mathematics-computer-science-ba" → "Mathematics
 *  and Computer Science (BA)". Used for the chunk metadata's `source`
 *  field so reranker output is human-meaningful. */
function programSlugToLabel(slug: string, schoolId: string): string {
    // Trim a trailing degree marker (-ba, -bs, -minor, -ma, -ms) and remember it.
    const degreeMatch = slug.match(/-(ba|bs|minor|ma|ms|phd|cert)$/);
    const degree = degreeMatch ? degreeMatch[1] : null;
    const base = degreeMatch ? slug.slice(0, -degreeMatch[0].length) : slug;
    // Title-case the rest, joining with spaces.
    const title = base
        .split("-")
        .map((p) => (p === "and" || p === "of" || p === "in" ? p : p[0]?.toUpperCase() + p.slice(1)))
        .join(" ");
    const schoolPrefix =
        schoolId === "cas" ? "CAS"
        : schoolId === "stern" ? "Stern"
        : schoolId === "tandon" ? "Tandon"
        : schoolId === "tisch" ? "Tisch"
        : schoolId === "gallatin" ? "Gallatin"
        : schoolId === "liberal_studies" ? "Liberal Studies"
        : schoolId === "nyuad" ? "NYU Abu Dhabi"
        : schoolId === "shanghai" ? "NYU Shanghai"
        : schoolId;
    const degreeLabel = degree ? ` (${degree.toUpperCase()})` : "";
    return `${schoolPrefix} ${title}${degreeLabel}`;
}

/** Phase 9 Stage 1 — walk `data/bulletin-raw/undergraduate/<school-dir>/programs/`
 *  and produce a CorpusEntry per program _index.md. Skips dirs that
 *  don't have an _index.md (rare). */
function discoverProgramEntries(bulletinDir: string): CorpusEntry[] {
    const out: CorpusEntry[] = [];
    const undergradRoot = join(bulletinDir, "undergraduate");
    if (!existsSync(undergradRoot)) return out;
    for (const schoolDir of readdirSync(undergradRoot)) {
        const schoolId = PROGRAM_DIR_TO_SCHOOL[schoolDir];
        if (!schoolId) continue;
        const programsRoot = join(undergradRoot, schoolDir, "programs");
        if (!existsSync(programsRoot)) continue;
        for (const slug of readdirSync(programsRoot)) {
            const programDir = join(programsRoot, slug);
            try {
                if (!statSync(programDir).isDirectory()) continue;
            } catch { continue; }
            const indexPath = join(programDir, "_index.md");
            if (!existsSync(indexPath)) continue;
            out.push({
                school: schoolId,
                source: programSlugToLabel(slug, schoolId),
                relPath: join("undergraduate", schoolDir, "programs", slug, "_index.md"),
                category: "program",
            });
        }
    }
    return out;
}

/** Phase 9 Stage 1 — entries for the College Core Curriculum page +
 *  any other school-overview pages we want indexed (e.g. CAS
 *  college-core-curriculum). */
function discoverCoreCurriculumEntries(bulletinDir: string): CorpusEntry[] {
    const out: CorpusEntry[] = [];
    const candidates: Array<{school: string; relPath: string; source: string}> = [
        {
            school: "cas",
            source: "CAS College Core Curriculum",
            relPath: "undergraduate/arts-science/college-core-curriculum/_index.md",
        },
    ];
    for (const c of candidates) {
        if (existsSync(join(bulletinDir, c.relPath))) {
            out.push({ ...c, category: "core_curriculum" });
        }
    }
    return out;
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
    const bulletinDir = options.bulletinDir ?? BULLETIN_DIR;
    let entries = options.entries ?? DEFAULT_ENTRIES;
    if (options.includeProgramPages) {
        // De-duplicate against the explicit DEFAULT_ENTRIES list (we
        // already include economics-ba there) — keep the explicit
        // entry's source name + category.
        const seen = new Set(entries.map((e) => e.relPath));
        const programEntries = discoverProgramEntries(bulletinDir).filter((e) => !seen.has(e.relPath));
        const coreEntries = discoverCoreCurriculumEntries(bulletinDir).filter((e) => !seen.has(e.relPath));
        entries = [...entries, ...programEntries, ...coreEntries];
    }
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

export { DEFAULT_ENTRIES };
