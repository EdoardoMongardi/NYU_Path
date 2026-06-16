// ============================================================
// E5.2 — home-school PROPOSE + confirm (sends body.homeSchool; never silent CAS)
// ============================================================
// The Confirm-profile wizard step PROPOSES the DPR-derived home school
// (via buildStudentProfileFromDpr → deriveHomeSchool) and lets the
// student CONFIRM or OVERRIDE it across all 11 schools + NYU Shanghai +
// NYU Abu Dhabi. The confirmed value is sent as `body.homeSchool` on
// subsequent chat turns AND persisted via `profileStore.persistMutation`
// when it CHANGES an already-persisted profile.
//
// BINDING — NEVER SILENT CAS (core_philosophy.md:4/26): when the DPR
// carries no school indicator, `deriveHomeSchool` degrades to the
// school-agnostic "unknown"; `computeHomeSchoolProposal` MUST turn that
// into a PROMPT ({ proposed:null, needsPrompt:true }) — never auto-pick
// "cas".
//
// RED before GREEN:
//   - apps/web/lib/wizard/homeSchool.ts does not exist yet → the pure
//     helper tests (a)/(c) fail to import.
//   - the v2 route does not yet persist a profile-EXISTS-and-CHANGED
//     home-school correction → the route-level persist test (b) fails.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr, type ChatTurnResult } from "@nyupath/engine";
import type { DegreeProgressReport } from "@nyupath/engine";
import type { StudentProfile } from "@nyupath/shared";
import {
    SCHOOL_OPTIONS,
    computeHomeSchoolProposal,
    isValidSchoolCode,
} from "../lib/wizard/homeSchool";
import { getStores, resetStoresForTests } from "../lib/db/store";

// ------------------------------------------------------------
// DPR fixtures — reuse the shared redacted fixture (derives "cas") and
// synthesize a no-indicator variant for the "never silent CAS" path,
// mirroring homeSchoolDerivation.test.ts.
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

/** A DPR whose program labels match NO school indicator → "unknown". */
function makeUnderivableDpr(): DegreeProgressReport {
    const base = loadDpr();
    return {
        ...base,
        programs: [
            {
                programType: "Major",
                label: "Some Unknown Program Approved",
                requirementTerm: "Fall 2024",
                requirementStatus: "satisfied",
            },
        ],
    };
}

// =====================================================================
// (a) NEVER SILENT CAS — the proposal prompts on an unknown derivation
//     and proposes the real derived school otherwise.
// =====================================================================
describe("computeHomeSchoolProposal — never silent CAS (E5.2)", () => {
    it("no-indicator DPR → prompts (proposed:null, needsPrompt:true) — NOT cas", () => {
        const proposal = computeHomeSchoolProposal(makeUnderivableDpr());
        expect(proposal.needsPrompt).toBe(true);
        expect(proposal.proposed).toBeNull();
        // The binding guard — must never silently pick CAS.
        expect(proposal.proposed).not.toBe("cas");
    });

    it("clear-school DPR (CAS fixture) → proposes that school, no prompt", () => {
        const proposal = computeHomeSchoolProposal(loadDpr());
        expect(proposal.proposed).toBe("cas");
        expect(proposal.needsPrompt).toBe(false);
    });
});

// =====================================================================
// (c) Shanghai + Abu Dhabi (and all 11) are selectable + valid codes.
// =====================================================================
describe("SCHOOL_OPTIONS — all 11 schools incl. global campuses (E5.2)", () => {
    it("includes shanghai + nyuad", () => {
        const codes = SCHOOL_OPTIONS.map((o) => o.code);
        expect(codes).toContain("shanghai");
        expect(codes).toContain("nyuad");
    });

    it("covers all 11 home-school codes", () => {
        const codes = new Set(SCHOOL_OPTIONS.map((o) => o.code));
        for (const c of [
            "cas", "stern", "tandon", "tisch", "steinhardt", "gallatin",
            "liberal_studies", "sps", "nursing", "nyuad", "shanghai",
        ]) {
            expect(codes.has(c)).toBe(true);
        }
        expect(SCHOOL_OPTIONS).toHaveLength(11);
    });

    it("every option carries a non-empty display label", () => {
        for (const o of SCHOOL_OPTIONS) {
            expect(typeof o.label).toBe("string");
            expect(o.label.length).toBeGreaterThan(0);
        }
    });

    it("isValidSchoolCode accepts shanghai/nyuad/cas, rejects junk", () => {
        expect(isValidSchoolCode("shanghai")).toBe(true);
        expect(isValidSchoolCode("nyuad")).toBe(true);
        expect(isValidSchoolCode("cas")).toBe(true);
        expect(isValidSchoolCode("not_a_school")).toBe(false);
        expect(isValidSchoolCode("")).toBe(false);
    });
});

// =====================================================================
// (b) SENT + PERSISTED — body.homeSchool inclusion + a route-level test
//     that an explicit CHANGE persists via persistMutation. Mirrors
//     chatV2ProfileHydration.test.ts (mock runAgentTurnStreaming, seed
//     the in-memory profileStore, POST a turn with a differing
//     body.homeSchool, assert the persisted profile updated).
// =====================================================================

// The request-body shape the chat page builds for handleSendV2 — the
// `homeSchool` field is conditionally spread in only when set, so an
// unset home school never sends a (silent CAS) value.
function buildSendBody(args: {
    message: string;
    parsedData: unknown;
    homeSchool: string | null;
}): Record<string, unknown> {
    return {
        message: args.message,
        parsedData: args.parsedData,
        ...(args.homeSchool ? { homeSchool: args.homeSchool } : {}),
    };
}

describe("send body includes homeSchool only when set (E5.2)", () => {
    it("omits homeSchool when null (never silent CAS)", () => {
        const body = buildSendBody({ message: "hi", parsedData: {}, homeSchool: null });
        expect("homeSchool" in body).toBe(false);
    });

    it("includes the confirmed homeSchool when set", () => {
        const body = buildSendBody({ message: "hi", parsedData: {}, homeSchool: "shanghai" });
        expect(body.homeSchool).toBe("shanghai");
    });
});

// ---- Route-level persist of an explicit CHANGE ----
const holder = vi.hoisted(() => ({ session: undefined as unknown }));

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

function validDprPayload(): { kind: "dpr"; report: unknown } {
    return { kind: "dpr", report: loadDpr() };
}

// F2 — a DPR that derives "unknown" (no school indicator). This is the
// ONLY case where a body.homeSchool override is legitimately accepted +
// persisted: the DPR can't determine the school, so the student picks it.
// (When the DPR confidently derives a school, the override is IGNORED —
// see dprFieldEnforcement.test.ts.)
function unknownDprPayload(): { kind: "dpr"; report: unknown } {
    return { kind: "dpr", report: makeUnderivableDpr() };
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
        field: "homeSchool",
        before: null,
        after: profile.homeSchool,
        confirmedAt: new Date().toISOString(),
    });
}

describe("v2 route persists an explicit home-school CHANGE (E5.2)", () => {
    const ORIGINAL = {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        dbUrl: process.env.DATABASE_URL,
        sessionPath: process.env.NYUPATH_SESSION_STORE_PATH,
    };

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        delete process.env.NYUPATH_SESSION_STORE_PATH;
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-e52";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-e52";
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

    it("persists a CHANGED homeSchool from body.homeSchool (UNKNOWN-deriving DPR — the legitimate override case)", async () => {
        const userId = "e52-change-homeschool";
        // F2: the override is only accepted when the DPR can't determine the
        // school. Persisted profile is the "unknown" fallback; the student
        // picks "stern" at the Confirm-profile step (the DPR-derived-field
        // rule's only editable home-school case).
        await seedConfirmedProfile(userId, { homeSchool: "unknown" });

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: unknownDprPayload(),
            userId,
            homeSchool: "stern",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const stores = getStores({});
        const persisted = await stores.profileStore.get(userId);
        expect(persisted?.homeSchool).toBe("stern");
    });

    it("accepts + persists a Shanghai override (UNKNOWN-deriving DPR)", async () => {
        const userId = "e52-change-shanghai";
        await seedConfirmedProfile(userId, { homeSchool: "unknown" });

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: unknownDprPayload(),
            userId,
            homeSchool: "shanghai",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const stores = getStores({});
        const persisted = await stores.profileStore.get(userId);
        expect(persisted?.homeSchool).toBe("shanghai");
    });

    it("is idempotent — an UNCHANGED home school appends no new persist", async () => {
        const userId = "e52-unchanged-homeschool";
        await seedConfirmedProfile(userId, { homeSchool: "stern" });

        const stores = getStores({});
        // Capture the audit-log length BEFORE the turn (the seed wrote one).
        const before = (stores.profileStore as unknown as { auditLog: unknown[] }).auditLog.length;

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: validDprPayload(),
            userId,
            homeSchool: "stern", // SAME as persisted
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const after = (stores.profileStore as unknown as { auditLog: unknown[] }).auditLog.length;
        // No new change-persist row (the bootstrap gate is skipped because a
        // profile exists, and the change-persist is skipped because the value
        // is unchanged).
        expect(after).toBe(before);
        expect((await stores.profileStore.get(userId))?.homeSchool).toBe("stern");
    });

    it("does not persist for the anonymous user (no throw)", async () => {
        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: validDprPayload(),
            userId: "anonymous",
            homeSchool: "stern",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);
        // Nothing threw; the turn completed.
        expect(holder.session).toBeDefined();
    });

    it("REJECTS a forged/unknown home-school code — never persists or threads it (never silently wrong)", async () => {
        const userId = "e52-forged-homeschool";
        await seedConfirmedProfile(userId, { homeSchool: "stern" });

        const stores = getStores({});
        const before = (stores.profileStore as unknown as { auditLog: unknown[] }).auditLog.length;

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: validDprPayload(),
            userId,
            homeSchool: "hogwarts", // not a known NYU school code
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        // The forged value was dropped: no change-persist row written, and
        // the persisted profile is UNCHANGED (still the real "stern").
        const after = (stores.profileStore as unknown as { auditLog: unknown[] }).auditLog.length;
        expect(after).toBe(before);
        expect((await stores.profileStore.get(userId))?.homeSchool).toBe("stern");
        // The forged value never threaded into the session's student profile.
        const threaded = (holder.session as { student?: { homeSchool?: string } } | undefined)?.student?.homeSchool;
        expect(threaded).not.toBe("hogwarts");
    });
});
