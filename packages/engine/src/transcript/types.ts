// ============================================================
// Transcript Types (Phase 2 §11.8)
// ============================================================

export interface TranscriptHeader {
    name?: string;
    studentId?: string;
    program?: string;
    datePrinted?: string;
}

export type TranscriptGrade =
    | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C-" | "D+" | "D" | "F"
    | "P" | "W" | "I" | "NR" | "WF" | "TR" | "***";

export interface TranscriptCourseRow {
    /** Course identifier as printed on the transcript, e.g. "CSCI-UA 101" */
    courseId: string;
    title: string;
    /** Letter grade or symbol; "***" indicates an in-progress grade */
    grade: TranscriptGrade;
    /** Earned hours */
    ehrs: number;
    /** Quality hours (used in GPA) */
    qhrs: number;
    /** Quality points (used in GPA) */
    qpts: number;
}

export interface TranscriptTerm {
    /** Term label as printed, e.g. "Fall 2023" */
    label: string;
    /** Normalized form: "2023-fall" / "2024-spring" */
    semester: string;
    courses: TranscriptCourseRow[];
    ahrs: number;
    ehrs: number;
    qhrs: number;
    qpts: number;
    printedGpa: number;
}

export interface TranscriptOverall {
    ahrs: number;
    ehrs: number;
    qhrs: number;
    qpts: number;
    printedGpa: number;
}

export interface TranscriptExamCredit {
    /** Source name as printed, e.g. "AP Calculus BC" */
    source: string;
    /** Score or grade */
    scoreOrGrade: string;
    /** Credits awarded */
    credits: number;
    /** Course id the credit maps to, when listed (e.g., "MATH-UA 121") */
    nyuEquivalent?: string;
}

export interface TranscriptDocument {
    header: TranscriptHeader;
    terms: TranscriptTerm[];
    overall: TranscriptOverall;
    examCredits: TranscriptExamCredit[];
    /** Term in which the home school changed (G40), if detected */
    schoolTransition?: { fromSemester: string; previousSuffixes: string[]; newSuffixes: string[] };
    /** Suffix → first semester observed, used for home-school inference */
    suffixHistory: Record<string, string>;
    /** Currently in-progress courses (grade === "***") */
    inProgress: TranscriptCourseRow[];
}

export type TranscriptParseErrorKind =
    | "term_gpa_mismatch"
    | "overall_qpts_mismatch"
    | "cumulative_gpa_mismatch"
    | "lex_error"
    | "parse_error"
    | "missing_overall_block"
    | "no_terms";

export interface TranscriptParseErrorPayload {
    kind: TranscriptParseErrorKind;
    /** Term label when relevant (term_gpa_mismatch) */
    term?: string;
    computed?: number;
    printed?: number;
    summed?: number;
    line?: number;
    snippet?: string;
    detail?: string;
}

export class TranscriptParseError extends Error {
    public readonly payload: TranscriptParseErrorPayload;
    constructor(payload: TranscriptParseErrorPayload) {
        super(`TranscriptParseError[${payload.kind}]: ${JSON.stringify(payload)}`);
        this.name = "TranscriptParseError";
        this.payload = payload;
    }
}
