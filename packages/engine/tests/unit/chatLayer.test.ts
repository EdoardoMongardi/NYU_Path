// ============================================================
// Unit Tests — Chat Layer (Intent Router + Orchestrator)
// ============================================================
import { describe, it, expect } from "vitest";
import { quickClassify } from "../../src/chat/intentRouter.js";
import { formatSearchResults, generateGreeting } from "../../src/chat/explanationGenerator.js";
import { createMockClient } from "../../src/chat/llmClient.js";
import { handleMessage, type ChatContext } from "../../src/chat/chatOrchestrator.js";

// ============================================================
// Quick Classify (rule-based, no LLM)
// ============================================================
describe("Intent Router: quickClassify", () => {
    it("greetings → general", () => {
        expect(quickClassify("hello")?.intent).toBe("general");
        expect(quickClassify("Hi!")?.intent).toBe("general");
        expect(quickClassify("Hey there")?.intent).toBe("general");
    });

    it("audit keywords → audit_status", () => {
        expect(quickClassify("How many credits do I need?")?.intent).toBe("audit_status");
        expect(quickClassify("Am I on track to graduate?")?.intent).toBe("audit_status");
        expect(quickClassify("What requirements are left?")?.intent).toBe("audit_status");
        expect(quickClassify("Check my degree progress")?.intent).toBe("audit_status");
    });

    it("elective search → elective_search with query", () => {
        const result = quickClassify("I want courses about machine learning");
        expect(result?.intent).toBe("elective_search");
        expect(result?.searchQuery).toContain("machine learning");
    });

    it("something creative → elective_search", () => {
        const result = quickClassify("something creative and fun");
        expect(result?.intent).toBe("elective_search");
    });

    it("plan questions → plan_explain", () => {
        expect(quickClassify("What should I take next semester?")?.intent).toBe("plan_explain");
        expect(quickClassify("Explain my course plan")?.intent).toBe("plan_explain");
    });

    it("ambiguous messages → null (needs LLM)", () => {
        expect(quickClassify("I'm confused about my schedule")).toBeNull();
        expect(quickClassify("Tell me about CSCI-UA 472")).toBeNull();
    });
});

// ============================================================
// Search Result Formatting
// ============================================================
describe("Explanation Generator: formatSearchResults", () => {
    it("formats results with scores and availability", () => {
        const results = [
            { courseId: "CSCI-UA 472", title: "Artificial Intelligence", score: 0.92, availability: "🟢 Confirmed" },
            { courseId: "CS-UY 4613", title: "AI", score: 0.88 },
        ];
        const msg = formatSearchResults(results, "AI");
        expect(msg).toContain("CSCI-UA 472");
        expect(msg).toContain("92%");
        expect(msg).toContain("🟢 Confirmed");
    });

    it("empty results → helpful message", () => {
        const msg = formatSearchResults([], "quantum teleportation");
        expect(msg).toContain("couldn't find");
        expect(msg).toContain("quantum teleportation");
    });

    it("more than 5 results → truncated with message", () => {
        const results = Array.from({ length: 8 }, (_, i) => ({
            courseId: `CS-${i}`,
            title: `Course ${i}`,
            score: 0.9 - i * 0.05,
        }));
        const msg = formatSearchResults(results, "test");
        expect(msg).toContain("3 more");
    });
});

// ============================================================
// Greeting
// ============================================================
describe("Explanation Generator: generateGreeting", () => {
    it("includes capabilities", () => {
        const msg = generateGreeting();
        expect(msg).toContain("Find electives");
        expect(msg).toContain("Check progress");
    });

    it("personalizes with name", () => {
        const msg = generateGreeting("Edoardo");
        expect(msg).toContain("Edoardo");
    });
});

// ============================================================
// Chat Orchestrator (with mock LLM)
// ============================================================
describe("Chat Orchestrator: handleMessage", () => {
    const mockLLM = createMockClient(() =>
        JSON.stringify({ intent: "general", confidence: 0.8 })
    );

    it("greetings → greeting response (no LLM call)", async () => {
        const ctx: ChatContext = { studentName: "Alex" };
        const response = await handleMessage("hello", ctx, mockLLM);
        expect(response.intent.intent).toBe("general");
        expect(response.message).toContain("Alex");
        expect(response.message).toContain("Find electives");
    });

    it("audit question → calls runAudit", async () => {
        let auditCalled = false;
        // Mock must return valid JSON for chatJSON (intent classification)
        // and plain text for chat (explanation)
        const auditLLM = createMockClient((messages) => {
            const lastUser = messages.filter(m => m.role === "user").pop();
            // If it's audit data (JSON), return explanation text
            if (lastUser?.content.startsWith("{")) {
                return "You're doing great! 80 of 128 credits done.";
            }
            // Otherwise it's intent classification
            return JSON.stringify({ intent: "audit_status", confidence: 0.9 });
        });
        const ctx: ChatContext = {
            runAudit: async () => {
                auditCalled = true;
                return {
                    programName: "CS BA",
                    totalCreditsCompleted: 80,
                    totalCreditsRequired: 128,
                    rulesCompleted: 8,
                    rulesTotal: 12,
                    unmetRules: ["Elective A", "Elective B"],
                };
            },
        };
        const response = await handleMessage("How many credits do I need?", ctx, auditLLM);
        expect(auditCalled).toBe(true);
        expect(response.intent.intent).toBe("audit_status");
    });

    it("elective search → calls searchCourses", async () => {
        let searchQuery = "";
        const ctx: ChatContext = {
            searchCourses: async (query) => {
                searchQuery = query;
                return {
                    query,
                    results: [
                        { courseId: "CSCI-UA 473", title: "ML", score: 0.9 },
                    ],
                };
            },
        };
        const response = await handleMessage(
            "I want courses about machine learning",
            ctx,
            mockLLM
        );
        expect(response.intent.intent).toBe("elective_search");
        expect(searchQuery).toContain("machine learning");
        expect(response.message).toContain("CSCI-UA 473");
    });

    it("plan question → calls runPlan", async () => {
        let planCalled = false;
        const planLLM = createMockClient(() => "Take Calc II and Linear Algebra next semester.");
        const ctx: ChatContext = {
            runPlan: async () => {
                planCalled = true;
                return {
                    semester: "2026-fall",
                    courses: [{ id: "MATH-UA 122", title: "Calc II", credits: 4, category: "required" }],
                    totalCredits: 16,
                    freeSlots: 1,
                    enrollmentWarnings: [],
                };
            },
        };
        const response = await handleMessage("What should I take next semester?", ctx, planLLM);
        expect(planCalled).toBe(true);
        expect(response.intent.intent).toBe("plan_explain");
    });

    it("no context → graceful fallback", async () => {
        const ctx: ChatContext = {}; // no functions injected
        const response = await handleMessage("How many credits do I need?", ctx, mockLLM);
        // quickClassify catches this as audit_status, but no runAudit → fallback message
        expect(response.intent.intent).toBe("audit_status");
        const msg = response.message.toLowerCase();
        expect(msg.includes("don't have") || msg.includes("profile")).toBe(true);
    });
});
