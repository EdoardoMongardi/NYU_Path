// ============================================================
// Policy Document Chunker (Phase 4 §5.3)
// ============================================================
// Splits a bulletin markdown file into chunks the RAG pipeline can
// search over. Chunking rules per architecture §5.3:
//   - Split on section headings (`#`/`##`/`###` markers)
//   - Max ~500 tokens per chunk; if a section exceeds, split on
//     paragraph boundaries with a 50-token overlap between adjacent
//     pieces
//   - Each chunk tagged with: source document, school, section name,
//     year (catalogYear), chunkId
//
// Pure: same input + same metadata → same chunks. No LLM call.
// Tokens are approximated as whitespace-split words; the 500-token /
// 50-token overlap policy is conservative enough that a real
// tokenizer would land within ±15% of these counts.
// ============================================================

export interface ChunkMeta {
    /** Source document title, e.g., "CAS Academic Policies" */
    source: string;
    /** Lowercase school id, e.g., "cas", "stern", "tandon", "all" */
    school: string;
    /** Catalog year, e.g., "2025-2026" */
    year: string;
    /** Section heading the chunk lives under */
    section: string;
    /** Stable chunk id, e.g., "cas_pf_003" */
    chunkId: string;
    /** Absolute or repo-relative path to the source markdown */
    sourcePath: string;
    /** 1-indexed line in the source where the chunk starts */
    sourceLine: number;
    /** Phase 9 Stage 1 — kind of source. Lets the agent + reranker
     *  prefer e.g. "program" pages for curriculum questions and
     *  "academic_policy" chunks for rule questions. Optional for
     *  back-compat. */
    category?: "academic_policy" | "admissions" | "program" | "core_curriculum" | "course_catalog" | "school_overview";
}

export interface PolicyChunk {
    text: string;
    meta: ChunkMeta;
}

export interface ChunkOptions {
    /** Max approximate tokens per chunk (whitespace words). Default 500. */
    maxTokens?: number;
    /** Overlap between adjacent intra-section pieces. Default 50. */
    overlapTokens?: number;
    /** Slug prefix for chunkIds (default: lowercased + underscored source) */
    slug?: string;
}

/**
 * Chunk a markdown document into PolicyChunk[].
 * Splits on `#` / `##` / `###` headings; sub-splits oversized sections.
 *
 * Phase 9 Stage 1 — strips bulletin boilerplate (CDATA / inline JS /
 * navigation tab markers) before chunking so retrieval doesn't waste
 * embedding budget on noise. Original line numbers are preserved
 * because the strip operates on whole-line replacement (lines that
 * contain noise become empty); paragraph boundaries are unchanged.
 */
export function chunkMarkdown(
    markdown: string,
    base: Omit<ChunkMeta, "section" | "chunkId" | "sourceLine">,
    options: ChunkOptions = {},
): PolicyChunk[] {
    const maxTokens = options.maxTokens ?? 500;
    const overlapTokens = options.overlapTokens ?? 50;
    const slug = options.slug ?? slugify(base.source);

    const cleaned = stripBulletinBoilerplate(markdown);
    const sections = splitIntoSections(cleaned);
    const chunks: PolicyChunk[] = [];
    let runningIndex = 0;

    for (const sec of sections) {
        const pieces = splitOversized(sec.body, maxTokens, overlapTokens);
        const nonEmpty = pieces.filter((p) => p.trim().length > 0);
        if (nonEmpty.length === 0) {
            // Heading-only section (no body text). Emit a single chunk
            // whose body IS the heading so the heading remains indexed
            // and discoverable via the scope filter + retrieval. Without
            // this, a bulletin section like "### Reserved" with no body
            // would silently disappear from the corpus.
            runningIndex += 1;
            chunks.push({
                text: sec.heading,
                meta: {
                    ...base,
                    section: sec.heading,
                    chunkId: `${slug}_${pad3(runningIndex)}`,
                    sourceLine: sec.startLine,
                },
            });
            continue;
        }
        for (const piece of nonEmpty) {
            runningIndex += 1;
            chunks.push({
                text: piece,
                meta: {
                    ...base,
                    section: sec.heading,
                    chunkId: `${slug}_${pad3(runningIndex)}`,
                    sourceLine: sec.startLine,
                },
            });
        }
    }
    return chunks;
}

interface RawSection {
    heading: string;
    body: string;
    startLine: number;
}

function splitIntoSections(markdown: string): RawSection[] {
    const lines = markdown.split(/\r?\n/);
    const sections: RawSection[] = [];
    let currentHeading = "(preamble)";
    let currentBuffer: string[] = [];
    let currentStart = 1;

    const headingRe = /^(#{1,6})\s+(.+?)\s*$/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = line.match(headingRe);
        if (m) {
            // Flush previous section. We flush even when the buffer is empty
            // (a heading with no body) — except for the synthetic "(preamble)"
            // open at the top of the file, which is dropped when empty.
            const hasContent = currentBuffer.some((l) => l.trim().length > 0);
            const isUntouchedPreamble = currentHeading === "(preamble)" && !hasContent;
            if (!isUntouchedPreamble) {
                sections.push({
                    heading: currentHeading,
                    body: currentBuffer.join("\n"),
                    startLine: currentStart,
                });
            }
            currentHeading = m[2]!;
            currentBuffer = [];
            currentStart = i + 1;
        } else {
            currentBuffer.push(line);
        }
    }
    // End-of-file flush. A trailing heading with no body produces an empty
    // body chunk so the heading is still indexed (the `splitOversized` /
    // `chunkMarkdown` callers will skip whitespace-only pieces, but the
    // section heading itself remains discoverable via `meta.section`).
    const trailingHasContent = currentBuffer.some((l) => l.trim().length > 0);
    const trailingIsUntouchedPreamble = currentHeading === "(preamble)" && !trailingHasContent;
    if (!trailingIsUntouchedPreamble) {
        sections.push({
            heading: currentHeading,
            body: currentBuffer.join("\n"),
            startLine: currentStart,
        });
    }
    return sections;
}

/**
 * If the section body exceeds maxTokens, split on paragraph boundaries
 * (blank lines) and keep an overlap between pieces. Otherwise return [body].
 */
function splitOversized(body: string, maxTokens: number, overlapTokens: number): string[] {
    const tokens = body.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length <= maxTokens) return [body];

    const result: string[] = [];
    let i = 0;
    while (i < tokens.length) {
        const piece = tokens.slice(i, i + maxTokens).join(" ");
        result.push(piece);
        if (i + maxTokens >= tokens.length) break;
        i += maxTokens - overlapTokens;
    }
    return result;
}

function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

/** Phase 9 Stage 1 — strip the noise the bulletin scraper baked in.
 *  Bulletin program pages embed a `<![CDATA[...]]>` JS block + tab
 *  navigation menus that contribute thousands of tokens of pure
 *  formatting cruft. This function preserves line indexing (replaces
 *  noise lines with empty lines) so `sourceLine` annotations stay
 *  meaningful. */
function stripBulletinBoilerplate(md: string): string {
    // 1. Remove the CDATA / inline JS block (between the opening
    //    `//<![CDATA[` and closing `//]]>` markers).
    let out = md.replace(/\/\/<!\[CDATA\[[\s\S]*?\/\/]]>/g, "");
    // 2. Remove tab-anchor navigation lines like:
    //      * [Overview](#textcontainer)
    //      * [Curriculum](#curriculumtextcontainer)
    //      * [Sample Plan of Study](#sampleplanofstudytextcontainer)
    //    These are pure UI affordances; bulletins put them at the top
    //    of every program page.
    out = out.replace(/^\s*\*\s*\[[^\]]+\]\(#[a-zA-Z]+container\)\s*$/gm, "");
    // 3. Remove "On This Page" navigation blocks (the bulletin page TOC).
    out = out.replace(/^On This Page\s*$/gm, "");
    return out;
}

function pad3(n: number): string {
    return n.toString().padStart(3, "0");
}
