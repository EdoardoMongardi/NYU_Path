# Phase 12.8 — Bulletin Parsing → Structured Prereqs + Term Offerings

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse the bulletin markdown files (full undergrad coverage from Phase 12.7) into structured `prereqs.json` and `coursesOfferings.json` data files that Phase 13's constraint-satisfaction solver consumes. Output files ride alongside the existing `packages/engine/src/data/courses.json` and `prereqs.json`.

**Architecture:** Two extractors, one per signal:
- **Offering extractor** (deterministic regex): walks every `data/bulletin-raw/courses/*/index.md` (or equivalent), extracts `Typically offered <terms>` lines, writes structured `termsOffered: ["fall", "spring", ...]` per courseId.
- **Prereq extractor** (LLM-assisted): walks the same files, finds `Prerequisites:` blocks, parses the English boolean expression into the existing `PrereqGroup` discriminated-union shape using `claude-haiku-4-5`. Validates against the 27 hand-curated entries already in the repo as ground truth — must match before expanding to uncurated courses. AP/IB exam clauses get materialized as synthetic course IDs (`AP-CS-A-3`, `IB-MATH-HL-5`). Instructor-permission clauses get a `requiresPetition: true` flag.

**Tech Stack:** TypeScript scripts + Anthropic SDK (`claude-haiku-4-5`) for prereq parsing. Output: JSON files in `packages/engine/src/data/`. Validation: regression-test against the 27 curated entries.

**Out of scope:**
- Co-requisites (Phase 14)
- Cross-listed-course resolution beyond what's in the bulletin
- Inferring offering patterns from FOSE history
- Manual curation of the 27 ground-truth entries (those stay as-is; the parser must match them)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `tools/bulletin-parser/extractOfferings.ts` | **Create** | Deterministic regex extractor. Walks bulletin markdown, finds `Typically offered <terms>` lines, emits `data/courses-offerings.generated.json`. |
| `tools/bulletin-parser/extractPrereqs.ts` | **Create** | LLM-assisted parser. Walks bulletin markdown, finds `Prerequisites:` blocks, calls `claude-haiku-4-5` with a structured-output schema, emits `packages/engine/src/data/prereqs.generated.json`. |
| `tools/bulletin-parser/validatePrereqs.ts` | **Create** | Regression check. Compares the generated prereqs against the 27 curated entries in `packages/engine/src/data/prereqs.json`. Fails the run if any curated entry's parse doesn't match. |
| `tools/bulletin-parser/syntheticCourseIds.ts` | **Create** | Helper module: maps AP exam name + score → synthetic courseId (e.g. "AP Computer Science A ≥ 3" → `AP-CS-A-3`). |
| `tools/bulletin-parser/types.ts` | **Create** | Shared types between the two extractors and the validator. |
| `packages/engine/src/data/prereqs.json` | **Modify** | Append the new entries (parser output) to the existing 27 hand-curated entries. New shape: full undergrad-school coverage. |
| `packages/engine/src/data/courses-offerings.json` | **Create** | New file: structured `termsOffered` per courseId across all undergrad schools. Replaces the partial `termsOffered` field already in `courses.json` for the 85 bundled courses. |
| `packages/shared/src/types.ts` | **Modify** | Extend `PrereqGroup` with `requiresPetition?: boolean`, `apEquivalent?: string` fields. |
| `packages/engine/tests/data/parsedDataValidation.test.ts` | **Create** | Vitest suite that loads the generated files and asserts shape + the 27-curated-match invariant. |

---

## Task 1: Define enriched `PrereqGroup` schema

**Files:**
- Modify: `packages/shared/src/types.ts`

The existing `PrereqGroup` has `type: "AND" | "OR"`, `courses: string[]`, `coreqs: string[]`. We extend with two optional fields capturing the design decisions locked in:

- `requiresPetition?: boolean` — soft-allow flag for "or instructor permission" / "or department approval" clauses (decision #3, middle path: place + flag).
- `notCourses?: string[]` — courses that, if taken, EXCLUDE the student from the dependent course (decision #1, strict NOT support).

AP/IB equivalencies become synthetic courseIds (decision #2, strict synthetic codes) — they show up as normal entries in `courses[]` so no schema change there.

- [ ] **Step 1: Find the existing `PrereqGroup`**

```bash
grep -n "PrereqGroup\|type:.*AND.*OR" packages/shared/src/types.ts
```

Quote the current shape so we know what to extend.

- [ ] **Step 2: Extend the type**

Replace the existing `PrereqGroup` definition with:

```typescript
/**
 * Phase 12.8 — Prerequisite group for a course. A course's prereqs
 * are an array of these groups; ALL groups must be satisfied (implicit
 * top-level AND).
 *
 * Within a group:
 *   - type === "AND"   → every entry in `courses` must be satisfied
 *   - type === "OR"    → at least one entry in `courses` must be satisfied
 *   - type === "NOT"   → none of the entries in `courses` may have been taken
 *                        (Phase 13 enforces; rare in CAS but real)
 *
 * Optional fields:
 *   - `requiresPetition` — true when this group's English text mentioned
 *     "or instructor permission" / "or department approval". The solver
 *     treats the group as soft-satisfied (course can be placed) but the
 *     UI surfaces a flag so the student knows a real-world step is needed.
 *   - `notCourses` — explicit list of courses that block enrollment if
 *     the student took them. Distinct from `courses` because the polarity
 *     differs (NOT excludes; AND/OR include).
 */
export interface PrereqGroup {
    type: "AND" | "OR" | "NOT";
    courses: string[];
    coreqs?: string[];
    requiresPetition?: boolean;
    notCourses?: string[];
}

export interface CoursePrereqs {
    course: string;
    prereqGroups: PrereqGroup[];
}
```

- [ ] **Step 3: Type-check**

```bash
cd packages/shared && npx tsc --noEmit
cd ../engine && npx tsc --noEmit
```

Expected: clean (the 27 curated entries don't use the new optional fields, so they remain valid).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): PrereqGroup gains NOT type + requiresPetition/notCourses fields"
```

---

## Task 2: AP/IB synthetic-courseId helper

**Files:**
- Create: `tools/bulletin-parser/syntheticCourseIds.ts`
- Create: `tools/bulletin-parser/syntheticCourseIds.test.ts` (or under `packages/engine/tests/data/`)

When the parser sees `"Advanced Placement Examination Computer Science A >= 3"` it must turn that into a synthetic courseId. The student profile gets the same synthetic IDs added to `coursesTaken` (per decision #2, strict modeling). This helper is the canonical mapping.

- [ ] **Step 1: Write the failing test**

Create `tools/bulletin-parser/syntheticCourseIds.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { synthesizeCourseId, parseAPClause, parseIBClause } from "./syntheticCourseIds";

describe("synthesizeCourseId", () => {
    it("maps AP CS A score 3 to AP-CS-A-3", () => {
        expect(synthesizeCourseId({ exam: "AP Computer Science A", score: 3 }))
            .toBe("AP-CS-A-3");
    });

    it("maps AP Calculus BC score 5 to AP-CALC-BC-5", () => {
        expect(synthesizeCourseId({ exam: "AP Calculus BC", score: 5 }))
            .toBe("AP-CALC-BC-5");
    });

    it("maps IB HL Mathematics score 6 to IB-MATH-HL-6", () => {
        expect(synthesizeCourseId({ exam: "IB Higher Level Mathematics", score: 6 }))
            .toBe("IB-MATH-HL-6");
    });

    it("returns null for unrecognized exam names", () => {
        expect(synthesizeCourseId({ exam: "Random Exam", score: 5 }))
            .toBeNull();
    });
});

describe("parseAPClause", () => {
    it("extracts AP CS A score 3 from bulletin English", () => {
        const out = parseAPClause("Advanced Placement Examination Computer Science A >= 3");
        expect(out).toEqual({ exam: "AP Computer Science A", score: 3 });
    });

    it("extracts AP Calc BC score 4 with greater-equal symbol", () => {
        const out = parseAPClause("AP Calculus BC ≥ 4");
        expect(out).toEqual({ exam: "AP Calculus BC", score: 4 });
    });

    it("returns null when no AP clause is present", () => {
        expect(parseAPClause("CSCI-UA 2 with a Minimum Grade of C")).toBeNull();
    });
});

describe("parseIBClause", () => {
    it("extracts IB HL Math score 5", () => {
        expect(parseIBClause("IB Higher Level Mathematics 5"))
            .toEqual({ exam: "IB Higher Level Mathematics", score: 5 });
    });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
node_modules/.bin/vitest run tools/bulletin-parser/syntheticCourseIds.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the helper**

Create `tools/bulletin-parser/syntheticCourseIds.ts`:

```typescript
/**
 * Phase 12.8 — Synthetic courseIds for AP / IB / placement-exam
 * equivalencies. When a bulletin prereq says "AP Computer Science A
 * >= 3", we mint a courseId like "AP-CS-A-3" and treat it as a normal
 * entry in the prereq tree. The student profile must include matching
 * synthetic IDs in `coursesTaken` for the prereq to resolve as
 * satisfied; this is wired by the DPR ingest path (Phase 13 follow-up
 * after this Phase ships).
 *
 * Naming convention:
 *   AP-<SUBJECT-CODE>-<SCORE>
 *   IB-<SUBJECT-CODE>-<LEVEL>-<SCORE>
 *
 * Subject codes mirror AP's official short codes where possible
 * (CS-A, CALC-BC, BIO, CHEM, etc.). For IB, level is HL/SL.
 */

export interface ExamScore {
    exam: string;
    score: number;
}

const AP_SUBJECT_CODES: Record<string, string> = {
    "ap computer science a": "CS-A",
    "ap computer science principles": "CS-P",
    "ap calculus ab": "CALC-AB",
    "ap calculus bc": "CALC-BC",
    "ap statistics": "STATS",
    "ap biology": "BIO",
    "ap chemistry": "CHEM",
    "ap physics 1": "PHYS-1",
    "ap physics 2": "PHYS-2",
    "ap physics c mechanics": "PHYS-C-MECH",
    "ap physics c electricity and magnetism": "PHYS-C-EM",
    "ap microeconomics": "ECON-MICRO",
    "ap macroeconomics": "ECON-MACRO",
    "ap us history": "USH",
    "ap world history": "WH",
    "ap european history": "EH",
    "ap english language and composition": "ENG-LANG",
    "ap english literature and composition": "ENG-LIT",
    "ap psychology": "PSYCH",
    "ap french language and culture": "FRENCH",
    "ap spanish language and culture": "SPANISH",
    "ap chinese language and culture": "CHINESE",
    "ap latin": "LATIN",
};

const IB_SUBJECT_CODES: Record<string, string> = {
    "ib higher level mathematics": "MATH",
    "ib higher level computer science": "CS",
    "ib higher level chemistry": "CHEM",
    "ib higher level biology": "BIO",
    "ib higher level physics": "PHYS",
    "ib higher level economics": "ECON",
    "ib higher level history": "HIST",
    "ib standard level mathematics": "MATH",
    "ib standard level computer science": "CS",
    // ...extend as needed
};

export function synthesizeCourseId(exam: ExamScore): string | null {
    const key = exam.exam.toLowerCase().trim();
    if (key.startsWith("ap ")) {
        const code = AP_SUBJECT_CODES[key];
        if (!code) return null;
        return `AP-${code}-${exam.score}`;
    }
    if (key.startsWith("ib ")) {
        const code = IB_SUBJECT_CODES[key];
        if (!code) return null;
        const level = key.includes("higher level") ? "HL" : key.includes("standard level") ? "SL" : "";
        return level ? `IB-${code}-${level}-${exam.score}` : null;
    }
    return null;
}

const AP_CLAUSE_RE = /(?:AP|Advanced Placement(?:\s+Examination)?)\s+([A-Za-z][A-Za-z0-9\s]*?)\s*[≥>=]+\s*(\d)/i;

export function parseAPClause(text: string): ExamScore | null {
    const m = AP_CLAUSE_RE.exec(text);
    if (!m) return null;
    const subject = m[1]!.trim();
    const score = parseInt(m[2]!, 10);
    return { exam: `AP ${subject}`, score };
}

const IB_CLAUSE_RE = /IB\s+(Higher Level|Standard Level)\s+([A-Za-z][A-Za-z\s]+?)\s*(\d)/i;

export function parseIBClause(text: string): ExamScore | null {
    const m = IB_CLAUSE_RE.exec(text);
    if (!m) return null;
    const level = m[1]!.trim();
    const subject = m[2]!.trim();
    const score = parseInt(m[3]!, 10);
    return { exam: `IB ${level} ${subject}`, score };
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
node_modules/.bin/vitest run tools/bulletin-parser/syntheticCourseIds.test.ts
```

Expected: 9/9 PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/bulletin-parser/syntheticCourseIds.ts tools/bulletin-parser/syntheticCourseIds.test.ts
git commit -m "feat(parser): synthetic courseIds for AP/IB exam equivalencies"
```

---

## Task 3: Offering extractor (deterministic regex)

**Files:**
- Create: `tools/bulletin-parser/extractOfferings.ts`
- Create: `packages/engine/src/data/courses-offerings.json` (generated; commit the output)

Walks every `data/bulletin-raw/courses/<DEPT>_<SCHOOL>/<NUMBER>/index.md` (or whatever path the scraper produces). Looks for `Typically offered <terms>` lines. Emits a JSON file: `{ "CSCI-UA 101": { termsOffered: ["fall", "spring", "summer"] }, ... }`.

- [ ] **Step 1: Sample the bulletin format**

```bash
head -30 data/bulletin-raw/courses/CSCI_UA/101/index.md
head -30 data/bulletin-raw/courses/MATH_UA/121/index.md
head -30 data/bulletin-raw/courses/ECON_UA/1/index.md
```

Note the exact phrasing. Expected variants:
- `*Typically offered Fall, Spring, and Summer terms*`
- `*Typically offered Fall and Spring*`
- `*Typically offered Fall*`
- `*Typically offered Spring*`
- (no "Typically offered" line at all — assume `["fall", "spring"]` default)

Document any unusual variants found.

- [ ] **Step 2: Write the extractor**

Create `tools/bulletin-parser/extractOfferings.ts`:

```typescript
/**
 * Phase 12.8 — Offering extractor.
 * Walks bulletin markdown, extracts "Typically offered <terms>" lines,
 * emits a structured JSON map of courseId → termsOffered.
 *
 * Run: pnpm tsx tools/bulletin-parser/extractOfferings.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const BULLETIN_DIR = path.join(REPO_ROOT, "data/bulletin-raw/courses");
const OUTPUT_PATH = path.join(REPO_ROOT, "packages/engine/src/data/courses-offerings.json");

type Term = "fall" | "spring" | "summer" | "january";

interface OfferingEntry {
    termsOffered: Term[];
    /** Raw "Typically offered ..." line for audit. Empty if no line was found
     *  (then `termsOffered` defaults to ["fall", "spring"] and `inferred` is true). */
    rawLine: string;
    /** True when no offering line was present and we used the default. */
    inferred: boolean;
}

const TYPICAL_RE = /\*?\s*Typically\s+offered\s+([^.*]+)\*?/i;

function parseOfferingLine(line: string): { terms: Term[]; raw: string } {
    const m = TYPICAL_RE.exec(line);
    if (!m) return { terms: [], raw: "" };
    const text = m[1]!.toLowerCase();
    const terms: Term[] = [];
    if (/\bfall\b/.test(text)) terms.push("fall");
    if (/\bspring\b/.test(text)) terms.push("spring");
    if (/\bsummer\b/.test(text)) terms.push("summer");
    if (/\bjanuary\b|\bj-?term\b|\bintersession\b/.test(text)) terms.push("january");
    return { terms, raw: m[0]! };
}

function readBulletin(filePath: string): { terms: Term[]; raw: string; inferred: boolean } {
    let content = "";
    try {
        content = fs.readFileSync(filePath, "utf8");
    } catch {
        return { terms: ["fall", "spring"], raw: "", inferred: true };
    }
    for (const line of content.split("\n")) {
        if (TYPICAL_RE.test(line)) {
            const parsed = parseOfferingLine(line);
            if (parsed.terms.length === 0) continue;
            return { terms: parsed.terms, raw: parsed.raw, inferred: false };
        }
    }
    return { terms: ["fall", "spring"], raw: "", inferred: true };
}

function main() {
    const out: Record<string, OfferingEntry> = {};
    let totalCourses = 0;
    let inferredCount = 0;
    const deptDirs = fs.readdirSync(BULLETIN_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());
    for (const dept of deptDirs) {
        const m = /^([A-Z]{2,5})_(UA|UB|UE|UF|UH|UT|UY|SHU)$/.exec(dept.name);
        if (!m) continue;
        const [, deptCode, schoolCode] = m;
        const courseNumDirs = fs.readdirSync(path.join(BULLETIN_DIR, dept.name), { withFileTypes: true })
            .filter(d => d.isDirectory());
        for (const courseDir of courseNumDirs) {
            const courseId = `${deptCode}-${schoolCode} ${courseDir.name}`;
            const indexPath = path.join(BULLETIN_DIR, dept.name, courseDir.name, "index.md");
            const result = readBulletin(indexPath);
            out[courseId] = {
                termsOffered: result.terms,
                rawLine: result.raw,
                inferred: result.inferred,
            };
            totalCourses++;
            if (result.inferred) inferredCount++;
        }
    }
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ${OUTPUT_PATH}`);
    console.log(`  Total courses: ${totalCourses}`);
    console.log(`  Inferred (default fall+spring): ${inferredCount} (${(inferredCount / totalCourses * 100).toFixed(1)}%)`);
}

main();
```

If the bulletin file path differs from `<DEPT>_<SCHOOL>/<NUMBER>/index.md` (e.g. it's `index.html`, or files are flat in the dept dir without a numbered subdir), adjust the walker. Read 5-10 sample dept dirs first to confirm.

- [ ] **Step 3: Run the extractor**

```bash
pnpm tsx tools/bulletin-parser/extractOfferings.ts
```

Expected output:
```
Wrote .../packages/engine/src/data/courses-offerings.json
  Total courses: ~5,000-7,000
  Inferred (default fall+spring): ~5-15% (good)
```

If the inferred percentage is >25%, the regex is missing a common bulletin variant. Add it to `parseOfferingLine` and re-run.

- [ ] **Step 4: Spot-check the output**

```bash
cat packages/engine/src/data/courses-offerings.json | head -50
```

Verify the 5 audit courses (CSCI-UA 101, MATH-UA 121, ECON-UA 1, CORE-UA 400, HIST-UA 1) all appear with sensible `termsOffered` arrays.

- [ ] **Step 5: Commit**

```bash
git add tools/bulletin-parser/extractOfferings.ts packages/engine/src/data/courses-offerings.json
git commit -m "data(parser): courses-offerings.json — termsOffered for all undergrad courses"
```

---

## Task 4: Prereq extractor (LLM-assisted)

**Files:**
- Create: `tools/bulletin-parser/extractPrereqs.ts`
- Modify: `packages/engine/src/data/prereqs.json` (extends the existing 27-entry hand-curated file)

The prereq parser walks bulletin markdown, finds `Prerequisites:` blocks, and uses `claude-haiku-4-5` (with structured JSON output via the SDK's `tool_use` mode) to convert the English boolean expression into the `PrereqGroup[]` shape. The 27 hand-curated entries are the validation gold standard (Task 5 enforces parity).

- [ ] **Step 1: Define the output schema**

The LLM must produce JSON matching this shape (per Task 1's enriched type):

```typescript
{
  "course": "CSCI-UA 310",
  "prereqGroups": [
    {
      "type": "AND" | "OR" | "NOT",
      "courses": ["CSCI-UA 102", ...],
      "coreqs": [],
      "requiresPetition": false,  // true when "or instructor permission"
      "notCourses": []  // populated when type === "NOT"
    },
    ...
  ]
}
```

AP / IB clauses get materialized via `synthesizeCourseId()` (Task 2) into the same `courses` array as normal courseIds.

- [ ] **Step 2: Build the extractor's system prompt**

The prompt is the parser's contract. Quote the bulletin format, give 3 worked examples (one simple, one with AP, one with NOT), state the output schema, list edge cases.

```typescript
const SYSTEM_PROMPT = `
You are parsing NYU course-bulletin prerequisite strings into a
structured JSON form. The input is the English text after
"Prerequisites:" in a bulletin entry. The output is a JSON object
matching this schema:

{
  "prereqGroups": [
    {
      "type": "AND" | "OR" | "NOT",
      "courses": ["CSCI-UA 102", ...],
      "coreqs": [],
      "requiresPetition": false,
      "notCourses": []
    }
  ]
}

Rules:
1. Each top-level group represents one constraint. The constraints are
   AND-ed at the top level — ALL groups must be satisfied.
2. Within a group:
   - "AND" → every course in \`courses\` must be satisfied.
   - "OR" → at least one course in \`courses\` must be satisfied.
   - "NOT" → none of the courses in \`notCourses\` may have been taken.
3. AP / IB / placement exam scores become synthetic courseIds:
   - "AP Computer Science A >= 3" → "AP-CS-A-3"
   - "AP Calculus BC >= 4" → "AP-CALC-BC-4"
   - "IB Higher Level Mathematics 5" → "IB-MATH-HL-5"
   These go in the SAME \`courses\` array as normal courseIds.
4. "or instructor permission" / "or department approval" sets
   \`requiresPetition: true\` on the group it modifies. Do NOT add a
   synthetic course for the permission itself.
5. "Minimum Grade of C" annotations are IGNORED. The DPR's satisfied
   flag handles grade thresholds; we don't model them here.
6. Cross-listed alternatives (e.g. "CSCI-UA 2 OR CSCI-SHU 11") are
   represented as multiple courses inside an "OR" group.
7. If the prereq text is empty or just "None.", return
   \`{"prereqGroups": []}\`.

Worked examples:

Input: "CSCI-UA 102 AND MATH-UA 120 AND (MATH-UA 121 OR MATH-UA 131)"
Output: {
  "prereqGroups": [
    {"type": "AND", "courses": ["CSCI-UA 102"], "coreqs": [], "requiresPetition": false, "notCourses": []},
    {"type": "AND", "courses": ["MATH-UA 120"], "coreqs": [], "requiresPetition": false, "notCourses": []},
    {"type": "OR", "courses": ["MATH-UA 121", "MATH-UA 131"], "coreqs": [], "requiresPetition": false, "notCourses": []}
  ]
}

Input: "CSCI-UA 2 with a Minimum Grade of C OR CSCI-UA 3 OR Advanced Placement Examination Computer Science A >= 3 OR instructor permission"
Output: {
  "prereqGroups": [
    {"type": "OR", "courses": ["CSCI-UA 2", "CSCI-UA 3", "AP-CS-A-3"], "coreqs": [], "requiresPetition": true, "notCourses": []}
  ]
}

Input: "Not open to students who have completed CSCI-UA 2."
Output: {
  "prereqGroups": [
    {"type": "NOT", "courses": [], "coreqs": [], "requiresPetition": false, "notCourses": ["CSCI-UA 2"]}
  ]
}

Be conservative. If a clause is ambiguous, return what you can parse and
skip the unparseable parts. Do NOT invent courses that aren't in the
input.
`;
```

- [ ] **Step 3: Implement the extractor**

Create `tools/bulletin-parser/extractPrereqs.ts`:

```typescript
/**
 * Phase 12.8 — Prereq extractor.
 * Walks bulletin markdown, finds "Prerequisites:" blocks, and parses
 * each via claude-haiku-4-5 with structured JSON output. Output goes
 * to packages/engine/src/data/prereqs.json (extending the existing
 * 27-entry hand-curated file).
 *
 * Run: pnpm tsx tools/bulletin-parser/extractPrereqs.ts
 *
 * Cost note: ~5,000-7,000 courses × 1 LLM call each. At haiku-4-5 prices
 * (~$0.001 per call for short prompts), total ~$5-10. Re-runs are
 * idempotent: skips courses already present in prereqs.json unless
 * --force is passed.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CoursePrereqs } from "../../packages/shared/src/types";

const REPO_ROOT = path.resolve(__dirname, "../..");
const BULLETIN_DIR = path.join(REPO_ROOT, "data/bulletin-raw/courses");
const OUTPUT_PATH = path.join(REPO_ROOT, "packages/engine/src/data/prereqs.json");

const FORCE = process.argv.includes("--force");

const SYSTEM_PROMPT = `[the prompt from Step 2 above]`;

const PREREQ_BLOCK_RE = /^\s*\*?\*?Prerequisites?\*?\*?:\s*(.+?)(?:\n\n|$)/im;

function extractPrereqText(content: string): string | null {
    const m = PREREQ_BLOCK_RE.exec(content);
    if (!m) return null;
    return m[1]!.trim();
}

async function parsePrereq(client: Anthropic, courseId: string, text: string): Promise<CoursePrereqs["prereqGroups"]> {
    const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
            { role: "user", content: `Course: ${courseId}\nPrerequisite text: ${text}` },
        ],
    });
    const textOut = response.content
        .filter(b => b.type === "text")
        .map(b => (b as { text: string }).text)
        .join("");
    const jsonMatch = textOut.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error(`Failed to extract JSON from response for ${courseId}: ${textOut.slice(0, 200)}`);
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.prereqGroups ?? [];
}

async function main() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    const client = new Anthropic({ apiKey });

    // Load existing curated entries.
    const existing: CoursePrereqs[] = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
    const existingByCourse = new Map(existing.map(e => [e.course, e]));

    // Walk bulletin.
    const out: CoursePrereqs[] = [...existing];
    const seen = new Set(existing.map(e => e.course));
    let parsed = 0, skipped = 0, failed = 0;

    const deptDirs = fs.readdirSync(BULLETIN_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dept of deptDirs) {
        const m = /^([A-Z]{2,5})_(UA|UB|UE|UF|UH|UT|UY|SHU)$/.exec(dept.name);
        if (!m) continue;
        const [, deptCode, schoolCode] = m;
        const courseNumDirs = fs.readdirSync(path.join(BULLETIN_DIR, dept.name), { withFileTypes: true })
            .filter(d => d.isDirectory());
        for (const courseDir of courseNumDirs) {
            const courseId = `${deptCode}-${schoolCode} ${courseDir.name}`;
            if (!FORCE && seen.has(courseId)) {
                skipped++;
                continue;
            }
            const indexPath = path.join(BULLETIN_DIR, dept.name, courseDir.name, "index.md");
            let content = "";
            try {
                content = fs.readFileSync(indexPath, "utf8");
            } catch {
                continue;
            }
            const prereqText = extractPrereqText(content);
            if (!prereqText) {
                // No prereqs → empty prereqGroups
                out.push({ course: courseId, prereqGroups: [] });
                seen.add(courseId);
                parsed++;
                continue;
            }
            try {
                const groups = await parsePrereq(client, courseId, prereqText);
                out.push({ course: courseId, prereqGroups: groups });
                seen.add(courseId);
                parsed++;
            } catch (e) {
                console.error(`FAILED ${courseId}: ${e instanceof Error ? e.message : e}`);
                failed++;
            }
            if (parsed % 50 === 0) console.log(`  parsed ${parsed}, skipped ${skipped}, failed ${failed}`);
        }
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n");
    console.log(`Wrote ${OUTPUT_PATH}`);
    console.log(`  Total: ${out.length}, Parsed: ${parsed}, Skipped (existing): ${skipped}, Failed: ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Smoke-test on 5 courses**

Comment out the main loop and hand-pick 5 test courses (e.g. `CSCI-UA 101`, `CSCI-UA 310`, `MATH-UA 121`, `ECON-UA 1`, `BIOL-UA 11`). Run, inspect the LLM's output, verify the JSON shape matches the schema. Iterate on the prompt until 5/5 produce sensible output.

- [ ] **Step 5: Run the full extractor**

```bash
pnpm tsx tools/bulletin-parser/extractPrereqs.ts
```

Expected runtime: ~30-60 minutes (1 call per course, ~500ms latency). Cost: ~$5-10 in haiku-4-5 tokens.

If the run errors on a specific course, capture the offending input and iterate on the prompt. The script's `failed` counter should be <2% of total.

- [ ] **Step 6: Commit (do NOT yet validate against curated)**

```bash
git add tools/bulletin-parser/extractPrereqs.ts packages/engine/src/data/prereqs.json
git commit -m "data(parser): prereqs.json — extracted prereqs for all undergrad courses"
```

---

## Task 5: Validation gate — generated prereqs MUST match the 27 curated entries

**Files:**
- Create: `tools/bulletin-parser/validatePrereqs.ts`
- Create: `packages/engine/tests/data/parsedDataValidation.test.ts`

The 27 hand-curated entries already in `prereqs.json` are ground truth. The LLM-parsed output for those same courses MUST match. If it doesn't, the parser is wrong; iterate on the prompt before shipping.

- [ ] **Step 1: Snapshot the 27 curated entries**

Before running the extractor, save the 27 curated entries to a separate file:

```bash
cp packages/engine/src/data/prereqs.json /tmp/prereqs.curated.snapshot.json
```

(This is a one-time snapshot; subsequent extractor runs will produce a merged file. The snapshot is the regression target.)

- [ ] **Step 2: Write the validator**

Create `tools/bulletin-parser/validatePrereqs.ts`:

```typescript
/**
 * Phase 12.8 — Prereq parser regression check.
 * Compares the generated prereqs (entries that match a curated
 * snapshot) against the snapshot. Any mismatch is a parser bug.
 *
 * Run: pnpm tsx tools/bulletin-parser/validatePrereqs.ts /tmp/prereqs.curated.snapshot.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CoursePrereqs, PrereqGroup } from "../../packages/shared/src/types";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CURRENT_PATH = path.join(REPO_ROOT, "packages/engine/src/data/prereqs.json");

function normalizeGroup(g: PrereqGroup): PrereqGroup {
    return {
        type: g.type,
        courses: [...(g.courses ?? [])].sort(),
        coreqs: [...(g.coreqs ?? [])].sort(),
        requiresPetition: g.requiresPetition ?? false,
        notCourses: [...(g.notCourses ?? [])].sort(),
    };
}

function deepEqualGroups(a: PrereqGroup[], b: PrereqGroup[]): boolean {
    if (a.length !== b.length) return false;
    const an = a.map(normalizeGroup);
    const bn = b.map(normalizeGroup);
    return JSON.stringify(an) === JSON.stringify(bn);
}

function main() {
    const snapshotPath = process.argv[2];
    if (!snapshotPath) {
        console.error("usage: validatePrereqs.ts <snapshot.json>");
        process.exit(1);
    }
    const snapshot: CoursePrereqs[] = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    const current: CoursePrereqs[] = JSON.parse(fs.readFileSync(CURRENT_PATH, "utf8"));
    const currentByCourse = new Map(current.map(c => [c.course, c]));
    const mismatches: Array<{ course: string; expected: PrereqGroup[]; actual: PrereqGroup[] }> = [];
    for (const expected of snapshot) {
        const actual = currentByCourse.get(expected.course);
        if (!actual) {
            mismatches.push({ course: expected.course, expected: expected.prereqGroups, actual: [] });
            continue;
        }
        if (!deepEqualGroups(expected.prereqGroups, actual.prereqGroups)) {
            mismatches.push({ course: expected.course, expected: expected.prereqGroups, actual: actual.prereqGroups });
        }
    }
    if (mismatches.length === 0) {
        console.log(`✓ All ${snapshot.length} curated entries match.`);
        process.exit(0);
    }
    console.error(`✗ ${mismatches.length} mismatches out of ${snapshot.length}:`);
    for (const m of mismatches.slice(0, 10)) {
        console.error(`  - ${m.course}`);
        console.error(`    expected: ${JSON.stringify(m.expected)}`);
        console.error(`    actual:   ${JSON.stringify(m.actual)}`);
    }
    process.exit(1);
}

main();
```

- [ ] **Step 3: Run the validator**

```bash
pnpm tsx tools/bulletin-parser/validatePrereqs.ts /tmp/prereqs.curated.snapshot.json
```

Expected: `✓ All 27 curated entries match.`

If any mismatch: iterate on the prompt (Task 4 Step 2), re-run extractPrereqs.ts with `--force` for those courses, re-validate. Loop until 27/27 match.

Common mismatch causes:
- LLM split an AND into multiple groups instead of merging.
- LLM missed a NOT clause.
- LLM hallucinated `requiresPetition: true` on courses that don't have instructor-permission language.

- [ ] **Step 4: Add a vitest regression test**

Create `packages/engine/tests/data/parsedDataValidation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CoursePrereqs } from "@nyupath/shared";

const PREREQS_PATH = path.resolve(__dirname, "../../src/data/prereqs.json");
const OFFERINGS_PATH = path.resolve(__dirname, "../../src/data/courses-offerings.json");

describe("parsed-data invariants", () => {
    it("prereqs.json is non-empty and well-shaped", () => {
        const data: CoursePrereqs[] = JSON.parse(fs.readFileSync(PREREQS_PATH, "utf8"));
        expect(data.length).toBeGreaterThan(1000); // post-12.8: should be ~5K-7K
        for (const entry of data.slice(0, 50)) {
            expect(entry.course).toMatch(/^[A-Z]{2,5}-(UA|UB|UE|UF|UH|UT|UY|SHU)\s+\d/);
            expect(Array.isArray(entry.prereqGroups)).toBe(true);
            for (const g of entry.prereqGroups) {
                expect(["AND", "OR", "NOT"]).toContain(g.type);
                expect(Array.isArray(g.courses)).toBe(true);
            }
        }
    });

    it("offerings.json covers undergrad courses with valid term sets", () => {
        const data: Record<string, { termsOffered: string[] }> = JSON.parse(fs.readFileSync(OFFERINGS_PATH, "utf8"));
        const ids = Object.keys(data);
        expect(ids.length).toBeGreaterThan(1000);
        for (const id of ids.slice(0, 50)) {
            expect(id).toMatch(/^[A-Z]{2,5}-(UA|UB|UE|UF|UH|UT|UY|SHU)\s+\d/);
            const terms = data[id]!.termsOffered;
            expect(Array.isArray(terms)).toBe(true);
            expect(terms.length).toBeGreaterThan(0);
            for (const t of terms) {
                expect(["fall", "spring", "summer", "january"]).toContain(t);
            }
        }
    });

    it("prereqs.json includes all 27 originally-curated entries", () => {
        const data: CoursePrereqs[] = JSON.parse(fs.readFileSync(PREREQS_PATH, "utf8"));
        const courses = new Set(data.map(d => d.course));
        // Spot-check the 27 known entries (replace with the actual list).
        const required = [
            "CSCI-UA 310",
            "MATH-UA 122",
            // ...add the remaining 25 from the snapshot
        ];
        for (const r of required) {
            expect(courses.has(r), `missing curated entry: ${r}`).toBe(true);
        }
    });
});
```

The exact 27 course IDs should be lifted from the snapshot file. Replace the placeholder list with the real ones.

- [ ] **Step 5: Run the test**

```bash
node_modules/.bin/vitest run packages/engine/tests/data/parsedDataValidation.test.ts
```

Expected: 3/3 PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/bulletin-parser/validatePrereqs.ts packages/engine/tests/data/parsedDataValidation.test.ts
git commit -m "data(parser): validate-against-curated regression test + parsed-data shape tests"
```

---

## Task 6: Manual QA on 30 random non-curated entries

**Files:** none (verification step)

The 27 curated entries are in-distribution for the parser (they were the prompt's worked examples). The real test is whether the parser handles unfamiliar bulletin language. Hand-review 30 random parsed entries.

- [ ] **Step 1: Pick 30 random entries**

Write a one-liner to sample:

```bash
pnpm tsx -e '
import * as fs from "node:fs";
const data = JSON.parse(fs.readFileSync("packages/engine/src/data/prereqs.json", "utf8"));
const nonEmpty = data.filter(d => d.prereqGroups.length > 0);
const sample = [];
for (let i = 0; i < 30; i++) {
    sample.push(nonEmpty[Math.floor(Math.random() * nonEmpty.length)]);
}
console.log(JSON.stringify(sample, null, 2));
' > /tmp/random-prereq-sample.json
```

- [ ] **Step 2: Read each + check the bulletin source**

For each entry, open the corresponding bulletin markdown:

```bash
for course in $(cat /tmp/random-prereq-sample.json | jq -r '.[].course'); do
    dept=$(echo "$course" | sed 's/-.* / /' | awk '{print $1}')
    school=$(echo "$course" | grep -oE 'UA|UB|UE|UF|UH|UT|UY|SHU')
    num=$(echo "$course" | awk '{print $2}')
    echo "=== $course ==="
    head -20 "data/bulletin-raw/courses/${dept}_${school}/${num}/index.md" | grep -A 1 -i "prerequisite"
    echo
done
```

Compare each to the parsed JSON. Note any discrepancies.

Common issues to catch:
- AND/OR mistakes
- Missed AP/IB clauses
- Hallucinated courses
- Missing `requiresPetition` flag
- Cross-listed alternatives misrepresented

- [ ] **Step 3: If <90% are correct, iterate**

If you find >3 errors in 30 samples, the parser needs a prompt fix. Update the system prompt's worked examples to cover the failure mode, re-run `extractPrereqs.ts --force` for affected courses, re-validate against the curated snapshot, re-sample.

- [ ] **Step 4: Document the QA**

Write a short note in your operator-test log noting the sample size, error count, error types, and the final accuracy estimate. Commit nothing — this is for your own records.

---

## Task 7: Final commit + push

**Files:** none

- [ ] **Step 1: Confirm clean working tree on Phase-12.8 work**

```bash
git status
```

Expected: nothing to commit beyond what Tasks 1-5 already staged.

- [ ] **Step 2: Run all tests**

```bash
node_modules/.bin/vitest run
```

Expected: all engine + web tests pass; the 3 new `parsedDataValidation` tests pass.

- [ ] **Step 3: Push**

```bash
git push
```

- [ ] **Step 4: Tear-off note**

```
Phase 12.8 (bulletin parsing) shipped:
- offerings extractor (regex) → courses-offerings.json (~5,000+ undergrad courses)
- prereq extractor (LLM-assisted) → prereqs.json (~5,000+ entries, NOT/AND/OR
  + requiresPetition + AP/IB synthetic IDs)
- validator: generated entries match the 27 curated snapshot 27/27
- vitest regression suite locks the data shape

Phase 13 (multi-semester planner) can now consume both files as
ground truth for prereq + offering constraints in the solver.
```

---

## Self-review notes

**Coverage targets:** ~5,000-7,000 entries in each output file (matches 17K-dump's undergrad subset minus grad / Silver / out-of-scope).

**Validation gate:** the 27-curated-snapshot regression test is the hard quality bar. Until 27/27 match, do not ship.

**Cost:** one-time ~$5-10 in haiku-4-5 tokens. Re-runs are skipped per-course (idempotent).

**Failure modes acknowledged:**
- Some bulletin pages won't have a `Prerequisites:` block (intro courses, electives without prereqs) — parser emits empty `prereqGroups: []`, solver treats as "no constraint."
- Some bulletin entries have ambiguous or malformed prereq text — parser gracefully skips with a logged warning.
- AP/IB synthetic IDs are minted only for the 30+ exams in `AP_SUBJECT_CODES` / `IB_SUBJECT_CODES`. New exams need adding to the dictionary; until then, the parser emits a warning and omits the AP clause from the OR group.

**Phases 13+ depend on this:**
- Phase 13's solver reads both `prereqs.json` and `courses-offerings.json` as static catalog data.
- Phase 14's planner uses the same files plus optional `coreqs` (which Phase 12.8 leaves empty — Phase 14 populates).

**No engine impact yet:** Phase 12.8 is pure data prep. The engine doesn't read either file until Phase 13 wires them in.
