// ============================================================
// Unit Tests — Onboarding Flow
// ============================================================
import { describe, it, expect } from "vitest";
import {
    checkMajorSupport,
    termToSemester,
    transcriptToProfile,
    type ParsedTranscript,
} from "../../src/chat/transcriptParser.js";
import {
    getWelcomeMessage,
    handleConfirmation,
    handleVisaResponse,
    handleGraduationResponse,
    handleOnboardingMessage,
    type OnboardingState,
} from "../../src/chat/onboardingFlow.js";

// ---- Mock transcript data (based on the real format) ----
const mockTranscript: ParsedTranscript = {
    name: "Edoardo Mongardi",
    studentId: "N17849249",
    school: "College of Arts and Science",
    major: "Computer Science/Math",
    degree: "Bachelor of Arts",
    cumulativeGPA: 3.5,
    totalCreditsEarned: 64,
    testCredits: [
        { testName: "ADV_PL", component: "Calculus BC", credits: 4 },
        { testName: "ADV_PL", component: "Computer Science A", credits: 4 },
        { testName: "ADV_PL", component: "Physics C Mechanics", credits: 4 },
    ],
    semesters: [
        {
            term: "Fall 2023",
            school: "Tisch School of the Arts",
            major: "Interactive Media Arts",
            courses: [
                { title: "Data Structures", courseId: "CSCI-UA 102", credits: 4, grade: "B" },
                { title: "Creative Computing", courseId: "IMNY-UT 101", credits: 4, grade: "A" },
            ],
            semesterGPA: 3.583,
            semesterCredits: 16,
        },
        {
            term: "Spring 2024",
            school: "Tisch School of the Arts",
            major: "Interactive Media Arts",
            courses: [
                { title: "Discrete Mathematics", courseId: "MATH-UA 120", credits: 4, grade: "B+" },
                { title: "Computer Systems Org", courseId: "CSCI-UA 201", credits: 4, grade: "B+" },
            ],
            semesterGPA: 3.333,
            semesterCredits: 16,
        },
    ],
    currentSemester: {
        term: "Spring 2025",
        courses: [
            { title: "Basic Algorithms", courseId: "CSCI-UA 310", credits: 4 },
            { title: "Theory of Probability", courseId: "MATH-UA 233", credits: 4 },
        ],
    },
};

const csOnlyTranscript: ParsedTranscript = {
    ...mockTranscript,
    major: "Computer Science",
};

// ============================================================
// Major Validation
// ============================================================
describe("Transcript Parser: checkMajorSupport", () => {
    it("CS/Math BA at CAS → unsupported", () => {
        const result = checkMajorSupport(mockTranscript);
        expect(result.supported).toBe(false);
        if (!result.supported) {
            expect(result.message).toContain("Computer Science/Math");
            expect(result.message).toContain("CAS Computer Science BA");
            expect(result.message).toContain("coming soon");
        }
    });

    it("CS BA at CAS → supported", () => {
        const result = checkMajorSupport(csOnlyTranscript);
        expect(result.supported).toBe(true);
        if (result.supported) {
            expect(result.programId).toBe("cs_major_ba");
        }
    });

    it("Econ BA at CAS → unsupported", () => {
        const econTranscript = { ...mockTranscript, major: "Economics" };
        const result = checkMajorSupport(econTranscript);
        expect(result.supported).toBe(false);
    });

    it("CS at Tandon → unsupported", () => {
        const tandonTranscript = {
            ...csOnlyTranscript,
            school: "Tandon School of Engineering",
            degree: "Bachelor of Science",
        };
        const result = checkMajorSupport(tandonTranscript);
        expect(result.supported).toBe(false);
    });
});

// ============================================================
// Term to Semester Conversion
// ============================================================
describe("Transcript Parser: termToSemester", () => {
    it("Fall 2023 → 2023-fall", () => {
        expect(termToSemester("Fall 2023")).toBe("2023-fall");
    });

    it("Spring 2024 → 2024-spring", () => {
        expect(termToSemester("Spring 2024")).toBe("2024-spring");
    });

    it("Summer 2025 → 2025-summer", () => {
        expect(termToSemester("Summer 2025")).toBe("2025-summer");
    });
});

// ============================================================
// Transcript to Profile Conversion
// ============================================================
describe("Transcript Parser: transcriptToProfile", () => {
    it("converts courses correctly", () => {
        const profile = transcriptToProfile(csOnlyTranscript, {
            visaStatus: "f1",
            programId: "cs_major_ba",
        });

        expect(profile.coursesTaken).toHaveLength(4); // 2 per semester × 2 semesters
        expect(profile.coursesTaken[0].courseId).toBe("CSCI-UA 102");
        expect(profile.coursesTaken[0].grade).toBe("B");
        expect(profile.coursesTaken[0].semester).toBe("2023-fall");
    });

    it("converts transfer credits", () => {
        const profile = transcriptToProfile(csOnlyTranscript);
        expect(profile.transferCourses).toHaveLength(3);
        expect(profile.transferCourses![0].source).toContain("Calculus BC");
    });

    it("sets visa status", () => {
        const profile = transcriptToProfile(csOnlyTranscript, { visaStatus: "f1" });
        expect(profile.visaStatus).toBe("f1");
    });

    it("sets program ID", () => {
        const profile = transcriptToProfile(csOnlyTranscript, { programId: "cs_major_ba" });
        expect(profile.declaredPrograms).toEqual(["cs_major_ba"]);
    });
});

// ============================================================
// Welcome Message
// ============================================================
describe("Onboarding Flow: getWelcomeMessage", () => {
    it("returns awaiting_transcript state", () => {
        const result = getWelcomeMessage();
        expect(result.state.step).toBe("awaiting_transcript");
        expect(result.complete).toBe(false);
        expect(result.message).toContain("transcript");
    });
});

// ============================================================
// Confirmation Step
// ============================================================
describe("Onboarding Flow: handleConfirmation", () => {
    const state: OnboardingState = {
        step: "confirming_data",
        parsedTranscript: csOnlyTranscript,
        majorCheck: { supported: true, programId: "cs_major_ba" },
    };

    it("yes → asks visa", () => {
        const result = handleConfirmation("yes", state);
        expect(result.state.step).toBe("asking_visa");
        expect(result.message).toContain("F-1 visa");
    });

    it("no → back to transcript upload", () => {
        const result = handleConfirmation("no", state);
        expect(result.state.step).toBe("awaiting_transcript");
    });

    it("ambiguous → asks again", () => {
        const result = handleConfirmation("hmm maybe", state);
        expect(result.state.step).toBe("confirming_data");
        expect(result.message).toContain("yes");
    });
});

// ============================================================
// Visa Question
// ============================================================
describe("Onboarding Flow: handleVisaResponse", () => {
    const state: OnboardingState = {
        step: "asking_visa",
        parsedTranscript: csOnlyTranscript,
        majorCheck: { supported: true, programId: "cs_major_ba" },
    };

    it("yes → f1, asks graduation", () => {
        const result = handleVisaResponse("yes", state);
        expect(result.state.step).toBe("asking_graduation");
        expect(result.state.visaStatus).toBe("f1");
        expect(result.message).toContain("12+ credits");
    });

    it("no → domestic, asks graduation", () => {
        const result = handleVisaResponse("no", state);
        expect(result.state.step).toBe("asking_graduation");
        expect(result.state.visaStatus).toBe("domestic");
    });

    it("mentions F-1 → f1", () => {
        const result = handleVisaResponse("I'm on an F-1", state);
        expect(result.state.visaStatus).toBe("f1");
    });
});

// ============================================================
// Graduation Question
// ============================================================
describe("Onboarding Flow: handleGraduationResponse", () => {
    const state: OnboardingState = {
        step: "asking_graduation",
        parsedTranscript: csOnlyTranscript,
        majorCheck: { supported: true, programId: "cs_major_ba" },
        visaStatus: "f1",
    };

    it("yes → accepts estimate, completes onboarding", () => {
        const result = handleGraduationResponse("yes", state);
        expect(result.complete).toBe(true);
        expect(result.state.step).toBe("complete");
        expect(result.state.profile).toBeDefined();
        expect(result.message).toContain("All set");
    });

    it("Spring 2027 → parses custom graduation", () => {
        const result = handleGraduationResponse("Spring 2027", state);
        expect(result.complete).toBe(true);
        expect(result.state.targetGraduation).toBe("2027-spring");
    });

    it("Fall 2026 → parses custom graduation", () => {
        const result = handleGraduationResponse("fall 2026", state);
        expect(result.complete).toBe(true);
        expect(result.state.targetGraduation).toBe("2026-fall");
    });

    it("gibberish → asks again", () => {
        const result = handleGraduationResponse("asdf", state);
        expect(result.complete).toBe(false);
        expect(result.state.step).toBe("asking_graduation");
    });

    it("profile has correct visa status", () => {
        const result = handleGraduationResponse("yes", state);
        expect(result.state.profile?.visaStatus).toBe("f1");
    });
});

// ============================================================
// Main router
// ============================================================
describe("Onboarding Flow: handleOnboardingMessage", () => {
    it("routes confirming_data step correctly", () => {
        const state: OnboardingState = {
            step: "confirming_data",
            parsedTranscript: csOnlyTranscript,
            majorCheck: { supported: true, programId: "cs_major_ba" },
        };
        const result = handleOnboardingMessage("yes", state);
        expect(result.state.step).toBe("asking_visa");
    });

    it("routes asking_visa step correctly", () => {
        const state: OnboardingState = {
            step: "asking_visa",
            parsedTranscript: csOnlyTranscript,
            majorCheck: { supported: true, programId: "cs_major_ba" },
        };
        const result = handleOnboardingMessage("yes", state);
        expect(result.state.visaStatus).toBe("f1");
    });

    it("defaults to awaiting_transcript for unknown step", () => {
        const state: OnboardingState = { step: "awaiting_transcript" };
        const result = handleOnboardingMessage("hello", state);
        expect(result.state.step).toBe("awaiting_transcript");
    });
});
