// ============================================================
// Onboarding Flow — Conversational student profile builder
// ============================================================
// Orchestrates the onboarding conversation:
// 1. Student uploads transcript PDF
// 2. Parser extracts structured data
// 3. Major validation
// 4. Confirmation + 2 follow-up questions
// 5. Produces a complete StudentProfile
// ============================================================

import type { LLMClient } from "./llmClient.js";
import {
    parseTranscript,
    checkMajorSupport,
    transcriptToProfile,
    termToSemester,
    type ParsedTranscript,
    type MajorCheckResult,
} from "./transcriptParser.js";

export type OnboardingStep =
    | "awaiting_transcript"
    | "confirming_data"
    | "asking_visa"
    | "asking_graduation"
    | "complete"
    | "unsupported_major";

export interface OnboardingState {
    step: OnboardingStep;
    parsedTranscript?: ParsedTranscript;
    majorCheck?: MajorCheckResult;
    visaStatus?: "f1" | "domestic" | "other";
    targetGraduation?: string;
    profile?: ReturnType<typeof transcriptToProfile>;
}

export interface OnboardingResponse {
    message: string;
    state: OnboardingState;
    /** True if the onboarding is complete and profile is ready */
    complete: boolean;
}

/**
 * Generate the welcome message prompting for transcript upload.
 */
export function getWelcomeMessage(): OnboardingResponse {
    return {
        message:
            `Welcome to **NYU Path** 🎓\n\n` +
            `I'll help you plan your courses and track your degree progress.\n\n` +
            `To get started, please upload your **unofficial transcript PDF**. ` +
            `You can download it from Albert → Student Center → Academics → View Unofficial Transcript.\n\n` +
            `📎 Just send the PDF file and I'll do the rest!`,
        state: { step: "awaiting_transcript" },
        complete: false,
    };
}

/**
 * Handle a transcript PDF upload.
 */
export async function handleTranscriptUpload(
    pdfBuffer: Buffer,
    llm: LLMClient
): Promise<OnboardingResponse> {
    let parsed: ParsedTranscript;
    try {
        parsed = await parseTranscript(pdfBuffer, llm);
    } catch (err) {
        return {
            message:
                `❌ I had trouble reading that PDF. Please make sure it's your ` +
                `NYU unofficial transcript (not a screenshot or scanned copy).\n\n` +
                `Try downloading it again from Albert and sending the PDF file.`,
            state: { step: "awaiting_transcript" },
            complete: false,
        };
    }

    // Check major support
    const majorCheck = checkMajorSupport(parsed);
    if (!majorCheck.supported) {
        return {
            message: majorCheck.message,
            state: { step: "unsupported_major", parsedTranscript: parsed, majorCheck },
            complete: false,
        };
    }

    // Generate confirmation message
    const msg = formatConfirmation(parsed);

    return {
        message: msg,
        state: {
            step: "confirming_data",
            parsedTranscript: parsed,
            majorCheck,
        },
        complete: false,
    };
}

/**
 * Handle the student's confirmation response.
 */
export function handleConfirmation(
    response: string,
    state: OnboardingState
): OnboardingResponse {
    const lower = response.toLowerCase().trim();

    if (lower === "yes" || lower === "y" || lower === "looks good" || lower === "correct") {
        return {
            message: `Great! Two quick questions:\n\n` +
                `1️⃣ Are you on an **F-1 visa**? (yes / no)`,
            state: { ...state, step: "asking_visa" },
            complete: false,
        };
    }

    if (lower === "no" || lower === "n" || lower.includes("wrong") || lower.includes("fix")) {
        return {
            message: `No worries! Please upload a corrected transcript or let me know ` +
                `what's wrong and I'll adjust.`,
            state: { ...state, step: "awaiting_transcript" },
            complete: false,
        };
    }

    return {
        message: `Please reply **yes** if the data looks correct, or **no** if something needs fixing.`,
        state,
        complete: false,
    };
}

/**
 * Handle the F-1 visa question.
 */
export function handleVisaResponse(
    response: string,
    state: OnboardingState
): OnboardingResponse {
    const lower = response.toLowerCase().trim();
    let visaStatus: "f1" | "domestic" | "other";

    if (lower === "yes" || lower === "y" || lower.includes("f-1") || lower.includes("f1")) {
        visaStatus = "f1";
    } else if (lower === "no" || lower === "n" || lower.includes("domestic") || lower.includes("citizen") || lower.includes("resident")) {
        visaStatus = "domestic";
    } else {
        visaStatus = "other";
    }

    // Estimate graduation semester
    const parsed = state.parsedTranscript!;
    const estimatedGrad = estimateGraduation(parsed);

    return {
        message:
            (visaStatus === "f1"
                ? `Got it — I'll make sure every semester has **12+ credits** to keep your F-1 status.\n\n`
                : `Noted! `) +
            `2️⃣ When do you plan to **graduate**? ` +
            `Based on your credits, I'd estimate **${estimatedGrad}**. ` +
            `Is that right, or do you have a different target?`,
        state: { ...state, step: "asking_graduation", visaStatus },
        complete: false,
    };
}

/**
 * Handle the graduation target response.
 */
export function handleGraduationResponse(
    response: string,
    state: OnboardingState
): OnboardingResponse {
    const lower = response.toLowerCase().trim();

    // Parse common formats
    let targetGraduation: string;

    if (lower === "yes" || lower === "y" || lower.includes("correct") || lower.includes("right") || lower.includes("that works")) {
        // Use estimated graduation
        targetGraduation = estimateGraduation(state.parsedTranscript!);
    } else {
        // Parse "Spring 2027", "fall 2026", etc.
        const match = response.match(/(spring|fall|summer)\s*(\d{4})/i);
        if (match) {
            targetGraduation = `${match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()} ${match[2]}`;
        } else {
            // Try just a year
            const yearMatch = response.match(/\b(202\d)\b/);
            if (yearMatch) {
                targetGraduation = `Spring ${yearMatch[1]}`;
            } else {
                return {
                    message: `I didn't quite catch that. Please enter your target graduation semester ` +
                        `(e.g., "Spring 2027" or "Fall 2026").`,
                    state,
                    complete: false,
                };
            }
        }
    }

    // Build the final profile
    const parsed = state.parsedTranscript!;
    const majorCheck = state.majorCheck as { supported: true; programId: string };
    const profile = transcriptToProfile(parsed, {
        visaStatus: state.visaStatus,
        programId: majorCheck.programId,
    });

    const targetSem = termToSemester(targetGraduation);
    const creditsEarned = parsed.totalCreditsEarned;
    const creditsRemaining = Math.max(0, 128 - creditsEarned);
    const currentCourses = parsed.currentSemester?.courses.length ?? 0;

    const completeMsg =
        `✅ **All set, ${parsed.name.split(" ")[0]}!** Your profile is ready.\n\n` +
        `📋 **${parsed.major}** — ${parsed.degree}, ${parsed.school}\n` +
        `📊 **${creditsEarned} credits** earned (${creditsRemaining} remaining)\n` +
        `🎓 Target graduation: **${targetGraduation}**\n` +
        (state.visaStatus === "f1" ? `🛂 F-1 visa: 12+ credits enforced\n` : ``) +
        (currentCourses > 0 ? `📝 Currently enrolled in ${currentCourses} courses\n` : ``) +
        `\nWhat would you like to do?\n` +
        `📚 *"What should I take next semester?"*\n` +
        `🔍 *"Find courses about machine learning"*\n` +
        `📊 *"Am I on track to graduate?"*`;

    return {
        message: completeMsg,
        state: {
            ...state,
            step: "complete",
            targetGraduation: targetSem,
            profile,
        },
        complete: true,
    };
}

/**
 * Main onboarding handler — routes based on current step.
 */
export function handleOnboardingMessage(
    message: string,
    state: OnboardingState
): OnboardingResponse {
    switch (state.step) {
        case "confirming_data":
            return handleConfirmation(message, state);
        case "asking_visa":
            return handleVisaResponse(message, state);
        case "asking_graduation":
            return handleGraduationResponse(message, state);
        default:
            return {
                message: `Please upload your transcript PDF to get started.`,
                state: { step: "awaiting_transcript" },
                complete: false,
            };
    }
}

// ---- Helpers ----

function formatConfirmation(parsed: ParsedTranscript): string {
    const testCredits = parsed.testCredits.reduce((sum, tc) => sum + tc.credits, 0);
    const courseCount = parsed.semesters.reduce((sum, sem) => sum + sem.courses.length, 0);
    const semesterCount = parsed.semesters.length;

    let msg = `✅ Got it! Here's what I found:\n\n`;
    msg += `👤 **${parsed.name}**\n`;
    msg += `🏫 ${parsed.school} — ${parsed.major}, ${parsed.degree}\n`;
    msg += `📊 **${parsed.totalCreditsEarned} credits** earned (GPA: ${parsed.cumulativeGPA.toFixed(2)})\n`;

    if (testCredits > 0) {
        const testNames = parsed.testCredits.map(tc => tc.component).join(", ");
        msg += `📝 ${testCredits} AP/transfer credits (${testNames})\n`;
    }

    msg += `📚 ${courseCount} courses completed across ${semesterCount} semesters\n`;

    // Note school transfers
    const schools = new Set(parsed.semesters.map(s => s.school));
    if (schools.size > 1) {
        const schoolList = Array.from(schools).join(" → ");
        msg += `🔄 Transferred: ${schoolList}\n`;
    }

    // Current enrollment
    if (parsed.currentSemester) {
        msg += `\n📝 Currently enrolled (${parsed.currentSemester.term}):\n`;
        for (const c of parsed.currentSemester.courses) {
            msg += `   • ${c.courseId} — ${c.title}\n`;
        }
    }

    msg += `\nDoes this look right? (**yes** / **no**)`;
    return msg;
}

function estimateGraduation(parsed: ParsedTranscript): string {
    const creditsEarned = parsed.totalCreditsEarned;
    const creditsRemaining = Math.max(0, 128 - creditsEarned);
    const semestersNeeded = Math.ceil(creditsRemaining / 16); // ~16 credits/sem

    // Figure out the current semester
    const lastTerm = parsed.currentSemester?.term ?? parsed.semesters[parsed.semesters.length - 1]?.term ?? "Spring 2025";
    const match = lastTerm.match(/(Fall|Spring|Summer)\s+(\d{4})/i);
    if (!match) return "Spring 2027";

    let currentYear = parseInt(match[2]);
    let isFall = match[1].toLowerCase() === "fall";

    for (let i = 0; i < semestersNeeded; i++) {
        if (isFall) {
            // Next is spring of next year
            currentYear++;
            isFall = false;
        } else {
            // Next is fall of same year
            isFall = true;
        }
    }

    return isFall ? `Fall ${currentYear}` : `Spring ${currentYear}`;
}
