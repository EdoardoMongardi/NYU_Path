// ============================================================
// Transcript Parser — Extract student data from NYU transcript PDF
// ============================================================
// Takes a PDF buffer, extracts text, then uses GPT-4o-mini to
// parse the semi-structured text into a structured StudentProfile.
// ============================================================

import type { LLMClient, Message } from "./llmClient.js";

export interface ParsedTranscript {
    name: string;
    studentId: string;
    /** Current school, e.g. "College of Arts and Science" */
    school: string;
    /** Current major, e.g. "Computer Science" */
    major: string;
    /** Degree type, e.g. "Bachelor of Arts" */
    degree: string;
    /** Cumulative GPA */
    cumulativeGPA: number;
    /** Total credits earned */
    totalCreditsEarned: number;
    /** AP/IB/transfer test credits */
    testCredits: Array<{
        testName: string;
        component: string;
        credits: number;
    }>;
    /** Courses taken by semester */
    semesters: Array<{
        term: string; // e.g. "Fall 2023"
        school: string;
        major: string;
        courses: Array<{
            title: string;
            courseId: string;
            credits: number;
            grade: string;
        }>;
        semesterGPA: number;
        semesterCredits: number;
    }>;
    /** Currently enrolled (grades = "***" or "IP") */
    currentSemester?: {
        term: string;
        courses: Array<{
            title: string;
            courseId: string;
            credits: number;
        }>;
    };
}

export type MajorCheckResult =
    | { supported: true; programId: string }
    | { supported: false; message: string };

const SUPPORTED_PROGRAMS: Record<string, string> = {
    "computer science|bachelor of arts|college of arts and science": "cs_major_ba",
};

/**
 * Check if the student's current major is supported by the planner.
 */
export function checkMajorSupport(parsed: ParsedTranscript): MajorCheckResult {
    const key = `${parsed.major.toLowerCase()}|${parsed.degree.toLowerCase()}|${parsed.school.toLowerCase()}`;

    for (const [pattern, programId] of Object.entries(SUPPORTED_PROGRAMS)) {
        if (key.includes(pattern.split("|")[0]) &&
            key.includes(pattern.split("|")[1]) &&
            key.includes(pattern.split("|")[2])) {
            // Check for exact CS (not CS/Math, CS/Econ, etc.)
            const majorLower = parsed.major.toLowerCase();
            if (majorLower === "computer science" ||
                majorLower === "computer science major") {
                return { supported: true, programId };
            }
        }
    }

    return {
        supported: false,
        message: `Hey! I can see you're studying **${parsed.major}** (${parsed.degree}) at ${parsed.school}. ` +
            `Right now, I only support the **CAS Computer Science BA** program. ` +
            `Support for more majors is coming soon — stay tuned! 🚀`,
    };
}

/**
 * Extract text from a PDF buffer.
 */
export async function extractTextFromPDF(pdfBuffer: Buffer): Promise<string> {
    const { extractText } = await import("unpdf");
    const { text } = await extractText(new Uint8Array(pdfBuffer));
    return text.join("\n");
}

const PARSE_SYSTEM_PROMPT = `You are a transcript parser for NYU (New York University). Parse the raw text from an unofficial transcript PDF into structured JSON.

Extract:
1. Student info: name, studentId, current school, current major, degree type
2. Test credits (AP/IB/transfer): each with testName (e.g. "ADV_PL"), component (e.g. "Calculus BC"), credits
3. All semesters with courses: for each course extract title, courseId (e.g. "CSCI-UA 102"), credits (number), grade
4. Current semester (if grades show "***" or are missing): list courses without grades
5. Cumulative GPA and total credits earned (from the LAST semester's cumulative line)

Rules:
- Course IDs look like "DEPT-XX NNN" (e.g., "CSCI-UA 101", "MATH-UA 120", "IMNY-UT 101")
- Section numbers after the course ID (e.g., "-001", "-007") should NOT be included in the courseId
- Grades: A, A-, B+, B, B-, C+, C, C-, D+, D, F, P, W, "***" = in-progress
- For the "school" and "major", use the MOST RECENT semester's school/major (students can transfer)
- Credits are usually 4.0 — parse as numbers

Respond ONLY with valid JSON matching this structure:
{
  "name": "string",
  "studentId": "string",
  "school": "string",
  "major": "string",
  "degree": "string",
  "cumulativeGPA": number,
  "totalCreditsEarned": number,
  "testCredits": [{"testName": "string", "component": "string", "credits": number}],
  "semesters": [{
    "term": "string",
    "school": "string",
    "major": "string",
    "courses": [{"title": "string", "courseId": "string", "credits": number, "grade": "string"}],
    "semesterGPA": number,
    "semesterCredits": number
  }],
  "currentSemester": {
    "term": "string",
    "courses": [{"title": "string", "courseId": "string", "credits": number}]
  }
}`;

/**
 * Parse a transcript PDF into structured data using GPT-4o-mini.
 */
export async function parseTranscript(
    pdfBuffer: Buffer,
    llm: LLMClient
): Promise<ParsedTranscript> {
    const rawText = await extractTextFromPDF(pdfBuffer);

    const messages: Message[] = [
        { role: "system", content: PARSE_SYSTEM_PROMPT },
        { role: "user", content: rawText },
    ];

    const parsed = await llm.chatJSON<ParsedTranscript>(messages, {
        maxTokens: 2048,
        temperature: 0,
    });

    return parsed;
}

/**
 * Convert a parsed transcript term string to our semester format.
 * "Fall 2023" → "2023-fall", "Spring 2024" → "2024-spring"
 */
export function termToSemester(term: string): string {
    const match = term.match(/(Fall|Spring|Summer|January)\s+(\d{4})/i);
    if (!match) return term.toLowerCase().replace(/\s+/g, "-");
    const season = match[1].toLowerCase();
    const year = match[2];
    return `${year}-${season}`;
}

/**
 * Convert a ParsedTranscript into a StudentProfile-compatible object.
 * This produces the data shape that the engine expects.
 */
export function transcriptToProfile(parsed: ParsedTranscript, options?: {
    visaStatus?: "f1" | "domestic" | "other";
    programId?: string;
    homeSchool?: string;
}) {
    const coursesTaken = parsed.semesters.flatMap(sem =>
        sem.courses.map(c => ({
            courseId: c.courseId,
            grade: c.grade,
            semester: termToSemester(sem.term),
            credits: c.credits,
        }))
    );

    const transferCourses = parsed.testCredits.map(tc => ({
        source: `${tc.testName} ${tc.component}`,
        scoreOrGrade: "P", // AP credits are pass/fail
        credits: tc.credits,
    }));

    const totalTestCredits = parsed.testCredits.reduce((sum, tc) => sum + tc.credits, 0);

    // Phase 1 §11.2: emit ProgramDeclaration[] + homeSchool. Default homeSchool
    // to "cas" while only the CS BA program is supported by the parser; once
    // additional schools are wired up, the caller should pass an explicit value.
    return {
        id: parsed.studentId,
        catalogYear: parsed.semesters[0]
            ? parsed.semesters[0].term.match(/\d{4}/)?.[0] ?? "2024"
            : "2024",
        homeSchool: options?.homeSchool ?? "cas",
        declaredPrograms: [
            {
                programId: options?.programId ?? "cs_major_ba",
                programType: "major" as const,
            },
        ],
        coursesTaken,
        transferCourses,
        genericTransferCredits: totalTestCredits,
        visaStatus: options?.visaStatus,
    };
}
