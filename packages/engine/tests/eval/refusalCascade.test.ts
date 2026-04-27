// ============================================================
// Phase 7-A P-4 — §6.4 error recovery cascade tests
// ============================================================
// Pins the four-branch cascade at the tool layer:
//   - validation error → bare error message returned (Phase 5/6 path)
//   - tool_unsupported → structured "not in system" wrapper
//   - transient error → retry once; if still fails, graceful wrapper
//   - unknown error → graceful "unexpected issue" wrapper
// ============================================================

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    runAgentTurn,
    buildTool,
    ToolRegistry,
    RecordingLLMClient,
    type Tool,
    type ToolSession,
} from "../../src/agent/index.js";
import type { ZodTypeAny } from "zod";

const session: ToolSession = {
    student: {
        id: "u1",
        catalogYear: "2025-2026",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
        coursesTaken: [],
    },
};

function clientThatCallsThenStops(toolName: string, args: Record<string, unknown>): RecordingLLMClient {
    return new RecordingLLMClient({
        recordings: [
            // Turn 2 (assistant has emitted exactly one assistant
            // message — the tool-call turn — so index === 1).
            {
                match: { assistantTurnIndex: 1 },
                completion: { text: "ok, abandoning", toolCalls: [] },
            },
            // Turn 1.
            {
                match: { assistantTurnIndex: 0 },
                completion: {
                    text: "calling tool",
                    toolCalls: [{ id: "tc1", name: toolName, args }],
                },
            },
        ] as never,
    });
}

describe("§6.4 error recovery cascade (Phase 7-A P-4)", () => {
    it("retries a transient error ONCE and succeeds on attempt 2", async () => {
        let attempts = 0;
        const flaky = buildTool({
            name: "flaky_tool",
            description: "fails once then succeeds",
            inputSchema: z.object({}),
            prompt: () => "test",
            async call() {
                attempts += 1;
                if (attempts === 1) throw new Error("ETIMEDOUT temporary network blip");
                return { ok: true };
            },
            summarizeResult: () => "OK",
        });
        const registry = new ToolRegistry([flaky as Tool<ZodTypeAny, unknown>]);
        const client = clientThatCallsThenStops("flaky_tool", {});
        const result = await runAgentTurn(client, registry, session, "go", { systemPrompt: "test" });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        const inv = result.invocations[0]!;
        expect(inv.summary).toBe("OK");
        expect(attempts).toBe(2); // retried once
    });

    it("does NOT retry a non-transient error (fails fast)", async () => {
        let attempts = 0;
        const sync = buildTool({
            name: "sync_fail",
            description: "fails once with a logic error",
            inputSchema: z.object({}),
            prompt: () => "test",
            async call() {
                attempts += 1;
                throw new Error("Invalid input shape — schema mismatch");
            },
            summarizeResult: () => "n/a",
        });
        const registry = new ToolRegistry([sync as Tool<ZodTypeAny, unknown>]);
        const client = clientThatCallsThenStops("sync_fail", {});
        const result = await runAgentTurn(client, registry, session, "go", { systemPrompt: "test" });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        expect(attempts).toBe(1); // no retry
        const inv = result.invocations[0]!;
        expect(inv.error?.message).toMatch(/unexpected issue/i);
    });

    it("wraps tool_unsupported errors with structured 'no data for' guidance", async () => {
        const tool = buildTool({
            name: "unsupported_tool",
            description: "throws unsupported",
            inputSchema: z.object({}),
            prompt: () => "test",
            async call() {
                throw new Error("Program XYZ is unsupported by this engine");
            },
            summarizeResult: () => "n/a",
        });
        const registry = new ToolRegistry([tool as Tool<ZodTypeAny, unknown>]);
        const client = clientThatCallsThenStops("unsupported_tool", {});
        const result = await runAgentTurn(client, registry, session, "go", { systemPrompt: "test" });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        const inv = result.invocations[0]!;
        expect(inv.error?.message).toMatch(/tool_unsupported:/);
        expect(inv.error?.message).toMatch(/NYU contact/i);
    });

    it("retries a transient error TWICE and gives up gracefully on persistent failure", async () => {
        let attempts = 0;
        const persistent = buildTool({
            name: "persistent_fail",
            description: "fails persistently with a transient-looking error",
            inputSchema: z.object({}),
            prompt: () => "test",
            async call() {
                attempts += 1;
                throw new Error("Network timeout (still down)");
            },
            summarizeResult: () => "n/a",
        });
        const registry = new ToolRegistry([persistent as Tool<ZodTypeAny, unknown>]);
        const client = clientThatCallsThenStops("persistent_fail", {});
        const result = await runAgentTurn(client, registry, session, "go", { systemPrompt: "test" });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        // Retried once → 2 attempts total.
        expect(attempts).toBe(2);
        const inv = result.invocations[0]!;
        expect(inv.error?.message).toMatch(/unexpected issue|try again in a moment/i);
    });
});
