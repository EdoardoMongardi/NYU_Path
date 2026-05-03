#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 12.8 Task 4a — LLM-based prereq extractor with smoke testing
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
const SMOKE_OUTPUT_PATH = "/tmp/prereqs.smoke.json";

const IN_SCOPE_SUFFIXES = ["ua", "ub", "ue", "uh", "ut", "uy", "shu"] as const;

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

const SMOKE_TEST_COURSES = [
    { courseId: "CSCI-UA 101", suffix: "ua" },
    { courseId: "CSCI-UA 310", suffix: "ua" },
    { courseId: "MGMT-UB 2", suffix: "ub" },
    { courseId: "MATH-UA 121", suffix: "ua" },
    { courseId: "CS-UY 1134", suffix: "uy" },
];

// ============================================================
// SYSTEM PROMPT (with prompt caching)
// ============================================================

const SYSTEM_PROMPT = `You are a parser for NYU course prerequisite listings. Your task is to extract prerequisite information from bulletin text and return it as structured JSON.

## OUTPUT SCHEMA

You must respond with a single JSON object (no markdown, no prose):

{
  "course": "CSCI-UA 101",
  "prereqGroups": [
    {
      "type": "AND" | "OR" | "NOT",
      "courses": ["CSCI-UA 0101", "MATH-UA 0120"],
      "notCourses": ["CSCI-UA 0102"]?,
      "requiresPetition": true?
    }
  ],
  "coreqs": []
}

## KEY RULES

1. **Course ID Padding (Decision A):**
   - Inside prereqGroups[].courses and notCourses, zero-pad course numbers to 4 digits.
   - Example: "CSCI-UA 2" → "CSCI-UA 0002"
   - Example: "CSCI-UA 101" → "CSCI-UA 0101"
   - Example: "CS-UY 1114" → "CS-UY 1114" (already 4 digits)
   - Course numbers with letters (e.g., "INTM-SHU 140T-A") are passed through verbatim.
   - The entry-level "course" field is NEVER padded.

2. **Synthetic AP/IB IDs (Decision Y) + Placement Exams (Decision Y′):**
   - AP/IB clauses become synthetic IDs: "AP-<SUBJECT>-<SCORE>" or "IB-<SUBJECT>-<LEVEL>-<SCORE>"
   - Example: "Advanced Placement Examination Computer Science A >= 3" → "AP-CS-A-3"
   - Example: "IB Higher Level Mathematics >= 5" → "IB-MATH-HL-5"
   - NEVER emit "PLACEMENT_EXAM" — if unrecognized, omit and continue.
   - **Decision Y′ Placement Exam IDs (NEW):**
     * Math placement: "MATH_PLCM2 score of 100" → "PLACE-MATH-PLCM2-100"; "Math Placement Test score 85" → "PLACE-MATH-85"
     * Language placement: "Japanese Language Placement >= 3302" → "PLACE-LANG-JAPANESE-3302"; "Foreign language placement exam score 4" → "PLACE-LANG-4"
     * SAT II: "SAT II Math Level 2 score 700" → "SAT2-MATH2-700"; "SAT Subject Test in Chemistry >= 650" → "SAT2-CHEM-650"
     * NO fallback to PLACEMENT_EXAM. If the form is unclear, skip silently.

3. **Campus-Specific Prerequisites:**
   - When the bulletin lists "Prerequisite for Brooklyn Students: X | Prerequisite for Abu Dhabi Students: Y | Prerequisite for Shanghai Students: Z", collect ALL variants into a SINGLE OR group.
   - Example: "Prereq for Brooklyn: [A] or [B] | Prereq for Abu Dhabi: [C] or [D] | Prereq for Shanghai: [E]" → ONE OR group with [A, B, C, D, E].
   - Do NOT create separate groups per campus.

4. **Group Types:**
   - "AND": all prerequisites must be satisfied (separate groups in the output).
   - "OR": at least one of the listed courses satisfies the group.
   - "NOT": the notCourses field lists courses the student must NOT have taken.

5. **Petition Clauses:**
   - If a clause says "or instructor permission", "or department approval", "or consent of instructor", etc., set requiresPetition: true on that specific group.
   - Do NOT create a synthetic course for the permission itself.

6.5. **Boolean Precedence & Grouping (Critical for AND/OR parsing):**
   - **AND binds tighter than OR.** Parse as: "A AND B OR C" → "(A AND B) OR C", not "A AND (B OR C)".
   - **One group per top-level AND-clause.** When the bulletin contains multiple AND-connected courses, emit SEPARATE groups for each. Do NOT consolidate single-course AND clauses into a multi-course AND group.
     * WRONG: "CSCI-UA 102 AND MATH-UA 140" → `[{type:"AND", courses:["CSCI-UA 0102", "MATH-UA 0140"]}]`
     * RIGHT: "CSCI-UA 102 AND MATH-UA 140" → `[{type:"AND", courses:["CSCI-UA 0102"]}, {type:"AND", courses:["MATH-UA 0140"]}]`
   - **Follow bulletin parenthesization literally.** Example: bulletin says "(X) AND (Y) AND (Z)" → three separate AND groups. Do NOT reinterpret as "(X AND Y) OR Z" or other redistribution.
   - **Worked example (CSCI-UA 421 actual bulletin text):**
     Input: "Prerequisites: [CSCI-UA 102] AND [MATH-UA 140] with a Minimum Grade of C AND ([MATH-UA 121] or [MATH-UA 131])"
     Correct parsing:
     - {type:"AND", courses:["CSCI-UA 0102"]}
     - {type:"AND", courses:["MATH-UA 0140"]}
     - {type:"OR", courses:["MATH-UA 0121", "MATH-UA 0131"]}

7. **Corequisites:**
   - ALWAYS set coreqs: [] (empty array). Phase 14 will populate coreqs; the parser only outputs empty.
   - Even if the bulletin mentions "Corequisite: X", emit coreqs: [] and let Phase 14 handle it.

8. **Grade Thresholds:**
   - Ignore "Minimum Grade of X" annotations. The parser does not emit grade info.

9. **Empty Prerequisites:**
   - If there are no prerequisites, return {course, prereqGroups: [], coreqs: []}.

## AP/IB REFERENCE (Sample Common Mappings)

- "AP Computer Science A >= 3" → "AP-CS-A-3"
- "AP Computer Science Principles >= 4" → "AP-CS-P-4"
- "AP Calculus AB >= 4" → "AP-CALC-AB-4"
- "AP Calculus BC >= 5" → "AP-CALC-BC-5"
- "AP Statistics >= 3" → "AP-STATS-3"
- "AP Biology >= 3" → "AP-BIO-3"
- "AP Chemistry >= 3" → "AP-CHEM-3"
- "AP Physics 1 >= 3" → "AP-PHYS-1-3"
- "IB Higher Level Mathematics >= 5" → "IB-MATH-HL-5"
- "IB Standard Level Computer Science >= 5" → "IB-CS-SL-5"

If unrecognizable, omit (do NOT use PLACEMENT_EXAM).

## EXAMPLES

### Example 1: Simple OR with AP
Input: "Prerequisites: ([CSCI-UA 2] with a Minimum Grade of C OR [CSCI-SHU 11] OR [CSCI-UA 3] OR [CS-UY 1114] OR Advanced Placement Examination Computer Science A >= 3 OR Advanced Placement Examination Computer Science Principles >= 4)."
Output:
{
  "course": "CSCI-UA 101",
  "prereqGroups": [
    {
      "type": "OR",
      "courses": ["CSCI-UA 0002", "CSCI-SHU 0011", "CSCI-UA 0003", "CS-UY 1114", "AP-CS-A-3", "AP-CS-P-4"]
    }
  ],
  "coreqs": []
}

### Example 2: Multiple AND Groups Followed by OR
Input: "Prerequisites: [CSCI-UA 102] with a Minimum Grade of C AND [MATH-UA 120] with a Minimum Grade of C AND [MATH-UA 121] OR [MATH-UA 131]."
Output:
{
  "course": "CSCI-UA 310",
  "prereqGroups": [
    {
      "type": "AND",
      "courses": ["CSCI-UA 0102"]
    },
    {
      "type": "AND",
      "courses": ["MATH-UA 0120"]
    },
    {
      "type": "OR",
      "courses": ["MATH-UA 0121", "MATH-UA 0131"]
    }
  ],
  "coreqs": []
}

### Example 3: OR with NOT Clause
Input: "Prerequisites: [ECON-UB 1] OR [ECON-UB 2] OR [ECON-UA 2] OR [ECON-UA 10] OR [ECII-UF 102] OR [ECON-UH 2010] OR [ECON-SHU 3] AND Cannot have taken [MGMT-UB 18]."
Output:
{
  "course": "MGMT-UB 2",
  "prereqGroups": [
    {
      "type": "OR",
      "courses": ["ECON-UB 0001", "ECON-UB 0002", "ECON-UA 0002", "ECON-UA 0010", "ECII-UF 0102", "ECON-UH 2010", "ECON-SHU 0003"]
    },
    {
      "type": "NOT",
      "courses": [],
      "notCourses": ["MGMT-UB 0018"]
    }
  ],
  "coreqs": []
}

### Example 4: Empty Prerequisites
Input: (No "Prerequisites:" line)
Output:
{
  "course": "MATH-UA 121",
  "prereqGroups": [],
  "coreqs": []
}

### Example 5: Campus-Specific Collapsed to Single OR
Input: "Prerequisite for Brooklyn Students: [CS-UY 1114] or [CS-UY 1121] | Prerequisite for Abu Dhabi Students: [CS-UH 1001] or [ENGR-UH 1000] | Prerequisite for Shanghai Students: [CSCI-SHU 101]"
Output:
{
  "course": "CS-UY 1134",
  "prereqGroups": [
    {
      "type": "OR",
      "courses": ["CS-UY 1114", "CS-UY 1121", "CS-UH 1001", "ENGR-UH 1000", "CSCI-SHU 0101"]
    }
  ],
  "coreqs": []
}

### Example 6: Multiple AND Groups (Correct Grouping)
Input: "[CSCI-UA 102] AND [MATH-UA 140] with a Minimum Grade of C AND ([MATH-UA 121] or [MATH-UA 131])"
Output (CORRECT — three separate groups, not consolidated):
{
  "course": "CSCI-UA 421",
  "prereqGroups": [
    {
      "type": "AND",
      "courses": ["CSCI-UA 0102"]
    },
    {
      "type": "AND",
      "courses": ["MATH-UA 0140"]
    },
    {
      "type": "OR",
      "courses": ["MATH-UA 0121", "MATH-UA 0131"]
    }
  ],
  "coreqs": []
}

### Example 7: Decision Y′ Placement Exams
Input: "Prerequisites: ([MATH_PLCM2 score of 100] OR [MATH_PLCM3 score of 100] OR [CSCI-UA 101])"
Output:
{
  "course": "MATH-UA 251",
  "prereqGroups": [
    {
      "type": "OR",
      "courses": ["PLACE-MATH-PLCM2-100", "PLACE-MATH-PLCM3-100", "CSCI-UA 0101"]
    }
  ],
  "coreqs": []
}

### Example 8: SAT II Subject Test
Input: "Prerequisites: [SAT II Math Level 2 score 700] OR [CSCI-UA 10]"
Output:
{
  "course": "MATH-UA 123",
  "prereqGroups": [
    {
      "type": "OR",
      "courses": ["SAT2-MATH2-700", "CSCI-UA 0010"]
    }
  ],
  "coreqs": []
}

## PARSING STRATEGY

- Parse course codes: "[DEPT-XX YYYY]" or DEPT-XX YYYY.
- Parse AP/IB clauses per the reference.
- Collect campus-specific variants into ONE OR group (not separate groups per campus).
- Treat each AND-connected segment as a separate group; collect OR-connected segments within a group.
- Parse unambiguous parts; skip unparseable.
- Always emit coreqs: [] (even if the bulletin has coreqs).
`;

// ============================================================
// TYPES
// ============================================================

interface PrereqGroup {
    type: "AND" | "OR" | "NOT";
    courses: string[];
    notCourses?: string[];
    requiresPetition?: boolean;
}

interface ParsedPrereq {
    course: string;
    prereqGroups: PrereqGroup[];
    coreqs: string[];
}

interface CuratedEntry {
    course: string;
    prereqGroups: PrereqGroup[];
    coreqs: string[];
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function loadCuratedPrereqs(): Map<string, CuratedEntry> {
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

function extractPrereqText(chunk: string): string | null {
    const match = /\*\*Prerequisite(s)?:\*\*\s*(.+?)(?=\n\n|\n\*\*|\Z)/is.exec(
        chunk,
    );
    if (!match) {
        return null;
    }
    return match[2].trim();
}

async function callLLM(courseId: string, prereqText: string): Promise<string> {
    const client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const userMessage = `Course: ${courseId}\n\nPrerequisite text:\n${prereqText}`;

    const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: [
            {
                type: "text",
                text: SYSTEM_PROMPT,
                cache_control: { type: "ephemeral" },
            },
        ],
        messages: [
            {
                role: "user",
                content: userMessage,
            },
        ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
        throw new Error(`No text block in response for ${courseId}`);
    }

    return textBlock.text;
}

function parseJSONResponse(response: string): ParsedPrereq {
    let json = response.trim();
    json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    return JSON.parse(json);
}

function extractCourseChunks(filePath: string): Array<{
    courseId: string;
    chunk: string;
}> {
    const raw = readFileSync(filePath, "utf-8");

    const chunks: Array<{ courseId: string; chunk: string }> = [];
    const courseHeadingRe =
        /^\*\*([A-Z][A-Z0-9]*-(?:UA|UB|UE|UH|UT|UY|SHU)\s+\S+)\*\*/gm;

    let match: RegExpExecArray | null;
    const matches: Array<{ courseId: string; idx: number }> = [];

    while ((match = courseHeadingRe.exec(raw)) !== null) {
        matches.push({ courseId: match[1], idx: match.index });
    }

    for (let i = 0; i < matches.length; i++) {
        const startIdx = matches[i].idx;
        const endIdx = i + 1 < matches.length ? matches[i + 1].idx : raw.length;
        const chunk = raw.substring(startIdx, endIdx);
        chunks.push({ courseId: matches[i].courseId, chunk });
    }

    return chunks;
}

function normalizeArray(arr: string[]): string[] {
    return [...new Set(arr)].sort();
}

function prereqGroupsEqual(
    actual: PrereqGroup[],
    expected: PrereqGroup[],
): boolean {
    if (actual.length !== expected.length) return false;

    for (let i = 0; i < actual.length; i++) {
        const a = actual[i];
        const e = expected[i];

        if (a.type !== e.type) return false;
        if (a.requiresPetition !== e.requiresPetition) return false;

        const aCourses = normalizeArray(a.courses);
        const eCourses = normalizeArray(e.courses || []);
        if (aCourses.join(",") !== eCourses.join(",")) return false;

        const aNotCourses = normalizeArray(a.notCourses || []);
        const eNotCourses = normalizeArray(e.notCourses || []);
        if (aNotCourses.join(",") !== eNotCourses.join(",")) return false;
    }

    return true;
}

async function runSmokeTest(curated: Map<string, CuratedEntry>) {
    console.log("=== SMOKE TEST: 5 Hand-Picked Courses ===\n");

    let matches = 0;
    let mismatches = 0;
    const results: ParsedPrereq[] = [];

    for (const { courseId, suffix } of SMOKE_TEST_COURSES) {
        console.log(`\n--- ${courseId} ---`);

        const deptDirs = readdirSync(BULLETIN_DIR, { withFileTypes: true });
        let filePath: string | null = null;

        for (const dir of deptDirs) {
            if (!dir.isDirectory() || !dir.name.endsWith("_" + suffix)) continue;
            const candidatePath = join(BULLETIN_DIR, dir.name, "_index.md");
            try {
                const chunks = extractCourseChunks(candidatePath);
                if (chunks.find((c) => c.courseId === courseId)) {
                    filePath = candidatePath;
                    break;
                }
            } catch {
                continue;
            }
        }

        if (!filePath) {
            console.log(`ERROR: Could not find ${courseId} in bulletin`);
            mismatches++;
            continue;
        }

        const chunks = extractCourseChunks(filePath);
        const courseChunk = chunks.find((c) => c.courseId === courseId);

        if (!courseChunk) {
            console.log(`ERROR: Could not extract chunk for ${courseId}`);
            mismatches++;
            continue;
        }

        const prereqText = extractPrereqText(courseChunk.chunk);

        if (!prereqText) {
            const parsed: ParsedPrereq = {
                course: courseId,
                prereqGroups: [],
                coreqs: [],
            };
            results.push(parsed);
            console.log(`Parsed (no prerequisites): ${JSON.stringify(parsed)}`);
        } else {
            console.log(`Prerequisite text: ${prereqText.substring(0, 80)}...`);
            try {
                const response = await callLLM(courseId, prereqText);
                const parsed = parseJSONResponse(response);
                results.push(parsed);
                console.log(`Parsed: ${JSON.stringify(parsed)}`);
            } catch (err) {
                console.error(`ERROR parsing ${courseId}:`, err);
                mismatches++;
                continue;
            }
        }

        const curatedEntry = curated.get(courseId);
        if (curatedEntry) {
            const matched = prereqGroupsEqual(
                results[results.length - 1].prereqGroups,
                curatedEntry.prereqGroups,
            );

            if (matched) {
                console.log("✓ MATCH");
                matches++;
            } else {
                console.log("✗ MISMATCH");
                console.log(`  Expected: ${JSON.stringify(curatedEntry)}`);
                console.log(
                    `  Actual:   ${JSON.stringify(results[results.length - 1])}`,
                );
                mismatches++;
            }
        } else {
            console.log("(Not in curated baseline)");
        }
    }

    writeFileSync(SMOKE_OUTPUT_PATH, JSON.stringify(results, null, 2));
    console.log(
        `\n\n=== SMOKE TEST SUMMARY ===\nMatches: ${matches}/5\nMismatches: ${mismatches}/5\nOutput: ${SMOKE_OUTPUT_PATH}`,
    );

    return { matches, mismatches };
}

async function main() {
    const args = process.argv.slice(2);
    const isSmoke = args.includes("--smoke");

    const curated = loadCuratedPrereqs();

    if (isSmoke) {
        await runSmokeTest(curated);
    } else {
        console.log("Full extraction not yet implemented in Task 4a.");
        console.log("Run with --smoke for the 5-course smoke test.");
    }
}

main().catch(console.error);
