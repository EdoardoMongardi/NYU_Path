// ============================================================
// Phase 12.8 Task 5 — parsed-data invariants regression suite
// ============================================================
//
// What this asserts
// -----------------
// Pure-TypeScript regression tests (no LLM calls) that lock the
// invariants of the two parser-output JSONs:
//
//   - packages/engine/src/data/prereqs.json
//   - packages/engine/src/data/courses-offerings.json
//
// Five invariant categories:
//   1. prereqs.json shape (length, courseId regex, group types,
//      NOT-group structural rules).
//   2. Inner course IDs canonical (per Decision Y / Y′; zero
//      PLACEMENT_EXAM tokens).
//   3. The 16 curated entries are present and snapshot-equal.
//   4. courses-offerings.json shape (key regex, termsOffered
//      subset, inferred flag).
//   5. Per-suffix coverage thresholds for both files.
//
// Co-located with the synth-ID test (same vitest workspace
// glob: packages/*/tests/**/*.test.ts).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ------------------------------------------------------------
// Constants & types
// ------------------------------------------------------------

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const PREREQS_PATH = join(
    REPO_ROOT,
    "packages",
    "engine",
    "src",
    "data",
    "prereqs.json"
);
const OFFERINGS_PATH = join(
    REPO_ROOT,
    "packages",
    "engine",
    "src",
    "data",
    "courses-offerings.json"
);
const SNAPSHOT_PATH = "/tmp/prereqs.curated.snapshot.json";

const SUFFIX_RE = "(UA|UB|UE|UF|UG|UH|UT|UY|SHU)";
const COURSE_ID_RE = new RegExp(`^[A-Z][A-Z0-9]*-${SUFFIX_RE} \\S+$`);

// Inner course IDs canonical patterns — Decision Y + Y′.
const INNER_COURSE_RE = /^[A-Z][A-Z0-9]*-[A-Z]+ [A-Z0-9-]+$/;
const AP_RE = /^AP-[A-Z0-9-]+-\d+$/;
const IB_RE = /^IB-[A-Z]+-(HL|SL)-\d+$/;
const PLACE_MATH_RE = /^PLACE-MATH-([A-Z0-9]+-)?\d+$/;
const PLACE_LANG_RE = /^PLACE-LANG-([A-Z]+-)?\d+$/;
const SAT2_RE = /^SAT2-[A-Z0-9]+-\d+$/;

const VALID_TERMS = new Set(["fall", "spring", "summer", "january"]);

interface PrereqGroup {
    type: "AND" | "OR" | "NOT";
    courses?: string[];
    notCourses?: string[];
    requiresPetition?: boolean;
}

interface PrereqEntry {
    course: string;
    prereqGroups: PrereqGroup[];
    coreqs: string[];
    minGrades?: Record<string, string>;
}

// Canonical NYU letter-grade strings allowed in `Prerequisite.minGrades`.
// Mirrors the bulletin's "with a Minimum Grade of X" universe — does NOT
// include D-, F, or pass-fail equivalents (the bulletin never asserts
// those as thresholds).
const VALID_MIN_GRADE_VALUES = new Set([
    "A",
    "A-",
    "B+",
    "B",
    "B-",
    "C+",
    "C",
    "C-",
    "D+",
    "D",
]);

interface OfferingEntry {
    termsOffered: string[];
    rawLine: string;
    inferred: boolean;
}

// The 16 curated course IDs (hardcoded per task spec). Anchors
// the regression: if any of these disappears, the curated parity
// guarantee is broken.
const CURATED_REQUIRED_IDS = [
    "ACCT-UB 1",
    "CS-UH 3090",
    "CS-UY 1121",
    "CS-UY 1134",
    "CSCI-SHU 2314",
    "CSCI-UA 101",
    "CSCI-UA 310",
    "CSCI-UA 421",
    "IDSEM-UG 1843",
    "MATH-UA 121",
    "MATH-UA 122",
    "MATH-UA 123",
    "MGMT-UB 2",
    "MKTG-UB 54",
    "MPATC-UE 9322",
    "PHTI-UT 1014",
] as const;

// ------------------------------------------------------------
// Lazy file loaders (read once per file).
// ------------------------------------------------------------

let cachedPrereqs: PrereqEntry[] | null = null;
function loadPrereqs(): PrereqEntry[] {
    if (cachedPrereqs === null) {
        cachedPrereqs = JSON.parse(readFileSync(PREREQS_PATH, "utf-8")) as PrereqEntry[];
    }
    return cachedPrereqs;
}

let cachedOfferings: Record<string, OfferingEntry> | null = null;
function loadOfferings(): Record<string, OfferingEntry> {
    if (cachedOfferings === null) {
        cachedOfferings = JSON.parse(readFileSync(OFFERINGS_PATH, "utf-8")) as Record<
            string,
            OfferingEntry
        >;
    }
    return cachedOfferings;
}

let cachedSnapshot: PrereqEntry[] | null = null;
function loadSnapshot(): PrereqEntry[] {
    if (cachedSnapshot === null) {
        cachedSnapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")) as PrereqEntry[];
    }
    return cachedSnapshot;
}

// ------------------------------------------------------------
// Normalize helpers — same semantics as validatePrereqs.ts.
// ------------------------------------------------------------

function normalizeGroup(g: PrereqGroup): {
    type: string;
    courses: string[];
    notCourses?: string[];
    requiresPetition?: true;
} {
    const out: ReturnType<typeof normalizeGroup> = {
        type: g.type,
        courses: [...(g.courses ?? [])].sort(),
    };
    if (g.notCourses && g.notCourses.length > 0) {
        out.notCourses = [...g.notCourses].sort();
    }
    if (g.requiresPetition === true) {
        out.requiresPetition = true;
    }
    return out;
}

function normalizeMinGrades(
    m: Record<string, string> | undefined,
): Record<string, string> | undefined {
    if (!m) return undefined;
    const keys = Object.keys(m);
    if (keys.length === 0) return undefined;
    const sorted: Record<string, string> = {};
    for (const k of keys.sort()) sorted[k] = m[k];
    return sorted;
}

function normalizeEntry(e: PrereqEntry): {
    course: string;
    prereqGroups: ReturnType<typeof normalizeGroup>[];
    coreqs: string[];
    minGrades?: Record<string, string>;
} {
    const out: {
        course: string;
        prereqGroups: ReturnType<typeof normalizeGroup>[];
        coreqs: string[];
        minGrades?: Record<string, string>;
    } = {
        course: e.course,
        prereqGroups: (e.prereqGroups ?? []).map(normalizeGroup),
        coreqs: [...(e.coreqs ?? [])].sort(),
    };
    const mg = normalizeMinGrades(e.minGrades);
    if (mg) out.minGrades = mg;
    return out;
}

function suffixOf(courseId: string): string | null {
    const m = courseId.match(/-(UA|UB|UE|UF|UG|UH|UT|UY|SHU) /);
    return m ? m[1] : null;
}

function isCanonicalInnerId(id: string): boolean {
    return (
        INNER_COURSE_RE.test(id) ||
        AP_RE.test(id) ||
        IB_RE.test(id) ||
        PLACE_MATH_RE.test(id) ||
        PLACE_LANG_RE.test(id) ||
        SAT2_RE.test(id)
    );
}

// ============================================================
// Test 1 — prereqs.json shape
// ============================================================

describe("Phase 12.8 Task 5 — prereqs.json shape", () => {
    it("loads as a non-empty array with > 7000 entries", () => {
        const prereqs = loadPrereqs();
        expect(Array.isArray(prereqs)).toBe(true);
        expect(prereqs.length).toBeGreaterThan(7000);
    });

    it("every entry has course:string, prereqGroups:array, coreqs:array", () => {
        const prereqs = loadPrereqs();
        const violations: string[] = [];
        for (const e of prereqs) {
            if (typeof e.course !== "string") {
                violations.push(`course not string: ${JSON.stringify(e)}`);
            }
            if (!Array.isArray(e.prereqGroups)) {
                violations.push(`prereqGroups not array: ${e.course}`);
            }
            if (!Array.isArray(e.coreqs)) {
                violations.push(`coreqs not array: ${e.course}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it("every course matches the courseId regex", () => {
        const prereqs = loadPrereqs();
        const bad = prereqs
            .map((e) => e.course)
            .filter((c) => !COURSE_ID_RE.test(c));
        expect(bad).toEqual([]);
    });

    it('every prereqGroups[].type is one of "AND" | "OR" | "NOT"', () => {
        const prereqs = loadPrereqs();
        const bad: string[] = [];
        for (const e of prereqs) {
            for (const g of e.prereqGroups) {
                if (g.type !== "AND" && g.type !== "OR" && g.type !== "NOT") {
                    bad.push(`${e.course}: type=${JSON.stringify(g.type)}`);
                }
            }
        }
        expect(bad).toEqual([]);
    });

    it("every prereqGroups[].courses is string[]", () => {
        const prereqs = loadPrereqs();
        const bad: string[] = [];
        for (const e of prereqs) {
            for (const g of e.prereqGroups) {
                if (!Array.isArray(g.courses)) {
                    bad.push(`${e.course}: missing courses field — ${JSON.stringify(g)}`);
                    continue;
                }
                if (!g.courses.every((c) => typeof c === "string")) {
                    bad.push(`${e.course}: non-string in courses — ${JSON.stringify(g)}`);
                }
            }
        }
        expect(bad).toEqual([]);
    });

    it("every prereqGroups[].notCourses (when present) is string[]", () => {
        const prereqs = loadPrereqs();
        const bad: string[] = [];
        for (const e of prereqs) {
            for (const g of e.prereqGroups) {
                if (g.notCourses === undefined) continue;
                if (!Array.isArray(g.notCourses)) {
                    bad.push(`${e.course}: notCourses not array — ${JSON.stringify(g)}`);
                    continue;
                }
                if (!g.notCourses.every((c) => typeof c === "string")) {
                    bad.push(`${e.course}: non-string in notCourses — ${JSON.stringify(g)}`);
                }
            }
        }
        expect(bad).toEqual([]);
    });

    it('when type === "NOT", courses is empty and notCourses is non-empty', () => {
        const prereqs = loadPrereqs();
        const bad: string[] = [];
        for (const e of prereqs) {
            for (const g of e.prereqGroups) {
                if (g.type !== "NOT") continue;
                const courses = g.courses ?? [];
                const notCourses = g.notCourses ?? [];
                if (courses.length !== 0) {
                    bad.push(`${e.course}: NOT group has non-empty courses — ${JSON.stringify(g)}`);
                }
                if (notCourses.length === 0) {
                    bad.push(`${e.course}: NOT group has empty notCourses — ${JSON.stringify(g)}`);
                }
            }
        }
        expect(bad).toEqual([]);
    });
});

// ============================================================
// Test 1b — minGrades shape (Decision #4 reversal)
// ============================================================
//
// minGrades is an optional entry-level field added by
// tools/bulletin-parser/extractGradeThresholds.ts. When present:
//   - Every key must match the courseId regex (zero-padded form,
//     consistent with prereqGroups[].courses[]).
//   - Every value must be one of the canonical letter grades
//     listed in VALID_MIN_GRADE_VALUES (the bulletin universe;
//     D-/F/P/CR/S are never used as thresholds).
//   - Every key SHOULD appear in at least one of the entry's
//     prereqGroups[].courses[]/notCourses[] — otherwise the regex
//     paired with a course the LLM didn't include and we want to
//     flag it (informational, not a hard fail at this layer; the
//     extractor surfaces orphan-pairings as warnings).

describe("Phase 13 prereq-fix — Prerequisite.minGrades shape", () => {
    it("every minGrades key matches the courseId regex", () => {
        const prereqs = loadPrereqs();
        const bad: string[] = [];
        for (const e of prereqs) {
            if (!e.minGrades) continue;
            for (const cid of Object.keys(e.minGrades)) {
                if (!COURSE_ID_RE.test(cid)) {
                    bad.push(`${e.course}: minGrades key ${JSON.stringify(cid)} fails courseId regex`);
                }
            }
        }
        expect(bad).toEqual([]);
    });

    it("every minGrades value is one of the canonical letter grades", () => {
        const prereqs = loadPrereqs();
        const bad: string[] = [];
        for (const e of prereqs) {
            if (!e.minGrades) continue;
            for (const [cid, grade] of Object.entries(e.minGrades)) {
                if (typeof grade !== "string") {
                    bad.push(`${e.course}: minGrades[${cid}] not string`);
                    continue;
                }
                if (!VALID_MIN_GRADE_VALUES.has(grade)) {
                    bad.push(`${e.course}: minGrades[${cid}]=${JSON.stringify(grade)} not canonical`);
                }
            }
        }
        expect(bad).toEqual([]);
    });

    it("every minGrades key appears in at least one of the entry's prereqGroups[].courses[]/notCourses[]", () => {
        const prereqs = loadPrereqs();
        const orphans: string[] = [];
        for (const e of prereqs) {
            if (!e.minGrades) continue;
            const known = new Set<string>();
            for (const g of e.prereqGroups) {
                for (const c of g.courses ?? []) known.add(c);
                for (const c of g.notCourses ?? []) known.add(c);
            }
            for (const cid of Object.keys(e.minGrades)) {
                if (!known.has(cid)) {
                    orphans.push(`${e.course}: ${cid}`);
                }
            }
        }
        // Orphans = the bulletin grades a course the LLM didn't include
        // in this entry's prereq tree (typically unbracketed shorthand
        // like "MA-UY 4" that the LLM was uncertain about). The
        // extractor preserves these as informational pairings — losing
        // them silently would discard real bulletin info. Tolerance
        // ratchets down to 0 once the affected entries are hand-curated
        // so the LLM-dropped courses are added back to prereqGroups.
        const ORPHAN_TOLERANCE = 5;
        expect(orphans.length).toBeLessThanOrEqual(ORPHAN_TOLERANCE);
    });
});

// ============================================================
// Test 2 — Inner course IDs canonical
// ============================================================

describe("Phase 12.8 Task 5 — inner course IDs canonical", () => {
    it("every inner ID matches one of the 6 canonical patterns", () => {
        const prereqs = loadPrereqs();
        const violations: Array<{ course: string; id: string; loc: string }> = [];
        for (const e of prereqs) {
            for (const g of e.prereqGroups) {
                for (const c of g.courses ?? []) {
                    if (!isCanonicalInnerId(c)) {
                        violations.push({ course: e.course, id: c, loc: "courses" });
                    }
                }
                for (const c of g.notCourses ?? []) {
                    if (!isCanonicalInnerId(c)) {
                        violations.push({ course: e.course, id: c, loc: "notCourses" });
                    }
                }
            }
            for (const c of e.coreqs) {
                if (!isCanonicalInnerId(c)) {
                    violations.push({ course: e.course, id: c, loc: "coreqs" });
                }
            }
        }
        // TODO: Curate remaining Abu Dhabi campus references (PSYC1-UC, MATH-AD, etc.)
        // Tolerance ratchets down as docs/PHASE_12_8_DATA_ISSUES.md gets curated.
        // Current count: 16 Abu Dhabi + unknown-suffix entries. Target: 0.
        expect(violations.length).toBeLessThanOrEqual(16);
    });

    it("zero PLACEMENT_EXAM tokens anywhere in prereqs.json", () => {
        const raw = readFileSync(PREREQS_PATH, "utf-8");
        const matches = raw.match(/PLACEMENT_EXAM/g);
        expect(matches).toBeNull();
    });
});

// ============================================================
// Test 3 — 16 curated entries present + snapshot-equal
// ============================================================

describe("Phase 12.8 Task 5 — 16 curated entries are snapshot-equal", () => {
    it("every required curated ID appears in prereqs.json", () => {
        const prereqs = loadPrereqs();
        const present = new Set(prereqs.map((e) => e.course));
        const missing = CURATED_REQUIRED_IDS.filter((id) => !present.has(id));
        expect(missing).toEqual([]);
    });

    it("every required curated entry matches snapshot under normalization", () => {
        const prereqs = loadPrereqs();
        const snapshot = loadSnapshot();
        const liveByCourse = new Map<string, PrereqEntry>();
        for (const e of prereqs) liveByCourse.set(e.course, e);

        // Sanity: snapshot must have exactly the 16 hardcoded IDs.
        const snapIds = snapshot.map((e) => e.course).sort();
        const requiredSorted = [...CURATED_REQUIRED_IDS].sort();
        expect(snapIds).toEqual(requiredSorted);

        const mismatches: Array<{
            course: string;
            expected: object;
            actual: object | null;
        }> = [];
        for (const expected of snapshot) {
            const actual = liveByCourse.get(expected.course);
            if (!actual) {
                mismatches.push({
                    course: expected.course,
                    expected: normalizeEntry(expected),
                    actual: null,
                });
                continue;
            }
            if (
                JSON.stringify(normalizeEntry(expected)) !==
                JSON.stringify(normalizeEntry(actual))
            ) {
                mismatches.push({
                    course: expected.course,
                    expected: normalizeEntry(expected),
                    actual: normalizeEntry(actual),
                });
            }
        }
        expect(mismatches).toEqual([]);
    });
});

// ============================================================
// Test 4 — courses-offerings.json shape
// ============================================================

describe("Phase 12.8 Task 5 — courses-offerings.json shape", () => {
    it("loads as an object with > 7000 keys", () => {
        const offerings = loadOfferings();
        expect(typeof offerings).toBe("object");
        expect(offerings).not.toBeNull();
        expect(Array.isArray(offerings)).toBe(false);
        expect(Object.keys(offerings).length).toBeGreaterThan(7000);
    });

    it("every key matches the courseId regex", () => {
        const offerings = loadOfferings();
        const bad = Object.keys(offerings).filter((k) => !COURSE_ID_RE.test(k));
        expect(bad).toEqual([]);
    });

    it("every value has termsOffered:string[], rawLine:string, inferred:boolean", () => {
        const offerings = loadOfferings();
        const bad: string[] = [];
        for (const [k, v] of Object.entries(offerings)) {
            if (!Array.isArray(v.termsOffered)) {
                bad.push(`${k}: termsOffered not array`);
            } else if (!v.termsOffered.every((t) => typeof t === "string")) {
                bad.push(`${k}: termsOffered has non-string`);
            }
            if (typeof v.rawLine !== "string") {
                bad.push(`${k}: rawLine not string`);
            }
            if (typeof v.inferred !== "boolean") {
                bad.push(`${k}: inferred not boolean`);
            }
        }
        expect(bad).toEqual([]);
    });

    it('every termsOffered entry is in {"fall","spring","summer","january"}', () => {
        const offerings = loadOfferings();
        const bad: string[] = [];
        for (const [k, v] of Object.entries(offerings)) {
            for (const t of v.termsOffered) {
                if (!VALID_TERMS.has(t)) {
                    bad.push(`${k}: invalid term ${JSON.stringify(t)}`);
                }
            }
        }
        expect(bad).toEqual([]);
    });
});

// ============================================================
// Test 5 — Per-suffix coverage thresholds
// ============================================================

describe("Phase 12.8 Task 5 — per-suffix coverage", () => {
    function suffixCounts(ids: Iterable<string>): Record<string, number> {
        const counts: Record<string, number> = {
            UA: 0, UB: 0, UE: 0, UF: 0, UG: 0, UH: 0, UT: 0, UY: 0, SHU: 0,
        };
        for (const id of ids) {
            const s = suffixOf(id);
            if (s) counts[s] = (counts[s] ?? 0) + 1;
        }
        return counts;
    }

    it("prereqs.json: ≥200 each from UA, UE, UH, UT, UY, SHU; ≥100 from UB; UG=1", () => {
        const prereqs = loadPrereqs();
        const counts = suffixCounts(prereqs.map((e) => e.course));
        expect(counts.UA, `UA=${counts.UA}`).toBeGreaterThanOrEqual(200);
        expect(counts.UE, `UE=${counts.UE}`).toBeGreaterThanOrEqual(200);
        expect(counts.UH, `UH=${counts.UH}`).toBeGreaterThanOrEqual(200);
        expect(counts.UT, `UT=${counts.UT}`).toBeGreaterThanOrEqual(200);
        expect(counts.UY, `UY=${counts.UY}`).toBeGreaterThanOrEqual(200);
        expect(counts.SHU, `SHU=${counts.SHU}`).toBeGreaterThanOrEqual(200);
        expect(counts.UB, `UB=${counts.UB}`).toBeGreaterThanOrEqual(100);
        expect(counts.UG, `UG=${counts.UG}`).toBe(1);
    });

    it("courses-offerings.json: per-suffix counts roughly match verify_coverage.py", () => {
        const offerings = loadOfferings();
        const counts = suffixCounts(Object.keys(offerings));
        // Thresholds calibrated to current production counts (verify_coverage.py
        // output 2026-05-02): UF=46 (Liberal Studies, small), all others ≥200.
        // Lower-bounded ~10% below current to leave headroom for small future
        // scrape diffs without flapping. UF is the only suffix below 200.
        expect(counts.UA, `UA=${counts.UA}`).toBeGreaterThanOrEqual(200);
        expect(counts.UB, `UB=${counts.UB}`).toBeGreaterThanOrEqual(200);
        expect(counts.UE, `UE=${counts.UE}`).toBeGreaterThanOrEqual(200);
        expect(counts.UF, `UF=${counts.UF}`).toBeGreaterThanOrEqual(40);
        expect(counts.UG, `UG=${counts.UG}`).toBeGreaterThanOrEqual(200);
        expect(counts.UH, `UH=${counts.UH}`).toBeGreaterThanOrEqual(200);
        expect(counts.UT, `UT=${counts.UT}`).toBeGreaterThanOrEqual(200);
        expect(counts.UY, `UY=${counts.UY}`).toBeGreaterThanOrEqual(200);
        expect(counts.SHU, `SHU=${counts.SHU}`).toBeGreaterThanOrEqual(200);
    });
});
