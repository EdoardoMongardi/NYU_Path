// ============================================================
// E1.3 — chat/sidebar PARITY test (Phase 4, EXIT GATE #1)
// ============================================================
// Phase 4's core continuity guarantee is that the TWO edit channels
// the workspace exposes — the SIDEBAR (drag-to-move → /api/plan/move →
// /api/plan/confirm HTTP routes) and CHAT (the agent's
// confirm_plan_change tool, wrapped by the planActionOrchestrator
// propose/confirm machinery) — converge on ONE persisted plan state.
// There must be no "two truths" drift where the chat agent and the
// sidebar render divergent schedules.
//
// This suite proves that convergence end-to-end, OFFLINE + in-memory
// (no DB, no LLM). Every actor below — the seed, both HTTP routes, the
// orchestrator stages, the v2 chat-turn route, and the restore route —
// shares the SAME process-singleton in-memory store bundle that
// getStores({}) returns when DATABASE_URL is absent. That shared
// singleton is precisely what makes convergence observable in one test.
//
// ------------------------------------------------------------
// What each part proves
// ------------------------------------------------------------
//   (a) SIDEBAR → CHAT re-hydration (NEXT turn, via P3.1).
//       Apply a move via the sidebar HTTP routes (/api/plan/move →
//       /api/plan/confirm), THEN POST a fresh v2 chat turn and capture
//       the constructed ToolSession. The agent's hydrated
//       session.forwardSchedule must reflect the sidebar edit (course X
//       now in T2). This is intentionally NEXT-turn hydration — the
//       route rebuilds the session from persisted state at the START of
//       each turn (P3.1), NOT mid-turn.
//
//   (b) CHAT → SIDEBAR (restore reflects the chat edit).
//       Apply a DIFFERENT change through the CHAT channel — the
//       planActionOrchestrator propose/confirm machinery, the same path
//       the confirm_plan_change agent tool wraps — THEN GET
//       /api/session/restore (the sidebar-facing payload) and assert it
//       reflects that chat edit specifically.
//
//   (c) ONE persisted row (no divergent snapshots).
//       After an edit+confirm, the scheduleStore holds exactly ONE
//       non-superseded forwardSchedule row. Both channels funnel
//       through the same runConfirmStage write path (soft-delete
//       supersede), so there is a single live row — never two.
//
//   (in-session store parity) E1.1 createPlanStore.
//       A sidebar-driven setForwardSchedule and a chat-driven
//       setForwardSchedule into ONE createPlanStore() are both read by a
//       synchronous getSnapshot() WITHOUT any server round-trip — the
//       last write wins and both consumers see it.
//
// ------------------------------------------------------------
// Part-(b) DRIVER DECISION (load-bearing — read before editing)
// ------------------------------------------------------------
// Part (b)'s chat edit is driven through the planActionOrchestrator
// `runProposeStage` → `runConfirmStage` machinery — the SAME helper the
// `confirm_plan_change` agent tool path delegates to — NOT by
// re-calling the /api/plan/confirm HTTP route that part (a) uses. This
// keeps the two CHANNELS genuinely distinct: part (a) exercises the
// sidebar HTTP routes; part (b) exercises the chat/agent tool path.
//
// It is EXPECTED AND CORRECT that both channels ultimately funnel
// through the same runConfirmStage write path and land on the SAME
// forwardSchedule row — that convergence is exactly what part (c)
// proves. No LLM is stubbed; the orchestrator stages are deterministic
// and offline.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr, type ChatTurnResult, InMemoryScheduleStore } from "@nyupath/engine";
import { getStores, resetStoresForTests } from "../lib/db/store";
import {
    runProposeStage,
    runConfirmStage,
    _resetPendingMutationsForTests,
} from "../lib/planActionOrchestrator";
import { _clearBuckets } from "../lib/rateLimit";
import { SESSION_COOKIE } from "../lib/auth/session";
import { createPlanStore } from "../app/chat/planState";
import {
    seedStudentState,
    issueTestToken,
    fakeRequest as fakePlanRequest,
    makeFeasibleScheduleWithSemesters,
    specificSlot,
    TEST_SECRET,
} from "./_planRouteTestUtils";
import type { ForwardSchedule, PlanMutation } from "@nyupath/shared";

// ------------------------------------------------------------
// v2-route mock: capture the constructed ToolSession (3rd positional
// arg of runAgentTurnStreaming) so part (a) can read the hydrated
// session.forwardSchedule. Mirrors chatV2Hydration.test.ts exactly.
// vi.mock is hoisted; the holder is created with vi.hoisted so the
// factory can close over it.
// ------------------------------------------------------------
const holder = vi.hoisted(() => ({
    session: undefined as unknown,
}));

vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        runAgentTurnStreaming: async function* (...args: unknown[]) {
            holder.session = args[2];
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: "Here is a plan for next semester.",
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

// Import the v2 POST AFTER the mock so the route binds the mocked
// engine export. The plan routes import their own engine internals
// (which stay real via importOriginal) — only runAgentTurnStreaming is
// replaced.
import { POST as chatV2POST } from "../app/api/chat/v2/route";

// ------------------------------------------------------------
// DPR payload for the v2 turn — the shared redacted fixture wrapped in
// the canonical onboarding shape (matches chatV2Hydration.test.ts).
// ------------------------------------------------------------
const DPR_FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);
function validDprPayload(): { kind: "dpr"; report: unknown } {
    const r = parseDpr(DPR_FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("DPR fixture failed to parse");
    return { kind: "dpr", report: r.report };
}

// The v2 route reads `req.json()` only (no cookie auth — userId is in
// the body). The plan routes use a cookie + JWT (fakePlanRequest).
function fakeJsonRequest(body: unknown): { json: () => Promise<unknown> } {
    return { json: async () => body };
}

async function drainSse(res: Response): Promise<void> {
    const reader = res.body!.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { done } = await reader.read();
        if (done) break;
    }
}

// Locate the slot for a courseId within a given term of a schedule.
function slotInTerm(
    schedule: ForwardSchedule | null | undefined,
    term: string,
    courseId: string,
): boolean {
    const sem = schedule?.semesters.find((s) => s.term === term);
    if (!sem) return false;
    return sem.slots.some((sl) => "courseId" in sl && sl.courseId === courseId);
}

// The proven movable course from planMoveRoute.test.ts — the move
// route's [move, pin(freeze)] batch + solver reliably lands it in the
// toTerm.
const COURSE_X = "CSCI-UA 101";
const T1 = "2026-fall";
// T2 MUST equal the shared fixture's `graduationTerm`
// (`_planRouteTestUtils.ts` `makeFeasibleScheduleWithSemesters`,
// "2027-spring"): the move target is also the graduation term, and the
// test relies on a course remaining valid when moved INTO the grad term.
// If that fixture's `graduationTerm` ever changes, update this literal.
const T2 = "2027-spring";

describe("chat/sidebar PARITY — both edit channels converge on one persisted state (E1.3, EXIT GATE #1)", () => {
    const ORIGINAL = {
        secret: process.env.SECRET_KEY,
        dbUrl: process.env.DATABASE_URL,
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        sessionPath: process.env.NYUPATH_SESSION_STORE_PATH,
    };

    beforeEach(() => {
        // Force the in-memory store bundle so the seed + ALL routes +
        // the orchestrator stages share ONE singleton instance.
        delete process.env.DATABASE_URL;
        delete process.env.NYUPATH_SESSION_STORE_PATH;
        process.env.SECRET_KEY = TEST_SECRET;
        // createPrimaryClient only checks for key presence; the agent
        // loop is mocked, so no real provider call is made.
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-parity";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-parity";
        resetStoresForTests();
        _resetPendingMutationsForTests();
        _clearBuckets();
        holder.session = undefined;
    });

    afterEach(() => {
        if (ORIGINAL.secret === undefined) delete process.env.SECRET_KEY;
        else process.env.SECRET_KEY = ORIGINAL.secret;
        if (ORIGINAL.dbUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = ORIGINAL.dbUrl;
        if (ORIGINAL.openai === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = ORIGINAL.openai;
        if (ORIGINAL.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = ORIGINAL.anthropic;
        if (ORIGINAL.sessionPath === undefined) delete process.env.NYUPATH_SESSION_STORE_PATH;
        else process.env.NYUPATH_SESSION_STORE_PATH = ORIGINAL.sessionPath;
        resetStoresForTests();
        _resetPendingMutationsForTests();
        _clearBuckets();
        vi.restoreAllMocks();
    });

    // ------------------------------------------------------------------
    // (a) SIDEBAR edit → CHAT re-hydration (NEXT turn, via P3.1).
    // ------------------------------------------------------------------
    it("(a) a SIDEBAR move (/api/plan/move → confirm) is reflected in the chat agent's NEXT-turn session.forwardSchedule", async () => {
        const studentId = "parity_sidebar_to_chat";
        // Seed a valid two-term schedule with course X placed in T1, so
        // the sidebar move is a genuine T1 → T2 relocation.
        const schedule = makeFeasibleScheduleWithSemesters(studentId, [
            { term: T1, slots: [specificSlot(COURSE_X)] },
            { term: T2, slots: [] },
        ]);
        await seedStudentState(studentId, schedule);

        const token = await issueTestToken(studentId);

        // --- SIDEBAR channel: propose the move (HTTP /api/plan/move). ---
        const { POST: movePOST } = await import("../app/api/plan/move/route");
        const moveRes = await movePOST(
            fakePlanRequest(token, { courseId: COURSE_X, fromTerm: T1, toTerm: T2 }) as never,
        );
        expect(moveRes.status).toBe(200);
        const moveJson = await moveRes.json();
        expect(moveJson.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);

        // --- SIDEBAR channel: confirm (HTTP /api/plan/confirm). ---
        const { POST: confirmPOST } = await import("../app/api/plan/confirm/route");
        const confirmRes = await confirmPOST(
            fakePlanRequest(token, { pendingMutationId: moveJson.pendingMutationId }) as never,
        );
        expect(confirmRes.status).toBe(200);

        // --- CHAT channel (NEXT turn): POST a v2 turn; the route
        //     re-hydrates session.forwardSchedule from persisted state
        //     at the START of the turn (P3.1). The mock captures that
        //     constructed session. This is INTENTIONALLY next-turn — the
        //     sidebar edit is NOT pushed mid-turn; it is re-read on the
        //     subsequent turn. ---
        const chatRes = await chatV2POST(
            fakeJsonRequest({
                message:
                    "What courses should I take next semester for my computer science major?",
                parsedData: validDprPayload(),
                userId: studentId,
            }) as never,
        );
        expect(chatRes.status).toBe(200);
        await drainSse(chatRes);

        expect(holder.session).toBeDefined();
        const session = holder.session as { forwardSchedule?: ForwardSchedule };
        const hydrated = session.forwardSchedule;
        expect(hydrated).toBeDefined();
        // SPECIFIC placement: X is now in T2, and is gone from T1. This
        // is the sidebar edit re-hydrated into the chat agent's session.
        expect(slotInTerm(hydrated, T2, COURSE_X)).toBe(true);
        expect(slotInTerm(hydrated, T1, COURSE_X)).toBe(false);
    });

    // ------------------------------------------------------------------
    // (b) CHAT edit (orchestrator confirm machinery) → SIDEBAR restore.
    // ------------------------------------------------------------------
    it("(b) a CHAT edit (planActionOrchestrator confirm machinery) is reflected in the sidebar-facing /api/session/restore payload", async () => {
        const studentId = "parity_chat_to_sidebar";
        // Seed a valid two-term schedule. The chat edit pins a DIFFERENT
        // course (Y) into T2 — distinct from part (a)'s move so the two
        // channels can't be confused.
        const COURSE_Y = "MATH-UA 121";
        const schedule = makeFeasibleScheduleWithSemesters(studentId, [
            { term: T1, slots: [] },
            { term: T2, slots: [] },
        ]);
        await seedStudentState(studentId, schedule);

        // --- CHAT channel: stage via the orchestrator propose path
        //     (the same helper confirm_plan_change wraps), then apply
        //     via runConfirmStage. NOT the /api/plan/confirm HTTP route
        //     (that is part (a)'s sidebar channel). ---
        const mutations: PlanMutation[] = [
            { kind: "pin", courseId: COURSE_Y, term: T2, freeze: true },
        ];
        const propose = await runProposeStage(studentId, mutations);
        expect(propose.ok).toBe(true);
        if (!propose.ok) return;

        const apply = await runConfirmStage(studentId, propose.response.pendingMutationId);
        expect(apply.ok).toBe(true);
        if (!apply.ok) return;
        expect(apply.response.storedIn).toBe("forwardSchedule");

        // --- SIDEBAR-facing read: GET /api/session/restore. The
        //     restored forwardSchedule must reflect the chat edit (Y in
        //     T2) specifically. ---
        const { GET: restoreGET } = await import("../app/api/session/restore/route");
        const token = await issueTestToken(studentId);
        const restoreRes = await restoreGET(
            // The restore route only reads the cookie + headers (no body).
            { cookies: { get: (n: string) => (n === SESSION_COOKIE ? { value: token } : undefined) }, headers: { get: () => null } } as never,
        );
        expect(restoreRes.status).toBe(200);
        const restoreJson = await restoreRes.json();
        expect(restoreJson.forwardSchedule).not.toBeNull();
        expect(slotInTerm(restoreJson.forwardSchedule as ForwardSchedule, T2, COURSE_Y)).toBe(true);
    });

    // ------------------------------------------------------------------
    // (c) After an edit+confirm, exactly ONE non-superseded row exists.
    // ------------------------------------------------------------------
    it("(c) after a confirmed edit, the scheduleStore holds exactly ONE non-superseded forwardSchedule row (no divergent snapshots)", async () => {
        const studentId = "parity_single_row";
        const schedule = makeFeasibleScheduleWithSemesters(studentId, [
            { term: T1, slots: [specificSlot(COURSE_X)] },
            { term: T2, slots: [] },
        ]);
        await seedStudentState(studentId, schedule);

        const token = await issueTestToken(studentId);
        const { POST: movePOST } = await import("../app/api/plan/move/route");
        const { POST: confirmPOST } = await import("../app/api/plan/confirm/route");

        const moveRes = await movePOST(
            fakePlanRequest(token, { courseId: COURSE_X, fromTerm: T1, toTerm: T2 }) as never,
        );
        const moveJson = await moveRes.json();
        const confirmRes = await confirmPOST(
            fakePlanRequest(token, { pendingMutationId: moveJson.pendingMutationId }) as never,
        );
        expect(confirmRes.status).toBe(200);

        const stores = getStores({});
        const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;

        // loadLatestSchedule returns ONLY the live (non-superseded) row;
        // it being non-null proves there is a live row to read.
        const latest = await scheduleStore.loadLatestSchedule(studentId);
        expect(latest).not.toBeNull();

        // Reach into the store's internal row list to prove there is
        // exactly ONE non-superseded row — the seed + the confirm wrote
        // two ROWS total (audit trail), but only the confirm's row is
        // live; the seed row was superseded. No divergent live snapshot.
        const internal = scheduleStore as unknown as {
            schedules: Map<string, Array<{ supersededAt: number | null }>>;
        };
        const rows = internal.schedules.get(studentId) ?? [];
        const liveRows = rows.filter((r) => r.supersededAt === null);
        expect(liveRows.length).toBe(1);
        // The single live row is the one loadLatestSchedule returns, and
        // it carries the confirmed edit (X moved to T2).
        expect(slotInTerm(latest!.schedule, T2, COURSE_X)).toBe(true);
    });

    // ------------------------------------------------------------------
    // In-session store parity (E1.1 createPlanStore): a sidebar-driven
    // and a chat-driven write into ONE store are both read by a
    // synchronous getSnapshot() with NO server round-trip.
    // ------------------------------------------------------------------
    it("in-session: a sidebar write and a chat write into ONE createPlanStore are both read synchronously, last-write-wins, no server call", async () => {
        const studentId = "parity_in_session_store";
        // Two distinct schedule snapshots standing in for the two
        // channels' outputs. editedA = "sidebar produced this"; editedB
        // = "chat produced this".
        const editedA = makeFeasibleScheduleWithSemesters(studentId, [
            { term: T1, slots: [specificSlot(COURSE_X)] },
        ]);
        const editedB = makeFeasibleScheduleWithSemesters(studentId, [
            { term: T2, slots: [specificSlot(COURSE_X)] },
        ]);

        const store = createPlanStore();
        // No round-trip is even possible here — this is the pure E1.1
        // module with no network surface. The assertion is that both
        // writers hit the SAME snapshot and a synchronous read sees the
        // latest.

        // Sidebar channel writes first.
        store.setForwardSchedule(editedA);
        expect(store.getSnapshot().forwardSchedule).toBe(editedA);

        // Chat channel writes next, into the SAME store.
        store.setForwardSchedule(editedB);
        // Synchronous read — no await, no fetch — returns the latest
        // (last-write-wins). Both "consumers" reading getSnapshot() see
        // editedB; there is no second divergent store.
        const snapshot = store.getSnapshot();
        expect(snapshot.forwardSchedule).toBe(editedB);
        expect(snapshot.forwardSchedule).not.toBe(editedA);
        // getSnapshot is stable on a no-op repeat read (React 19
        // useSyncExternalStore contract).
        expect(store.getSnapshot()).toBe(snapshot);
    });
});
