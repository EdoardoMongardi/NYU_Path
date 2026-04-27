// ============================================================
// Phase 5 — Agent Orchestrator + Validators
// ============================================================
// Covers:
//   - Tool registry shape + duplicate-name detection
//   - Tool factory (buildTool) caps maxResultChars
//   - Each of the 6 NYU Path tools wraps its engine function correctly
//   - Agent loop:
//       - returns "ok" with finalText when model emits text without tool calls
//       - executes tool calls in order, threads results back into the convo
//       - returns "max_turns" when the model keeps tool-calling forever
//       - returns "aborted" when the AbortSignal fires
//       - falls back to a secondary client when the primary throws
//       - rejects malformed tool-call args via Zod validation
//   - System prompt: 25 rules present + per-session context block
//   - Template matcher pre-loop dispatch:
//       - returns "template" when a curated answer fires
//       - returns "fallthrough" when no template fires
//       - returns "fallthrough" when the session has no student
//   - Response validator (3 launch-blocking checks):
//       - grounding: ungrounded GPA blocked; grounded GPA passes
//       - invocation auditor: GPA claim with no run_full_audit blocked
//       - completeness: F-1 student + credit-load discussion needs F-1 mention
// ============================================================

import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import { z } from "zod";
import {
    buildTool,
    buildDefaultRegistry,
    buildSystemPrompt,
    ToolRegistry,
    runAgentTurn,
    preLoopDispatch,
    validateResponse,
    extractClaimNumbers,
    RecordingLLMClient,
    updateProfileTool,
    confirmProfileUpdateTool,
    searchPolicyTool,
    type LLMClient,
    type LLMCompletion,
    type ToolSession,
    type Tool,
} from "../../src/agent/index.js";
import { loadPolicyTemplates } from "../../src/rag/index.js";

// ============================================================
// Tool factory + registry
// ============================================================
describe("buildTool + ToolRegistry", () => {
    it("buildTool caps summarizeResult at maxResultChars", () => {
        const t = buildTool({
            name: "tiny",
            description: "test",
            inputSchema: z.object({}),
            maxResultChars: 10,
            prompt: () => "p",
            async call() { return "irrelevant"; },
            summarizeResult: () => "this string is more than ten characters long",
        });
        const out = t.summarizeResult("anything");
        expect(out.length).toBeLessThanOrEqual(11); // 10 + ellipsis
        expect(out.endsWith("…")).toBe(true);
    });

    it("ToolRegistry rejects duplicate tool names", () => {
        const a = buildTool({
            name: "x", description: "", inputSchema: z.object({}),
            prompt: () => "", async call() { return null; }, summarizeResult: () => "",
        });
        const b = { ...a };
        expect(() => new ToolRegistry([a as Tool<ZodTypeAny, unknown>, b as Tool<ZodTypeAny, unknown>])).toThrow(/duplicate/);
    });

    it("buildDefaultRegistry exposes the 9 NYU Path tools (Phase 5's 7 + Phase 6 WS7b's 2)", () => {
        const reg = buildDefaultRegistry();
        const names = reg.list().map((t) => t.name).sort();
        expect(names).toEqual([
            "check_transfer_eligibility",
            "confirm_profile_update",
            "get_credit_caps",
            "plan_semester",
            "run_full_audit",
            "search_availability",
            "search_policy",
            "update_profile",
            "what_if_audit",
        ]);
    });

    it("confirm_profile_update is the only NON-read-only tool (update_profile only stages)", () => {
        const reg = buildDefaultRegistry();
        const writes = reg.list().filter((t) => !t.isReadOnly).map((t) => t.name);
        expect(writes).toEqual(["confirm_profile_update"]);
    });
});

// ============================================================
// System prompt
// ============================================================
describe("buildSystemPrompt", () => {
    const prompt = buildSystemPrompt({});
    it("contains all 25 numbered rules", () => {
        for (let i = 1; i <= 25; i++) {
            expect(prompt).toMatch(new RegExp(`^${i}\\. `, "m"));
        }
    });
    it("declares Appendix A's CORE RULES section verbatim", () => {
        // Per reviewer P0a: the system prompt is now Appendix A verbatim,
        // not the old "Cardinal Rules / synthesize a numerical claim"
        // paraphrase. The §2.1 Cardinal-Rule equivalent is rule #1
        // ("NEVER compute numbers yourself…").
        expect(prompt).toContain("CORE RULES");
        expect(prompt).toContain("NEVER compute numbers yourself");
        expect(prompt).toContain("FALLBACK RULES");
        expect(prompt).toContain("PRECISION RULES");
        expect(prompt).toContain("PLANNING-SPECIFIC RULES");
    });
    it("renders per-session context when student is supplied", () => {
        const out = buildSystemPrompt({
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
                coursesTaken: [],
                visaStatus: "f1",
            },
        });
        expect(out).toContain("homeSchool: cas");
        expect(out).toContain("major cs_major_ba");
        expect(out).toContain("visaStatus: f1");
    });
});

// ============================================================
// Template matcher pre-loop dispatch
// ============================================================
describe("preLoopDispatch", () => {
    const { templates } = loadPolicyTemplates();
    const session: ToolSession = {
        student: {
            id: "u1", catalogYear: "2025-2026", homeSchool: "cas",
            declaredPrograms: [], coursesTaken: [],
        },
    };

    it("returns 'template' when a CAS student asks 'pass fail major'", () => {
        const r = preLoopDispatch("Can I pass fail major courses?", session, {
            templates,
            now: new Date("2026-04-26T00:00:00Z"),
        });
        expect(r.kind).toBe("template");
        if (r.kind !== "template") return;
        expect(r.match.template.id).toBe("cas_pf_major");
        expect(r.finalText).toContain("Pass/Fail");
    });

    it("returns 'fallthrough' when no template matches", () => {
        const r = preLoopDispatch("What's the cafeteria menu today?", session, {
            templates,
            now: new Date("2026-04-26T00:00:00Z"),
        });
        expect(r.kind).toBe("fallthrough");
    });

    it("returns 'fallthrough' when no student is loaded", () => {
        const r = preLoopDispatch("anything", {}, { templates });
        expect(r.kind).toBe("fallthrough");
    });
});

// ============================================================
// Response validator
// ============================================================
describe("responseValidator", () => {
    it("extractClaimNumbers picks up GPAs + credit-counts; ignores 'step 1'-style", () => {
        const claims = extractClaimNumbers("Your GPA is 3.42 and you have 64 credits. Step 1 is to plan.");
        expect(claims.has("3.42")).toBe(true);
        expect(claims.has("64")).toBe(true);
        // "1" near "step" with no unit keyword nearby — excluded
        expect(claims.has("1")).toBe(false);
    });

    it("BLOCKS ungrounded GPA claim", () => {
        const verdict = validateResponse({
            assistantText: "Your cumulative GPA is 3.42.",
            invocations: [
                { toolName: "run_full_audit", args: {}, summary: "PROGRAM: CS BA — credits: 64/128" },
            ],
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some((v) => v.kind === "ungrounded_number" && v.number === "3.42")).toBe(true);
    });

    it("ALLOWS GPA claim that appears verbatim in tool summary", () => {
        const verdict = validateResponse({
            assistantText: "Your cumulative GPA is 3.42.",
            invocations: [
                { toolName: "run_full_audit", args: {}, summary: "STANDING: good_standing (cumulative GPA 3.42)" },
            ],
        });
        expect(verdict.ok).toBe(true);
    });

    it("BLOCKS GPA claim with no run_full_audit invocation (invocation auditor)", () => {
        const verdict = validateResponse({
            assistantText: "Your GPA is 3.42.",
            invocations: [
                // 3.42 is grounded in some other tool's args, but the audit-trigger phrase requires run_full_audit
                { toolName: "search_policy", args: { query: "3.42 average" }, summary: "no relevant" },
            ],
        });
        expect(verdict.ok).toBe(false);
        const kinds = verdict.violations.map((v) => v.kind);
        expect(kinds).toContain("missing_invocation");
    });

    it("BLOCKS reply that discusses F-1 credit load without F-1 caveat (completeness)", () => {
        const verdict = validateResponse({
            assistantText: "You can drop to 9 credits this semester to lighten your credit load.",
            invocations: [
                { toolName: "run_full_audit", args: {}, summary: "credit load 9" },
            ],
            student: {
                id: "f1user",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
                visaStatus: "f1",
            },
        });
        const missing = verdict.violations.filter((v) => v.kind === "missing_caveat" && v.caveatId === "f1_visa");
        expect(missing.length).toBeGreaterThan(0);
    });

    it("ALLOWS reply that discusses F-1 credit load WITH F-1 caveat", () => {
        const verdict = validateResponse({
            assistantText:
                "You can drop to 9 credits this semester to lighten your credit load. " +
                "Important: F-1 students must maintain full-time status of at least 12 credits per semester.",
            invocations: [
                { toolName: "run_full_audit", args: {}, summary: "credit load 9 12" },
            ],
            student: {
                id: "f1user",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
                visaStatus: "f1",
            },
        });
        // No "missing F-1 caveat" violation
        expect(verdict.violations.some((v) => v.caveatId === "f1_visa")).toBe(false);
    });

    it("flags missing 'GPA not published' caveat in internal-transfer reply", () => {
        const verdict = validateResponse({
            assistantText: "For internal transfer to Stern you need calculus and writing.",
            invocations: [
                { toolName: "check_transfer_eligibility", args: { targetSchool: "stern" }, summary: "Stern eligible" },
            ],
        });
        const missing = verdict.violations.filter((v) => v.caveatId === "internal_transfer_gpa_note");
        expect(missing.length).toBeGreaterThan(0);
    });

    it("ALLOWS internal-transfer reply with the canonical 'not published' caveat", () => {
        const verdict = validateResponse({
            assistantText:
                "For internal transfer to Stern, GPA thresholds are not published. " +
                "Required: calculus and writing.",
            invocations: [
                { toolName: "check_transfer_eligibility", args: { targetSchool: "stern" }, summary: "Stern eligible" },
            ],
        });
        expect(verdict.violations.some((v) => v.caveatId === "internal_transfer_gpa_note")).toBe(false);
    });

    it("ALLOWS internal-transfer reply with the 'aren't published' / 'isn't published' variants (P2)", () => {
        const v1 = validateResponse({
            assistantText: "Internal transfer GPA thresholds aren't published. Stern requires calc.",
            invocations: [
                { toolName: "check_transfer_eligibility", args: { targetSchool: "stern" }, summary: "Stern" },
            ],
        });
        const v2 = validateResponse({
            assistantText: "The GPA cutoff for transfer to Stern isn't published. Required: calc.",
            invocations: [
                { toolName: "check_transfer_eligibility", args: { targetSchool: "stern" }, summary: "Stern" },
            ],
        });
        expect(v1.violations.some((v) => v.caveatId === "internal_transfer_gpa_note")).toBe(false);
        expect(v2.violations.some((v) => v.caveatId === "internal_transfer_gpa_note")).toBe(false);
    });

    it("BLOCKS unsourced policy claim with no search_policy invocation (P0c policy-claim rule)", () => {
        const verdict = validateResponse({
            assistantText: "The policy says you can take up to 18 credits per semester.",
            invocations: [
                { toolName: "run_full_audit", args: {}, summary: "credits 18 used" },
            ],
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some((v) => v.kind === "missing_invocation")).toBe(true);
    });

    it("ALLOWS sourced policy claim when search_policy was invoked (P0c)", () => {
        const verdict = validateResponse({
            assistantText:
                "The policy says you can take up to 18 credits per semester. " +
                "Source: NYU CAS bulletin.",
            invocations: [
                {
                    toolName: "search_policy",
                    args: { query: "credit overload limit" },
                    summary: "RAG hits (confidence=high; scope=cas,all; override=false)\n  [cas/credit_load] 18 credits maximum…",
                },
            ],
        });
        expect(verdict.violations.some((v) => v.kind === "missing_invocation")).toBe(false);
    });

    it("FIRES low-confidence consult-adviser caveat on confidence=low summary", () => {
        const verdict = validateResponse({
            assistantText: "I think you can do that.", // no adviser/consult mention
            invocations: [
                {
                    toolName: "search_policy",
                    args: { query: "obscure rule" },
                    summary: "POLICY UNCERTAINTY: confidence=low. Few hits. Recommend escalation.",
                },
            ],
        });
        expect(verdict.violations.some((v) => v.caveatId === "low_confidence_consult_adviser")).toBe(true);
    });

    it("does NOT FIRE low-confidence caveat on incidental 'low'/'medium' substrings (P1 false-positive fix)", () => {
        // The summary contains the literal word "low" but only as part of
        // "follow"/"below" — the strict `confidence=…` regex must not fire.
        const verdict = validateResponse({
            assistantText: "Sure, you may follow up next semester.",
            invocations: [
                {
                    toolName: "search_policy",
                    args: { query: "advising followup" },
                    summary: "RAG hits (confidence=high; scope=cas,all; override=false)\n  [cas/policy] Please follow the steps below…",
                },
            ],
        });
        expect(verdict.violations.some((v) => v.caveatId === "low_confidence_consult_adviser")).toBe(false);
    });

    it("ALLOWS low-confidence reply when adviser/consult is mentioned", () => {
        const verdict = validateResponse({
            assistantText:
                "I'm not fully sure — please consult your academic adviser to confirm.",
            invocations: [
                {
                    toolName: "search_policy",
                    args: { query: "edge case" },
                    summary: "POLICY UNCERTAINTY: confidence=low. Recommend escalation.",
                },
            ],
        });
        expect(verdict.violations.some((v) => v.caveatId === "low_confidence_consult_adviser")).toBe(false);
    });

    it("flags BOTH F-1 and internal-transfer caveats when both apply", () => {
        const verdict = validateResponse({
            assistantText:
                "If you transfer to Stern with a 9-credit semester, you'll be on a part-time credit load.",
            invocations: [
                { toolName: "check_transfer_eligibility", args: { targetSchool: "stern" }, summary: "Stern eligible" },
                { toolName: "run_full_audit", args: {}, summary: "credits 9" },
            ],
            student: {
                id: "f1user",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
                visaStatus: "f1",
            },
        });
        const ids = verdict.violations.filter((v) => v.kind === "missing_caveat").map((v) => v.caveatId);
        expect(ids).toContain("f1_visa");
        expect(ids).toContain("internal_transfer_gpa_note");
    });
});

// ============================================================
// Agent loop — using RecordingLLMClient (deterministic)
// ============================================================
describe("runAgentTurn — recorded conversation", () => {
    const session: ToolSession = {
        student: {
            id: "u1",
            catalogYear: "2025-2026",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
            coursesTaken: [],
        },
    };

    function makeClient(recordings: Array<{ match: Record<string, unknown>; completion: Record<string, unknown> }>): RecordingLLMClient {
        return new RecordingLLMClient({ recordings: recordings as never });
    }

    it("returns 'ok' when the model emits text with no tool calls", async () => {
        const client = makeClient([
            {
                match: { userMessageContains: "hello" },
                completion: { text: "Hi! What can I help with?", toolCalls: [] },
            },
        ]);
        const result = await runAgentTurn(client, buildDefaultRegistry(), session, "hello", {
            systemPrompt: "test",
        });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        expect(result.finalText).toContain("Hi!");
    });

    it("returns 'aborted' when the signal fires before the loop starts", async () => {
        const client = makeClient([{ match: {}, completion: { text: "x", toolCalls: [] } }]);
        const ac = new AbortController();
        ac.abort();
        const result = await runAgentTurn(client, buildDefaultRegistry(), session, "anything", {
            systemPrompt: "test",
            signal: ac.signal,
        });
        expect(result.kind).toBe("aborted");
    });

    it("returns 'max_turns' when the model loops on tool calls forever", async () => {
        // Recording always issues a tool call → loop never terminates → max_turns
        const client = makeClient([
            {
                match: {},
                completion: {
                    text: "calling search_policy",
                    toolCalls: [
                        { id: "tc1", name: "search_policy", args: { query: "nothing useful" } },
                    ],
                },
            },
        ]);
        const result = await runAgentTurn(client, buildDefaultRegistry(), session, "loop forever", {
            systemPrompt: "test",
            maxTurns: 3,
        });
        expect(result.kind).toBe("max_turns");
    });

    it("falls back to the secondary client when the primary throws", async () => {
        const broken: LLMClient = {
            id: "broken",
            async complete(): Promise<LLMCompletion> {
                throw new Error("primary down");
            },
        };
        const fallback = makeClient([
            {
                match: { userMessageContains: "hello" },
                completion: { text: "from fallback", toolCalls: [] },
            },
        ]);
        const result = await runAgentTurn(broken, buildDefaultRegistry(), session, "hello", {
            systemPrompt: "test",
            fallbackClient: fallback,
        });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        expect(result.modelUsedId).toBe(fallback.id);
        expect(result.finalText).toBe("from fallback");
    });

    it("rejects a tool call whose Zod input validation fails", async () => {
        // Order matters: RecordingLLMClient takes the FIRST matching
        // record. Put the more-specific (turn-2) match first so it
        // doesn't get pre-empted by the broader user-message match.
        const client = makeClient([
            {
                match: { latestToolResultContains: "validation failed" },
                completion: { text: "saw validation error; giving up", toolCalls: [] },
            },
            {
                match: { userMessageContains: "bad-args" },
                completion: {
                    text: "calling search_policy with bad args",
                    toolCalls: [
                        { id: "tc1", name: "search_policy", args: { query: "" } }, // .min(2) fails
                    ],
                },
            },
        ]);
        const result = await runAgentTurn(client, buildDefaultRegistry(), session, "bad-args", {
            systemPrompt: "test",
        });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        const errInv = result.invocations.find((i) => i.error);
        expect(errInv?.error?.message).toMatch(/validation failed/i);
    });

    it("records an error invocation when the model calls a tool not in the registry", async () => {
        // Order matters: more-specific recording first (turn 2 sees the
        // "not found in registry" error string in the tool result).
        const client = makeClient([
            {
                match: { latestToolResultContains: "not found in registry" },
                completion: { text: "Got it; the requested tool isn't available.", toolCalls: [] },
            },
            {
                match: { userMessageContains: "unknown-tool" },
                completion: {
                    text: "calling a nonexistent tool",
                    toolCalls: [
                        { id: "tc1", name: "totally_nonexistent_tool", args: {} },
                    ],
                },
            },
        ]);
        const result = await runAgentTurn(client, buildDefaultRegistry(), session, "unknown-tool", {
            systemPrompt: "test",
        });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        const errInv = result.invocations.find((i) => i.toolName === "totally_nonexistent_tool");
        expect(errInv).toBeDefined();
        expect(errInv?.error?.message).toMatch(/not found in registry/i);
    });

    it("wraps validateInput rejections with 'validation failed:' prefix in error.message (Phase 6 WS6)", async () => {
        // search_policy.validateInput rejects when session has no rag.
        // The agent-loop wrapper should fail this with `error.message`
        // starting "validation failed:" so observability + downstream
        // matchers can recognize the rejection class.
        const sessionNoRag: ToolSession = {
            student: session.student,
        };
        const client = makeClient([
            // Turn 2 — model recovers after seeing the wrapped error.
            {
                match: { latestToolResultContains: "validation failed" },
                completion: { text: "ok, I'll ask differently", toolCalls: [] },
            },
            // Turn 1 — issues a search_policy with valid args (so Zod
            // passes); validateInput then rejects on missing rag.
            {
                match: { userMessageContains: "policy" },
                completion: {
                    text: "",
                    toolCalls: [
                        { id: "tc1", name: "search_policy", args: { query: "any policy question" } },
                    ],
                },
            },
        ]);
        const result = await runAgentTurn(client, buildDefaultRegistry(), sessionNoRag, "policy question", {
            systemPrompt: "test",
        });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;
        const errInv = result.invocations.find((i) => i.toolName === "search_policy");
        expect(errInv?.error?.message).toMatch(/^validation failed:/i);
        // The structured `rejected.userMessage` keeps the clean original.
        expect(errInv?.rejected?.userMessage).not.toMatch(/^validation failed:/i);
    });

    it("returns 'model_error_no_fallback' when BOTH primary and fallback throw", async () => {
        const primary: LLMClient = {
            id: "primary",
            async complete(): Promise<LLMCompletion> {
                throw new Error("primary down");
            },
        };
        const fallback: LLMClient = {
            id: "fallback",
            async complete(): Promise<LLMCompletion> {
                throw new Error("fallback also down");
            },
        };
        const result = await runAgentTurn(primary, buildDefaultRegistry(), session, "anything", {
            systemPrompt: "test",
            fallbackClient: fallback,
        });
        expect(result.kind).toBe("model_error_no_fallback");
    });
});

// ============================================================
// Two-step profile update (§7.2) + searchPolicy.transferIntent
// ============================================================
describe("update_profile + confirm_profile_update (two-step §7.2)", () => {
    function freshSession(): ToolSession {
        return {
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
                coursesTaken: [],
                visaStatus: "domestic",
            },
        };
    }
    const ctx = (session: ToolSession) => ({ signal: new AbortController().signal, session });

    it("update_profile STAGES the change (does not mutate) and returns pending_confirmation", async () => {
        const session = freshSession();
        const out = await updateProfileTool.call(
            { field: "homeSchool", value: "stern" },
            ctx(session),
        ) as { status: string; pendingMutationId: string; mutation: { field: string; before: unknown; after: unknown } };
        expect(out.status).toBe("pending_confirmation");
        expect(out.pendingMutationId).toMatch(/^pm_/);
        // Profile must NOT have been mutated yet.
        expect(session.student!.homeSchool).toBe("cas");
        // Pending map must contain the staged mutation.
        expect(session.pendingMutations?.has(out.pendingMutationId)).toBe(true);
    });

    it("confirm_profile_update applies the staged mutation and consumes the pending id", async () => {
        const session = freshSession();
        const staged = await updateProfileTool.call(
            { field: "homeSchool", value: "stern" },
            ctx(session),
        ) as { pendingMutationId: string };
        const out = await confirmProfileUpdateTool.call(
            { pendingMutationId: staged.pendingMutationId },
            ctx(session),
        ) as { status: string; mutation: { field: string; after: unknown } };
        expect(out.status).toBe("applied");
        expect(session.student!.homeSchool).toBe("stern");
        expect(session.pendingMutations?.has(staged.pendingMutationId)).toBe(false);
    });

    it("confirm_profile_update rejects an unknown pendingMutationId via validateInput", async () => {
        const session = freshSession();
        const result = await confirmProfileUpdateTool.validateInput!(
            { pendingMutationId: "pm_nonexistent_999" },
            ctx(session),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.userMessage).toMatch(/no pending mutation/i);
    });

    it("update_profile prompt + summarizeResult instruct the agent to require user confirmation", async () => {
        // Ensures the §7.2 two-step contract is surfaced in the model-facing strings.
        const session = freshSession();
        const out = await updateProfileTool.call(
            { field: "visaStatus", value: "f1" },
            ctx(session),
        );
        const summary = updateProfileTool.summarizeResult(out);
        expect(summary).toMatch(/pending_confirmation/i);
        expect(summary).toMatch(/confirm_profile_update/i);
    });
});

describe("search_policy — transferIntent threading (§7.2)", () => {
    it("propagates session.transferIntent into the result + summary note", async () => {
        // Build a minimal RAG stub that returns no hits — we only care
        // about the transferIntent flag being threaded.
        const session: ToolSession = {
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
            },
            transferIntent: true,
            rag: {
                store: { search: async () => [] } as never,
                embedder: { embed: async () => [0] } as never,
                reranker: { rerank: async () => [] } as never,
                templates: [],
            },
        };
        const out = await searchPolicyTool.call(
            { query: "internal transfer to stern" },
            { signal: new AbortController().signal, session },
        ) as { transferIntent?: boolean; kind: string };
        expect(out.transferIntent).toBe(true);
        const summary = searchPolicyTool.summarizeResult(out);
        expect(summary).toMatch(/transferIntent=on/);
    });

    it("does NOT add the transferIntent note when session.transferIntent is unset", async () => {
        const session: ToolSession = {
            student: {
                id: "u1",
                catalogYear: "2025-2026",
                homeSchool: "cas",
                declaredPrograms: [],
                coursesTaken: [],
            },
            rag: {
                store: { search: async () => [] } as never,
                embedder: { embed: async () => [0] } as never,
                reranker: { rerank: async () => [] } as never,
                templates: [],
            },
        };
        const out = await searchPolicyTool.call(
            { query: "p/f rules" },
            { signal: new AbortController().signal, session },
        ) as { transferIntent?: boolean };
        expect(out.transferIntent).toBe(false);
        const summary = searchPolicyTool.summarizeResult(out);
        expect(summary).not.toMatch(/transferIntent=on/);
    });
});
