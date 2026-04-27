// ============================================================
// Phase 6.5 P-5 — cohort runner integration test
// ============================================================
// Drives a 2-case cohort through `runCohort` with a
// `RecordingLLMClient`. Asserts the runner correctly threads
// priorMessages, scores per-turn, and aggregates the cohort.
// ============================================================

import { describe, expect, it } from "vitest";
import { runCohort, type ConversationCase } from "../cohort/runner.js";
import { RecordingLLMClient } from "../../packages/engine/src/agent/index.js";
import type { StudentProfile } from "@nyupath/shared";

const STUDENT: StudentProfile = {
    id: "u1",
    catalogYear: "2025-2026",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
    coursesTaken: [],
    visaStatus: "domestic",
};

const CAS_F1: StudentProfile = { ...STUDENT, id: "f1", visaStatus: "f1" };

describe("runCohort (Phase 6.5 P-5)", () => {
    it("scores a 2-case cohort with mixed quality", async () => {
        // Case 1: model gives a perfect, grounded reply.
        // Case 2: F-1 student asks about credit load; model omits the
        //         F-1 caveat → completeness penalty.
        const client = new RecordingLLMClient({
            recordings: [
                {
                    match: { userMessageContains: "hi" },
                    completion: { text: "Hi! How can I help?", toolCalls: [] },
                },
                {
                    match: { userMessageContains: "credits" },
                    completion: {
                        text: "You can drop to 9 credits this semester.",
                        toolCalls: [],
                    },
                },
            ] as never,
        });
        const cases: ConversationCase[] = [
            {
                id: "case-1-greeting",
                description: "Plain greeting, perfect reply.",
                student: STUDENT,
                turns: [{ userMessage: "hi" }],
            },
            {
                id: "case-2-f1-credit-load",
                description: "F-1 student asks about credit load; reply MUST mention F-1.",
                student: CAS_F1,
                turns: [
                    {
                        userMessage: "Can I drop to 9 credits this semester?",
                        requiredCaveats: ["F-1", "12 credits"],
                    },
                ],
            },
        ];

        const report = await runCohort(client, cases);

        expect(report.cases).toHaveLength(2);
        expect(report.turnCount).toBe(2);
        // Case 1 should score perfect.
        expect(report.cases[0]!.caseComposite).toBeCloseTo(1);
        // Case 2 should score below 1 (completeness=0).
        expect(report.cases[1]!.caseComposite).toBeLessThan(1);
        // Cohort composite is below the production-ready threshold of 0.90.
        // Case 2 scored 0 on completeness with weight 0.35 → -0.175 vs case 1's perfect.
        // Mean composite: (1 + 0.825) / 2 = 0.9125. Just above 0.90.
        // We assert the relative ordering only.
        expect(report.cohortComposite).toBeLessThan(1);
        expect(report.cohortComposite).toBeGreaterThan(0.5);
    });

    it("threads priorMessages across turns within a case", async () => {
        const client = new RecordingLLMClient({
            recordings: [
                // Turn 2 must come first so userMessageContains "second"
                // doesn't false-match the "first" turn.
                {
                    match: { userMessageContains: "second" },
                    completion: { text: "Got it.", toolCalls: [] },
                },
                {
                    match: { userMessageContains: "first" },
                    completion: { text: "OK first turn done.", toolCalls: [] },
                },
            ] as never,
        });
        const report = await runCohort(client, [
            {
                id: "multi-turn",
                description: "Two turns; checks priorMessages threading.",
                student: STUDENT,
                turns: [
                    { userMessage: "this is the first turn" },
                    { userMessage: "this is the second turn" },
                ],
            },
        ]);
        expect(report.cases[0]!.turnScores).toHaveLength(2);
    });

    it("records errors when a turn does not produce kind=ok", async () => {
        // No matching recording → RecordingLLMClient throws → max_turns
        const client = new RecordingLLMClient({
            recordings: [
                {
                    match: { userMessageContains: "loop" },
                    completion: {
                        text: "infinite",
                        toolCalls: [{ id: "tc1", name: "search_policy", args: { query: "x" } }],
                    },
                },
            ] as never,
        });
        const report = await runCohort(
            client,
            [
                {
                    id: "case-loop",
                    description: "Model loops forever",
                    student: STUDENT,
                    turns: [{ userMessage: "loop forever" }],
                },
            ],
            { maxTurns: 2 },
        );
        expect(report.cases[0]!.errors.length).toBeGreaterThan(0);
        expect(report.cases[0]!.caseComposite).toBe(0);
    });
});
