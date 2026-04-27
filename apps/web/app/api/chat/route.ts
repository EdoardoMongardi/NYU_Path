// ============================================================
// /api/chat — onboarding + pre-onboarding chitchat ONLY (Phase 6.5 P-2)
// ============================================================
// Post-onboarding turns are served by /api/chat/v2 (the agent loop +
// SSE pipeline shipped in Phase 6.1). This route now ONLY handles:
//
//   1. Onboarding state-machine steps (confirming_data → correcting_data
//      → asking_visa → asking_graduation → complete).
//   2. Pre-onboarding chitchat (the user typed a message before
//      uploading a transcript).
//
// Any post-onboarding POST that lands here returns 410 Gone with a
// pointer at /api/chat/v2. The legacy `handleAIChat` path + the
// chat/, data/academicRules.ts, and search/semanticSearch.ts modules
// it depended on are deleted in this same PR (Phase 6.5 P-2 / WS3
// finish). The deprecation guard at
// packages/engine/tests/eval/legacyDeprecation.test.ts has been
// updated to drop the grandfathered entries that are now gone.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { OpenAIEngineClient, DEFAULT_PRIMARY_MODEL } from "@nyupath/engine";

// ============================================================
// POST /api/chat
// ============================================================

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { message, onboardingStep, parsedData } = body as {
            message?: string;
            onboardingStep?: string;
            parsedData?: unknown;
        };

        if (typeof message !== "string") {
            return NextResponse.json(
                { error: "`message` is required and must be a string." },
                { status: 400 },
            );
        }

        // Onboarding state-machine steps.
        if (onboardingStep && onboardingStep !== "complete" && onboardingStep !== "awaiting_transcript") {
            return handleOnboardingStep(message, onboardingStep);
        }

        // Post-onboarding traffic must use /api/chat/v2 (SSE).
        if (onboardingStep === "complete" && parsedData) {
            return NextResponse.json(
                {
                    error: "POST /api/chat is deprecated for post-onboarding turns. Use POST /api/chat/v2 (SSE).",
                    redirect: "/api/chat/v2",
                },
                { status: 410 },
            );
        }

        // Pre-onboarding chitchat (no parsedData yet).
        return handleBasicChat(message, onboardingStep);
    } catch (err) {
        console.error("Chat error:", err);
        return NextResponse.json(
            { message: "Sorry, something went wrong. Please try again." },
            { status: 500 },
        );
    }
}

// ============================================================
// Onboarding state machine (unchanged from pre-cutover)
// ============================================================

function handleOnboardingStep(message: string, step: string) {
    const lower = message.toLowerCase().trim();

    switch (step) {
        case "confirming_data": {
            if (lower === "yes" || lower === "y" || lower === "looks good" || lower === "correct" || lower.includes("looks right") || lower.includes("that's right")) {
                return NextResponse.json({
                    message: "Great! Two quick questions:\n\n1️⃣ Are you on an **F-1 visa**? (yes / no)",
                    onboardingStep: "asking_visa",
                });
            }
            if (lower === "no" || lower === "n" || lower.includes("not right") || lower.includes("wrong") || lower.includes("incorrect")) {
                return NextResponse.json({
                    message: "No problem! What looks incorrect? You can tell me:\n\n" +
                        "- **Name** — e.g. \"My name is wrong, it should be Jane Doe\"\n" +
                        "- **Major / Degree** — e.g. \"I'm actually BA not BS\"\n" +
                        "- **Credits** — e.g. \"I have 80 credits not 64\"\n" +
                        "- **GPA** — e.g. \"My GPA is 3.7\"\n" +
                        "- **Missing courses** — e.g. \"CSCI-UA 301 is missing\"\n\n" +
                        "Or if it's significantly wrong, you can **upload a new transcript**.",
                    onboardingStep: "correcting_data",
                });
            }
            return NextResponse.json({
                message: "Please reply **yes** if the data looks correct, or **no** if something needs fixing.",
                onboardingStep: "confirming_data",
            });
        }

        case "correcting_data": {
            const isReupload = lower.includes("upload") || lower.includes("new transcript") || lower.includes("try again");
            if (isReupload) {
                return NextResponse.json({
                    message: "Sure! Go ahead and upload the corrected transcript using the 📎 button.",
                    onboardingStep: "awaiting_transcript",
                });
            }
            const isDone = lower === "done" || lower === "proceed" || lower === "continue" || lower.includes("that's it") || lower.includes("that's all");
            if (isDone) {
                return NextResponse.json({
                    message: "Great! Two quick questions:\n\n1️⃣ Are you on an **F-1 visa**? (yes / no)",
                    onboardingStep: "asking_visa",
                });
            }
            return NextResponse.json({
                message: "Got it, I've noted that correction! ✅\n\nIs there anything else that looks wrong, or shall we proceed?\n\n(Reply **done** to continue, or describe another correction)",
                onboardingStep: "correcting_data",
            });
        }

        case "asking_visa": {
            const isF1 = lower === "yes" || lower === "y" || lower.includes("f-1") || lower.includes("f1");
            const visaNote = isF1
                ? "Got it — I'll make sure every semester has **12+ credits** to keep your F-1 status.\n\n"
                : "Noted! ";

            return NextResponse.json({
                message: `${visaNote}2️⃣ When do you plan to **graduate**? (e.g., "Spring 2027")`,
                onboardingStep: "asking_graduation",
                visaStatus: isF1 ? "f1" : "domestic",
            });
        }

        case "asking_graduation": {
            const match = message.match(/(spring|fall|summer)\s*(\d{4})/i);
            const yearMatch = message.match(/\b(202\d)\b/);
            const accepted = lower === "yes" || lower === "y" || lower.includes("correct");

            if (!match && !yearMatch && !accepted) {
                return NextResponse.json({
                    message: 'I didn\'t quite catch that. Please enter your target graduation semester (e.g., "Spring 2027").',
                    onboardingStep: "asking_graduation",
                });
            }

            const gradTarget = match ? `${match[2]}-${match[1].toLowerCase()}` : yearMatch ? `${yearMatch[1]}-spring` : "2027-spring";

            return NextResponse.json({
                message: `✅ **All set!** Your profile is ready.\n\nWhat would you like to do?\n📚 *"What should I take next semester?"*\n🔍 *"Find courses about machine learning"*\n📊 *"Am I on track to graduate?"*`,
                onboardingStep: "complete",
                graduationTarget: gradTarget,
            });
        }

        default:
            return NextResponse.json({
                message: "Please upload your transcript PDF to get started.",
                onboardingStep: "awaiting_transcript",
            });
    }
}

// ============================================================
// Pre-onboarding chitchat (no transcript yet)
// ============================================================

async function handleBasicChat(message: string, onboardingStep?: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    const needsTranscript = onboardingStep === "awaiting_transcript";

    // If we have an API key, run a 1-shot completion via the engine
    // adapter (no tools — pre-onboarding has no profile to act on).
    if (apiKey) {
        const llm = new OpenAIEngineClient({ modelId: DEFAULT_PRIMARY_MODEL, apiKey });
        const systemPrompt = `You are NYU Path 🎓, a friendly AI course planning assistant for NYU students. You are chatting with a student who has NOT yet uploaded their transcript.

Your capabilities: transcript parsing, degree audit, course search, semester planning with prerequisite checks.

The student needs to upload their unofficial transcript PDF before you can help with specific academic planning. Mention this naturally if relevant, but don't repeat it in every single response — it gets annoying.

Keep responses concise (2-3 sentences). Be warm, natural, and conversational. Match the student's tone (casual if they're casual).`;

        try {
            const response = await llm.complete({
                system: systemPrompt,
                messages: [{ role: "user", content: message }],
                temperature: 0.6,
                maxTokens: 200,
            });
            return NextResponse.json({ message: response.text });
        } catch {
            // Fall through to hardcoded responses if LLM fails.
        }
    }

    const lower = message.toLowerCase().trim();
    if (/^(hi|hello|hey|yo|sup)\b/.test(lower)) {
        return NextResponse.json({
            message: "Hey! 👋 I'm your NYU course planning assistant. I can help you with:\n\n" +
                "📚 **Find electives** — \"I want courses about machine learning\"\n" +
                "📊 **Check progress** — \"How many credits do I still need?\"\n" +
                "📋 **Plan semester** — \"What should I take next semester?\"\n" +
                (needsTranscript ? "\nBut first, **upload your transcript PDF** so I can see your courses! 📎" : "\nWhat can I help you with?"),
        });
    }
    return NextResponse.json({
        message: needsTranscript
            ? "I'd love to help! But first, please **upload your transcript PDF** so I know what courses you've completed. 📎\n\nYou can download it from Albert → Student Center → Academics → View Unofficial Transcript."
            : `I understand you're asking: "${message}"\n\nTry asking:\n• "What should I take next semester?"\n• "Am I on track to graduate?"\n• "Find courses about data science"`,
    });
}
