// ============================================================
// E5.3 — correcting_data PERSISTS (visa-status correction survives the turn)
// ============================================================
// A confirmed profile correction must be WRITTEN to the profile store so
// it survives the next turn (and is read back by E1.2). E5.2 established
// the route-side correction-persist for `homeSchool`; E5.3 generalizes it
// to `visaStatus` — the next correctable field the v2 body carries.
//
// The legacy `/api/chat` `correcting_data` step (route.ts:112-130) only
// returns a canned ack and STORES NOTHING — that is the documented no-op
// the wizard path FIXES, and this suite CONTRASTS the two:
//   - the v2 route persists a CHANGED visaStatus and reads it back;
//   - the legacy route returns the ack and writes NOTHING to profileStore.
//
// RED before GREEN:
//   - the v2 route does not yet capture `persistedVisaStatus`, read it
//     back, or persist a profile-EXISTS-and-CHANGED visa correction →
//     the persist + read-back tests fail.
//   - the legacy-route contrast asserts the existing no-op (already true)
//     so it documents the gap the v2 path closes.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr, type ChatTurnResult } from "@nyupath/engine";
import type { DegreeProgressReport } from "@nyupath/engine";
import type { StudentProfile } from "@nyupath/shared";
import { getStores, resetStoresForTests } from "../lib/db/store";

// ------------------------------------------------------------
// DPR fixture — reuse the shared redacted fixture (mirrors
// homeSchoolConfirm.test.ts's route harness).
// ------------------------------------------------------------
const FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);

function loadDpr(): DegreeProgressReport {
    const r = parseDpr(FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("DPR fixture failed to parse");
    return r.report;
}

// ---- Mock the agent loop so the route returns immediately ----
// Capture the session the route built so the read-back assertions can
// inspect `session.student.visaStatus` directly.
const holder = vi.hoisted(() => ({ session: undefined as unknown }));

vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        runAgentTurnStreaming: async function* (...args: unknown[]) {
            holder.session = args[2];
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: "Noted — using your confirmed visa status.",
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

// Import the routes AFTER the mock so the v2 route binds the mocked engine
// export. The legacy route does NOT use runAgentTurnStreaming (it is a pure
// canned-ack state machine) — importing it here is harmless.
import { POST as POST_V2 } from "../app/api/chat/v2/route";
import { POST as POST_LEGACY } from "../app/api/chat/route";

function validDprPayload(): { kind: "dpr"; report: unknown } {
    return { kind: "dpr", report: loadDpr() };
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

async function seedConfirmedProfile(
    userId: string,
    overrides: Partial<StudentProfile>,
): Promise<void> {
    const stores = getStores({});
    const profile: StudentProfile = {
        id: userId,
        catalogYear: "2024-2025",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "computer_science_math", programType: "major" }],
        coursesTaken: [],
        genericTransferCredits: 0,
        flags: [],
        visaStatus: "domestic",
        ...overrides,
    };
    await stores.profileStore.persistMutation(profile, {
        pendingMutationId: "seed-confirmed",
        field: "visaStatus",
        before: null,
        after: profile.visaStatus,
        confirmedAt: new Date().toISOString(),
    });
}

describe("v2 route persists an explicit visaStatus CHANGE (E5.3)", () => {
    const ORIGINAL = {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        dbUrl: process.env.DATABASE_URL,
        sessionPath: process.env.NYUPATH_SESSION_STORE_PATH,
    };

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        delete process.env.NYUPATH_SESSION_STORE_PATH;
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-e53";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-e53";
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
        resetStoresForTests();
        vi.restoreAllMocks();
    });

    it("persists a CHANGED visaStatus from body.visaStatus (profile-exists case) + reads it back", async () => {
        const userId = "e53-change-visa";
        // Persisted profile says "domestic"; the student now corrects to "f1".
        await seedConfirmedProfile(userId, { visaStatus: "domestic" });

        const res = await POST_V2(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: validDprPayload(),
            userId,
            visaStatus: "f1",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const stores = getStores({});
        const persisted = await stores.profileStore.get(userId);
        expect(persisted?.visaStatus).toBe("f1");

        // A NEXT turn that OMITS visaStatus reads the corrected value back
        // into session.student (the E1.2 read-back path). The message is a
        // long, fully-specified question (the "should I" phrasing keeps it
        // first-person, and it carries > 4 content tokens), so `detectAmbiguity`
        // does NOT fire the clarifier short-circuit — the turn always reaches
        // the (mocked) agent loop and `holder.session` is set.
        holder.session = undefined;
        const res2 = await POST_V2(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: validDprPayload(),
            userId,
            // visaStatus intentionally omitted — must be read back.
        }) as never);
        expect(res2.status).toBe(200);
        await drainSse(res2);
        const readBack = (holder.session as { student?: { visaStatus?: string } } | undefined)
            ?.student?.visaStatus;
        expect(readBack).toBe("f1");
    });

    it("is idempotent — an UNCHANGED visaStatus appends no new persist", async () => {
        const userId = "e53-unchanged-visa";
        await seedConfirmedProfile(userId, { visaStatus: "f1" });

        const stores = getStores({});
        const before = (stores.profileStore as unknown as { auditLog: unknown[] }).auditLog.length;

        const res = await POST_V2(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: validDprPayload(),
            userId,
            visaStatus: "f1", // SAME as persisted
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const after = (stores.profileStore as unknown as { auditLog: unknown[] }).auditLog.length;
        // No new change-persist row (profile exists → bootstrap gate skipped;
        // value unchanged → change-persist skipped).
        expect(after).toBe(before);
        expect((await stores.profileStore.get(userId))?.visaStatus).toBe("f1");
    });

    it("does not persist for the anonymous user (no throw)", async () => {
        const res = await POST_V2(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: validDprPayload(),
            userId: "anonymous",
            visaStatus: "f1",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);
        // Nothing threw; the turn completed.
        expect(holder.session).toBeDefined();
    });

    it("CONTRAST: the legacy /api/chat correcting_data step returns the canned ack and writes NOTHING", async () => {
        const userId = "e53-legacy-noop";
        // Seed a profile so we can prove the legacy route leaves it untouched.
        await seedConfirmedProfile(userId, { visaStatus: "domestic" });

        const stores = getStores({});
        const before = (stores.profileStore as unknown as { auditLog: unknown[] }).auditLog.length;

        const res = await POST_LEGACY(fakeRequest({
            message: "My visa is actually F-1, not domestic",
            onboardingStep: "correcting_data",
        }) as never);
        expect(res.status).toBe(200);
        const json = (await res.json()) as { message?: string; onboardingStep?: string };
        // The canned ack — it acknowledges the correction but does NOT store it.
        expect(json.onboardingStep).toBe("correcting_data");
        expect(json.message).toContain("noted that correction");

        // The legacy route wrote NOTHING: the audit log is unchanged and the
        // persisted profile still says "domestic" (the documented no-op the
        // wizard/v2 path fixes).
        const after = (stores.profileStore as unknown as { auditLog: unknown[] }).auditLog.length;
        expect(after).toBe(before);
        expect((await stores.profileStore.get(userId))?.visaStatus).toBe("domestic");
    });
});
