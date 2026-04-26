// ============================================================
// Transcript Parser (Phase 2 §11.8.2)
// ============================================================
// Token stream → TranscriptDocument. Pure deterministic parse — no
// LLM call, no fallback. On any structural failure, throws
// `TranscriptParseError` with a kind/payload describing exactly what
// went wrong. Per §11.8.3, the parser MUST run reconcileTranscript
// before returning the document.
// ============================================================

import {
    type LexedToken,
    lexTranscript,
} from "./lexer.js";
import { reconcileTranscript } from "./invariants.js";
import {
    type TranscriptCourseRow,
    type TranscriptDocument,
    type TranscriptExamCredit,
    type TranscriptGrade,
    type TranscriptHeader,
    type TranscriptOverall,
    type TranscriptTerm,
    TranscriptParseError,
} from "./types.js";

const KNOWN_GRADES = new Set<TranscriptGrade>([
    "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "F",
    "P", "W", "I", "NR", "WF", "TR", "***",
]);

const COURSE_ID_RE = /^([A-Z]{2,6}\d?-[A-Z]{2})\s+(\d+(?:-\d+)?)$/;

export interface ParseOptions {
    /** Skip invariants (used by tests that want the raw structure). */
    skipInvariants?: boolean;
}

export function parseTranscript(text: string, opts?: ParseOptions): TranscriptDocument {
    const { tokens } = lexTranscript(text);
    const header: TranscriptHeader = {};
    const terms: TranscriptTerm[] = [];
    const examCredits: TranscriptExamCredit[] = [];
    let overall: Partial<TranscriptOverall> = {};

    let inOverallBlock = false;
    let currentTerm: TranscriptTerm | null = null;
    let lastSawTermTotals = false;

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!;

        switch (tok.kind) {
            case "blank":
                continue;

            case "header_line": {
                if (!currentTerm && terms.length === 0 && !header.name) {
                    // Best-effort header capture from the first non-empty line
                    header.name = tok.raw.trim();
                }
                continue;
            }

            case "term_header": {
                if (currentTerm) {
                    if (!lastSawTermTotals) {
                        // Term ended without a Term Totals line — synthesize from courses
                        synthesizeTermTotals(currentTerm);
                    }
                    terms.push(currentTerm);
                }
                currentTerm = newTerm(tok.label);
                lastSawTermTotals = false;
                inOverallBlock = false;
                continue;
            }

            case "course_row": {
                if (!currentTerm) {
                    throw new TranscriptParseError({
                        kind: "parse_error",
                        line: tok.line,
                        snippet: tok.raw,
                        detail: "Course row encountered before any term header.",
                    });
                }
                const row = parseCourseRow(tok);
                currentTerm.courses.push(row);
                continue;
            }

            case "term_totals": {
                if (!currentTerm) {
                    throw new TranscriptParseError({
                        kind: "parse_error",
                        line: tok.line,
                        snippet: tok.raw,
                        detail: "Term totals encountered without a current term.",
                    });
                }
                currentTerm.ahrs = tok.ahrs;
                currentTerm.ehrs = tok.ehrs;
                currentTerm.qhrs = tok.qhrs;
                currentTerm.qpts = tok.qpts;
                currentTerm.printedGpa = tok.gpa;
                lastSawTermTotals = true;
                continue;
            }

            case "overall_label": {
                // Once we hit overall labels, push any pending term
                if (currentTerm) {
                    if (!lastSawTermTotals) synthesizeTermTotals(currentTerm);
                    terms.push(currentTerm);
                    currentTerm = null;
                }
                inOverallBlock = true;
                if (tok.field === "AHRS") overall.ahrs = tok.value;
                else if (tok.field === "EHRS") overall.ehrs = tok.value;
                else if (tok.field === "QHRS") overall.qhrs = tok.value;
                else if (tok.field === "QPTS") overall.qpts = tok.value;
                else if (tok.field === "GPA") overall.printedGpa = tok.value;
                continue;
            }

            case "exam_credit": {
                examCredits.push({
                    source: tok.source,
                    scoreOrGrade: tok.scoreOrGrade,
                    credits: tok.credits,
                    nyuEquivalent: tok.nyuEquivalent,
                });
                continue;
            }
        }
    }

    // End-of-file: flush any pending term
    if (currentTerm) {
        if (!lastSawTermTotals) synthesizeTermTotals(currentTerm);
        terms.push(currentTerm);
    }

    if (terms.length === 0) {
        throw new TranscriptParseError({
            kind: "no_terms",
            detail: "No term headers found in transcript text.",
        });
    }
    if (
        overall.ahrs === undefined ||
        overall.ehrs === undefined ||
        overall.qhrs === undefined ||
        overall.qpts === undefined ||
        overall.printedGpa === undefined
    ) {
        throw new TranscriptParseError({
            kind: "missing_overall_block",
            detail:
                `Overall totals block incomplete. Got: ${JSON.stringify(overall)}.`,
        });
    }

    const inProgress: TranscriptCourseRow[] = [];
    for (const t of terms) {
        for (const c of t.courses) if (c.grade === "***") inProgress.push(c);
    }

    const suffixHistory = computeSuffixHistory(terms);
    const schoolTransition = detectSchoolTransition(terms);

    const doc: TranscriptDocument = {
        header,
        terms,
        overall: overall as TranscriptOverall,
        examCredits,
        inProgress,
        suffixHistory,
        ...(schoolTransition ? { schoolTransition } : {}),
    };

    if (!opts?.skipInvariants) reconcileTranscript(doc);
    return doc;
}

// ---- helpers ----

function newTerm(label: string): TranscriptTerm {
    return {
        label,
        semester: normalizeSemester(label),
        courses: [],
        ahrs: 0,
        ehrs: 0,
        qhrs: 0,
        qpts: 0,
        printedGpa: 0,
    };
}

function normalizeSemester(label: string): string {
    const m = label.match(/(Fall|Spring|Summer|January)\s+(\d{4})/i);
    if (!m) return label.toLowerCase().replace(/\s+/g, "-");
    return `${m[2]}-${m[1]!.toLowerCase()}`;
}

function parseCourseRow(tok: { line: number; fields: string[]; raw: string }): TranscriptCourseRow {
    const fields = tok.fields;
    if (fields.length < 5) {
        throw new TranscriptParseError({
            kind: "parse_error",
            line: tok.line,
            snippet: tok.raw,
            detail: `Course row has only ${fields.length} fields; expected at least 5 (id, title, grade, ehrs, qhrs, qpts).`,
        });
    }
    const courseId = fields[0]!;
    if (!COURSE_ID_RE.test(courseId)) {
        throw new TranscriptParseError({
            kind: "parse_error",
            line: tok.line,
            snippet: tok.raw,
            detail: `First field "${courseId}" is not a recognisable course id.`,
        });
    }

    // Per ARCHITECTURE.md §11.8.1, the row layout is:
    //   id  title…  GRADE  EHRS  QHRS  QPTS
    // Three trailing numerics. Title is whatever sits between id and grade.
    const qpts = parseFloat(fields[fields.length - 1]!);
    const qhrs = parseFloat(fields[fields.length - 2]!);
    const ehrs = parseFloat(fields[fields.length - 3]!);
    const grade = fields[fields.length - 4] as TranscriptGrade;

    if ([qpts, qhrs, ehrs].some((n) => Number.isNaN(n))) {
        throw new TranscriptParseError({
            kind: "parse_error",
            line: tok.line,
            snippet: tok.raw,
            detail: "One of the numeric trailing fields (EHRS/QHRS/QPTS) is non-numeric.",
        });
    }
    if (!KNOWN_GRADES.has(grade)) {
        throw new TranscriptParseError({
            kind: "parse_error",
            line: tok.line,
            snippet: tok.raw,
            detail: `Unrecognised grade token "${grade}". Known: ${[...KNOWN_GRADES].join(", ")}.`,
        });
    }

    const title = fields.slice(1, fields.length - 4).join(" ");

    return {
        courseId,
        title,
        grade,
        ehrs,
        qhrs,
        qpts,
    };
}

function synthesizeTermTotals(term: TranscriptTerm): void {
    // No row-level AHRS — derive term AHRS from EHRS as a baseline. Real
    // term-totals lines from the transcript override this when present.
    let ehrs = 0, qhrs = 0, qpts = 0;
    for (const c of term.courses) {
        ehrs += c.ehrs;
        qhrs += c.qhrs;
        qpts += c.qpts;
    }
    term.ahrs = ehrs;
    term.ehrs = ehrs;
    term.qhrs = qhrs;
    term.qpts = qpts;
    term.printedGpa = qhrs > 0 ? Math.round((qpts / qhrs) * 1000) / 1000 : 0;
}

function computeSuffixHistory(terms: TranscriptTerm[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of terms) {
        for (const c of t.courses) {
            const m = c.courseId.match(/-(U[ABDEFGHNTY]|CE)\b/);
            if (!m) continue;
            const suffix = `-${m[1]}`;
            if (!(suffix in out)) out[suffix] = t.semester;
        }
    }
    return out;
}

function detectSchoolTransition(terms: TranscriptTerm[]):
    | TranscriptDocument["schoolTransition"]
    | undefined {
    // A transition is when the DOMINANT suffix changes between consecutive
    // terms — e.g., Tisch IMA (dominant -UT) → CAS (dominant -UA). Mixed
    // terms with multiple suffixes don't trigger by themselves; only a
    // change in which suffix dominates does.
    function dominantOf(t: TranscriptTerm): string | null {
        const counts = new Map<string, number>();
        for (const c of t.courses) {
            const m = c.courseId.match(/-(U[ABDEFGHNTY]|CE)\b/);
            if (!m) continue;
            const suffix = `-${m[1]}`;
            counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
        }
        if (counts.size === 0) return null;
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    }

    let lastDominant: string | null = null;
    let lastSuffixes: Set<string> | null = null;
    for (const t of terms) {
        const dominant = dominantOf(t);
        if (!dominant) continue;
        const termSuffixes = new Set<string>();
        for (const c of t.courses) {
            const m = c.courseId.match(/-(U[ABDEFGHNTY]|CE)\b/);
            if (m) termSuffixes.add(`-${m[1]}`);
        }
        if (lastDominant !== null && lastDominant !== dominant) {
            return {
                fromSemester: t.semester,
                previousSuffixes: lastSuffixes ? [...lastSuffixes] : [lastDominant],
                newSuffixes: [...termSuffixes],
            };
        }
        lastDominant = dominant;
        lastSuffixes = termSuffixes;
    }
    return undefined;
}

export { lexTranscript };
