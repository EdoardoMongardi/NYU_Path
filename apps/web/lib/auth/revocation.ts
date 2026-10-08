// ============================================================
// Session revocation (self-serve delete)
// ============================================================
// The session cookie is a stateless 30-day JWT, so wiping a student's
// rows (/api/session/delete) does not end their sessions by itself: a
// later request from another open tab — or a chat turn already in
// flight — would write the account back (every Postgres store write
// upserts the `students` row). Deletion therefore records a per-student
// tombstone (`session_revocations`, no FK so it outlives the row), and:
//   - verifySessionToken rejects any token issued at or before it, so
//     every later request is unauthenticated (session.ts);
//   - the chat route fences its stores for the turn
//     (`fenceStoresForSession`): once the session is revoked, every
//     write throws SessionRevokedError, which the existing no-throw
//     persistence call sites log and swallow.
// A token issued after the tombstone (the student signs in again)
// verifies normally.
//
// Without DATABASE_URL (dev/tests) the tombstones live in this
// process — on `globalThis`, because Next loads route handlers and the
// /chat layout as separate module instances, and the layout must see a
// revocation the delete route recorded. `resetStoresForTests`
// deliberately does not clear them (the delete route calls it).
//
// Residual race: a fenced write that checked the tombstone just before
// the delete committed can still land a moment after it.
// ============================================================

import { eq } from "drizzle-orm";
import type {
    ChatHistoryStore,
    ProfileStore,
    ScheduleStore,
    SessionStore,
} from "@nyupath/engine";
import { getDb, type Database } from "../db/client";
import { sessionRevocations } from "../db/schema";

/** The token fields a revocation check needs. */
export interface RevocableSession {
    sub: string;
    /** JWT `iat`, seconds. A token without one is treated as revoked once
     *  any revocation exists. */
    iat?: number;
}

export class SessionRevokedError extends Error {
    constructor(sub: string, cause?: unknown) {
        super(
            `session for ${sub} is revoked (account deleted) or could not be checked — write refused`,
            cause === undefined ? undefined : { cause },
        );
        this.name = "SessionRevokedError";
    }
}

const REVOCATIONS_KEY = Symbol.for("nyupath.inMemorySessionRevocations");
const inMemoryRevocations: Map<string, Date> = ((globalThis as Record<symbol, unknown>)[
    REVOCATIONS_KEY
] ??= new Map<string, Date>()) as Map<string, Date>;

/** Record that every session `studentId` holds up to `at` is revoked.
 *  Pass the transaction the wipe runs in, or `null` in in-memory mode. */
export async function recordSessionRevocation(
    db: Pick<Database, "insert"> | null,
    studentId: string,
    at: Date,
): Promise<void> {
    if (!db) {
        const prev = inMemoryRevocations.get(studentId);
        if (!prev || prev < at) inMemoryRevocations.set(studentId, at);
        return;
    }
    await db
        .insert(sessionRevocations)
        .values({ studentId, revokedAt: at })
        .onConflictDoUpdate({ target: sessionRevocations.studentId, set: { revokedAt: at } });
}

async function revokedAt(
    studentId: string,
    env: Record<string, string | undefined>,
): Promise<Date | null> {
    const db = getDb(env);
    if (!db) return inMemoryRevocations.get(studentId) ?? null;
    const rows = await db
        .select({ revokedAt: sessionRevocations.revokedAt })
        .from(sessionRevocations)
        .where(eq(sessionRevocations.studentId, studentId))
        .limit(1);
    return rows[0]?.revokedAt ?? null;
}

/** True when the session was issued at or before the student's latest
 *  revocation. Throws when the lookup fails — callers fail closed. */
export async function isSessionRevoked(
    session: RevocableSession,
    env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
    const at = await revokedAt(session.sub, env);
    if (!at) return false;
    // `iat` has one-second resolution: a token minted in the same second
    // as the revocation counts as revoked (the safe side).
    return session.iat === undefined || session.iat * 1000 <= at.getTime();
}

// ---- per-turn store fence ----

const PROFILE_WRITES = ["persistMutation"] as const satisfies ReadonlyArray<keyof ProfileStore>;
const SCHEDULE_WRITES = [
    "persistSchedule",
    "persistPreferences",
    "clearScheduleForStudent",
] as const satisfies ReadonlyArray<keyof ScheduleStore>;
const CHAT_HISTORY_WRITES = ["appendMessage", "clearForStudent"] as const satisfies ReadonlyArray<
    keyof ChatHistoryStore
>;
const SESSION_WRITES = ["appendSummary", "replace"] as const satisfies ReadonlyArray<keyof SessionStore>;

function fenceWrites<T extends object>(
    store: T,
    writes: ReadonlyArray<PropertyKey>,
    assertLive: () => Promise<void>,
): T {
    const writeSet = new Set(writes);
    return new Proxy(store, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== "function") return value;
            if (!writeSet.has(prop)) return value.bind(target);
            return async (...args: unknown[]) => {
                await assertLive();
                return value.apply(target, args);
            };
        },
    });
}

interface FenceableStores {
    profileStore: ProfileStore;
    scheduleStore: ScheduleStore;
    chatHistoryStore: ChatHistoryStore;
    sessionStore: SessionStore;
}

/** The same store bundle, except every write first checks that
 *  `session` hasn't been revoked and throws SessionRevokedError if it
 *  has (or if the check itself fails). Reads pass straight through. */
export function fenceStoresForSession<B extends FenceableStores>(
    stores: B,
    session: RevocableSession,
    env: Record<string, string | undefined> = process.env,
): B {
    const assertLive = async (): Promise<void> => {
        let revoked: boolean;
        try {
            revoked = await isSessionRevoked(session, env);
        } catch (err) {
            throw new SessionRevokedError(session.sub, err);
        }
        if (revoked) throw new SessionRevokedError(session.sub);
    };
    return {
        ...stores,
        profileStore: fenceWrites(stores.profileStore, PROFILE_WRITES, assertLive),
        scheduleStore: fenceWrites(stores.scheduleStore, SCHEDULE_WRITES, assertLive),
        chatHistoryStore: fenceWrites(stores.chatHistoryStore, CHAT_HISTORY_WRITES, assertLive),
        sessionStore: fenceWrites(stores.sessionStore, SESSION_WRITES, assertLive),
    };
}

/** Test-only: forget every in-memory revocation. */
export function resetRevocationsForTests(): void {
    inMemoryRevocations.clear();
}
