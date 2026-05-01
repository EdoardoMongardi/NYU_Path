// ============================================================
// /api/onboard — DPR-first onboarding (Phase 7-E W2.1)
// ============================================================
// Accepts a single PDF upload of the student's Albert Degree
// Progress Report (DPR). Parses deterministically via the engine's
// dpr-parser (no LLM); returns the parsed `DegreeProgressReport`
// for the chat session to inject as `session.degreeProgressReport`.
//
// Backward compatibility: when the upload field is `transcript`
// (legacy) instead of `dpr`, the route falls back to the original
// unpdf + gpt-4o-mini transcript-parsing flow. Stays in place
// through cohort A in case a student can't get their DPR but does
// have a transcript; planned for removal in cohort-B prep.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { extractText } from "unpdf";
import { parseDpr, type DegreeProgressReport } from "@nyupath/engine";
import { consumeRequest } from "../../../lib/rateLimit";

// Phase 7-E W11 reviewer P1-1 — onboard-route rate limit. Without
// this, anyone could pummel the /api/onboard endpoint with 10 MB
// PDFs and consume parser CPU regardless of the per-student chat
// rate limit. The chat-route guard means nothing if upload is open.
//
// We bucket by `X-Forwarded-For` (first hop) since onboarding doesn't
// send a userId — students upload before they have a chat-page client
// id. Limit is intentionally small: students realistically upload
// 1-3 times per day (initial DPR + maybe a corrected re-export).
const ONBOARD_LIMIT_PER_DAY = 10;

function ipFromRequest(req: NextRequest): string {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return `onboard-ip:${fwd.split(",")[0]!.trim()}`;
    const real = req.headers.get("x-real-ip");
    if (real) return `onboard-ip:${real.trim()}`;
    return "onboard-ip:anonymous";
}

export async function POST(req: NextRequest) {
    // Gate BEFORE we touch the multipart body so a flood of
    // 10MB uploads can't even allocate an ArrayBuffer.
    const rateKey = ipFromRequest(req);
    const rate = consumeRequest(rateKey, ONBOARD_LIMIT_PER_DAY);
    if (!rate.ok) {
        return NextResponse.json(
            {
                message:
                    `You've uploaded the maximum number of DPRs from this IP today (${rate.limit}). ` +
                    `If you need to retry, please wait until ${rate.resetAt} or contact the operator.`,
                onboardingStep: "awaiting_dpr",
            },
            {
                status: 429,
                headers: {
                    "Retry-After": String(rate.retryAfterSeconds),
                    "X-RateLimit-Limit": String(rate.limit),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": rate.resetAt,
                },
            },
        );
    }

    try {
        const formData = await req.formData();
        const dprFile = formData.get("dpr") as File | null;
        const transcriptFile = formData.get("transcript") as File | null;

        // ---- DPR path (primary) ----
        if (dprFile) {
            return await handleDprUpload(dprFile);
        }

        // ---- Transcript path (legacy fallback) ----
        if (transcriptFile) {
            return await handleTranscriptUpload(transcriptFile);
        }

        return NextResponse.json(
            {
                message:
                    "Please upload your Albert Degree Progress Report as a PDF. " +
                    "From Albert: **Academics tab → Planning Tools → Degree Progress Report**, then save the page as PDF and upload here.",
                onboardingStep: "awaiting_dpr",
            },
            { status: 400 },
        );
    } catch (err) {
        console.error("Onboard error:", err);
        return NextResponse.json(
            {
                message: "Something went wrong. Please try uploading again.",
                onboardingStep: "awaiting_dpr",
            },
            { status: 500 },
        );
    }
}

// ============================================================
// DPR upload handler — deterministic, no LLM
// ============================================================

async function handleDprUpload(file: File): Promise<NextResponse> {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
        return NextResponse.json(
            {
                message: "The DPR file must be a PDF. Re-export it from Albert via your browser's Print → Save as PDF.",
                onboardingStep: "awaiting_dpr",
            },
            { status: 400 },
        );
    }

    const bytes = await file.arrayBuffer();
    const sizeMB = (bytes.byteLength / 1024 / 1024).toFixed(1);
    if (bytes.byteLength > 10 * 1024 * 1024) {
        return NextResponse.json(
            {
                message: `That PDF is **${sizeMB} MB** — please upload a file under 10 MB. The DPR is normally less than 200 KB.`,
                onboardingStep: "awaiting_dpr",
            },
            { status: 400 },
        );
    }

    // 1. Extract text from PDF (deterministic, no LLM).
    let rawText: string;
    let pageCount = 0;
    try {
        const { text, totalPages } = await extractText(new Uint8Array(bytes), { mergePages: false });
        rawText = Array.isArray(text) ? text.join("\n") : text;
        pageCount = totalPages ?? (Array.isArray(text) ? text.length : 1);
    } catch (pdfErr) {
        console.error("DPR PDF extract error:", pdfErr);
        return NextResponse.json(
            {
                message:
                    "I couldn't read text out of that PDF. Make sure it's a real PDF (not a screenshot or scanned image). " +
                    "Re-export from Albert via **Print → Save as PDF**, then try again.",
                onboardingStep: "awaiting_dpr",
            },
            { status: 400 },
        );
    }

    // 2. Parse the text into a structured DegreeProgressReport.
    const result = parseDpr(rawText, { pageCount });
    if (!result.ok) {
        console.error("DPR parse failed:", result.error);
        return NextResponse.json(
            {
                message:
                    "I extracted the text but couldn't recognize the Degree Progress Report layout. " +
                    "This might happen if Albert's format changed or you uploaded a different document. " +
                    "Double-check that you uploaded the **Degree Progress Report** (not the Academic Planner or What-If Plan), then try again. " +
                    "If the problem persists, you can fall back to your unofficial transcript by re-uploading under the 'transcript' option.",
                onboardingStep: "awaiting_dpr",
                error: result.error,
            },
            { status: 400 },
        );
    }
    const report = result.report;

    // 3. Build the user-facing summary message.
    const msg = buildDprSummary(report, file.name, sizeMB);

    return NextResponse.json({
        message: msg,
        onboardingStep: "confirming_data",
        parsedData: { kind: "dpr", report },
    });
}

function buildDprSummary(report: DegreeProgressReport, fileName: string, sizeMB: string): string {
    const c = report.cumulative;
    const programs = report.programs.map((p) => `${p.label} (${p.programType})`).join(", ");
    const credits =
        c.creditsRequired !== null && c.creditsUsed !== null
            ? `**${c.creditsUsed} of ${c.creditsRequired} credits** earned`
            : "credits not parsed";
    const gpa = c.cumulativeGpa !== null ? `GPA: ${c.cumulativeGpa.toFixed(3)}` : "GPA not parsed";

    // Count not-satisfied requirements.
    const allReqs: string[] = [];
    const visit = (n: { rId?: string; rgId?: string; status: string; children?: unknown[]; title: string }): void => {
        if (n.rId) {
            if (n.status === "not_satisfied") allReqs.push(n.title);
            return;
        }
        for (const child of (n.children as Array<typeof n>) ?? []) visit(child);
    };
    for (const g of report.requirementGroups) visit(g as unknown as Parameters<typeof visit>[0]);
    const notSatisfiedCount = allReqs.length;

    let lines = `Got it! I read your Degree Progress Report (**${fileName}**, ${sizeMB} MB).\n\n`;
    lines += `**${report.header.studentName}** — ${programs}\n`;
    lines += `${credits} • ${gpa}\n`;
    if (c.passFailUsedUnits !== null && c.passFailCapUnits !== null) {
        lines += `Pass/Fail used: **${c.passFailUsedUnits} of ${c.passFailCapUnits} units**\n`;
    }
    if (c.outsideHomeUsedUnits !== null && c.outsideHomeCapUnits !== null) {
        lines += `Outside-home credits: **${c.outsideHomeUsedUnits} of ${c.outsideHomeCapUnits} units**\n`;
    }
    if (notSatisfiedCount > 0) {
        lines += `\n**${notSatisfiedCount} requirement${notSatisfiedCount === 1 ? "" : "s"} still to satisfy.** I'll walk you through them when you're ready.\n`;
    } else {
        lines += `\n**All requirements satisfied** — congrats!\n`;
    }
    // Parser warnings are operator-debugging signal — surface them in
    // server logs (visible via /admin/observability) but never in the
    // student-facing summary. The student doesn't need to see "15
    // parser warnings about info-only sections".
    if (report._meta.warnings.length > 0) {
        console.warn(`[onboard] DPR parsed for ${report.header.studentName} with ${report._meta.warnings.length} parser warnings`);
    }
    lines += `\nDoes this look right? (**yes** / **no**)`;
    return lines;
}

// ============================================================
// Transcript upload handler — legacy fallback (LLM-based)
// ============================================================

async function handleTranscriptUpload(file: File): Promise<NextResponse> {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
        return NextResponse.json(
            { message: "Please upload a PDF file (your unofficial transcript).", onboardingStep: "awaiting_transcript" },
            { status: 400 },
        );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const sizeMB = (bytes.byteLength / 1024 / 1024).toFixed(1);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return NextResponse.json({
            message: `Got it! Received **${file.name}** (${sizeMB} MB)\n\n` +
                `**Demo Mode** — The full transcript parser requires an OpenAI API key.\n\n` +
                `Here's what the real experience looks like:\n\n` +
                `**Your Name**\n` +
                `College of Arts and Science — Computer Science, BA\n` +
                `**64 credits** earned (GPA: 3.50)\n\n` +
                `Does this look right? (**yes** / **no**)`,
            onboardingStep: "confirming_data",
        });
    }

    let rawText: string;
    try {
        const { text } = await extractText(new Uint8Array(buffer));
        rawText = Array.isArray(text) ? text.join("\n") : text;
    } catch (pdfErr) {
        console.error("PDF parse error:", pdfErr);
        return NextResponse.json({
            message: "I couldn't read that PDF. Please make sure it's a proper PDF file (not a screenshot or scanned image).\n\nTry downloading your unofficial transcript again from **Albert → Student Center → Academics → View Unofficial Transcript**.",
            onboardingStep: "awaiting_transcript",
        });
    }

    const openai = new OpenAI({ apiKey });
    let parsed: TranscriptData;
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: PARSE_SYSTEM_PROMPT },
                { role: "user", content: rawText },
            ],
            temperature: 0,
            max_tokens: 2048,
            response_format: { type: "json_object" },
        });
        const content = response.choices[0]?.message?.content?.trim() ?? "{}";
        parsed = JSON.parse(content) as TranscriptData;
    } catch (llmErr) {
        console.error("LLM parse error:", llmErr);
        return NextResponse.json({
            message: "I had trouble analyzing the transcript text. Please try uploading again.",
            onboardingStep: "awaiting_transcript",
        });
    }

    // Build confirmation message
    const testCredits = (parsed.testCredits ?? []).reduce((s, tc) => s + tc.credits, 0);
    const courseCount = (parsed.semesters ?? []).reduce((s, sem) => s + sem.courses.length, 0);

    let msg = `Got it! Here's what I found:\n\n`;
    msg += `**${parsed.name}**\n`;
    msg += `${parsed.school} — ${parsed.major}, ${parsed.degree}\n`;
    msg += `**${parsed.totalCreditsEarned} credits** earned (GPA: ${parsed.cumulativeGPA?.toFixed(2)})\n`;
    if (testCredits > 0) {
        const testNames = parsed.testCredits!.map((tc) => tc.component).join(", ");
        msg += `${testCredits} AP/transfer credits (${testNames})\n`;
    }
    msg += `${courseCount} courses completed across ${parsed.semesters?.length ?? 0} semesters\n`;

    if (parsed.currentSemester) {
        msg += `\nCurrently enrolled (${parsed.currentSemester.term}):\n`;
        for (const c of parsed.currentSemester.courses) {
            msg += `   • ${c.courseId} — ${c.title}\n`;
        }
    }
    msg += `\nDoes this look right? (**yes** / **no**)`;

    return NextResponse.json({
        message: msg,
        onboardingStep: "confirming_data",
        parsedData: { kind: "transcript", transcript: parsed },
    });
}

// ============================================================
// Legacy types + prompt (transcript fallback)
// ============================================================

interface TranscriptData {
    name: string;
    studentId: string;
    school: string;
    major: string;
    degree: string;
    cumulativeGPA: number;
    totalCreditsEarned: number;
    testCredits?: Array<{ testName: string; component: string; credits: number }>;
    semesters?: Array<{
        term: string;
        school: string;
        major: string;
        courses: Array<{ title: string; courseId: string; credits: number; grade: string }>;
        semesterGPA: number;
        semesterCredits: number;
    }>;
    currentSemester?: {
        term: string;
        courses: Array<{ title: string; courseId: string; credits: number }>;
    };
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
