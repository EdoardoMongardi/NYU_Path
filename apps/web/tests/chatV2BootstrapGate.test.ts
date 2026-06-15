// ============================================================
// P3.2 — bootstrap profile persist is gated to initial onboarding
// ============================================================
// The /api/chat/v2 route persists the body-DPR-derived StudentProfile at
// "session bootstrap" so a refresh / new login can restore via
// /api/session/restore. Before P3.2 it ran that upsert on EVERY message
// (whenever `parsedDpr && userId !== "anonymous"`). Because `student` is
// rebuilt from the re-sent body DPR each turn, a profile a prior
// `confirm_profile_update` wrote (a confirmed edit) got OVERWRITTEN by
// the body-derived profile on the very next message — and a synthetic
// audit row was appended every message.
//
// P3.2 gates the upsert to run ONLY when no persisted profile exists yet
// (`profileStore.get(userId) === null`) — i.e. initial onboarding only.
// A confirmed edit is therefore never clobbered, and there is no
// per-message audit-row spam.
//
// NOTE (scope): this is the WRITE-path fix only. The live session still
// uses the body-derived profile for the turn — reading the persisted
// profile INTO session.student each turn is Phase-4 full hydration,
// explicitly out of scope here.
//
// Harness mirrors chatV2Hydration.test.ts: resetStoresForTests() in
// beforeEach, vi.mock("@nyupath/engine", importOriginal) stubbing
// runAgentTurnStreaming (no real LLM), fake API keys,
// validDprPayload() parse, NON-ambiguous message, userId in the body,
// drain the SSE.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    parseDpr,
    type ChatTurnResult,
} from "@nyupath/engine";
import type { StudentProfile } from "@nyupath/shared";
import { getStores, resetStoresForTests } from "../lib/db/store";

// ------------------------------------------------------------
// Mock ONLY the streaming agent loop (see chatV2Hydration.test.ts). The
// stub yields a minimal `ok` ChatTurnResult so the route reaches `done`
// WITHOUT a real LLM. Every other engine export stays real.
// ------------------------------------------------------------
vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        runAgentTurnStreaming: async function* () {
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

// DPR payload — reuse the shared redacted fixture (matches chatV2Hydration).
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

const NON_AMBIGUOUS_MESSAGE =
    "What courses should I take next semester for my computer science major?";

describe("v2 route bootstrap profile persist gate (P3.2)", () => {
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
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-bootstrap-gate";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-bootstrap-gate";
        resetStoresForTests();
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

    it("does NOT clobber a confirmed profile edit on a subsequent message", async () => {
        const userId = "bootstrap-gate-confirmed-edit";

        const stores = getStores({});

        // Seed a CONFIRMED profile edit with a DISTINCTIVE field that
        // DIFFERS from what buildStudentProfileFromDpr(bodyDPR) would
        // produce: a different homeSchool ("stern" — the fixture DPR is a
        // CAS student, so the body-derived profile would carry "cas") and
        // an extra declared program a confirm_profile_update added.
        const editedProfile: StudentProfile = {
            id: userId,
            catalogYear: "2024-2025",
            homeSchool: "stern",
            declaredPrograms: [
                { programId: "computer_science", programType: "major" },
                { programId: "business_studies", programType: "minor" },
            ],
            coursesTaken: [],
            genericTransferCredits: 0,
            flags: ["confirmed-edit-marker"],
            visaStatus: "domestic",
        };
        await stores.profileStore.persistMutation(editedProfile, {
            pendingMutationId: "confirmed-edit",
            field: "homeSchool",
            before: "cas",
            after: "stern",
            confirmedAt: new Date().toISOString(),
        });

        // POST a chat turn. Pre-fix the bootstrap upsert overwrites the
        // edited profile with the body-DPR-derived one (homeSchool back to
        // "cas", the marker flag + minor gone). Post-fix the gate skips
        // the upsert because a profile already exists.
        const res = await POST(fakeRequest({
            message: NON_AMBIGUOUS_MESSAGE,
            parsedData: validDprPayload(),
            userId,
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const stored = await stores.profileStore.get(userId);
        expect(stored).not.toBeNull();
        // The confirmed edit MUST survive untouched.
        expect(stored!.homeSchool).toBe("stern");
        expect(stored!.flags).toContain("confirmed-edit-marker");
        expect(
            stored!.declaredPrograms.some(
                p => p.programId === "business_studies" && p.programType === "minor",
            ),
        ).toBe(true);
    });

    it("still persists a body-derived profile on initial onboarding (no prior profile)", async () => {
        // Positive control — the original reason the bootstrap exists.
        // A userId with NO persisted profile must still get one written
        // so a refresh / login can restore via /api/session/restore.
        const userId = "bootstrap-gate-first-onboarding";

        const stores = getStores({});
        // Nothing persisted yet.
        expect(await stores.profileStore.get(userId)).toBeNull();

        const res = await POST(fakeRequest({
            message: NON_AMBIGUOUS_MESSAGE,
            parsedData: validDprPayload(),
            userId,
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        // Initial onboarding STILL persists the body-derived profile.
        const stored = await stores.profileStore.get(userId);
        expect(stored).not.toBeNull();
        expect(stored!.id).toBe(userId);
    });

    it("does NOT append a per-message audit row for an already-onboarded user", async () => {
        // The bootstrap previously appended one synthetic audit row PER
        // message. After the gate, an already-onboarded user's second
        // message must not grow the audit log.
        const userId = "bootstrap-gate-no-audit-spam";

        const stores = getStores({});
        // In-memory store exposes a test-only audit log.
        const profileStore = stores.profileStore as unknown as {
            auditLog: unknown[];
        };

        // First message — initial onboarding persists (one audit row).
        const res1 = await POST(fakeRequest({
            message: NON_AMBIGUOUS_MESSAGE,
            parsedData: validDprPayload(),
            userId,
        }) as never);
        await drainSse(res1);
        const auditLenAfterFirst = profileStore.auditLog.length;
        expect(auditLenAfterFirst).toBeGreaterThan(0);

        // Second message — profile already exists, so the gated bootstrap
        // must NOT append another audit row.
        const res2 = await POST(fakeRequest({
            message: NON_AMBIGUOUS_MESSAGE,
            parsedData: validDprPayload(),
            userId,
        }) as never);
        await drainSse(res2);
        expect(profileStore.auditLog.length).toBe(auditLenAfterFirst);
    });
});
