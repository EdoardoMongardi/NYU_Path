// ============================================================
// Self-serve delete revokes the session (PR #58 review finding 2)
// ============================================================
// /api/session/delete wiped the student's rows but left the stateless
// 30-day JWT valid and the cookie in place. One later chat turn from
// another open tab — or a turn already in flight — then re-created the
// `students` row and `parsed_dpr` through the chat route's bootstrap
// persist (every Postgres store write also upserts `students`).
//
// Now:
//   - delete records a per-student revocation (a tombstone keyed on the
//     studentId, written in the same transaction as the wipe) and clears
//     the cookie;
//   - verifySessionToken rejects any token issued at or before that
//     revocation — and fails closed when the lookup itself fails;
//   - the chat route's stores are fenced for the turn: once the session
//     is revoked, every write refuses (SessionRevokedError), so an
//     in-flight turn can't write the account back.
// A token issued AFTER the revocation (the student signs in again)
// verifies normally.
// ============================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import {
    InMemoryChatHistoryStore,
    InMemoryProfileStore,
    InMemoryScheduleStore,
    InMemorySessionStore,
    parseDpr,
    type ChatTurnResult,
} from "@nyupath/engine";
import { SESSION_COOKIE, verifySessionToken } from "../lib/auth/session";
import {
    SessionRevokedError,
    fenceStoresForSession,
    recordSessionRevocation,
    resetRevocationsForTests,
} from "../lib/auth/revocation";
import { getStores, resetStoresForTests } from "../lib/db/store";
// Static imports: the DB-mode cases below call vi.resetModules(), after
// which a dynamic import would load a SECOND module graph (its own store
// bundle + revocation map) that these assertions can't see.
import { POST as chatPOST } from "../app/api/chat/v2/route";
import { DELETE as deleteRoute } from "../app/api/session/delete/route";
import { makeDpr, makeFeasibleSchedule, makeProfile } from "./_planRouteTestUtils";

const TEST_SECRET = "test-secret-for-session-revocation-tests-32++";

// Controllable stand-in for the agent loop: a turn can be held open
// (`gate`) so a delete can land while it is in flight.
const agent = vi.hoisted(() => ({ gate: Promise.resolve() as Promise<void> }));
vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        // No clarifier round-trip (it would call the real provider).
        askClarification: async () => null,
        runAgentTurnStreaming: async function* () {
            await agent.gate;
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: "Here is your plan.",
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

const DPR_FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);
function validDprPayload(): { kind: "dpr"; report: unknown } {
    const r = parseDpr(DPR_FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("DPR fixture failed to parse");
    return { kind: "dpr", report: r.report };
}

async function tokenFor(sub: string, issuedAtSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
    return new SignJWT({ email: `${sub}@nyu.edu` })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(sub)
        .setIssuedAt(issuedAtSeconds)
        .setExpirationTime("30d")
        .sign(new TextEncoder().encode(TEST_SECRET));
}

function cookieRequest(token: string, body?: unknown) {
    return {
        cookies: { get: (n: string) => (n === SESSION_COOKIE ? { value: token } : undefined) },
        headers: { get: () => null },
        json: async () => body,
    };
}

async function drain(res: Response): Promise<void> {
    const reader = res.body!.getReader();
    while (!(await reader.read()).done) { /* drain */ }
}

const ENV_KEYS = ["SECRET_KEY", "DATABASE_URL", "NYUPATH_SESSION_STORE_PATH", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.NYUPATH_SESSION_STORE_PATH;
    process.env.SECRET_KEY = TEST_SECRET;
    // Presence-only checks in createPrimaryClient; the loop is mocked.
    process.env.OPENAI_API_KEY = "sk-test-fake";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";
    agent.gate = Promise.resolve();
    resetStoresForTests();
    resetRevocationsForTests();
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
        else process.env[k] = ORIGINAL_ENV[k];
    }
    resetStoresForTests();
    resetRevocationsForTests();
    vi.doUnmock("../lib/db/client");
});

describe("verifySessionToken honors a revocation", () => {
    it("rejects a token issued before the student's revocation", async () => {
        const token = await tokenFor("rev_a", Math.floor(Date.now() / 1000) - 60);
        expect(await verifySessionToken(token)).not.toBeNull();
        await recordSessionRevocation(null, "rev_a", new Date());
        expect(await verifySessionToken(token)).toBeNull();
    });

    it("accepts a token issued after the revocation (the student signs in again)", async () => {
        await recordSessionRevocation(null, "rev_b", new Date());
        const later = await tokenFor("rev_b", Math.floor(Date.now() / 1000) + 2);
        expect((await verifySessionToken(later))?.sub).toBe("rev_b");
    });

    it("only affects the revoked student", async () => {
        const other = await tokenFor("rev_other");
        await recordSessionRevocation(null, "rev_c", new Date(Date.now() + 1000));
        expect((await verifySessionToken(other))?.sub).toBe("rev_other");
    });

    it("shares in-memory revocations across module instances (Next loads route handlers and the /chat layout separately)", async () => {
        const token = await tokenFor("rev_shared", Math.floor(Date.now() / 1000) - 60);
        await recordSessionRevocation(null, "rev_shared", new Date());
        vi.resetModules();
        const otherInstance = await import("../lib/auth/session");
        expect(await otherInstance.verifySessionToken(token)).toBeNull();
    });

    it("fails closed when the revocation lookup throws", async () => {
        vi.resetModules();
        vi.doMock("../lib/db/client", () => ({
            getDb: () => ({
                select: () => {
                    throw new Error("relation \"session_revocations\" does not exist");
                },
            }),
        }));
        const fresh = await import("../lib/auth/session");
        const token = await tokenFor("rev_d");
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await fresh.verifySessionToken(token)).toBeNull();
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });
});

describe("DELETE /api/session/delete", () => {
    it("clears the session cookie", async () => {
        const res = await deleteRoute(cookieRequest(await tokenFor("del_cookie")) as never);
        expect(res.status).toBe(200);
        const setCookie = res.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain(`${SESSION_COOKIE}=`);
        expect(setCookie).toMatch(/Max-Age=0/i);
    });

    it("records the revocation inside the wipe transaction (DB mode)", async () => {
        const ops: Array<{ op: string; table: unknown; inTx: boolean }> = [];
        let inTx = false;
        class StubDb {
            select() {
                const chain = { from: () => chain, where: () => chain, limit: async () => [] };
                return chain;
            }
            delete(table: unknown) {
                ops.push({ op: "delete", table, inTx });
                return { where: async () => undefined };
            }
            insert(table: unknown) {
                ops.push({ op: "insert", table, inTx });
                const chain = { values: () => chain, onConflictDoUpdate: async () => undefined };
                return chain;
            }
            async transaction<T>(cb: (tx: this) => Promise<T>): Promise<T> {
                inTx = true;
                try { return await cb(this); } finally { inTx = false; }
            }
        }
        vi.resetModules();
        vi.doMock("../lib/db/client", () => ({ getDb: () => new StubDb() }));
        const schema = await import("../lib/db/schema");
        const { DELETE } = await import("../app/api/session/delete/route");
        const res = await DELETE(cookieRequest(await tokenFor("del_db")) as never);
        expect(res.status).toBe(200);
        const revocation = ops.find((o) => o.op === "insert" && o.table === schema.sessionRevocations);
        expect(revocation?.inTx).toBe(true);
        expect(ops.some((o) => o.op === "delete" && o.table === schema.students && o.inTx)).toBe(true);
    });

    it("delete, then a chat turn with the same cookie, leaves no profile behind", async () => {
        const sub = "del_then_chat";
        const token = await tokenFor(sub);

        // A first turn bootstraps the profile + parsed_dpr.
        await drain(await chatPOST(cookieRequest(token, { message: "What should I take next semester?", parsedData: validDprPayload() }) as never));
        expect(await getStores().profileStore.get(sub)).not.toBeNull();

        expect((await deleteRoute(cookieRequest(token) as never)).status).toBe(200);
        expect(await getStores().profileStore.get(sub)).toBeNull();

        // Another open tab sends a turn with the old cookie.
        const res = await chatPOST(cookieRequest(token, { message: "What should I take next semester?", parsedData: validDprPayload() }) as never);
        if (res.body) await drain(res);

        expect(await getStores().profileStore.get(sub)).toBeNull();
        expect(await getStores().profileStore.getParsedDpr?.(sub)).toBeNull();
        expect(await getStores().chatHistoryStore.loadRecentMessages(sub)).toEqual([]);
        expect((await getStores().sessionStore.get(sub)).sessionSummaries).toEqual([]);
    });
});

describe("an in-flight chat turn can't write after the revocation", () => {
    it("control: without a revocation the same turn writes its history + summary", async () => {
        const sub = "inflight_control";
        const res = await chatPOST(
            cookieRequest(await tokenFor(sub), { message: "What should I take next semester?", parsedData: validDprPayload() }) as never,
        );
        await drain(res);
        expect(await getStores().chatHistoryStore.loadRecentMessages(sub)).toHaveLength(2);
        expect((await getStores().sessionStore.get(sub)).sessionSummaries).toHaveLength(1);
    });

    it("drops the end-of-turn chat history + summary writes once the session is revoked mid-turn", async () => {
        const sub = "inflight";
        const token = await tokenFor(sub);
        let release!: () => void;
        agent.gate = new Promise<void>((r) => { release = r; });

        const res = await chatPOST(cookieRequest(token, { message: "What should I take next semester?", parsedData: validDprPayload() }) as never);
        expect(res.status).toBe(200);

        // The delete commits (here: on another instance, so this process's
        // store bundle is not reset) while the agent loop is still running.
        await recordSessionRevocation(null, sub, new Date());
        const warn = vi.spyOn(console, "error").mockImplementation(() => {});
        release();
        await drain(res);
        warn.mockRestore();

        expect(await getStores().chatHistoryStore.loadRecentMessages(sub)).toEqual([]);
        expect((await getStores().sessionStore.get(sub)).sessionSummaries).toEqual([]);
    });
});

describe("fenceStoresForSession", () => {
    function bundle() {
        return {
            profileStore: new InMemoryProfileStore(),
            scheduleStore: new InMemoryScheduleStore(),
            chatHistoryStore: new InMemoryChatHistoryStore(),
            sessionStore: new InMemorySessionStore(),
        };
    }
    const claims = (sub: string) => ({ sub, email: `${sub}@nyu.edu`, iat: Math.floor(Date.now() / 1000) - 5 });
    const audit = { pendingMutationId: "p", field: "homeSchool" as const, before: null, after: "cas", confirmedAt: new Date().toISOString() };
    const message = { role: "user" as const, content: "hi", createdAt: new Date().toISOString() };

    it("passes writes through while the session is live", async () => {
        const inner = bundle();
        const fenced = fenceStoresForSession(inner, claims("fence_live"));
        await fenced.profileStore.persistMutation(makeProfile("fence_live"), audit, makeDpr());
        await fenced.chatHistoryStore.appendMessage("fence_live", message);
        expect(await inner.profileStore.get("fence_live")).not.toBeNull();
        expect(await inner.chatHistoryStore.loadRecentMessages("fence_live")).toHaveLength(1);
    });

    it("refuses every write once the session is revoked, leaving the inner stores untouched", async () => {
        const inner = bundle();
        const fenced = fenceStoresForSession(inner, claims("fence_dead"));
        await recordSessionRevocation(null, "fence_dead", new Date());

        const writes: Array<() => Promise<unknown>> = [
            () => fenced.profileStore.persistMutation(makeProfile("fence_dead"), audit, makeDpr()),
            () => fenced.scheduleStore.persistSchedule("fence_dead", makeFeasibleSchedule("fence_dead"), "fp"),
            () => fenced.scheduleStore.persistPreferences("fence_dead", {} as never),
            () => fenced.scheduleStore.clearScheduleForStudent("fence_dead"),
            () => fenced.chatHistoryStore.appendMessage("fence_dead", message),
            () => fenced.chatHistoryStore.clearForStudent("fence_dead"),
            () => fenced.sessionStore.appendSummary("fence_dead", { date: "2026-10-08", summary: "s" }),
            () => fenced.sessionStore.replace({ studentId: "fence_dead", sessionSummaries: [] }),
        ];
        for (const write of writes) {
            await expect(write()).rejects.toBeInstanceOf(SessionRevokedError);
        }
        expect(await inner.profileStore.get("fence_dead")).toBeNull();
        expect(await inner.scheduleStore.loadLatestSchedule("fence_dead")).toBeNull();
        expect(await inner.chatHistoryStore.loadRecentMessages("fence_dead")).toEqual([]);
        expect((await inner.sessionStore.get("fence_dead")).sessionSummaries).toEqual([]);
    });

    it("still serves reads after the revocation", async () => {
        const inner = bundle();
        const fenced = fenceStoresForSession(inner, claims("fence_read"));
        await recordSessionRevocation(null, "fence_read", new Date());
        expect(await fenced.profileStore.get("fence_read")).toBeNull();
        expect(await fenced.chatHistoryStore.loadRecentMessages("fence_read")).toEqual([]);
    });
});
