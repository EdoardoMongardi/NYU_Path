// ============================================================
// P3.1 — per-turn plan + prefs hydration into the chat session
// ============================================================
// The /api/chat/v2 route builds a fresh ToolSession every turn. Before
// P3.1 it built that session WITHOUT loading the student's persisted
// forwardSchedule / studentDraftPlan / schedulePreferences, so the chat
// agent ran blind to the plan the student built (e.g. via the sidebar)
// and the upcoming D5 plan-claim validator had nothing to verify
// against. This suite pins the hydration: it captures the constructed
// session via a mock of runAgentTurnStreaming (the 3rd positional arg)
// and asserts the persisted plan + prefs (pins preserved) are present.
//
// RED before GREEN: with the route un-hydrated, holder.session.
// forwardSchedule is undefined and the first assertion fails.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setCohortAssignment, parseDpr, type ChatTurnResult } from "@nyupath/engine";
import { getStores, resetStoresForTests } from "../lib/db/store";
import type { SchedulePreferences } from "@nyupath/shared";
import {
    makeFeasibleScheduleWithSemesters,
    specificSlot,
    seedStudentState,
} from "./_planRouteTestUtils";

// ------------------------------------------------------------
// Capture holder — written by the mocked streaming agent loop. Because
// vi.mock is hoisted above the imports, the holder must be created with
// vi.hoisted so the factory can close over it.
// ------------------------------------------------------------
const holder = vi.hoisted(() => ({
    session: undefined as unknown,
}));

// Mock ONLY the streaming agent loop. `importOriginal` keeps every other
// engine export real (validator / cohort / DPR parse / clarifier all run
// for real). The stub records the session it's called with (3rd arg) and
// yields a minimal `ok` ChatTurnResult so the route reaches `done`.
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

// Import POST AFTER the mock so the route binds the mocked engine export.
import { POST } from "../app/api/chat/v2/route";

// DPR payload — reuse the shared redacted fixture wrapped in the
// canonical onboarding shape (matches chatV2Route.test.ts).
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

async function drainSse(res: Response): Promise<void> {
    const reader = res.body!.getReader();
    while (true) {
        const { done } = await reader.read();
        if (done) break;
    }
}

describe("v2 route per-turn plan + prefs hydration (P3.1)", () => {
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
        // createPrimaryClient only checks for key presence; the agent
        // loop is mocked so no real provider call is made.
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-hydration";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-hydration";
        // Default cohort `alpha` runs the full agent loop (evalGateFailing
        // false) so the turn reaches runAgentTurnStreaming.
        setCohortAssignment({ default: "alpha" });
        resetStoresForTests();
        holder.session = undefined;
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

    it("hydrates the persisted forwardSchedule + preferences (pins) into the session", async () => {
        const userId = "hydration-student-1";
        const seededCourseId = "CSCI-UA.0101";
        // Seed a valid forward schedule with a recognizable marker term
        // (graduationTerm "2027-spring") and one specific slot.
        const schedule = makeFeasibleScheduleWithSemesters(userId, [
            { term: "2026-fall", slots: [specificSlot(seededCourseId)] },
        ]);
        // seedStudentState writes profile + DPR + the schedule.
        await seedStudentState(userId, schedule);
        // Seed preferences carrying a pin so we can prove prefs hydrate too.
        const prefs: SchedulePreferences = {
            pins: [{ courseId: seededCourseId, term: "2026-fall" }],
        };
        const stores = getStores({});
        await stores.scheduleStore.persistPreferences(userId, prefs);

        setCohortAssignment({ overrides: { [userId]: "alpha" }, default: "alpha" });

        const res = await POST(fakeRequest({
            // NON-ambiguous message — an ambiguous one would trip the
            // clarifier gate and early-return BEFORE runAgentTurnStreaming.
            message: "What courses should I take next semester for my computer science major?",
            parsedData: validDprPayload(),
            userId,
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        // The constructed session must carry the hydrated plan + prefs.
        expect(holder.session).toBeDefined();
        const session = holder.session as {
            forwardSchedule?: { graduationTerm?: string };
            schedulePreferences?: { pins?: Array<{ courseId: string }> };
        };
        expect(session.forwardSchedule?.graduationTerm).toBe("2027-spring");
        expect(session.schedulePreferences?.pins?.[0]?.courseId).toBe(seededCourseId);
    });

    it("is a no-op (no forwardSchedule, no crash) when nothing is persisted for the user", async () => {
        // Negative control: a userId with profile/DPR seeded but NO
        // schedule + NO prefs persisted. Hydration must leave the
        // forwardSchedule slot undefined and the turn must still complete.
        const userId = "hydration-no-schedule";
        // Persist NOTHING to any store. The profile/DPR are supplied by the
        // request body, so the schedule + prefs slots must hydrate to undefined.

        setCohortAssignment({ overrides: { [userId]: "alpha" }, default: "alpha" });

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my computer science major?",
            parsedData: validDprPayload(),
            userId,
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        expect(holder.session).toBeDefined();
        const session = holder.session as { forwardSchedule?: unknown; schedulePreferences?: unknown };
        expect(session.forwardSchedule).toBeUndefined();
        expect(session.schedulePreferences).toBeUndefined();
    });
});
