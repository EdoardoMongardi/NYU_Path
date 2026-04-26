// ============================================================
// Transcript Lexer (Phase 2 §11.8.2)
// ============================================================
// Token classifier over the raw transcript text. Reads line-by-line,
// classifies each line by shape, and emits a token stream the parser
// can consume.
//
// No bulletin facts here — only the observed unofficial-transcript
// layout per ARCHITECTURE.md §11.8.1.
// ============================================================

export type LexedToken =
    | { kind: "term_header"; line: number; raw: string; label: string }
    | { kind: "course_row"; line: number; raw: string; fields: string[] }
    | { kind: "term_totals"; line: number; raw: string; ahrs: number; ehrs: number; qhrs: number; qpts: number; gpa: number }
    | { kind: "overall_label"; line: number; raw: string; field: "AHRS" | "EHRS" | "QHRS" | "QPTS" | "GPA"; value: number }
    | { kind: "exam_credit"; line: number; raw: string; source: string; scoreOrGrade: string; credits: number; nyuEquivalent?: string }
    | { kind: "header_line"; line: number; raw: string }
    | { kind: "blank"; line: number };

const TERM_HEADER_RE =
    /^\s*(?:Term\s*[:\-]\s*)?(Fall|Spring|Summer|January)\s+(\d{4})\s*$/i;

// Course-row anchor: any line that starts with a recognisable NYU course id
// (DEPT-UA / DEPT-UY / DEPT-UB / etc., possibly with a sub-section like 99-1).
const COURSE_ID_RE = /^([A-Z]{2,6}\d?-[A-Z]{2})\s+(\d+(?:-\d+)?)\b/;

const TERM_TOTALS_RE =
    /Term\s*Totals?\s*[:\-]?\s*AHRS\s+(\d+(?:\.\d+)?)\s+EHRS\s+(\d+(?:\.\d+)?)\s+QHRS\s+(\d+(?:\.\d+)?)\s+QPTS\s+(\d+(?:\.\d+)?)\s+GPA\s+(\d+(?:\.\d+)?)/i;

const OVERALL_LABEL_RE = /^\s*(AHRS|EHRS|QHRS|QPTS|GPA)\s+(\d+(?:\.\d+)?)\s*$/i;

const EXAM_CREDIT_RE =
    /^(.*?)\s+Score\s+(\S+)\s*(?:→|->)\s*([A-Z]{2,6}-[A-Z]{2}\s+\d+(?:-\d+)?)?\s*\(?\s*(\d+(?:\.\d+)?)\s*cr\)?/i;

export interface LexResult {
    tokens: LexedToken[];
}

export function lexTranscript(text: string): LexResult {
    const lines = text.split(/\r?\n/);
    const tokens: LexedToken[] = [];

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        const trimmed = raw.trim();
        const lineNo = i + 1;

        if (trimmed === "") {
            tokens.push({ kind: "blank", line: lineNo });
            continue;
        }

        const termHeaderMatch = trimmed.match(TERM_HEADER_RE);
        if (termHeaderMatch) {
            tokens.push({
                kind: "term_header",
                line: lineNo,
                raw,
                label: `${capitalize(termHeaderMatch[1]!)} ${termHeaderMatch[2]}`,
            });
            continue;
        }

        const termTotalsMatch = trimmed.match(TERM_TOTALS_RE);
        if (termTotalsMatch) {
            tokens.push({
                kind: "term_totals",
                line: lineNo,
                raw,
                ahrs: parseFloat(termTotalsMatch[1]!),
                ehrs: parseFloat(termTotalsMatch[2]!),
                qhrs: parseFloat(termTotalsMatch[3]!),
                qpts: parseFloat(termTotalsMatch[4]!),
                gpa: parseFloat(termTotalsMatch[5]!),
            });
            continue;
        }

        const overallMatch = trimmed.match(OVERALL_LABEL_RE);
        if (overallMatch) {
            tokens.push({
                kind: "overall_label",
                line: lineNo,
                raw,
                field: overallMatch[1]!.toUpperCase() as "AHRS" | "EHRS" | "QHRS" | "QPTS" | "GPA",
                value: parseFloat(overallMatch[2]!),
            });
            continue;
        }

        const courseIdMatch = trimmed.match(COURSE_ID_RE);
        if (courseIdMatch) {
            tokens.push({
                kind: "course_row",
                line: lineNo,
                raw,
                fields: tokenizeCourseRow(trimmed),
            });
            continue;
        }

        const examMatch = trimmed.match(EXAM_CREDIT_RE);
        if (examMatch) {
            tokens.push({
                kind: "exam_credit",
                line: lineNo,
                raw,
                source: examMatch[1]!.trim(),
                scoreOrGrade: examMatch[2]!,
                credits: parseFloat(examMatch[4]!),
                nyuEquivalent: examMatch[3] ? examMatch[3].trim() : undefined,
            });
            continue;
        }

        tokens.push({ kind: "header_line", line: lineNo, raw });
    }

    return { tokens };
}

// ---- helpers ----

function capitalize(s: string): string {
    return s[0]!.toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Split a course-row line into whitespace-separated fields, but keep the
 * course id ("CSCI-UA 101") as a single field. Returns:
 *   [courseId, ...titleWords, grade, ahrs, ehrs, qhrs, qpts]
 *
 * Terminal numeric fields drive the parse; the title is whatever sits
 * between the course id and the grade column.
 */
export function tokenizeCourseRow(line: string): string[] {
    const idMatch = line.match(COURSE_ID_RE);
    if (!idMatch) return line.split(/\s+/);
    const courseId = `${idMatch[1]} ${idMatch[2]}`;
    const rest = line.slice(idMatch[0].length).trim();
    return [courseId, ...rest.split(/\s+/)];
}
