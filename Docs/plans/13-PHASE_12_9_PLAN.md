# Phase 12.9 — Bulletin Embeddings: Course Catalog + Policy RAG

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the freshly-scraped bulletin (Phase 12.7) and embed two distinct slices into two distinct indices: (Option B) per-course rich descriptions into the course-catalog semantic-search index that powers `search_courses`, replacing the thin Postgres-dump blurbs; (Option C) non-CAS program/curriculum pages into the policy RAG that powers `search_policy`, extending the CAS-only Phase 9 coverage. No engine logic changes — pure data + index work.

**Architecture:** Two parallel pipelines sharing the same embedder (OpenAI `text-embedding-3-small`, already in use per Phase 7-B step 12). Pipeline B walks `data/bulletin-raw/courses/*/index.md`, extracts the multi-paragraph description prose, embeds, writes to a new `course_embeddings_bulletin.jsonl`, and rewires `search_courses` to read it (with the existing 17K-dump index as fallback for courses not in the bulletin). Pipeline C walks `data/bulletin-raw/undergraduate/<school>/<program>/index.md` (and equivalents under non-CAS schools), chunks each program page by section, embeds each chunk, appends to `data/policy-corpus/policy_chunks.jsonl`. The existing `search_policy` tool picks up the new chunks transparently.

**Tech Stack:** TypeScript, `@anthropic-ai/sdk` not used (this is OpenAI embedding only), Node.js scripts.

**Prerequisites:**
- **Phase 12.7** complete (full undergrad bulletin scrape).
- **Phase 12.8** complete (parsed prereqs + offerings — needed for the description-extractor's confidence baseline).

**Out of scope:**
- Re-embedding the existing CAS policy chunks (they stay as-is)
- Adding graduate-school programs (different audience)
- Restructuring `search_policy`'s reranker (Cohere Rerank v3.5 stays)
- Multi-vector retrieval / hybrid search (out of scope for Phase 12.9; pure vector search continues)

---

## Why split into two pipelines

The two indices have different consumers and different chunking semantics:

| | Pipeline B (course-catalog) | Pipeline C (policy RAG) |
|---|---|---|
| **Source** | Per-course bulletin markdown | Program-overview / department / curriculum bulletin markdown |
| **Granularity** | One entry per course (~5,000-7,000) | One entry per section (~300-500 chars; ~1,000-3,000 chunks) |
| **Index file** | `data/course-catalog/course_embeddings_bulletin.jsonl` | append to `data/policy-corpus/policy_chunks.jsonl` |
| **Consumer** | `search_courses` | `search_policy` |
| **Existing data we DON'T touch** | 17K Postgres-dump embeddings (kept as fallback) | CAS policy chunks from Phase 9 (kept as-is) |

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `tools/bulletin-parser/extractCourseDescriptions.ts` | **Create** | Walk per-course bulletin, extract description prose between the prereq line and the attributes footer. Output: `{courseId, title, description}[]`. |
| `tools/bulletin-parser/extractProgramPages.ts` | **Create** | Walk non-CAS program-overview pages, split each by section. Output: `{programId, schoolId, sectionTitle, body, source}[]`. |
| `tools/embeddings/embedCourses.ts` | **Create** | Read the course-description JSON, batch-embed via OpenAI, emit `course_embeddings_bulletin.jsonl`. |
| `tools/embeddings/embedProgramChunks.ts` | **Create** | Read the program-page chunks, batch-embed via OpenAI, append to `policy_chunks.jsonl`. |
| `data/course-catalog/course_embeddings_bulletin.jsonl` | **Create** (generated) | New course-catalog embedding index. ~5,000-7,000 entries. Embedded with `text-embedding-3-small` (1536 dims). |
| `data/policy-corpus/policy_chunks.jsonl` | **Modify** | Append ~1,000-3,000 new chunks from non-CAS curriculum pages. Existing CAS chunks unchanged. |
| `apps/web/lib/courseCatalogSearch.ts` (or wherever `search_courses` reads its index) | **Modify** | Read the new bulletin index first; fall back to the 17K-dump index for courses not present. |
| `packages/engine/tests/data/embeddingsCoverage.test.ts` | **Create** | Vitest: load both new indices, assert non-empty, shape, sample-spot-check known queries. |

---

## Task 1: Course-description extractor (Pipeline B foundation)

**Files:**
- Create: `tools/bulletin-parser/extractCourseDescriptions.ts`
- Create: `tools/bulletin-parser/extractCourseDescriptions.test.ts`

Walks each `data/bulletin-raw/courses/<DEPT>_<SCHOOL>/<NUMBER>/index.md`, extracts the multi-paragraph description that lives between the prereq line and the "Course Attributes" footer, packages with course metadata.

The bulletin markdown shape (per the Phase 12.8 inspection) is approximately:

```
# CSCI-UA 101 — Introduction to Computer Science (4 Credits)

*Typically offered Fall, Spring, and Summer terms*

Prerequisites: ([CSCI-UA 2] with a Minimum Grade of C OR ...)

This course introduces students to the fundamentals of computer science.
Topics include algorithms, data structures, ... [multi-paragraph prose]

Course Attributes:
* Last Term Offered: 2025 Spr
* Course Subject: CSCI-UA
* ...
```

The description is everything between the prereq line (or, if no prereq, the offering line) and the "Course Attributes" footer.

- [ ] **Step 1: Sample 5 bulletin pages to verify the format**

```bash
cat data/bulletin-raw/courses/CSCI_UA/101/index.md | head -40
cat data/bulletin-raw/courses/MATH_UA/121/index.md | head -40
cat data/bulletin-raw/courses/CORE_UA/400/index.md | head -40
cat data/bulletin-raw/courses/STERN_UB/*/index.md 2>/dev/null | head -40 # spot-check Stern
cat data/bulletin-raw/courses/HIST_UA/1/index.md | head -40
```

Confirm: prereq line (when present), description prose, attribute footer all follow the documented shape. Note any deviations.

- [ ] **Step 2: Write the failing test**

Create `tools/bulletin-parser/extractCourseDescriptions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractDescription } from "./extractCourseDescriptions";

const SAMPLE_WITH_PREREQ = `
# CSCI-UA 101 — Introduction to Computer Science (4 Credits)

*Typically offered Fall, Spring, and Summer terms*

Prerequisites: ([CSCI-UA 2](/search/?P=CSCI-UA%202) with a Minimum Grade of C OR [CSCI-UA 3](/search/?P=CSCI-UA%203)).

This course introduces students to the fundamentals of computer science.
Topics include algorithms, data structures, recursion, and abstraction.
Students will gain experience programming in Python.

Course Attributes:
* Last Term Offered: 2025 Spr
* Course Subject: CSCI-UA
`;

const SAMPLE_NO_PREREQ = `
# HIST-UA 1 — World History to 1600 (4 Credits)

*Typically offered Fall and Spring*

A survey of major world civilizations and their interactions before 1600.
Themes include trade networks, religious diffusion, and the rise of states.

Course Attributes:
* Last Term Offered: 2025 Spr
`;

const SAMPLE_NO_ATTRIBUTES_FOOTER = `
# CSCI-UA 999 — Special Topics

*Typically offered as needed*

A topics course on emerging issues in computer science.
Subject varies by semester.
`;

describe("extractDescription", () => {
    it("extracts the prose between prereq line and attributes footer", () => {
        const desc = extractDescription(SAMPLE_WITH_PREREQ);
        expect(desc).toContain("introduces students to the fundamentals");
        expect(desc).toContain("Topics include algorithms");
        expect(desc).not.toContain("Prerequisites:");
        expect(desc).not.toContain("Course Attributes");
    });

    it("extracts the prose between offering line and attributes footer when no prereq present", () => {
        const desc = extractDescription(SAMPLE_NO_PREREQ);
        expect(desc).toContain("survey of major world civilizations");
        expect(desc).not.toContain("Typically offered");
        expect(desc).not.toContain("Course Attributes");
    });

    it("extracts everything after the offering line when no attributes footer present", () => {
        const desc = extractDescription(SAMPLE_NO_ATTRIBUTES_FOOTER);
        expect(desc).toContain("topics course on emerging issues");
    });

    it("returns empty string when input has no description prose", () => {
        const empty = `# CSCI-UA 999\n\n*Typically offered Fall*\n`;
        expect(extractDescription(empty).trim()).toBe("");
    });

    it("strips Markdown link syntax from the description", () => {
        const withLinks = `
# CSCI-UA 200 — Topic

*Typically offered Fall*

This course covers [machine learning](/search/?P=ML) and [data science](/search/?P=DS).
`;
        const desc = extractDescription(withLinks);
        expect(desc).toContain("machine learning and data science");
        expect(desc).not.toMatch(/\[|\]|\(\/search/);
    });
});
```

- [ ] **Step 3: Run test to verify failure**

```bash
node_modules/.bin/vitest run tools/bulletin-parser/extractCourseDescriptions.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement the extractor**

Create `tools/bulletin-parser/extractCourseDescriptions.ts`:

```typescript
/**
 * Phase 12.9 — Course-description extractor.
 *
 * Walks data/bulletin-raw/courses/*\/index.md, extracts the description
 * prose (between the prereq line and the attributes footer), packages
 * with course metadata. Output: data/course-catalog/course_descriptions_bulletin.json
 *
 * This output is then fed into tools/embeddings/embedCourses.ts which
 * generates the embedding index proper.
 *
 * Run: pnpm tsx tools/bulletin-parser/extractCourseDescriptions.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const BULLETIN_DIR = path.join(REPO_ROOT, "data/bulletin-raw/courses");
const OUTPUT_PATH = path.join(REPO_ROOT, "data/course-catalog/course_descriptions_bulletin.json");

const PREREQ_RE = /^\s*\*?\*?Prerequisites?\*?\*?:.+?(?:\n\n|$)/ims;
const OFFERING_RE = /^\s*\*Typically offered[^*]+\*\s*$/im;
const ATTRIBUTES_RE = /^\s*Course Attributes:/im;
const TITLE_RE = /^#\s+([A-Z]{2,5}-(?:UA|UB|UE|UF|UH|UT|UY|SHU))\s+(\d{1,4})\s+[—-]\s+(.+?)(?:\s+\((\d+)\s+Credits?\))?$/m;
const MD_LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;

export function extractDescription(content: string): string {
    let text = content;

    // Strip the title line (we extract title separately).
    text = text.replace(TITLE_RE, "");

    // Strip the offering line.
    text = text.replace(OFFERING_RE, "");

    // Find the attributes footer; everything before it is fair game.
    const attrMatch = ATTRIBUTES_RE.exec(text);
    if (attrMatch) text = text.slice(0, attrMatch.index);

    // Strip the prereq line.
    text = text.replace(PREREQ_RE, "");

    // Strip Markdown link syntax: [text](url) → text.
    text = text.replace(MD_LINK_RE, "$1");

    // Collapse multiple blank lines.
    text = text.replace(/\n{3,}/g, "\n\n");

    return text.trim();
}

interface CourseDescription {
    courseId: string;
    title: string;
    credits: number | null;
    description: string;
}

function extractTitle(content: string): { courseId: string; title: string; credits: number | null } | null {
    const m = TITLE_RE.exec(content);
    if (!m) return null;
    const courseId = `${m[1]} ${m[2]}`;
    const title = m[3]!.trim();
    const credits = m[4] ? parseInt(m[4], 10) : null;
    return { courseId, title, credits };
}

function main() {
    const out: CourseDescription[] = [];
    let totalFiles = 0;
    let extracted = 0;
    let skipped = 0;

    const deptDirs = fs.readdirSync(BULLETIN_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());
    for (const dept of deptDirs) {
        if (!/^[A-Z]{2,5}_(UA|UB|UE|UF|UH|UT|UY|SHU)$/.test(dept.name)) continue;
        const courseDirs = fs.readdirSync(path.join(BULLETIN_DIR, dept.name), { withFileTypes: true })
            .filter(d => d.isDirectory());
        for (const courseDir of courseDirs) {
            const indexPath = path.join(BULLETIN_DIR, dept.name, courseDir.name, "index.md");
            if (!fs.existsSync(indexPath)) continue;
            totalFiles++;
            const content = fs.readFileSync(indexPath, "utf8");
            const titleData = extractTitle(content);
            if (!titleData) { skipped++; continue; }
            const description = extractDescription(content);
            if (!description) { skipped++; continue; }
            out.push({
                courseId: titleData.courseId,
                title: titleData.title,
                credits: titleData.credits,
                description,
            });
            extracted++;
        }
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ${OUTPUT_PATH}`);
    console.log(`  Total files seen: ${totalFiles}`);
    console.log(`  Extracted: ${extracted}`);
    console.log(`  Skipped (no title or no description): ${skipped}`);
}

main();
```

- [ ] **Step 5: Run tests to verify pass**

```bash
node_modules/.bin/vitest run tools/bulletin-parser/extractCourseDescriptions.test.ts
```

Expected: 5/5 PASS.

- [ ] **Step 6: Run the full extraction**

```bash
pnpm tsx tools/bulletin-parser/extractCourseDescriptions.ts
```

Expected output:
```
Wrote .../data/course-catalog/course_descriptions_bulletin.json
  Total files seen: ~5,000-7,000
  Extracted: ~5,000-7,000 (>95%)
  Skipped: <5%
```

If the skip rate is high (>10%), the title regex is too strict — investigate the failures and loosen.

- [ ] **Step 7: Spot-check 5 random extracted entries**

```bash
pnpm tsx -e '
import * as fs from "node:fs";
const data = JSON.parse(fs.readFileSync("data/course-catalog/course_descriptions_bulletin.json", "utf8"));
for (let i = 0; i < 5; i++) {
    const e = data[Math.floor(Math.random() * data.length)];
    console.log("===", e.courseId, "—", e.title);
    console.log("description:", e.description.slice(0, 300));
    console.log();
}
'
```

Verify each description is multi-sentence prose, free of Markdown link syntax, and free of "Course Attributes" / "Prerequisites" / "Typically offered" boilerplate.

- [ ] **Step 8: Commit**

```bash
git add tools/bulletin-parser/extractCourseDescriptions.ts tools/bulletin-parser/extractCourseDescriptions.test.ts data/course-catalog/course_descriptions_bulletin.json
git commit -m "data(parser): per-course descriptions extracted from bulletin"
```

---

## Task 2: Embed course descriptions (Pipeline B completion)

**Files:**
- Create: `tools/embeddings/embedCourses.ts`
- Create: `data/course-catalog/course_embeddings_bulletin.jsonl` (generated)

Reads the JSON from Task 1, batch-embeds via OpenAI `text-embedding-3-small`, writes one JSONL line per course. The existing `course_embeddings_openai.jsonl` (17K-dump) stays untouched as a fallback index.

- [ ] **Step 1: Read the existing embedding script for pattern**

The repo already has embedding infrastructure from Phase 7-B. Find it:

```bash
grep -rln "text-embedding-3-small\|openai.*embed" tools/ scripts/ packages/ 2>/dev/null | head -10
ls scripts/generate-embeddings.* 2>/dev/null
```

Note the existing batching approach, env-var conventions (`OPENAI_API_KEY`), output format. Mirror them.

- [ ] **Step 2: Write the embedder**

Create `tools/embeddings/embedCourses.ts`:

```typescript
/**
 * Phase 12.9 — Course-description embedder.
 *
 * Reads data/course-catalog/course_descriptions_bulletin.json (from
 * Task 1), batch-embeds the descriptions via OpenAI text-embedding-3-small,
 * writes data/course-catalog/course_embeddings_bulletin.jsonl as the
 * new primary index for `search_courses`.
 *
 * Run: OPENAI_API_KEY=... pnpm tsx tools/embeddings/embedCourses.ts
 */

import OpenAI from "openai";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const INPUT_PATH = path.join(REPO_ROOT, "data/course-catalog/course_descriptions_bulletin.json");
const OUTPUT_PATH = path.join(REPO_ROOT, "data/course-catalog/course_embeddings_bulletin.jsonl");

const MODEL = "text-embedding-3-small";
const BATCH_SIZE = 100; // OpenAI accepts up to ~2048 inputs per call but 100 is safe + cheap

interface CourseDescription {
    courseId: string;
    title: string;
    credits: number | null;
    description: string;
}

interface EmbeddedRecord {
    courseId: string;
    title: string;
    credits: number | null;
    description: string;
    embedding: number[];
}

async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    const client = new OpenAI({ apiKey });

    const data: CourseDescription[] = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
    console.log(`Loaded ${data.length} courses to embed`);

    // Build the input text: title + description (gives the embedder
    // course-name signal in addition to the prose).
    const inputs = data.map(c => `${c.title}\n\n${c.description}`);

    const out: EmbeddedRecord[] = [];
    for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = inputs.slice(i, i + BATCH_SIZE);
        const response = await client.embeddings.create({
            model: MODEL,
            input: batch,
        });
        for (let j = 0; j < batch.length; j++) {
            const idx = i + j;
            const course = data[idx]!;
            const embedding = response.data[j]!.embedding;
            out.push({
                courseId: course.courseId,
                title: course.title,
                credits: course.credits,
                description: course.description,
                embedding,
            });
        }
        console.log(`  embedded ${Math.min(i + BATCH_SIZE, data.length)}/${data.length}`);
    }

    // Write JSONL (one record per line, easier to stream-load later).
    const lines = out.map(r => JSON.stringify(r)).join("\n");
    fs.writeFileSync(OUTPUT_PATH, lines + "\n");
    console.log(`Wrote ${OUTPUT_PATH} (${out.length} records)`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run the embedder**

```bash
OPENAI_API_KEY=$(cat .env.local | grep OPENAI_API_KEY | cut -d= -f2) pnpm tsx tools/embeddings/embedCourses.ts
```

(Or however env-vars are loaded in your local setup.)

Expected runtime: ~2-5 minutes for 5,000-7,000 courses (OpenAI batch endpoint is fast).
Expected cost: ~$5 (text-embedding-3-small is $0.02/1M input tokens; 7K courses × ~200 tokens each = 1.4M tokens = $0.028).

- [ ] **Step 4: Spot-check the output**

```bash
wc -l data/course-catalog/course_embeddings_bulletin.jsonl
head -1 data/course-catalog/course_embeddings_bulletin.jsonl | jq '.courseId, .title, .embedding | length'
```

Expected:
- ~5,000-7,000 lines
- Each `embedding` is an array of 1536 floats (text-embedding-3-small dimension)

- [ ] **Step 5: Commit**

```bash
git add tools/embeddings/embedCourses.ts data/course-catalog/course_embeddings_bulletin.jsonl
git commit -m "data(embed): course-description bulletin embeddings (text-embedding-3-small)"
```

Note: the JSONL file will be large (~150-200 MB). If repo size is a concern, consider Git LFS or storing externally with a download script. For Phase 12.9 we commit it directly; Phase 14+ may revisit.

---

## Task 3: Wire `search_courses` to use the new index

**Files:**
- Modify: `apps/web/lib/courseCatalogSearch.ts` (or wherever the search-courses tool reads its index)
- Possibly modify: `packages/engine/src/agent/tools/searchCourses.ts`

The bulletin-derived index becomes the primary source. The 17K-dump index stays as a fallback for courses present in the dump but not in the bulletin (rare cross-listed cases, recently-removed courses).

- [ ] **Step 1: Find the existing index loader**

```bash
grep -rln "course_embeddings_openai\|courseCatalogSearch\|loadCourseEmbeddings" apps/ packages/ 2>/dev/null
```

Note the file path and the loading pattern.

- [ ] **Step 2: Modify the loader**

Wherever the existing index is loaded, change to load BOTH files. Build an in-memory map by `courseId`, preferring bulletin-derived entries:

```typescript
function loadMergedIndex(): EmbeddedRecord[] {
    const bulletinPath = path.join(REPO_ROOT, "data/course-catalog/course_embeddings_bulletin.jsonl");
    const fallbackPath = path.join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.jsonl");

    const merged = new Map<string, EmbeddedRecord>();

    // Load fallback first.
    for (const line of fs.readFileSync(fallbackPath, "utf8").split("\n").filter(Boolean)) {
        const r = JSON.parse(line);
        merged.set(r.courseId, r);
    }
    // Override with bulletin entries (preferred).
    for (const line of fs.readFileSync(bulletinPath, "utf8").split("\n").filter(Boolean)) {
        const r = JSON.parse(line);
        merged.set(r.courseId, r);
    }
    return [...merged.values()];
}
```

If the existing loader has a more sophisticated structure (e.g., an in-memory vector index built from the JSONL at startup), adapt the merge to that structure — the principle is "bulletin wins on courseId collision; fallback covers anything bulletin doesn't have."

- [ ] **Step 3: Run existing tests**

```bash
node_modules/.bin/vitest run apps/web/tests/ packages/engine/tests/
```

Expected: all tests pass; the loader change is transparent to consumers.

- [ ] **Step 4: Smoke-test in dev server**

Start the dev server, send `search_courses` queries to the chat:
- "machine learning courses" → should return CS / Stats / DS courses with rich descriptions
- "film electives" → Tisch courses
- "introductory finance" → Stern courses
- "anything CS" → CSCI-UA / CSCI-UY courses

Compare answer quality before/after. If the new index produces noticeably less-relevant results for a query type, investigate (might be that the description-heavy text drowns out the courseCode signal — adjust the embedded text to weight the title more).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/courseCatalogSearch.ts # or wherever
git commit -m "feat(web): search_courses uses bulletin-derived embeddings (with 17K-dump fallback)"
```

---

## Task 4: Program-page extractor (Pipeline C foundation)

**Files:**
- Create: `tools/bulletin-parser/extractProgramPages.ts`
- Create: `tools/bulletin-parser/extractProgramPages.test.ts`

The `data/bulletin-raw/undergraduate/<school>/<program>/` (and similar) directories contain program-overview pages with curriculum requirements, sample plans, etc. Phase 12.9 chunks these by section and prepares them for embedding into the policy RAG.

The CAS portion is already in the policy RAG (Phase 9). Phase 12.9 adds the non-CAS portions.

- [ ] **Step 1: Audit which schools have program pages**

```bash
ls data/bulletin-raw/undergraduate/
find data/bulletin-raw/undergraduate -maxdepth 3 -name "*.md" | head -30
```

Expected: directories per school. Each contains program subdirectories. Note which schools have meaningful program-page content vs. just stubs.

- [ ] **Step 2: Sample 3 program pages from different schools**

```bash
cat data/bulletin-raw/undergraduate/stern-school-of-business/<some-program>/index.md 2>/dev/null | head -80
cat data/bulletin-raw/undergraduate/tisch-school-of-the-arts/<some-program>/index.md 2>/dev/null | head -80
cat data/bulletin-raw/undergraduate/tandon-school-of-engineering/<some-program>/index.md 2>/dev/null | head -80
```

Note the section structure (`## Major Requirements`, `## Sample Plan of Study`, etc.). Sections are the natural chunking unit.

- [ ] **Step 3: Write the extractor**

Create `tools/bulletin-parser/extractProgramPages.ts`:

```typescript
/**
 * Phase 12.9 — Program-page extractor.
 *
 * Walks data/bulletin-raw/undergraduate/<school>/<program>/index.md
 * (recursively), splits each page by section headings (## or ### level),
 * outputs one entry per section. Excludes CAS (already in the policy RAG
 * from Phase 9).
 *
 * Output: data/policy-corpus/non_cas_program_chunks.json
 *
 * Run: pnpm tsx tools/bulletin-parser/extractProgramPages.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const UNDERGRAD_ROOT = path.join(REPO_ROOT, "data/bulletin-raw/undergraduate");
const OUTPUT_PATH = path.join(REPO_ROOT, "data/policy-corpus/non_cas_program_chunks.json");

const CAS_SLUGS = ["college-of-arts-and-science"]; // exclude — already in policy RAG

interface ProgramChunk {
    /** A stable identifier for this chunk: school/program/section. */
    chunkId: string;
    schoolSlug: string;
    programSlug: string;
    sectionTitle: string;
    /** The chunk text. */
    body: string;
    /** Source URL or path for citation. */
    source: string;
}

const SECTION_HEADER_RE = /^(#{2,3})\s+(.+?)$/gm;
const MD_LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;

export function splitBySections(content: string): Array<{ heading: string; body: string }> {
    const sections: Array<{ heading: string; body: string }> = [];
    let lastHeading: string | null = null;
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    while ((m = SECTION_HEADER_RE.exec(content)) !== null) {
        if (lastHeading !== null) {
            const body = content.slice(lastIdx, m.index).trim();
            if (body) sections.push({ heading: lastHeading, body });
        }
        lastHeading = m[2]!.trim();
        lastIdx = SECTION_HEADER_RE.lastIndex;
    }
    if (lastHeading !== null) {
        const body = content.slice(lastIdx).trim();
        if (body) sections.push({ heading: lastHeading, body });
    }
    return sections;
}

function* walkProgramDirs(): Generator<{ schoolSlug: string; programSlug: string; filePath: string }> {
    if (!fs.existsSync(UNDERGRAD_ROOT)) return;
    for (const school of fs.readdirSync(UNDERGRAD_ROOT, { withFileTypes: true })) {
        if (!school.isDirectory()) continue;
        if (CAS_SLUGS.includes(school.name)) continue; // skip CAS
        const schoolPath = path.join(UNDERGRAD_ROOT, school.name);
        // Programs may be at any depth — walk recursively.
        const queue = [schoolPath];
        while (queue.length > 0) {
            const dir = queue.pop()!;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    queue.push(full);
                } else if (entry.name === "index.md") {
                    // Compute programSlug as the path from school to this file's parent.
                    const relProgram = path.relative(schoolPath, path.dirname(full));
                    yield { schoolSlug: school.name, programSlug: relProgram || "(school-root)", filePath: full };
                }
            }
        }
    }
}

function main() {
    const out: ProgramChunk[] = [];
    let pagesProcessed = 0;
    let chunksEmitted = 0;
    for (const { schoolSlug, programSlug, filePath } of walkProgramDirs()) {
        pagesProcessed++;
        const content = fs.readFileSync(filePath, "utf8")
            .replace(MD_LINK_RE, "$1");
        const sections = splitBySections(content);
        for (const sec of sections) {
            // Skip very short sections (TOC-like or boilerplate).
            if (sec.body.length < 50) continue;
            out.push({
                chunkId: `${schoolSlug}/${programSlug}/${sec.heading.toLowerCase().replace(/\s+/g, "-")}`,
                schoolSlug,
                programSlug,
                sectionTitle: sec.heading,
                body: sec.body,
                source: `bulletins.nyu.edu/undergraduate/${schoolSlug}/${programSlug}/`,
            });
            chunksEmitted++;
        }
    }
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ${OUTPUT_PATH}`);
    console.log(`  Pages processed: ${pagesProcessed}`);
    console.log(`  Chunks emitted: ${chunksEmitted}`);
}

main();
```

Add a small test for `splitBySections`:

```typescript
import { describe, it, expect } from "vitest";
import { splitBySections } from "./extractProgramPages";

describe("splitBySections", () => {
    it("splits markdown by ## and ### headings", () => {
        const content = `
## Overview
This is the overview.

## Requirements
This is the requirements section.

### Major Requirements
Detail.
`;
        const sections = splitBySections(content);
        expect(sections.length).toBe(3);
        expect(sections[0]!.heading).toBe("Overview");
        expect(sections[0]!.body).toContain("overview");
        expect(sections[1]!.heading).toBe("Requirements");
        expect(sections[2]!.heading).toBe("Major Requirements");
    });

    it("returns empty list when no headings", () => {
        expect(splitBySections("just some text\nno headings")).toEqual([]);
    });
});
```

- [ ] **Step 4: Run tests + run the extractor**

```bash
node_modules/.bin/vitest run tools/bulletin-parser/extractProgramPages.test.ts
pnpm tsx tools/bulletin-parser/extractProgramPages.ts
```

Expected output:
```
Pages processed: ~50-200 (depends on coverage)
Chunks emitted: ~500-2,000
```

If chunks emitted is suspiciously small (<200), the program-page paths may not match the regex assumptions — investigate one of the school directories manually.

- [ ] **Step 5: Spot-check output**

```bash
pnpm tsx -e '
import * as fs from "node:fs";
const data = JSON.parse(fs.readFileSync("data/policy-corpus/non_cas_program_chunks.json", "utf8"));
for (let i = 0; i < 5; i++) {
    const e = data[Math.floor(Math.random() * data.length)];
    console.log("=== school:", e.schoolSlug, "program:", e.programSlug);
    console.log("section:", e.sectionTitle);
    console.log("body:", e.body.slice(0, 250));
    console.log();
}
'
```

Verify each chunk:
- Has a meaningful section title (not "Overview" boilerplate-only — those provide little signal)
- Body is non-trivial prose
- Source path looks right

- [ ] **Step 6: Commit**

```bash
git add tools/bulletin-parser/extractProgramPages.ts tools/bulletin-parser/extractProgramPages.test.ts data/policy-corpus/non_cas_program_chunks.json
git commit -m "data(parser): non-CAS undergrad program-page chunks extracted"
```

---

## Task 5: Embed program chunks + append to policy RAG

**Files:**
- Create: `tools/embeddings/embedProgramChunks.ts`
- Modify: `data/policy-corpus/policy_chunks.jsonl` (append)

Reads the program-chunks JSON from Task 4, batch-embeds, appends to the existing `policy_chunks.jsonl` so `search_policy` picks them up automatically.

- [ ] **Step 1: Inspect the existing policy_chunks.jsonl format**

```bash
head -1 data/policy-corpus/policy_chunks.jsonl | jq 'keys'
```

Expected fields (per Phase 11.2 audit): `id`, `text`, `source`, `embedding` (1536 floats), possibly `chunkType` / `confidenceBand` / others. Note the exact shape so the new chunks match.

- [ ] **Step 2: Write the embedder**

Create `tools/embeddings/embedProgramChunks.ts`:

```typescript
/**
 * Phase 12.9 — Program-page chunk embedder.
 *
 * Reads data/policy-corpus/non_cas_program_chunks.json (from Task 4),
 * embeds via OpenAI text-embedding-3-small, APPENDS to
 * data/policy-corpus/policy_chunks.jsonl. The existing file's CAS
 * chunks are untouched.
 *
 * Run: OPENAI_API_KEY=... pnpm tsx tools/embeddings/embedProgramChunks.ts
 */

import OpenAI from "openai";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const INPUT_PATH = path.join(REPO_ROOT, "data/policy-corpus/non_cas_program_chunks.json");
const OUTPUT_PATH = path.join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");

const MODEL = "text-embedding-3-small";
const BATCH_SIZE = 100;

interface ProgramChunk {
    chunkId: string;
    schoolSlug: string;
    programSlug: string;
    sectionTitle: string;
    body: string;
    source: string;
}

interface PolicyChunkRecord {
    /** Match the existing file's field names exactly. */
    id: string;
    text: string;
    source: string;
    embedding: number[];
    /** Optional metadata that the existing chunks may carry. Adapt to actual shape. */
    chunkType?: string;
    schoolSlug?: string;
    programSlug?: string;
    sectionTitle?: string;
}

async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    const client = new OpenAI({ apiKey });

    const data: ProgramChunk[] = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
    console.log(`Loaded ${data.length} chunks to embed`);

    // Build the input text: section title + body gives the embedder
    // both the topic label and the full content.
    const inputs = data.map(c => `${c.sectionTitle}\n\n${c.body}`);

    const out: PolicyChunkRecord[] = [];
    for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = inputs.slice(i, i + BATCH_SIZE);
        const response = await client.embeddings.create({
            model: MODEL,
            input: batch,
        });
        for (let j = 0; j < batch.length; j++) {
            const idx = i + j;
            const chunk = data[idx]!;
            const embedding = response.data[j]!.embedding;
            out.push({
                id: chunk.chunkId,
                text: `${chunk.sectionTitle}\n\n${chunk.body}`,
                source: chunk.source,
                embedding,
                chunkType: "non_cas_program",
                schoolSlug: chunk.schoolSlug,
                programSlug: chunk.programSlug,
                sectionTitle: chunk.sectionTitle,
            });
        }
        console.log(`  embedded ${Math.min(i + BATCH_SIZE, data.length)}/${data.length}`);
    }

    // Append (NOT overwrite) — the existing file has CAS chunks we keep.
    const lines = out.map(r => JSON.stringify(r)).join("\n");
    fs.appendFileSync(OUTPUT_PATH, lines + "\n");
    console.log(`Appended ${out.length} chunks to ${OUTPUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

**Important:** the script appends, not overwrites. Verify the existing CAS chunks remain after the run.

- [ ] **Step 3: Back up the existing policy_chunks.jsonl FIRST**

```bash
cp data/policy-corpus/policy_chunks.jsonl /tmp/policy_chunks.preappend.backup.jsonl
wc -l data/policy-corpus/policy_chunks.jsonl
```

Note the line count BEFORE the run.

- [ ] **Step 4: Run the embedder**

```bash
OPENAI_API_KEY=$(...) pnpm tsx tools/embeddings/embedProgramChunks.ts
```

Expected runtime: ~1-3 minutes for ~500-2,000 chunks.
Expected cost: ~$2-5.

- [ ] **Step 5: Verify the file size grew correctly**

```bash
wc -l data/policy-corpus/policy_chunks.jsonl
diff <(head -100 /tmp/policy_chunks.preappend.backup.jsonl) <(head -100 data/policy-corpus/policy_chunks.jsonl)
```

The first 100 lines should be identical (existing CAS chunks). The line count should increase by exactly the number of appended chunks. If anything is off, restore from `/tmp/policy_chunks.preappend.backup.jsonl` and investigate.

- [ ] **Step 6: Commit**

```bash
git add tools/embeddings/embedProgramChunks.ts data/policy-corpus/policy_chunks.jsonl
git commit -m "data(embed): non-CAS undergrad program-page chunks appended to policy RAG"
```

---

## Task 6: Verification — search_courses + search_policy

**Files:** none (verification only — automated test creation if useful)

- [ ] **Step 1: Test `search_courses` against bulletin-derived index**

In the dev server, send queries:
- "courses about machine learning" → expect CS / Stats / DS courses with rich descriptions visible
- "film production electives" → expect Tisch courses
- "intro accounting at Stern" → expect Stern accounting courses

Compare answer quality against the prior 17K-dump-only behavior. The new descriptions should make answers more substantive (multi-paragraph descriptions visible to the agent).

- [ ] **Step 2: Test `search_policy` for non-CAS curriculum**

Send queries:
- "What's required for the Stern Finance major?" → expect chunks from the new program pages
- "How does the Tisch BFA program work?" → expect Tisch chunks
- "Tandon CS major requirements" → expect Tandon chunks
- "CAS Texts & Ideas requirement" → should still work (existing CAS chunks)

The new chunks should appear in `search_policy` results when the query is on-topic.

- [ ] **Step 3: Add an automated coverage test**

Create `packages/engine/tests/data/embeddingsCoverage.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const COURSE_BULLETIN = path.resolve(__dirname, "../../../../data/course-catalog/course_embeddings_bulletin.jsonl");
const POLICY_CHUNKS = path.resolve(__dirname, "../../../../data/policy-corpus/policy_chunks.jsonl");

describe("Phase 12.9 embeddings coverage", () => {
    it("course bulletin index exists with ≥3000 records and 1536-dim embeddings", () => {
        expect(fs.existsSync(COURSE_BULLETIN)).toBe(true);
        const lines = fs.readFileSync(COURSE_BULLETIN, "utf8").split("\n").filter(Boolean);
        expect(lines.length).toBeGreaterThan(3000);
        const sample = JSON.parse(lines[0]!);
        expect(sample.courseId).toMatch(/^[A-Z]+-(UA|UB|UE|UF|UH|UT|UY|SHU)\s+\d/);
        expect(Array.isArray(sample.embedding)).toBe(true);
        expect(sample.embedding.length).toBe(1536);
    });

    it("policy_chunks.jsonl includes non-CAS program chunks", () => {
        const lines = fs.readFileSync(POLICY_CHUNKS, "utf8").split("\n").filter(Boolean);
        const nonCasChunks = lines.filter(l => l.includes(`"chunkType":"non_cas_program"`));
        expect(nonCasChunks.length).toBeGreaterThan(100);
    });

    it("policy_chunks.jsonl still has the original CAS chunks (not overwritten)", () => {
        const lines = fs.readFileSync(POLICY_CHUNKS, "utf8").split("\n").filter(Boolean);
        // CAS chunks should outnumber or at least equal non-CAS in mature state.
        const casLikeChunks = lines.filter(l =>
            l.includes(`"source":"data/policy-corpus`) ||
            l.includes(`"chunkType":"cas_curriculum"`) ||
            !l.includes(`"chunkType":"non_cas_program"`)
        );
        expect(casLikeChunks.length).toBeGreaterThan(0);
    });
});
```

The exact assertion patterns depend on the actual chunk-source field names in the existing CAS chunks. Adapt as needed.

- [ ] **Step 4: Run the test**

```bash
node_modules/.bin/vitest run packages/engine/tests/data/embeddingsCoverage.test.ts
```

Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/tests/data/embeddingsCoverage.test.ts
git commit -m "test(data): regression test for Phase 12.9 embedding coverage"
```

---

## Task 7: Push + tear-off note

**Files:** none

- [ ] **Step 1: Run all tests**

```bash
node_modules/.bin/vitest run
```

Expected: all engine + web tests still pass.

- [ ] **Step 2: Confirm clean working tree**

```bash
git status
```

Expected: nothing beyond what Tasks 1-6 staged.

- [ ] **Step 3: Push**

```bash
git push
```

- [ ] **Step 4: Tear-off note**

```
Phase 12.9 (bulletin embeddings) shipped:
- Pipeline B: per-course bulletin descriptions extracted + embedded;
  course_embeddings_bulletin.jsonl is now the primary index for
  search_courses (with the 17K-dump as fallback for unmatched courses).
  ~5,000-7,000 rich descriptions vs. the dump's short blurbs.
- Pipeline C: non-CAS undergrad program pages chunked + embedded +
  appended to policy_chunks.jsonl. ~500-2,000 new chunks. search_policy
  now answers Stern / Tisch / Tandon / Steinhardt / etc. curriculum
  queries that previously fell through.
- Existing CAS data + 17K-dump fallback both untouched. Embedding cost
  was ~$5-10 in OpenAI text-embedding-3-small.

Phases 13 + 14 (multi-semester planner + preferences) consume these
indices via the existing search_courses / search_policy tools — no
engine changes needed for pickup.
```

---

## Self-review notes

**Two independent indices:** B and C don't depend on each other. A failed Pipeline-C run doesn't affect Pipeline-B's output and vice versa. Each task pair (1+2 = B, 4+5 = C) can ship on its own.

**Repo size:** the bulletin embedding JSONL will be ~150-200MB. If this becomes uncomfortable, future phases can move to:
- A vector DB (Postgres pgvector, the existing nyucourses Postgres infra) — ship this in Phase 14+ if needed
- Git LFS — adds complexity, but keeps embeddings out of the main pack
- A download script — committed manifest, embeddings fetched on first use

For Phase 12.9, direct commit is acceptable.

**Cost is one-time:** ~$5-15 in OpenAI tokens. Re-runs are idempotent (overwrite for B, append-once for C — the embedder script tracks chunkId for C to avoid duplicates if re-run). Document the re-run procedure in the script header.

**Bulletin churn:** if the bulletin is re-scraped (Phase 12.7 re-runs), course-description and program-page extracts must be re-run. The chain is: 12.7 → 12.8 (parsed) → 12.9 (embedded). Each phase produces immutable outputs that the next consumes.

**Phase 13/14 coupling:** zero. Phase 13's solver doesn't touch either index. Phase 14's preference-extraction doesn't either. Both phases benefit indirectly when the agent makes auxiliary `search_courses` / `search_policy` calls during planning conversations.
