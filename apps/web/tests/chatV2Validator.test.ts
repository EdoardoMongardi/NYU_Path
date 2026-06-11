// ============================================================
// D5.2 — wire the hydrated forwardSchedule into validateResponse at
// BOTH call sites of the v2 chat route
// ============================================================
// D5.1 added `checkPlanClaims(ctx)` to responseValidator.ts: a pure
// check that blocks ungrounded plan claims, but ONLY when
// `ctx.forwardSchedule` is populated (it no-ops otherwise). The v2 route
// hydrates `session.forwardSchedule` each turn (P3.1), but calls
// `validateResponse` at TWO sites and — pre-D5.2 — neither passed
// `forwardSchedule`. So the launch-blocking plan-claim check was a silent
// no-op in production.
//
// This suite pins BOTH paths firing through the REAL validator:
//   (i)  the POST-LOOP TERMINAL call (route.ts ~769) — drained off the
//        SSE stream as a `validator_block` event.
//   (ii) the IN-LOOP REPLAY closure (route.ts ~644) — the
//        `validateResponse` option passed INTO runAgentTurnStreaming,
//        captured via a vi.hoisted holder and invoked directly against
//        the hydrated session.
//
// The mock stubs ONLY runAgentTurnStreaming (the LLM loop) via
// importOriginal — the REAL validateResponse / checkPlanClaims run, which
// is the whole point: we prove the route wiring carries the plan to the
// real check.
//
// RED before GREEN: against the un-wired route, BOTH paths fail for the
// SAME reason — `forwardSchedule` never reaches the validator, so no
// `ungrounded_plan_claim` violation is produced even though the reply
// contradicts the stored plan.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setCohortAssignment, parseDpr, type ChatTurnResult, type ToolSession } from "@nyupath/engine";
import { getStores, resetStoresForTests } from "../lib/db/store";
import {
    makeFeasibleScheduleWithSemesters,
    specificSlot,
    seedStudentState,
} from "./_planRouteTestUtils";

// ------------------------------------------------------------
// Capture holder — written by the mocked streaming agent loop. vi.mock
// is hoisted above the imports, so the holder is created with vi.hoisted
// so the factory can close over it. We capture:
//   - the in-loop `validateResponse` closure (options.validateResponse,
//     the 5th positional arg) so test (ii) can drive it directly, and
//   - the hydrated session (3rd positional arg) it closes over, and
//   - the `finalText` to yield from the `done` event (set per test so we
//     can flip between ungrounded / grounded replies for test (i)).
// ------------------------------------------------------------
type InLoopValidate = (ctx: {
    assistantText: string;
    invocations: never[];
    session: ToolSession;
}) => { ok: boolean; violations: Array<{ kind: string; detail: string }> };

const holder = vi.hoisted(() => ({
    validate: undefined as unknown as InLoopValidate | undefined,
    session: undefined as ToolSession | undefined,
    finalText: "ok" as string,
}));

vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        runAgentTurnStreaming: async function* (...args: unknown[]) {
            // args[2] = hydrated session; args[4] = options (carries the
            // in-loop replay closure as options.validateResponse).
            holder.session = args[2] as ToolSession;
            const options = args[4] as { validateResponse?: InLoopValidate };
            holder.validate = options.validateResponse;
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: holder.finalText,
                invocations: [],
                turnMessages: [],
                usage: { promptTokens: 0, completionTokens: 0 },
                modelUsedId: "test-model",
                transitions: [],
            };
            yield { type: "done" as const, result };
        },
    };
});

// Import POST AFTER the mock so the route binds the mocked engine export.
import { POST } from "../app/api/chat/v2/route";

// DPR payload — reuse the shared redacted fixture wrapped in the
// canonical onboarding shape (matches chatV2Route / chatV2Hydration).
const DPR_FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);
function validDprPayload(): { kind: "dpr"; report: unknown } {
    const r = parseDpr(DPR_FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("DPR fixture failed to parse");
    return { kind: "dpr", report: r.report };
}

function fakeRequest(body: unknown): { json: () => Promise<unknown> } {
    return { json: async () => body };
}

// Drain the SSE stream to one string. The route writes `validator_block`
// (when blocked) BEFORE `done`, then closes in `finally` — so once the
// reader reports done=true the terminal validator has already run.
async function drainSse(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
    }
    return body;
}

// Parse the JSON `data:` payloads of every `validator_block` SSE event.
function validatorBlockEvents(sse: string): Array<{ kind: string; violations: Array<{ kind: string; detail: string }> }> {
    const out: Array<{ kind: string; violations: Array<{ kind: string; detail: string }> }> = [];
    for (const line of sse.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const json = trimmed.slice("data:".length).trim();
        if (!json) continue;
        try {
            const ev = JSON.parse(json);
            if (ev && ev.kind === "validator_block") out.push(ev);
        } catch {
            // non-JSON data line (e.g. token text) — skip.
        }
    }
    return out;
}

// The seeded plan places CSCI-UA 102 in 2027-fall (Fall 2027). An
// ungrounded reply asserts a DIFFERENT term; a grounded reply asserts
// the stored term.
const SEEDED_COURSE = "CSCI-UA 102";
const UNGROUNDED_CLAIM = "CSCI-UA 102 is in Spring 2026.";
const GROUNDED_CLAIM = "CSCI-UA 102 is in Fall 2027.";

describe("v2 route plan-claim validator wiring (D5.2)", () => {
    const ORIGINAL = {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        dbUrl: process.env.DATABASE_URL,
        sessionPath: process.env.NYUPATH_SESSION_STORE_PATH,
    };

    beforeEach(() => {
        // Force the in-memory store bundle so the seed + the route's
        // getStores() share one instance.
        delete process.env.DATABASE_URL;
        delete process.env.NYUPATH_SESSION_STORE_PATH;
        // createPrimaryClient only checks for key presence; the agent loop
        // is mocked so no real provider call is made.
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-validator";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-validator";
        // Default cohort `alpha` runs the full agent loop (evalGateFailing
        // false) so the turn reaches runAgentTurnStreaming + the terminal
        // validator.
        setCohortAssignment({ default: "alpha" });
        resetStoresForTests();
        holder.validate = undefined;
        holder.session = undefined;
        holder.finalText = "ok";
    });

    afterEach(() => {
        if (ORIGINAL.openai === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = ORIGINAL.openai;
        if (ORIGINAL.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = ORIGINAL.anthropic;
        if (ORIGINAL.dbUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = ORIGINAL.dbUrl;
        if (ORIGINAL.sessionPath === undefined) delete process.env.NYUPATH_SESSION_STORE_PATH;
        else process.env.NYUPATH_SESSION_STORE_PATH = ORIGINAL.sessionPath;
        setCohortAssignment({ default: "alpha" });
        resetStoresForTests();
        vi.restoreAllMocks();
    });

    // ------------------------------------------------------------
    // Seed a hydrate-able plan: CSCI-UA 102 in 2027-fall (specific_planned).
    // P3.1 hydration loads this into session.forwardSchedule each turn.
    // ------------------------------------------------------------
    async function seedPlanFor(userId: string): Promise<void> {
        const schedule = makeFeasibleScheduleWithSemesters(userId, [
            { term: "2027-fall", slots: [specificSlot(SEEDED_COURSE)] },
        ]);
        await seedStudentState(userId, schedule);
        setCohortAssignment({ overrides: { [userId]: "alpha" }, default: "alpha" });
    }

    // NON-ambiguous message so the clarifier gate doesn't early-return
    // BEFORE runAgentTurnStreaming.
    const CLEAR_MESSAGE =
        "What courses should I take next semester for my computer science major?";

    // ============================================================
    // (i) TERMINAL path — post-loop validateResponse → validator_block SSE
    // ============================================================
    it("(i) blocks an ungrounded plan claim on the terminal path (validator_block SSE)", async () => {
        const userId = "validator-terminal-ungrounded";
        await seedPlanFor(userId);
        // The mocked loop yields this as finalResult.finalText → the
        // post-loop validateResponse runs over it.
        holder.finalText = UNGROUNDED_CLAIM;

        const res = await POST(fakeRequest({
            message: CLEAR_MESSAGE,
            parsedData: validDprPayload(),
            userId,
        }) as never);
        expect(res.status).toBe(200);
        const sse = await drainSse(res);

        const blocks = validatorBlockEvents(sse);
        const planKinds = blocks.flatMap((b) => b.violations.map((v) => v.kind));
        expect(planKinds).toContain("ungrounded_plan_claim");
    });

    it("(i-control) does NOT block a GROUNDED plan claim on the terminal path", async () => {
        const userId = "validator-terminal-grounded";
        await seedPlanFor(userId);
        // Grounded: CSCI-UA 102 IS in Fall 2027 per the stored plan.
        holder.finalText = GROUNDED_CLAIM;

        const res = await POST(fakeRequest({
            message: CLEAR_MESSAGE,
            parsedData: validDprPayload(),
            userId,
        }) as never);
        expect(res.status).toBe(200);
        const sse = await drainSse(res);

        const blocks = validatorBlockEvents(sse);
        const planKinds = blocks.flatMap((b) => b.violations.map((v) => v.kind));
        expect(planKinds).not.toContain("ungrounded_plan_claim");
    });

    // ============================================================
    // (ii) IN-LOOP REPLAY closure — options.validateResponse (route.ts:644)
    // ============================================================
    it("(ii) the in-loop replay closure blocks an ungrounded plan claim against the hydrated session", async () => {
        const userId = "validator-inloop-ungrounded";
        await seedPlanFor(userId);
        // finalText irrelevant here — we drive the captured closure directly.
        holder.finalText = "ok";

        const res = await POST(fakeRequest({
            message: CLEAR_MESSAGE,
            parsedData: validDprPayload(),
            userId,
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        // The route passed the in-loop closure into runAgentTurnStreaming;
        // it closes over the hydrated session (CSCI-UA 102 in 2027-fall).
        expect(holder.validate).toBeDefined();
        expect(holder.session?.forwardSchedule).toBeDefined();

        const verdict = holder.validate!({
            assistantText: UNGROUNDED_CLAIM,
            invocations: [],
            session: holder.session!,
        });
        const kinds = verdict.violations.map((v) => v.kind);
        expect(kinds).toContain("ungrounded_plan_claim");
    });

    it("(ii-control) the in-loop closure is a no-op against a session with NO hydrated plan", async () => {
        // A userId with NO plan persisted → P3.1 leaves forwardSchedule
        // undefined → checkPlanClaims no-ops even for a contradicting reply.
        const userId = "validator-inloop-noplan";
        // No seedPlanFor — nothing persisted. Assign the cohort so the
        // turn runs the agent loop.
        setCohortAssignment({ overrides: { [userId]: "alpha" }, default: "alpha" });

        const res = await POST(fakeRequest({
            message: CLEAR_MESSAGE,
            parsedData: validDprPayload(),
            userId,
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        expect(holder.validate).toBeDefined();
        expect(holder.session?.forwardSchedule).toBeUndefined();

        const verdict = holder.validate!({
            assistantText: UNGROUNDED_CLAIM,
            invocations: [],
            session: holder.session!,
        });
        const kinds = verdict.violations.map((v) => v.kind);
        expect(kinds).not.toContain("ungrounded_plan_claim");
    });
});
