#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 14 Task 9 — LLM-assisted co-requisite extractor
//
// Mirrors extractPrereqs.ts (Phase 12.8 Task 4) structurally.
// Runs a cheap regex pre-filter (no LLM cost) and only calls
// the LLM for courses whose bulletin chunk contains a co-req
// pattern.  Skips courses already having non-empty coreqs in
// prereqs.json (trust existing data).
//
// Decision #14: extends `coreqs` field on existing prereqs.json
// entries where the bulletin mentions co-requisites using
// non-standard / unbracketed phrasings the Phase 12.8 regex
// missed (e.g. "Corequisite: EX-UY 1" without hyperlink markup,
// "must be taken concurrently with", etc.).
// ============================================================

// Load .env.local FIRST (before any other imports that might use process.env)
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
config({ path: join(REPO_ROOT, ".env.local"), override: true });
delete process.env.ANTHROPIC_BASE_URL;

// Now import everything else
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// ============================================================
// CONFIGURATION & CONSTANTS
// ============================================================

const BULLETIN_DIR = join(REPO_ROOT, "data/bulletin-raw/courses");
const PREREQS_JSON_PATH = join(
    REPO_ROOT,
    "packages/engine/src/data/prereqs.json",
);

const IN_SCOPE_SUFFIXES = ["ua", "ub", "ue", "uh", "ut", "uy", "shu"] as const;

// Cheap pre-filter — any bulletin chunk matching this gets sent to the LLM.
// Case-insensitive. Catches:
//   "**Corequisites:**", "Corequisite:", "Co-Req:", "Co-requisite:"
//   "must be taken concurrently", "must be taken with"
//   "concurrently with"
//   "co-listed with ... (must take both)"
export const COREQ_PATTERN = /corequisite|co-?req|concurrently|must be taken (with|concurrently)|co-?listed/i;

// ============================================================
// SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT = `You are a parser for NYU course co-requisite listings. Your task is to extract co-requisite course IDs from bulletin text and return them as a JSON array.

## OUTPUT SCHEMA

Respond with ONLY a JSON object (no markdown, no prose):

{
  "course": "BIOL-UA 100",
  "coreqs": ["BIOL-UA 0012"]
}

## KEY RULES

1. **What counts as a co-requisite:**
   - Courses listed under "**Corequisites:**", "Corequisite:", "Co-Req:", "Co-requisite:"
   - Courses explicitly stated to be taken "concurrently" or "simultaneously"
   - Courses in phrases like "must be taken with [X]", "must be taken concurrently with [X]"
   - Courses in "co-listed with [X] (must take both)" patterns
   - Inline within Prerequisites text: "[PREREQ-A] AND Corequisite [COREQ-B]"

2. **What does NOT count:**
   - Normal prerequisites (courses that must be taken BEFORE, not concurrently)
   - Suggestions ("expected to concurrently take" or "potential students... are expected to")
   - Phrases like "may be taken concurrently" — these are OPTIONAL, not required co-reqs
   - Cross-list mentions that don't mandate simultaneous enrollment

3. **Course ID formatting (zero-pad to 4 digits):**
   - Apply the EXACT SAME zero-padding as prereq IDs: pad course numbers to 4 digits.
   - "BIOL-UA 12" in the bulletin → "BIOL-UA 0012" in the output.
   - "EX-UY 1" in the bulletin → "EX-UY 0001" in the output.
   - "ME-UY 3313" (already 4 digits) → "ME-UY 3313" unchanged.
   - Course numbers with letters (e.g., "INTM-SHU 140T-A") are passed through verbatim.

4. **Empty result:**
   - If no required co-requisites found, emit coreqs: [].

5. **Valid NYU course IDs:**
   - Must match: DEPT-SUFFIX NUMBER where SUFFIX is one of UA, UB, UE, UF, UG, UH, UT, UY, SHU
   - Ignore any non-course text (eligibility, standing requirements, etc.)

## RESPONSE FORMAT

Respond with the JSON object ONLY. No prose, no markdown. Begin with \`{\` and end with \`}\`.

## EXAMPLES

### Example 1: Standard "**Corequisites:**" field
Input (BIOL-UA 100):
"**Corequisites:** [BIOL-UA 12]."

Output:
{"course": "BIOL-UA 100", "coreqs": ["BIOL-UA 0012"]}

### Example 2: Unbracketed co-requisite (MA-UY 914)
Input:
"...Corequisite: EX-UY 1\\n\\n**Corequisites:** EX-UY 1."

Output:
{"course": "MA-UY 914", "coreqs": ["EX-UY 0001"]}

### Example 3: Multiple co-requisites
Input (BMS-UY 2001):
"**Corequisites:** [BMS-UY 2003]."

Output:
{"course": "BMS-UY 2001", "coreqs": ["BMS-UY 2003"]}

### Example 4: "May be taken concurrently" — optional, NOT a required coreq
Input (BIOL-UA 63):
"Prerequisite: Fundamentals of Ecology (BIOL UA-63) (may be taken concurrently)."

Output:
{"course": "BIOL-UA 64", "coreqs": []}

### Example 5: Inline in Prerequisites text
Input (MPATC-UE 9322):
"Prerequisites: [MPATC-UE 1302] AND Corequisite [MPATC-UE 9312]."

Output:
{"course": "MPATC-UE 9322", "coreqs": ["MPATC-UE 9312"]}
`;

// ============================================================
// TYPES
// ============================================================

interface CuratedEntry {
    course: string;
    prereqGroups: Array<{
        type: "AND" | "OR" | "NOT";
        courses: string[];
        notCourses?: string[];
        requiresPetition?: boolean;
    }>;
    coreqs: string[];
    minGrades?: Record<string, string>;
}

interface CoreqParseResult {
    course: string;
    coreqs: string[];
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

export function loadCuratedPrereqs(): Map<string, CuratedEntry> {
    try {
        const raw = readFileSync(PREREQS_JSON_PATH, "utf-8");
        const entries = JSON.parse(raw) as CuratedEntry[];
        const map = new Map<string, CuratedEntry>();
        for (const entry of entries) {
            map.set(entry.course, entry);
        }
        return map;
    } catch {
        return new Map();
    }
}

// Balanced-brace JSON extractor (same as extractPrereqs.ts)
function extractFirstJsonObject(text: string): string | null {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (escape) { escape = false; continue; }
        if (c === "\\") { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === "{") {
            if (depth === 0) start = i;
            depth++;
        } else if (c === "}") {
            depth--;
            if (depth === 0 && start >= 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

function extractCourseChunks(filePath: string): Array<{ courseId: string; chunk: string }> {
    const raw = readFileSync(filePath, "utf-8");
    const chunks: Array<{ courseId: string; chunk: string }> = [];
    const courseHeadingRe = /^\*\*([A-Z][A-Z0-9]*-[A-Z]+\s+\S+)\*\*/gm;

    let match: RegExpExecArray | null;
    const matches: Array<{ courseId: string; idx: number }> = [];
    while ((match = courseHeadingRe.exec(raw)) !== null) {
        matches.push({ courseId: match[1]!, idx: match.index });
    }

    for (let i = 0; i < matches.length; i++) {
        const startIdx = matches[i]!.idx;
        const endIdx = i + 1 < matches.length ? matches[i + 1]!.idx : raw.length;
        const chunk = raw.substring(startIdx, endIdx);
        chunks.push({ courseId: matches[i]!.courseId, chunk });
    }
    return chunks;
}

async function callLLM(courseId: string, chunk: string): Promise<string> {
    const client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const userMessage = `Course: ${courseId}\n\nBulletin text:\n${chunk.slice(0, 2000)}`;

    const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: [
            {
                type: "text",
                text: SYSTEM_PROMPT,
                cache_control: { type: "ephemeral" },
            },
        ],
        messages: [
            { role: "user", content: userMessage },
            { role: "assistant", content: "{" },
        ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
        throw new Error(`No text block in response for ${courseId}`);
    }
    return "{" + textBlock.text;
}

function parseJSONResponse(response: string): CoreqParseResult {
    const jsonStr = extractFirstJsonObject(response);
    if (!jsonStr) {
        throw new Error(`Could not extract JSON from response: ${response.substring(0, 100)}`);
    }
    return JSON.parse(jsonStr) as CoreqParseResult;
}

// ============================================================
// MAIN EXTRACTION LOGIC
// ============================================================

async function runExtraction() {
    const curated = loadCuratedPrereqs();

    // Count before
    let beforeCount = 0;
    for (const [, entry] of curated) {
        if (entry.coreqs.length > 0) beforeCount++;
    }
    console.log(`Starting extraction. Entries with coreqs BEFORE: ${beforeCount}`);

    // Enumerate all in-scope bulletin directories
    let dirList: string[];
    try {
        dirList = readdirSync(BULLETIN_DIR);
    } catch (err) {
        console.error(`Cannot read BULLETIN_DIR: ${BULLETIN_DIR}`, err);
        process.exit(1);
    }

    const inScopeSet = new Set(IN_SCOPE_SUFFIXES);
    const inScopeDirs = dirList.filter(dir => {
        const parts = dir.split("_");
        const suffix = parts[parts.length - 1];
        return suffix && inScopeSet.has(suffix as typeof IN_SCOPE_SUFFIXES[number]);
    });

    console.log(`Scanning ${inScopeDirs.length} in-scope department directories...`);

    let scanned = 0;
    let filtered = 0; // passed regex pre-filter
    let skippedAlready = 0;
    let llmCalled = 0;
    let updated = 0;
    let errors = 0;

    for (const dir of inScopeDirs) {
        const filePath = join(BULLETIN_DIR, dir, "_index.md");
        let chunks: Array<{ courseId: string; chunk: string }>;
        try {
            chunks = extractCourseChunks(filePath);
        } catch {
            continue; // no _index.md or unreadable
        }

        for (const { courseId, chunk } of chunks) {
            scanned++;

            // Cheap regex pre-filter
            if (!COREQ_PATTERN.test(chunk)) continue;
            filtered++;

            // Skip if already has non-empty coreqs (trust existing data)
            const existing = curated.get(courseId);
            if (existing && existing.coreqs.length > 0) {
                skippedAlready++;
                continue;
            }

            // Call LLM
            llmCalled++;
            try {
                const response = await callLLM(courseId, chunk);
                const result = parseJSONResponse(response);

                if (result.coreqs && result.coreqs.length > 0) {
                    // Write back into the curated map
                    if (existing) {
                        existing.coreqs = result.coreqs;
                    } else {
                        curated.set(courseId, {
                            course: courseId,
                            prereqGroups: [],
                            coreqs: result.coreqs,
                        });
                    }
                    updated++;
                    console.log(`  ++ ${courseId}: coreqs = ${JSON.stringify(result.coreqs)}`);
                }

                // Rate-limit: ~10 req/s = 100ms delay
                await new Promise(res => setTimeout(res, 100));
            } catch (err) {
                errors++;
                console.error(`  ERROR ${courseId}: ${String(err).slice(0, 120)}`);
            }
        }
    }

    // Write back sorted
    const merged = Array.from(curated.values()).sort((a, b) => a.course.localeCompare(b.course));
    writeFileSync(PREREQS_JSON_PATH, JSON.stringify(merged, null, 2));

    // Count after
    let afterCount = 0;
    for (const entry of merged) {
        if (entry.coreqs.length > 0) afterCount++;
    }

    console.log(`\n=== EXTRACTION COMPLETE ===`);
    console.log(`  Courses scanned      : ${scanned}`);
    console.log(`  Passed regex filter  : ${filtered}`);
    console.log(`  Skipped (had coreqs) : ${skippedAlready}`);
    console.log(`  LLM calls made       : ${llmCalled}`);
    console.log(`  Entries updated      : ${updated}`);
    console.log(`  Errors               : ${errors}`);
    console.log(`  Entries with coreqs BEFORE: ${beforeCount}`);
    console.log(`  Entries with coreqs AFTER : ${afterCount}`);
    console.log(`  Delta                : +${afterCount - beforeCount}`);
}

// ============================================================
// Entry point
// ============================================================

async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--help")) {
        console.log("Usage: pnpm tsx tools/bulletin-parser/extractCoreqs.ts");
        console.log("  No flags needed. Runs the full extraction over all in-scope bulletin dirs.");
        return;
    }
    await runExtraction();
}

main().catch(console.error);
