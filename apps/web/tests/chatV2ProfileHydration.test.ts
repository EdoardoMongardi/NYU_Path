// ============================================================
// E1.2 — per-turn CONFIRMED-PROFILE read-back into session.student
// ============================================================
// The /api/chat/v2 route rebuilds `session.student` from the re-sent
// body DPR on every turn (buildStudentProfileFromDpr). P3.2 deliberately
// deferred the READ side: a confirmed `confirm_profile_update` edit
// (e.g. a corrected homeSchool, declared programs, catalog year, or visa
// status) was persisted to `profileStore` but never read BACK into the
// per-turn `session.student`, so the agent ran blind to the student's
// own confirmed correction.
//
// E1.2 closes that loop: after building `student` from the body DPR, the
// route reads `profileStore.get(userId)` and merges the four mutable
// fields (homeSchool / catalogYear / declaredPrograms / visaStatus —
// exactly the PendingProfileMutation["field"] union) back onto `student`
// BEFORE schoolConfig is loaded, so every school-scoped tool sees the
// confirmed home school (a binding "never silently CAS" concern).
//
// Precedence (freshest explicit signal wins): an explicit value the
// CLIENT sent THIS turn (body.homeSchool / body.visaStatus) beats the
// persisted value, which beats the DPR derivation. The body never sends
// catalogYear / declaredPrograms, so persisted overrides DPR for those.
//
// This suite mirrors chatV2Hydration.test.ts (P3.1): it captures the
// constructed ToolSession via a mock of runAgentTurnStreaming (3rd
// positional arg) and asserts on session.student.
//
// RED before GREEN: with the route un-hydrated, session.student carries
// the DPR-derived homeSchool ("cas") rather than the persisted/confirmed
// value, and the first assertion fails.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr, type ChatTurnResult } from "@nyupath/engine";
import { getStores, resetStoresForTests } from "../lib/db/store";
import type { StudentProfile } from "@nyupath/shared";

// ------------------------------------------------------------
// Capture holder — written by the mocked streaming agent loop. Because
// vi.mock is hoisted above the imports, the holder must be created with
// vi.hoisted so the factory can close over it.
// ------------------------------------------------------------
const holder = vi.hoisted(() => ({
    session: undefined as unknown,
}));

// Mock ONLY the streaming agent loop. `importOriginal` keeps every other
// engine export real (validator / DPR parse / clarifier all run for
// real). The stub records the session it's called with (3rd arg) and
// yields a minimal `ok` ChatTurnResult so the route reaches `done`.
vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        runAgentTurnStreaming: async function* (...args: unknown[]) {
            holder.session = args[2];
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: "Noted — using your confirmed home school.",
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
// canonical onboarding shape (matches chatV2Hydration.test.ts). This
// fixture derives: homeSchool="cas", catalogYear="2024-2025",
// visaStatus="domestic", declaredPrograms=[{computer_science_math,major}].
const DPR_FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);
function validDprPayload(): { kind: "dpr"; report: unknown } {
    const r = parseDpr(DPR_FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("DPR fixture failed to parse");
    return { kind: "dpr", report: r.report };
}

// F2 — a DPR variant whose program labels match NO school indicator, so
// `deriveHomeSchool` degrades to "unknown". This is the ONLY case where a
// body.homeSchool override is honored (the DPR can't determine the school).
function unknownDprPayload(): { kind: "dpr"; report: unknown } {
    const r = parseDpr(DPR_FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("DPR fixture failed to parse");
    return {
        kind: "dpr",
        report: {
            ...r.report,
            programs: [
                {
                    programType: "Major",
                    label: "Some Unknown Program Approved",
                    requirementTerm: "Fall 2024",
                    requirementStatus: "satisfied" as const,
                },
            ],
        },
    };
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

/**
 * Seed a CONFIRMED profile into the in-memory profileStore via the same
 * `persistMutation` write path `confirm_profile_update` uses. The seeded
 * profile carries SENTINEL values that all differ from what the body DPR
 * fixture derives, so the assertions prove the read-back (not the DPR
 * derivation) won.
 */
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
        field: "homeSchool",
        before: null,
        after: profile.homeSchool,
        confirmedAt: new Date().toISOString(),
    });
}

describe("v2 route confirmed-profile read-back into session.student (E1.2)", () => {
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

    it("reads a CONFIRMED homeSchool back into session.student (persisted beats DPR-derived)", async () => {
        const userId = "e12-confirmed-homeschool";
        // Persisted/confirmed homeSchool differs from the DPR derivation
        // ("cas"). The body does NOT send body.homeSchool this turn, so
        // the persisted value must win.
        await seedConfirmedProfile(userId, { homeSchool: "stern" });

        const res = await POST(fakeRequest({
            // NON-ambiguous message — an ambiguous one would trip the
            // clarifier gate and early-return BEFORE runAgentTurnStreaming.
            message: "What courses should I take next semester for my computer science major?",
            parsedData: validDprPayload(),
            userId,
            // deliberately NO homeSchool on the body
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        expect(holder.session).toBeDefined();
        const session = holder.session as { student?: StudentProfile };
        // The DPR derives "cas"; the read-back must surface the confirmed "stern".
        expect(session.student?.homeSchool).toBe("stern");
    });

    it("reads CONFIRMED catalogYear, declaredPrograms, and visaStatus back into session.student", async () => {
        const userId = "e12-confirmed-multi";
        await seedConfirmedProfile(userId, {
            catalogYear: "2022-2023",
            declaredPrograms: [{ programId: "economics", programType: "major" }],
            visaStatus: "f1",
        });

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my economics major?",
            parsedData: validDprPayload(),
            userId,
            // no body.visaStatus, no body.homeSchool
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const session = holder.session as { student?: StudentProfile };
        // All three differ from the DPR derivation
        // (2024-2025 / computer_science_math / domestic).
        expect(session.student?.catalogYear).toBe("2022-2023");
        expect(session.student?.declaredPrograms?.[0]?.programId).toBe("economics");
        expect(session.student?.visaStatus).toBe("f1");
    });

    it("F2 — IGNORES a body.homeSchool override when the DPR confidently derives a school (DPR-derived = read-only)", async () => {
        const userId = "e12-body-ignored-homeschool";
        // The DPR confidently derives "cas". A body.homeSchool="tandon"
        // override must be IGNORED under owner decision #1: home school is a
        // DPR-derived field, so the DPR value wins (to change it the student
        // uploads a corrected DPR).
        await seedConfirmedProfile(userId, { homeSchool: "cas" });

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my engineering major?",
            parsedData: validDprPayload(),
            userId,
            homeSchool: "tandon",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const session = holder.session as { student?: StudentProfile };
        expect(session.student?.homeSchool).toBe("cas");
    });

    it("F2 — body.homeSchool wins ONLY when the DPR can't determine the school (unknown fallback)", async () => {
        const userId = "e12-body-wins-unknown";
        // The DPR derives "unknown"; the body explicitly picks "tandon" — the
        // legitimate editable home-school case. The override must win.
        await seedConfirmedProfile(userId, { homeSchool: "unknown" });

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my engineering major?",
            parsedData: unknownDprPayload(),
            userId,
            homeSchool: "tandon",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const session = holder.session as { student?: StudentProfile };
        expect(session.student?.homeSchool).toBe("tandon");
    });

    it("body.visaStatus (explicit THIS-turn signal) beats the persisted value", async () => {
        const userId = "e12-body-wins-visa";
        // Persisted says "f1", but the client explicitly sends "domestic"
        // THIS turn — the freshest explicit signal must win.
        await seedConfirmedProfile(userId, { visaStatus: "f1" });

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my computer science major?",
            parsedData: validDprPayload(),
            userId,
            visaStatus: "domestic",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const session = holder.session as { student?: StudentProfile };
        expect(session.student?.visaStatus).toBe("domestic");
    });

    it("is a no-op when nothing is persisted (DPR-derived values survive)", async () => {
        const userId = "e12-no-persisted-profile";
        // Persist NOTHING — the read-back must leave the DPR-derived
        // values untouched and the turn must still complete.

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my computer science major?",
            parsedData: validDprPayload(),
            userId,
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const session = holder.session as { student?: StudentProfile };
        // The DPR derivation stands.
        expect(session.student?.homeSchool).toBe("cas");
        expect(session.student?.catalogYear).toBe("2024-2025");
    });

    it("skips the read-back for the anonymous user (no throw, DPR-derived survives)", async () => {
        // The literal "anonymous" id has no durable store row; the
        // read-back must be guarded just like the bootstrap persist.
        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my computer science major?",
            parsedData: validDprPayload(),
            userId: "anonymous",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        expect(holder.session).toBeDefined();
        const session = holder.session as { student?: StudentProfile };
        // No persisted read happened; DPR derivation stands and nothing threw.
        expect(session.student?.homeSchool).toBe("cas");
    });
});
