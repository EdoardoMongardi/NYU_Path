// ============================================================
// F2 — DPR-derived field enforcement (read-only + agent re-upload redirect)
// ============================================================
// Owner decision #1 (Docs/plans/34-2026-06-16-phase4-pre-merge-followups.md):
// Fields the DPR shows DETERMINISTICALLY — home school, declared
// major/minor, catalog year, courses taken, grades — CANNOT be changed
// via the wizard or by asking the agent. To change one the student
// uploads a corrected/new DPR. The ONLY editable identity/profile cases:
//   - home school when the DPR can't determine it (deriveHomeSchool →
//     "unknown");
//   - visa status (never on a DPR);
//   - preferences.
//
// This file covers the home-school ROUTE GATE + the wizard's
// confident-vs-unknown signal:
//   (a) a body.homeSchool override AGAINST a DPR that CONFIDENTLY derives
//       a DIFFERENT school is IGNORED + NOT persisted (read-only field);
//   (b) the SAME override AGAINST a DPR that derives "unknown" IS
//       persisted (the legitimate fallback — the DPR can't show it);
//   (c) the wizard proposal exposes confident-vs-unknown so the
//       Confirm-profile step can render read-only when confident.
//
// RED before GREEN:
//   - the route does not yet gate the override on "the DPR derivation was
//     unknown" → (a) fails (the override IS wrongly persisted today);
//   - computeHomeSchoolProposal does not yet expose `derivedFromDpr` →
//     the wizard-signal test fails to read the flag.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr, type ChatTurnResult } from "@nyupath/engine";
import type { DegreeProgressReport } from "@nyupath/engine";
import type { StudentProfile } from "@nyupath/shared";
import { computeHomeSchoolProposal } from "../lib/wizard/homeSchool";
import { getStores, resetStoresForTests } from "../lib/db/store";

// ------------------------------------------------------------
// DPR fixtures — the shared redacted fixture confidently derives "cas";
// a synthesized variant derives "unknown" (no school indicator).
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
// (c) Wizard confident-vs-unknown signal — the Confirm-profile step
//     branches on this to render read-only (confident) vs editable
//     (unknown).
// =====================================================================
describe("computeHomeSchoolProposal — exposes confident-vs-unknown (F2)", () => {
    it("a confidently-derived DPR → derivedFromDpr:true (read-only branch)", () => {
        const proposal = computeHomeSchoolProposal(loadDpr());
        expect(proposal.derivedFromDpr).toBe(true);
        expect(proposal.needsPrompt).toBe(false);
        expect(proposal.proposed).toBe("cas");
    });

    it("an unknown-deriving DPR → derivedFromDpr:false (editable picker branch)", () => {
        const proposal = computeHomeSchoolProposal(makeUnderivableDpr());
        expect(proposal.derivedFromDpr).toBe(false);
        expect(proposal.needsPrompt).toBe(true);
        expect(proposal.proposed).toBeNull();
    });
});

// =====================================================================
// (a)/(b) ROUTE GATE — only persist a body.homeSchool override when the
//         DPR could NOT determine the school ("unknown").
// =====================================================================

const holder = vi.hoisted(() => ({ session: undefined as unknown }));

vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        runAgentTurnStreaming: async function* (...args: unknown[]) {
            holder.session = args[2];
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: "Noted.",
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

function casDprPayload(): { kind: "dpr"; report: unknown } {
    // The shared fixture confidently derives "cas".
    return { kind: "dpr", report: loadDpr() };
}

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

describe("v2 route — DPR-derived home school is read-only (F2)", () => {
    const ORIGINAL = {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        dbUrl: process.env.DATABASE_URL,
        sessionPath: process.env.NYUPATH_SESSION_STORE_PATH,
    };

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        delete process.env.NYUPATH_SESSION_STORE_PATH;
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-f2";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-f2";
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

    it("(a) IGNORES + does NOT persist a body.homeSchool override when the DPR confidently derives a DIFFERENT school", async () => {
        const userId = "f2-confident-derive";
        // The DPR confidently derives "cas"; the persisted profile is "cas".
        await seedConfirmedProfile(userId, { homeSchool: "cas" });

        const stores = getStores({});
        const before = (stores.profileStore as unknown as { auditLog: unknown[] }).auditLog.length;

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: casDprPayload(),
            userId,
            homeSchool: "stern", // attempted override against a CAS-deriving DPR
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        // No change-persist row written — a DPR-derived field can't be overridden.
        const after = (stores.profileStore as unknown as { auditLog: unknown[] }).auditLog.length;
        expect(after).toBe(before);
        // The persisted profile is UNCHANGED — still the DPR-derived "cas".
        expect((await stores.profileStore.get(userId))?.homeSchool).toBe("cas");
        // The override never threaded into the session's student profile —
        // the DPR-derived value is used.
        const threaded = (holder.session as { student?: { homeSchool?: string } } | undefined)?.student?.homeSchool;
        expect(threaded).toBe("cas");
    });

    it("(b) PERSISTS a body.homeSchool override when the DPR could NOT determine the school (unknown fallback)", async () => {
        const userId = "f2-unknown-derive";
        // The DPR derives "unknown"; the persisted profile carries the
        // student's earlier confirmed pick ("unknown" — not yet chosen).
        await seedConfirmedProfile(userId, { homeSchool: "unknown" });

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: unknownDprPayload(),
            userId,
            homeSchool: "shanghai", // legitimate pick — the DPR can't show the school
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const stores = getStores({});
        // The legitimate fallback override IS persisted + threaded.
        expect((await stores.profileStore.get(userId))?.homeSchool).toBe("shanghai");
        const threaded = (holder.session as { student?: { homeSchool?: string } } | undefined)?.student?.homeSchool;
        expect(threaded).toBe("shanghai");
    });

    it("visaStatus correction still persists (non-DPR field stays editable)", async () => {
        const userId = "f2-visa-still-editable";
        await seedConfirmedProfile(userId, { homeSchool: "cas", visaStatus: "domestic" });

        const res = await POST(fakeRequest({
            message: "What courses should I take next semester for my major?",
            parsedData: casDprPayload(),
            userId,
            visaStatus: "f1",
        }) as never);
        expect(res.status).toBe(200);
        await drainSse(res);

        const stores = getStores({});
        expect((await stores.profileStore.get(userId))?.visaStatus).toBe("f1");
    });
});
