// ============================================================
// Phase 16 Task B — /api/session/restore route tests
// ============================================================
// We hit the route through its POST/GET export (not the full
// Next.js dispatcher) and rely on the in-memory store fallback
// `getStores({})` returns when DATABASE_URL is absent. Auth is
// stubbed by issuing a real HS256 JWT (so we exercise the real
// readSessionFromRequest path, not a mock).
// ============================================================

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SignJWT } from "jose";
import { GET } from "../app/api/session/restore/route";
import { getStores, resetStoresForTests } from "../lib/db/store";
import { SESSION_COOKIE } from "../lib/auth/session";
import {
    InMemoryProfileStore,
    InMemoryScheduleStore,
    InMemoryChatHistoryStore,
    type ChatMessageRecord,
} from "@nyupath/engine";
import type { ForwardSchedule, StudentProfile, SchedulePreferences } from "@nyupath/shared";

const TEST_SECRET = "test-secret-for-session-restore-route-tests-32+";

async function issueTestToken(sub: string, email = `${sub}@nyu.edu`): Promise<string> {
    return new SignJWT({ email })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(new TextEncoder().encode(TEST_SECRET));
}

interface FakeRequest {
    cookies?: { get: (name: string) => { value: string } | undefined };
    headers: { get: (name: string) => string | null };
}

function fakeRequest(cookieValue?: string): FakeRequest {
    return {
        cookies: cookieValue
            ? { get: (n: string) => (n === SESSION_COOKIE ? { value: cookieValue } : undefined) }
            : { get: () => undefined },
        headers: { get: () => null },
    };
}

function mkProfile(id: string): StudentProfile {
    return {
        id,
        catalogYear: "2024-2025",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "computer_science", programType: "major" }],
        coursesTaken: [],
        genericTransferCredits: 0,
        flags: [],
        visaStatus: "domestic",
    };
}

function mkSchedule(overrides: Partial<ForwardSchedule> = {}): ForwardSchedule {
    return {
        studentId: "test_student",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "test:hash",
        computedAt: 1700000000000,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
        ...overrides,
    } as ForwardSchedule;
}

describe("/api/session/restore (Phase 16 Task B)", () => {
    const ORIGINAL_SECRET = process.env.SECRET_KEY;
    const ORIGINAL_DB_URL = process.env.DATABASE_URL;

    beforeEach(() => {
        // Force in-memory mode + a deterministic JWT secret for the
        // duration of this suite. resetStoresForTests() drops the
        // module-cached bundle so the next getStores() rebuilds with
        // a fresh InMemoryStore set.
        delete process.env.DATABASE_URL;
        process.env.SECRET_KEY = TEST_SECRET;
        resetStoresForTests();
    });
    afterEach(() => {
        if (ORIGINAL_SECRET === undefined) delete process.env.SECRET_KEY;
        else process.env.SECRET_KEY = ORIGINAL_SECRET;
        if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = ORIGINAL_DB_URL;
        resetStoresForTests();
    });

    it("returns 401 when the request carries no session cookie", async () => {
        const res = await GET(fakeRequest() as never);
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error).toMatch(/Unauthorized/i);
    });

    it("returns the all-null shape for a new student (no profile, no schedule, empty chat)", async () => {
        const token = await issueTestToken("brand_new_student");
        const res = await GET(fakeRequest(token) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toEqual({
            profile: null,
            dpr: null,
            forwardSchedule: null,
            studentDraftPlan: null,
            schedulePreferences: null,
            chatMessages: [],
        });
    });

    it("hydrates every slot for a returning student (profile + dpr + schedule + prefs + chat in chronological order)", async () => {
        const studentId = "returning_student";
        const stores = getStores({}); // forces in-memory adapters
        const profileStore = stores.profileStore as InMemoryProfileStore;
        const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
        const chatHistoryStore = stores.chatHistoryStore as InMemoryChatHistoryStore;

        // Seed: profile + parsed DPR (stored via persistMutation's
        // optional arg added in 16.A)
        const profile = mkProfile(studentId);
        const fakeDpr = { _meta: { warnings: [] }, reportKind: "dpr" as const, header: { studentName: "Test" }, programs: [], advisorNotations: [], cumulative: { creditsRequired: 128, creditsUsed: 64, cumulativeGpa: 3.5, cumulativeGpaRequired: 2.0, residencyRequired: 64, residencyUsed: 64, passFailUsedUnits: 0, passFailCapUnits: 32, outsideHomeUsedUnits: 0, outsideHomeCapUnits: 16, timeLimitYears: 8 }, requirementGroups: [], courseHistory: [] };
        await profileStore.persistMutation(
            profile,
            { pendingMutationId: "pm_test", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fakeDpr as any,
        );

        const schedule = mkSchedule({ graduationTerm: "2027-spring" });
        await scheduleStore.persistSchedule(studentId, schedule, "fp_v1");

        const prefs: SchedulePreferences = { loadStyle: "balanced" };
        await scheduleStore.persistPreferences(studentId, prefs);

        // Three chat messages, chronological. The store is append-only
        // — the route must echo them in insertion order (oldest first).
        const m1: ChatMessageRecord = { role: "user", content: "first", createdAt: "2026-05-04T12:00:00Z" };
        const m2: ChatMessageRecord = { role: "assistant", content: "second", createdAt: "2026-05-04T12:00:01Z", thinkingText: "thought" };
        const m3: ChatMessageRecord = { role: "user", content: "third", createdAt: "2026-05-04T12:00:02Z" };
        await chatHistoryStore.appendMessage(studentId, m1);
        await chatHistoryStore.appendMessage(studentId, m2);
        await chatHistoryStore.appendMessage(studentId, m3);

        const token = await issueTestToken(studentId);
        const res = await GET(fakeRequest(token) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.profile).not.toBeNull();
        expect(json.profile.id).toBe(studentId);
        expect(json.dpr).not.toBeNull();
        expect(json.forwardSchedule).not.toBeNull();
        expect(json.forwardSchedule.graduationTerm).toBe("2027-spring");
        expect(json.studentDraftPlan).toBeNull();
        expect(json.schedulePreferences).toEqual({ loadStyle: "balanced" });
        expect(json.chatMessages.map((m: { content: string }) => m.content)).toEqual(["first", "second", "third"]);
        expect(json.chatMessages[1].thinkingText).toBe("thought");
    });

    it("routes infeasible-draft schedules into studentDraftPlan (Decision #32)", async () => {
        const studentId = "draft_student";
        const stores = getStores({});
        const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
        await scheduleStore.persistSchedule(
            studentId,
            mkSchedule({ state: "infeasible-draft" }),
            "fp_draft",
        );
        const token = await issueTestToken(studentId);
        const res = await GET(fakeRequest(token) as never);
        const json = await res.json();
        expect(json.forwardSchedule).toBeNull();
        expect(json.studentDraftPlan).not.toBeNull();
        expect(json.studentDraftPlan.state).toBe("infeasible-draft");
    });
});
