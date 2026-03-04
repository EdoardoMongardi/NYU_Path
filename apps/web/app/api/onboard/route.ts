import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { extractText } from "unpdf";

/**
 * POST /api/onboard
 * Handles transcript PDF upload and parsing with GPT-4o-mini.
 */
export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("transcript") as File;

        if (!file || !file.name.endsWith(".pdf")) {
            return NextResponse.json(
                { message: "Please upload a PDF file (your unofficial transcript).", onboardingStep: "awaiting_transcript" },
                { status: 400 }
            );
        }

        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);
        const sizeMB = (bytes.byteLength / 1024 / 1024).toFixed(1);

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            // Demo mode
            return NextResponse.json({
                message: `✅ Got it! Received **${file.name}** (${sizeMB} MB)\n\n` +
                    `📋 **Demo Mode** — The full AI parser requires an OpenAI API key.\n\n` +
                    `Here's what the real experience looks like:\n\n` +
                    `👤 **Your Name**\n` +
                    `🏫 College of Arts and Science — Computer Science, BA\n` +
                    `📊 **64 credits** earned (GPA: 3.50)\n\n` +
                    `Does this look right? (**yes** / **no**)`,
                onboardingStep: "confirming_data",
            });
        }

        // Extract text from PDF
        let rawText: string;
        try {
            const { text } = await extractText(new Uint8Array(buffer));
            rawText = text.join("\n");
        } catch (pdfErr) {
            console.error("PDF parse error:", pdfErr);
            return NextResponse.json({
                message: "❌ I couldn't read that PDF. Please make sure it's a proper PDF file (not a screenshot or scanned image).\n\nTry downloading your unofficial transcript again from **Albert → Student Center → Academics → View Unofficial Transcript**.",
                onboardingStep: "awaiting_transcript",
            });
        }

        // Parse with GPT-4o-mini
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
                message: "❌ I had trouble analyzing the transcript text. Please try uploading again.",
                onboardingStep: "awaiting_transcript",
            });
        }

        // Check major support
        // All available fields combined for flexible matching
        const allText = [
            parsed.major ?? "",
            parsed.degree ?? "",
            parsed.school ?? "",
            // also check semester school/major fields since real transcripts list them per-semester
            ...(parsed.semesters ?? []).map(s => `${s.school ?? ""} ${s.major ?? ""}`),
        ].join(" ").toLowerCase();

        console.log("Parsed transcript:", JSON.stringify({
            name: parsed.name,
            school: parsed.school,
            major: parsed.major,
            degree: parsed.degree,
            gpa: parsed.cumulativeGPA,
            credits: parsed.totalCreditsEarned,
        }, null, 2));

        const isCS = allText.includes("computer science");
        // BA indicators: explicit degree name, CAS affiliation, or "college of arts"
        const isBA = allText.includes("bachelor of arts") ||
            allText.includes(" b.a.") ||
            allText.includes("college of arts and science") ||
            allText.includes("liberal arts") ||
            allText.includes("cas ") ||
            allText.includes(" cas");

        if (!isCS) {
            return NextResponse.json({
                message: `Hey! I can see you're studying **${parsed.major}** (${parsed.degree}) at **${parsed.school}**. ` +
                    `Right now, I only support **Computer Science** programs. ` +
                    `Support for more majors is coming soon — stay tuned! 🚀`,
                onboardingStep: "unsupported_major",
            });
        }

        if (!isBA) {
            // Likely a BS CS or Tandon student
            return NextResponse.json({
                message: `Hey! I can see you're studying **Computer Science** at **${parsed.school}**. ` +
                    `Currently, NYU Path supports the **CAS Computer Science BA** program. ` +
                    `The BS program and Tandon engineering programs are coming soon! 🚀`,
                onboardingStep: "unsupported_major",
            });
        }

        // Build confirmation message
        const testCredits = (parsed.testCredits ?? []).reduce((s, tc) => s + tc.credits, 0);
        const courseCount = (parsed.semesters ?? []).reduce((s, sem) => s + sem.courses.length, 0);

        let msg = `✅ Got it! Here's what I found:\n\n`;
        msg += `👤 **${parsed.name}**\n`;
        msg += `🏫 ${parsed.school} — ${parsed.major}, ${parsed.degree}\n`;
        msg += `📊 **${parsed.totalCreditsEarned} credits** earned (GPA: ${parsed.cumulativeGPA?.toFixed(2)})\n`;
        if (testCredits > 0) {
            const testNames = parsed.testCredits!.map(tc => tc.component).join(", ");
            msg += `📝 ${testCredits} AP/transfer credits (${testNames})\n`;
        }
        msg += `📚 ${courseCount} courses completed across ${parsed.semesters?.length ?? 0} semesters\n`;

        if (parsed.currentSemester) {
            msg += `\n📝 Currently enrolled (${parsed.currentSemester.term}):\n`;
            for (const c of parsed.currentSemester.courses) {
                msg += `   • ${c.courseId} — ${c.title}\n`;
            }
        }

        msg += `\nDoes this look right? (**yes** / **no**)`;

        return NextResponse.json({
            message: msg,
            onboardingStep: "confirming_data",
            parsedData: parsed,
        });

    } catch (err) {
        console.error("Onboard error:", err);
        return NextResponse.json(
            { message: "Something went wrong. Please try uploading again.", onboardingStep: "awaiting_transcript" },
            { status: 500 }
        );
    }
}

// ---- Types & Prompts ----

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
