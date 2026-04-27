// ============================================================
// Phase 7-A P-10 — persona-surrogate runner tests
// ============================================================
// Drives a 1-case cohort through `runPersonaSurrogate` with two
// `RecordingLLMClient`s — one for the agent, one for the persona.
// Asserts the runner threads transcript correctly, terminates on
// "<<DONE>>", honors maxFollowUps, and produces a composite report.
// ============================================================

import { describe, expect, it } from "vitest";
import { runPersonaSurrogate } from "../cohort/personaSurrogate.js";
import { RecordingLLMClient } from "../../packages/engine/src/agent/index.js";
import type { ConversationCase } from "../cohort/runner.js";
import type { StudentProfile } from "@nyupath/shared";

const STUDENT: StudentProfile = {
    id: "u1",
    catalogYear: "2025-2026",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
    coursesTaken: [],
    visaStatus: "domestic",
};

const CASE: ConversationCase = {
    id: "test-case-001",
    description: "Test scenario for the persona surrogate.",
    student: STUDENT,
    turns: [{ userMessage: "What's my GPA?" }],
};

describe("runPersonaSurrogate (Phase 7-A P-10)", () => {
    it("runs a single case end-to-end and emits a composite report", async () => {
        const agentClient = new RecordingLLMClient({
            recordings: [
                { match: {}, completion: { text: "Stub agent reply.", toolCalls: [] } },
            ] as never,
        });
        const personaClient = new RecordingLLMClient({
            recordings: [
                // Persona terminates immediately on first follow-up.
                { match: {}, completion: { text: "<<DONE>>", toolCalls: [] } },
            ] as never,
        });

        const report = await runPersonaSurrogate([CASE], {
            agentClient,
            personaClient,
            maxFollowUps: 2,
        });

        expect(report.cases).toHaveLength(1);
        expect(report.cases[0]!.transcript.length).toBeGreaterThanOrEqual(2); // user + assistant
        expect(report.cohortComposite).toBeGreaterThanOrEqual(0);
        expect(report.cohortComposite).toBeLessThanOrEqual(1);
    });

    it("terminates the case when the persona emits <<DONE>>", async () => {
        const agentClient = new RecordingLLMClient({
            recordings: [
                { match: {}, completion: { text: "I see.", toolCalls: [] } },
            ] as never,
        });
        const personaClient = new RecordingLLMClient({
            recordings: [
                { match: {}, completion: { text: "<<DONE>>", toolCalls: [] } },
            ] as never,
        });
        const report = await runPersonaSurrogate([CASE], {
            agentClient, personaClient, maxFollowUps: 5,
        });
        // Only the seed turn should run; <<DONE>> aborts.
        expect(report.cases[0]!.transcript).toHaveLength(2);
    });

    it("honors maxFollowUps when the persona keeps talking", async () => {
        const agentClient = new RecordingLLMClient({
            recordings: [
                { match: {}, completion: { text: "Reply.", toolCalls: [] } },
            ] as never,
        });
        const personaClient = new RecordingLLMClient({
            // Persona never emits DONE.
            recordings: [
                { match: {}, completion: { text: "Tell me more.", toolCalls: [] } },
            ] as never,
        });
        const report = await runPersonaSurrogate([CASE], {
            agentClient, personaClient, maxFollowUps: 2,
        });
        // Seed turn + 2 follow-up turns = 3 turn pairs = 6 transcript entries
        expect(report.cases[0]!.transcript.length).toBe(6);
    });

    it("captures errors when the agent loop ends in non-ok state", async () => {
        // Agent records ONLY a tool-call recording, so the loop
        // hits max_turns trying to satisfy a tool that doesn't
        // resolve in the recording set.
        const agentClient = new RecordingLLMClient({
            recordings: [
                {
                    match: {},
                    completion: {
                        text: "calling forever",
                        toolCalls: [{ id: "tc1", name: "search_policy", args: { query: "x" } }],
                    },
                },
            ] as never,
        });
        const personaClient = new RecordingLLMClient({
            recordings: [
                { match: {}, completion: { text: "<<DONE>>", toolCalls: [] } },
            ] as never,
        });
        const report = await runPersonaSurrogate([CASE], {
            agentClient, personaClient, maxFollowUps: 1,
        });
        expect(report.cases[0]!.errors.length).toBeGreaterThan(0);
        expect(report.cases[0]!.composite).toBe(0);
    });
});
