// ============================================================
// Security — chat v2 durable identity comes ONLY from the session cookie
// ============================================================
// The route used to derive `userId = authClaims?.sub ?? body.userId ??
// "anonymous"`. With NO session cookie, a caller could put any student's
// NetID in `body.userId` and the route then:
//   - READ under that id: the confirmed-profile read-back
//     (`profileStore.get`), plan + prefs hydration
//     (`scheduleStore.loadLatestSchedule` / `loadPreferences`), and the
//     victim's prior advising summaries (`sessionStore.get`), which were
//     injected into the prompt;
//   - WROTE under that id: the bootstrap persist (the caller's DPR became
//     the victim's `parsed_dpr` — an R1 violation), the homeSchool /
//     visaStatus change-persists, chat history and session summaries;
//   - handed the agent a ToolSession whose stores persist under that id
//     (`plan_forward_degree` / `confirm_plan_change` / `confirm_profile_update`
//     key their writes on `session.student.id`).
//
// Now an unauthenticated caller is "anonymous" for every store access
// and its ToolSession carries no durable store; the body id is ignored,
// including for the rate-limit bucket (unauthenticated callers share the
// global "anonymous" bucket, so a forged id can't spend a student's quota).
//
// Harness mirrors chatV2Hydration.test.ts: in-memory stores, a mocked
// streaming agent loop that records the session (3rd arg), fake API keys.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr, type ChatTurnResult } from "@nyupath/engine";
import { getStores, resetStoresForTests } from "../lib/db/store";
import { _clearBuckets, consumeRequest } from "../lib/rateLimit";
import { TEST_SECRET, fakeRequest, issueTestToken, seedStudentState } from "./_planRouteTestUtils";

const holder = vi.hoisted(() => ({
    session: undefined as unknown,
}));

vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        detectAmbiguity: () => ({ ambiguous: false, signals: [], contentTokens: [] }),
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

const DPR_FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);
function validDprPayload(): { kind: "dpr"; report: unknown } {
    const r = parseDpr(DPR_FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("DPR fixture failed to parse");
    return { kind: "dpr", report: r.report };
}

async function drainSse(res: Response): Promise<void> {
    const reader = res.body!.getReader();
    while (true) {
        const { done } = await reader.read();
        if (done) break;
    }
}

const MESSAGE = "What courses should I take next semester for my computer science major?";
const VICTIM = "victim-netid-ab1234";
const VICTIM_SUMMARY = "VICTIM-PRIVATE-ADVISING-SUMMARY";

/** Spy on every method of every durable store so a test can ask whether
 *  ANY call (read or write) carried a given student id anywhere in its
 *  arguments — including nested, e.g. `persistMutation(student)` where
 *  `student.id` is the key. */
function spyOnAllStores(): MockInstance[] {
    const stores = getStores() as unknown as Record<string, object>;
    const spies: MockInstance[] = [];
    for (const [storeName, store] of Object.entries(stores)) {
        const proto = Object.getPrototypeOf(store) as object;
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === "constructor") continue;
            const fn = (store as Record<string, unknown>)[name];
            if (typeof fn !== "function") continue;
            spies.push(vi.spyOn(store as Record<string, () => unknown>, name).mockName(`${storeName}.${name}`));
        }
    }
    return spies;
}

function callsTouching(spies: MockInstance[], id: string): string[] {
    const hits: string[] = [];
    for (const spy of spies) {
        for (const args of spy.mock.calls) {
            if (JSON.stringify(args).includes(JSON.stringify(id))) {
                hits.push(`${spy.getMockName()}(${String(args[0]).slice(0, 40)})`);
            }
        }
    }
    return hits;
}

type CapturedSession = {
    student?: { id?: string };
    profileStore?: unknown;
    scheduleStore?: unknown;
    chatHistoryStore?: unknown;
};

describe("v2 route — durable identity comes only from the session cookie", () => {
    const ORIGINAL = {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        dbUrl: process.env.DATABASE_URL,
        sessionPath: process.env.NYUPATH_SESSION_STORE_PATH,
        secret: process.env.SECRET_KEY,
    };

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        delete process.env.NYUPATH_SESSION_STORE_PATH;
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-identity-test";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-identity-test";
        process.env.SECRET_KEY = TEST_SECRET;
        resetStoresForTests();
        _clearBuckets();
        holder.session = undefined;
    });

    afterEach(() => {
        for (const [key, value] of [
            ["OPENAI_API_KEY", ORIGINAL.openai],
            ["ANTHROPIC_API_KEY", ORIGINAL.anthropic],
            ["DATABASE_URL", ORIGINAL.dbUrl],
            ["NYUPATH_SESSION_STORE_PATH", ORIGINAL.sessionPath],
            ["SECRET_KEY", ORIGINAL.secret],
        ] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        resetStoresForTests();
        _clearBuckets();
        vi.restoreAllMocks();
    });

    it("a cookie-less request naming a seeded student in body.userId never reads or writes that student's rows", async () => {
        await seedStudentState(VICTIM);
        const stores = getStores();
        await stores.sessionStore.appendSummary(VICTIM, { date: "2026-10-01", summary: VICTIM_SUMMARY });
        const profileBefore = await stores.profileStore.get(VICTIM);

        const spies = spyOnAllStores();
        const res = await POST(fakeRequest(undefined, {
            message: MESSAGE,
            parsedData: validDprPayload(),
            history: [],
            userId: VICTIM,
            homeSchool: "stern",
            visaStatus: "f1",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        expect(callsTouching(spies, VICTIM)).toEqual([]);

        vi.restoreAllMocks();
        expect(await stores.profileStore.get(VICTIM)).toEqual(profileBefore);
        expect((await stores.sessionStore.get(VICTIM)).sessionSummaries.map((s) => s.summary)).toEqual([VICTIM_SUMMARY]);
        expect(await stores.chatHistoryStore.loadRecentMessages(VICTIM)).toEqual([]);
    });

    it("a cookie-less request naming an un-onboarded student does not bootstrap a profile or parsed_dpr for that id", async () => {
        const res = await POST(fakeRequest(undefined, {
            message: MESSAGE,
            parsedData: validDprPayload(),
            history: [],
            userId: VICTIM,
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const stores = getStores() as unknown as {
            profileStore: { get(id: string): Promise<unknown>; getParsedDpr(id: string): Promise<unknown> };
        };
        expect(await stores.profileStore.get(VICTIM)).toBeNull();
        expect(await stores.profileStore.getParsedDpr(VICTIM)).toBeNull();
    });

    it("hands the agent an anonymous ToolSession with no durable stores when there is no cookie", async () => {
        const res = await POST(fakeRequest(undefined, {
            message: MESSAGE,
            parsedData: validDprPayload(),
            history: [],
            userId: VICTIM,
        }) as never);
        await drainSse(res);

        const session = holder.session as CapturedSession;
        expect(session).toBeDefined();
        expect(session.student?.id).toBe("anonymous");
        expect(session.profileStore).toBeUndefined();
        expect(session.scheduleStore).toBeUndefined();
        expect(session.chatHistoryStore).toBeUndefined();
    });

    it("a forged body.userId cannot spend that student's rate-limit bucket", async () => {
        const res = await POST(fakeRequest(undefined, {
            message: MESSAGE,
            parsedData: validDprPayload(),
            history: [],
            userId: VICTIM,
        }) as never);
        await drainSse(res);

        // The victim's bucket is untouched: their first real request
        // still has the full daily quota minus itself.
        const victim = consumeRequest(VICTIM);
        expect(victim.ok && victim.remaining).toBe(victim.limit - 1);
        // The cookie-less request was charged to the shared anonymous bucket.
        const anon = consumeRequest("anonymous");
        expect(anon.ok && anon.remaining).toBe(anon.limit - 2);
    });

    it("an authenticated request keys every store access on the cookie subject, never on body.userId", async () => {
        const SUB = "alice-auth-cd5678";
        await seedStudentState(SUB);
        await seedStudentState(VICTIM);
        const spies = spyOnAllStores();

        const res = await POST(fakeRequest(await issueTestToken(SUB), {
            message: MESSAGE,
            parsedData: validDprPayload(),
            history: [],
            userId: VICTIM,
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        expect(callsTouching(spies, VICTIM)).toEqual([]);
        expect(callsTouching(spies, SUB).length).toBeGreaterThan(0);
        const session = holder.session as CapturedSession;
        expect(session.student?.id).toBe(SUB);
        expect(session.profileStore).toBeDefined();
        expect(session.scheduleStore).toBeDefined();
        expect(session.chatHistoryStore).toBeDefined();
    });
});
