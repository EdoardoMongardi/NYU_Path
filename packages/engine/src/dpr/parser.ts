// ============================================================
// DPR Parser — text → DegreeProgressReport (Phase 7-E W1.2)
// ============================================================
// Walks the line-by-line text of an Albert Degree Progress Report
// (Oracle Analytics Publisher PDF, PeopleSoft AAR semantics) and
// produces the typed `DegreeProgressReport` shape defined in
// schema.ts.
//
// This module is text-in, JSON-out. PDF byte-stream → text
// extraction lives in tools/dpr-parser/runParser.ts (uses unpdf);
// keeping the regex/walker logic in the engine package lets the
// test suite + the v2 route both invoke it without depending on
// PDF-specific tooling.
//
// Format conventions (verified against the canonical CAS DPR):
//   - Section header line: `<title> (<RGID|RID>)`
//     · RGID matches /^RG\d+$/, RID matches /^R\d+(\/\d+)?$/
//   - Status line: starts with "Satisfied: ", "Not Satisfied: ",
//     or "Overall Requirement Not Satisfied: "
//   - Counter line: starts with `· ` (middle dot + space) followed
//     by one of "Units:", "Courses:", "GPA:" then one or more of
//     "X.XX required" / "Y.XX used" / "Y.XX completed" / "Z.XX needed"
//   - Course-table sentinel: literal line "Courses Used"
//   - Course-table header: literal line "Term Subject Catalog Nbr Course Title Grade Units Type"
//   - Course rows: variable-spaced; right-side anchored (units + type
//     are always the last two whitespace-separated tokens)
//   - Continuation rows (start with 5+ spaces): "Course Topic: ..." or
//     "Repeat Code: ..." attach to the previous course row
//   - Multi-line course titles: title wraps to next line when long;
//     wrap line is bare text without grade/units/type
//   - Course History block: starts with literal line "Course History"
//     and runs to end of document
// ============================================================

import { createHash } from "node:crypto";
import {
    type DegreeProgressReport,
    type DPRAdvisorNotation,
    type DPRCourseRow,
    type DPRCounter,
    type DPRCumulative,
    type DPRHeader,
    type DPRProgram,
    type DPRRequirement,
    type DPRRequirementGroup,
    type DPRStatus,
    degreeProgressReportSchema,
} from "./schema.js";

const PARSER_VERSION = "1.0.0";

export interface ParseDprOptions {
    /** Number of pages in the source PDF (for meta). */
    pageCount?: number;
    /** Override `parsedAt` (for deterministic tests). */
    nowIso?: string;
}

export interface ParseDprFailure {
    ok: false;
    error: string;
    /** Lines that surrounded the failure point (for triage). */
    contextLines?: string[];
}

export interface ParseDprSuccess {
    ok: true;
    report: DegreeProgressReport;
}

export type ParseDprResult = ParseDprSuccess | ParseDprFailure;

/** Top-level entry. Accepts the raw text extracted from the DPR PDF. */
export function parseDpr(rawText: string, opts: ParseDprOptions = {}): ParseDprResult {
    const startedAt = Date.now();
    const warnings: string[] = [];

    // 1. Normalize: strip page markers ("===== PAGE N ====="), strip
    //    HTML anchors PeopleSoft embeds in description text, fold
    //    NBSP to space, drop trailing whitespace per line. Keep
    //    blank lines as separators — the walker uses them.
    const text = normalizeText(rawText);
    const lines = text.split("\n");

    // 2. Header — first ~5 lines.
    const header = extractHeader(lines);
    if (!header) {
        return failure("Could not find DPR header (expected `Degree Progress Report` + `For <name> prepared on <date>`).", lines.slice(0, 10));
    }

    // 3. Programs — table that starts at "Program Requirement Term Requirement Status".
    const programs = extractPrograms(lines, warnings);
    if (programs.length === 0) {
        warnings.push("No programs found in the Programs table.");
    }

    // 4. Advisor notations.
    const advisorNotations = extractAdvisorNotations(lines, warnings);

    // 5. Requirement Groups + Requirements (the heavy lift).
    const courseHistoryStart = lines.findIndex((l) => l.trim() === "Course History");
    const auditEnd = courseHistoryStart >= 0 ? courseHistoryStart : lines.length;
    const requirementGroups = extractRequirementGroups(lines, auditEnd, warnings);

    // 6. Cumulative metrics — derived from specific requirement IDs.
    const cumulative = deriveCumulative(requirementGroups, warnings);

    // 7. Course History (chronological tail).
    const courseHistory = courseHistoryStart >= 0
        ? extractCourseHistory(lines, courseHistoryStart + 1, warnings)
        : [];
    if (courseHistory.length === 0) {
        warnings.push("Course History block missing or empty.");
    }

    const fingerprint = "sha256:" + createHash("sha256").update(text, "utf-8").digest("hex");
    const report: DegreeProgressReport = {
        _meta: {
            parserVersion: PARSER_VERSION,
            parsedAt: opts.nowIso ?? new Date().toISOString(),
            sourceFingerprint: fingerprint,
            sourcePdfPageCount: opts.pageCount ?? -1,
            parseDurationMs: Date.now() - startedAt,
            warnings,
        },
        header,
        programs,
        advisorNotations,
        cumulative,
        requirementGroups,
        courseHistory,
    };

    // 8. Final schema validation — guards against type drift.
    const parsed = degreeProgressReportSchema.safeParse(report);
    if (!parsed.success) {
        return failure(
            `Parsed DPR failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
    }
    return { ok: true, report: parsed.data };
}

// ============================================================
// Normalization
// ============================================================

function normalizeText(raw: string): string {
    return raw
        // Strip extractor page markers (we collapse pages — the DPR
        // logically flows across pages without semantic boundaries).
        .replace(/^===== PAGE \d+ =====$/gm, "")
        // Strip HTML anchors PeopleSoft embeds in descriptions.
        .replace(/<a [^>]*>/g, "")
        .replace(/<\/a>/g, "")
        // Strip HTML entities the extractor leaves intact.
        .replace(/&#160;/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        // PeopleSoft uses non-breaking hyphens in some fixed-format
        // strings (e.g., "First­-Year Seminar"). Normalize to ASCII.
        .replace(/­/g, "")
        // Fold NBSP to regular space.
        .replace(/ /g, " ")
        // Normalize counter-line markers. Oracle Analytics Publisher
        // emits one of several visually-similar glyphs depending on
        // the PDF font; pypdf returns U+0387 (Greek ano teleia) for
        // ours. Fold all known variants to U+00B7 (standard middle
        // dot) so the rest of the parser can match a single form.
        .replace(/[·•‧]/g, "·")
        // Trim trailing whitespace per line; preserve leading whitespace
        // (it carries continuation-line semantics for course rows).
        .split("\n")
        .map((l) => l.replace(/\s+$/, ""))
        .join("\n");
}

// ============================================================
// Header
// ============================================================

function extractHeader(lines: string[]): DPRHeader | null {
    // Albert PDFs often emit "Page 1 of 9Degree Progress Report" on a
    // single line because the page-number runner and the title share
    // the same y-coordinate in the source PDF. Allow either form by
    // matching `contains` rather than equality, and stripping any
    // leading "Page N of M" prefix from the title line.
    let titleIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
        const trimmed = lines[i]!.trim();
        const stripped = trimmed.replace(/^Page\s+\d+\s+of\s+\d+\s*/i, "");
        if (stripped === "Degree Progress Report") {
            titleIdx = i;
            break;
        }
    }
    if (titleIdx === -1) return null;

    // Next non-empty line: "For <name> prepared on <date>". Also strip
    // any "Page N of M" prefix that landed on the same line.
    let nameLineIdx = titleIdx + 1;
    while (nameLineIdx < lines.length && lines[nameLineIdx]!.trim() === "") nameLineIdx++;
    const nameLine = (lines[nameLineIdx]?.trim() ?? "")
        .replace(/^Page\s+\d+\s+of\s+\d+\s*/i, "");
    const nameMatch = nameLine.match(/^For (.+?) prepared on (\S+)$/);
    if (!nameMatch) return null;
    const studentName = nameMatch[1]!.trim();
    const preparedDate = nameMatch[2]!.trim();

    let requestedBy: string | undefined;
    if (nameLineIdx + 1 < lines.length) {
        const next = lines[nameLineIdx + 1]!.trim();
        if (next.startsWith("Requested by")) {
            const r = next.replace(/^Requested by\s*/, "").trim();
            requestedBy = r.length > 0 ? r : undefined;
        }
    }
    return { studentName, preparedDate, ...(requestedBy ? { requestedBy } : {}) };
}

// ============================================================
// Programs table
// ============================================================

function extractPrograms(lines: string[], warnings: string[]): DPRProgram[] {
    const headerIdx = lines.findIndex((l) => l.trim() === "Program Requirement Term Requirement Status");
    if (headerIdx === -1) {
        warnings.push("Programs table header missing.");
        return [];
    }
    const programs: DPRProgram[] = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (line === "" || line === "Advisor Notations") break;
        const parsed = parseProgramRow(line);
        if (parsed) {
            programs.push(parsed);
        } else {
            warnings.push(`Could not parse program row: ${line.slice(0, 100)}`);
        }
    }
    return programs;
}

function parseProgramRow(line: string): DPRProgram | null {
    // Right-anchored: status is one of three known phrases at the end.
    const statusMap: Array<[RegExp, DPRStatus]> = [
        [/\s+(Overall Requirement Not Satisfied)$/, "overall_not_satisfied"],
        [/\s+(Not Satisfied)$/, "not_satisfied"],
        [/\s+(Satisfied)$/, "satisfied"],
    ];
    let status: DPRStatus | null = null;
    let stripped = line;
    for (const [re, st] of statusMap) {
        const m = stripped.match(re);
        if (m) {
            stripped = stripped.slice(0, m.index!).trimEnd();
            status = st;
            break;
        }
    }
    if (!status) return null;

    // Now `stripped` ends with the requirement term (e.g., "Fall 2024"
    // or "Fall 2023"). Match the last "<TermName> <Year>" pair.
    const termMatch = stripped.match(/\s+((?:Fall|Spring|Spr|Summer|January|J-Term)\s+\d{4})$/);
    if (!termMatch) return null;
    const requirementTerm = termMatch[1]!.trim();
    stripped = stripped.slice(0, termMatch.index!).trimEnd();

    // Remaining: "<programType> <label>" — programType is a small known
    // vocabulary at the start of the field.
    const KNOWN_TYPES = [
        "Undergraduate Career", "Graduate Career", "Program",
        "Major Approved", "Major", "Minor Approved", "Minor",
        "Concentration", "Specialization",
    ];
    for (const t of KNOWN_TYPES) {
        if (stripped.endsWith(" " + t)) {
            const label = stripped.slice(0, -t.length).trim();
            return { programType: t, label, requirementTerm, requirementStatus: status };
        }
    }
    // If no known type suffix matched, treat the whole thing as the
    // label and tag programType as "Program" so the row is still
    // captured (with a warning logged upstream).
    return { programType: "Program", label: stripped, requirementTerm, requirementStatus: status };
}

// ============================================================
// Advisor Notations
// ============================================================

function extractAdvisorNotations(lines: string[], warnings: string[]): DPRAdvisorNotation[] {
    const headerIdx = lines.findIndex((l) => l.trim() === "Advisor Notations");
    if (headerIdx === -1) return [];
    const out: DPRAdvisorNotation[] = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (line === "") {
            // Blank line ends the notations block IF the next non-blank
            // line is a section header (matches `(RG\d+)` or `(R\d+/`).
            // Otherwise a blank line is just a soft break.
            const nextNonBlank = lines.slice(i + 1).find((l) => l.trim() !== "");
            if (nextNonBlank && /\((?:RG\d+|R\d+(?:\/\d+)?)\)\s*$/.test(nextNonBlank)) break;
            continue;
        }
        // Numbered: "1. Request id 0000013777 ... T. Gurstel  09/17/2024"
        const m = line.match(/^(\d+)\.\s+(.+)$/);
        if (!m) {
            // Stop if we've left the notations region (heuristic).
            if (/\((?:RG\d+|R\d+(?:\/\d+)?)\)\s*$/.test(line)) break;
            // Otherwise treat as a continuation of the previous note.
            if (out.length > 0) out[out.length - 1]!.note += " " + line;
            continue;
        }
        const note = m[2]!.trim();
        const reqIdMatch = note.match(/Request id\s+(\S+)/);
        const dateMatch = note.match(/(\d{2}\/\d{2}\/\d{4})\s*$/);
        const advisorMatch = dateMatch
            ? note.slice(0, dateMatch.index!).match(/([A-Z]\.\s?[A-Z][a-zA-Z'-]+(?:\s[A-Z][a-zA-Z'-]+)?)\s*$/)
            : null;
        out.push({
            note,
            ...(reqIdMatch ? { requestId: reqIdMatch[1]! } : {}),
            ...(advisorMatch ? { advisor: advisorMatch[1]!.trim() } : {}),
            ...(dateMatch ? { date: dateMatch[1]! } : {}),
        });
    }
    if (out.length === 0) warnings.push("Advisor Notations section present but no notations parsed.");
    return out;
}

// ============================================================
// Requirement Groups + Requirements
// ============================================================

interface SectionHeader {
    lineIdx: number;
    title: string;
    id: string;
    isGroup: boolean; // true if RG, false if R
}

const SECTION_HEADER_RE = /^(.+?)\s+\((RG\d+|R\d+(?:\/\d+)?)\)\s*$/;

function findSectionHeaders(lines: string[], end: number): SectionHeader[] {
    const headers: SectionHeader[] = [];
    for (let i = 0; i < end; i++) {
        const line = lines[i]!.trim();
        const m = line.match(SECTION_HEADER_RE);
        if (!m) continue;
        // Skip false positives: course-table column headers, table
        // body lines that happen to end with "(...)" topic suffixes.
        if (line === "Term Subject Catalog Nbr Course Title Grade Units Type") continue;
        const title = m[1]!.trim();
        const id = m[2]!;
        headers.push({ lineIdx: i, title, id, isGroup: id.startsWith("RG") });
    }
    return headers;
}

function extractRequirementGroups(
    lines: string[],
    end: number,
    warnings: string[],
): DPRRequirementGroup[] {
    const headers = findSectionHeaders(lines, end);
    if (headers.length === 0) return [];

    // Each header's "section" runs from its line to the next header.
    const sections: Array<{ header: SectionHeader; bodyLines: string[] }> = [];
    for (let i = 0; i < headers.length; i++) {
        const start = headers[i]!.lineIdx + 1;
        const stop = i + 1 < headers.length ? headers[i + 1]!.lineIdx : end;
        sections.push({ header: headers[i]!, bodyLines: lines.slice(start, stop) });
    }

    // Build flat sections, then nest based on natural grouping:
    // an RG owns the following Rs until the next RG.
    const flat = sections.map((s) => parseSection(s.header, s.bodyLines, warnings));

    // Nesting: walk left-to-right; each RG opens a parent; subsequent
    // Rs become its children until the next RG. Top-level Rs (Pass/Fail
    // R1680/10, Maximum Credit R1680/30, Time Limit R1680/60) appear
    // before the first RG and are wrapped in a synthetic group.
    const result: DPRRequirementGroup[] = [];
    let currentGroup: DPRRequirementGroup | null = null;

    // Synthesize a host group for any orphan Rs before the first RG.
    const orphanHost: DPRRequirementGroup = {
        rgId: "RG_ORPHAN_PRE",
        title: "Pre-graduation Limits",
        status: "satisfied", // descriptive only
        statusText: "(Synthetic group: orphan limit-style Requirements at the top of the DPR.)",
        children: [],
    };

    for (const sec of flat) {
        if (sec.kind === "group") {
            currentGroup = sec.value;
            result.push(currentGroup);
        } else {
            const target = currentGroup ?? orphanHost;
            target.children.push(sec.value);
        }
    }
    if (orphanHost.children.length > 0) result.unshift(orphanHost);
    return result;
}

interface ParsedGroup { kind: "group"; value: DPRRequirementGroup }
interface ParsedReq { kind: "req"; value: DPRRequirement }

function parseSection(
    header: SectionHeader,
    body: string[],
    warnings: string[],
): ParsedGroup | ParsedReq {
    // Status line: first non-empty line of the body that starts with
    // a known status prefix. (Some sections have descriptive text
    // before the status, so scan a window.)
    let statusIdx = -1;
    let status: DPRStatus | null = null;
    let statusText = "";
    for (let i = 0; i < body.length; i++) {
        const line = body[i]!.trim();
        if (line === "") continue;
        if (line.startsWith("Overall Requirement Not Satisfied:")) {
            status = "overall_not_satisfied";
            statusText = line;
            statusIdx = i;
            break;
        }
        if (line.startsWith("Not Satisfied:")) {
            status = "not_satisfied";
            statusText = line;
            statusIdx = i;
            break;
        }
        if (line.startsWith("Satisfied:")) {
            status = "satisfied";
            statusText = line;
            statusIdx = i;
            break;
        }
    }

    // Description: the multi-line block from after status until the
    // counter / "Courses Used" / next section starts.
    let descriptionLines: string[] = [];
    let i = statusIdx === -1 ? 0 : statusIdx + 1;
    for (; i < body.length; i++) {
        const line = body[i]!.trim();
        if (line === "") continue;
        if (line.startsWith("·")) break;
        if (line === "Courses Used") break;
        if (SECTION_HEADER_RE.test(line)) break;
        if (line.startsWith("Satisfied:") || line.startsWith("Not Satisfied:") || line.startsWith("Overall Requirement Not Satisfied:")) break;
        descriptionLines.push(line);
    }
    const description = descriptionLines.join(" ").trim();

    // Counter line(s): zero or more lines starting with "·".
    let counter: DPRCounter | undefined;
    for (; i < body.length; i++) {
        const line = body[i]!.trim();
        if (line === "") continue;
        if (!line.startsWith("·")) break;
        const parsed = parseCounter(line);
        if (parsed) counter = parsed;
        // Multiple counter lines on one R are rare but possible (e.g.,
        // "Units" + "GPA" both appear). Last one wins; we keep both
        // would require multi-counter support — defer until needed.
    }

    // "Courses Used" table.
    let coursesUsed: DPRCourseRow[] = [];
    if (i < body.length && body[i]!.trim() === "Courses Used") {
        i += 1;
        // Skip header line if present.
        if (i < body.length && body[i]!.trim() === "Term Subject Catalog Nbr Course Title Grade Units Type") {
            i += 1;
        }
        const tableStart = i;
        // Find table end: blank line followed by another section, or
        // the buffer end.
        let tableEnd = body.length;
        for (let j = tableStart; j < body.length; j++) {
            const l = body[j]!;
            if (l.trim() === "" || SECTION_HEADER_RE.test(l.trim())) {
                tableEnd = j;
                break;
            }
        }
        coursesUsed = parseCourseTable(body.slice(tableStart, tableEnd), warnings);
    }

    if (status === null) {
        warnings.push(`Section ${header.id} (${header.title}) has no status line; defaulting to satisfied.`);
        status = "satisfied";
        statusText = "(no status line found)";
    }

    if (header.isGroup) {
        // Groups don't directly own counters/coursesUsed in the spec —
        // those live on their child Requirements. But occasionally a
        // group has a summary counter (e.g., "· Courses: 18.00 required,
        // 17.00 used" on RG5076). We attach those via a synthetic
        // "summary" requirement on the group children.
        const children: Array<DPRRequirementGroup | DPRRequirement> = [];
        if (counter) {
            children.push({
                rId: header.id + "/_summary",
                title: header.title + " (summary)",
                status,
                statusText,
                ...(description ? { description } : {}),
                counter,
                coursesUsed,
            });
        }
        return {
            kind: "group",
            value: {
                rgId: header.id,
                title: header.title,
                status,
                statusText,
                ...(description ? { description } : {}),
                children,
            },
        };
    }
    return {
        kind: "req",
        value: {
            rId: header.id,
            title: header.title,
            status,
            statusText,
            ...(description ? { description } : {}),
            ...(counter ? { counter } : {}),
            coursesUsed,
        },
    };
}

// ============================================================
// Counter line parsing
// ============================================================

function parseCounter(line: string): DPRCounter | null {
    // Strip leading "· " marker.
    const body = line.replace(/^·\s+/, "").trim();
    // Three flavors. GPA uses "completed" instead of "used".
    const gpaMatch = body.match(/^GPA:\s*([\d.]+)\s+required,\s*([\d.]+)\s+completed/);
    if (gpaMatch) {
        return {
            kind: "gpa",
            required: parseFloat(gpaMatch[1]!),
            completed: parseFloat(gpaMatch[2]!),
        };
    }
    const unitsMatch = body.match(/^Units:\s*(?:([\d.]+)\s+required,\s*)?([\d.]+)\s+used(?:,\s*([\d.]+)\s+needed)?/);
    if (unitsMatch) {
        return {
            kind: "units",
            required: unitsMatch[1] ? parseFloat(unitsMatch[1]) : 0,
            used: parseFloat(unitsMatch[2]!),
            ...(unitsMatch[3] ? { needed: parseFloat(unitsMatch[3]) } : {}),
        };
    }
    const coursesMatch = body.match(/^Courses:\s*(?:([\d.]+)\s+required,\s*)?([\d.]+)\s+used(?:,\s*([\d.]+)\s+needed)?/);
    if (coursesMatch) {
        return {
            kind: "courses",
            required: coursesMatch[1] ? parseFloat(coursesMatch[1]) : 0,
            used: parseFloat(coursesMatch[2]!),
            ...(coursesMatch[3] ? { needed: parseFloat(coursesMatch[3]) } : {}),
        };
    }
    return null;
}

// ============================================================
// Course table parsing
// ============================================================

// Subjects come in two forms:
//   - Standard: <DEPT>-<SCHOOL> e.g. "CSCI-UA", "MATH-UA", "MPAJZ-UE"
//   - Special: bare uppercase tokens like "ELECTIVE" used for the
//     "ELECTIVE CREDIT Elective Credit UGRD" transfer-credit rows
const SUBJECT_RE = "(?:[A-Z][A-Z0-9]*-[A-Z]{2,3}|ELECTIVE)";
// Term: "<YYYY> <SeasonName>"
const TERM_RE = "(\\d{4})\\s+(Fall|Spr|Spring|Summer|J-Term|January)";

const COURSE_ROW_RE = new RegExp(
    `^${TERM_RE}\\s+(${SUBJECT_RE})\\s+(\\S+)\\s+(.+?)(?:\\s+([A-Z][A-Z+\\-]?))?\\s+(\\d+(?:\\.\\d+)?)\\s+([A-Z]{1,3})\\s*$`,
);

function parseCourseTable(body: string[], warnings: string[]): DPRCourseRow[] {
    const out: DPRCourseRow[] = [];
    for (let i = 0; i < body.length; i++) {
        const line = body[i]!;
        const trimmed = line.trim();
        if (trimmed === "") continue;

        // Continuation lines start with leading whitespace.
        if (line.startsWith("     ") && out.length > 0) {
            const cont = trimmed;
            const last = out[out.length - 1]!;
            const topicMatch = cont.match(/^Course Topic:\s*(.+)$/);
            if (topicMatch) {
                last.courseTopic = topicMatch[1]!.trim();
                continue;
            }
            const repeatMatch = cont.match(/^Repeat Code:\s*(.+)$/);
            if (repeatMatch) {
                last.repeatCode = repeatMatch[1]!.trim();
                continue;
            }
            // A wrapped course-title continuation (no Code/Topic prefix);
            // append to the previous title.
            last.courseTitle += " " + cont;
            continue;
        }

        const row = parseCourseRow(trimmed);
        if (row) {
            out.push(row);
            continue;
        }
        // Try matching with a 2- or 3-line wrapped title: this row has
        // only term+subject+catalog+title (no grade/units/type yet);
        // the numeric tail is on a subsequent non-blank line; an
        // optional middle line carries a parenthesized topic suffix
        // (e.g., CORE-UA 500 Topics + "(Wine and Feasting in the Anci)").
        const wrappedRe = new RegExp(
            `^${TERM_RE}\\s+(${SUBJECT_RE})\\s+(\\S+)\\s+(.+)$`,
        );
        const wrapped = trimmed.match(wrappedRe);
        if (wrapped && i + 1 < body.length) {
            // Look ahead 1-2 lines: optional title-suffix line, then a
            // tail line with units (and optionally grade + type).
            let titleSuffix = "";
            let tailIdx = i + 1;
            const peek1 = body[tailIdx]?.trim() ?? "";
            const tailWithGradeRe = /^([A-Z][A-Z+\-]?)\s+(\d+(?:\.\d+)?)\s+([A-Z]{1,3})$/;
            const tailNoGradeRe = /^(\d+(?:\.\d+)?)\s+([A-Z]{1,3})$/;
            if (
                peek1.startsWith("(") && peek1.endsWith(")")
                && !tailWithGradeRe.test(peek1) && !tailNoGradeRe.test(peek1)
            ) {
                titleSuffix = " " + peek1;
                tailIdx += 1;
            }
            const tailLine = body[tailIdx]?.trim() ?? "";
            const tailWithGrade = tailLine.match(tailWithGradeRe);
            const tailNoGrade = tailLine.match(tailNoGradeRe);
            if (tailWithGrade) {
                out.push({
                    term: `${wrapped[1]} ${wrapped[2]}`,
                    subject: wrapped[3]!,
                    catalogNbr: wrapped[4]!,
                    courseTitle: (wrapped[5]! + titleSuffix).trim(),
                    grade: tailWithGrade[1]!,
                    units: parseFloat(tailWithGrade[2]!),
                    type: tailWithGrade[3]!,
                });
                i = tailIdx;
                continue;
            }
            if (tailNoGrade) {
                out.push({
                    term: `${wrapped[1]} ${wrapped[2]}`,
                    subject: wrapped[3]!,
                    catalogNbr: wrapped[4]!,
                    courseTitle: (wrapped[5]! + titleSuffix).trim(),
                    grade: null,
                    units: parseFloat(tailNoGrade[1]!),
                    type: tailNoGrade[2]!,
                });
                i = tailIdx;
                continue;
            }
        }
        warnings.push(`Could not parse course row: ${trimmed.slice(0, 120)}`);
    }
    return out;
}

function parseCourseRow(line: string): DPRCourseRow | null {
    const m = line.match(COURSE_ROW_RE);
    if (!m) {
        // IP rows have no grade. Try the no-grade variant.
        const noGradeRe = new RegExp(
            `^${TERM_RE}\\s+(${SUBJECT_RE})\\s+(\\S+)\\s+(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s+(IP)\\s*$`,
        );
        const noGrade = line.match(noGradeRe);
        if (noGrade) {
            return {
                term: `${noGrade[1]} ${noGrade[2]}`,
                subject: noGrade[3]!,
                catalogNbr: noGrade[4]!,
                courseTitle: noGrade[5]!.trim(),
                grade: null,
                units: parseFloat(noGrade[6]!),
                type: noGrade[7]!,
            };
        }
        return null;
    }
    return {
        term: `${m[1]} ${m[2]}`,
        subject: m[3]!,
        catalogNbr: m[4]!,
        courseTitle: m[5]!.trim(),
        grade: m[6] ?? null,
        units: parseFloat(m[7]!),
        type: m[8]!,
    };
}

// ============================================================
// Course History
// ============================================================

function extractCourseHistory(lines: string[], start: number, warnings: string[]): DPRCourseRow[] {
    // Skip the column-header row if present.
    let i = start;
    if (i < lines.length && lines[i]!.trim() === "Term Subject Catalog Nbr Title Grade Units Type") i += 1;
    return parseCourseTable(lines.slice(i), warnings);
}

// ============================================================
// Cumulative metrics — derive from specific R-IDs
// ============================================================

function deriveCumulative(
    groups: DPRRequirementGroup[],
    warnings: string[],
): DPRCumulative {
    const allReqs: DPRRequirement[] = [];
    const visit = (n: DPRRequirementGroup | DPRRequirement): void => {
        if ("rId" in n) {
            allReqs.push(n);
            return;
        }
        for (const c of n.children) visit(c);
    };
    for (const g of groups) visit(g);
    const byId = new Map(allReqs.map((r) => [r.rId, r] as const));

    const r1001_10 = byId.get("R1001/10"); // Min Credits
    const r1001_20 = byId.get("R1001/20"); // Min GPA
    const r1001_35 = byId.get("R1001/35"); // CAS Residency
    const r1680_10 = byId.get("R1680/10"); // Pass/Fail
    const r1680_30 = byId.get("R1680/30"); // Outside-CAS

    const c = (req: DPRRequirement | undefined): DPRCounter | undefined =>
        req?.counter;

    const credits = c(r1001_10);
    const gpa = c(r1001_20);
    const residency = c(r1001_35);
    const pf = c(r1680_10);
    const outside = c(r1680_30);

    // Pass/Fail and Outside-CAS caps live in the verbose body text
    // PeopleSoft prints under each section ("32 units" / "16 units").
    // For R1680/10 the cap appears in the description block; for
    // R1680/30 it's part of the status sentence ("Satisfied: No more
    // than 16 units may be taken outside of CAS..."). We scan
    // description first, then statusText, then default.
    const passFailCap = parseUnitCap(r1680_10) ?? 32;
    const outsideHomeCap = parseUnitCap(r1680_30) ?? 16;

    const r1680_60 = byId.get("R1680/60"); // Time Limit
    const timeLimit =
        parseFirstNumber(r1680_60?.description ?? "")
        ?? parseFirstNumber(r1680_60?.statusText ?? "")
        ?? null;

    if (!gpa) warnings.push("R1001/20 (Cumulative GPA) not found.");
    if (!credits) warnings.push("R1001/10 (Minimum Credits) not found.");

    return {
        creditsRequired: credits?.kind === "units" ? credits.required : null,
        creditsUsed: credits?.kind === "units" ? credits.used : null,
        cumulativeGpa: gpa?.kind === "gpa" ? gpa.completed : null,
        cumulativeGpaRequired: gpa?.kind === "gpa" ? gpa.required : null,
        residencyRequired: residency?.kind === "units" ? residency.required : null,
        residencyUsed: residency?.kind === "units" ? residency.used : null,
        passFailUsedUnits: pf?.kind === "units" ? pf.used : null,
        passFailCapUnits: passFailCap,
        outsideHomeUsedUnits: outside?.kind === "units" ? outside.used : null,
        outsideHomeCapUnits: outsideHomeCap,
        timeLimitYears: timeLimit,
    };
}

function parseFirstNumber(s: string): number | null {
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]!) : null;
}

/** Look for the "X units" phrase that names the section's cap. Tries
 *  description first, then statusText, returning the first integer
 *  followed by " units" (or " unit"). Falls back to the first number
 *  in either block. */
function parseUnitCap(req: DPRRequirement | undefined): number | null {
    if (!req) return null;
    const sources = [req.description, req.statusText];
    for (const s of sources) {
        if (!s) continue;
        const m = s.match(/(\d+(?:\.\d+)?)\s+units?/i);
        if (m) return parseFloat(m[1]!);
    }
    for (const s of sources) {
        if (!s) continue;
        const n = parseFirstNumber(s);
        if (n !== null) return n;
    }
    return null;
}

// ============================================================
// Failure helper
// ============================================================

function failure(error: string, contextLines?: string[]): ParseDprFailure {
    return { ok: false, error, ...(contextLines ? { contextLines } : {}) };
}
