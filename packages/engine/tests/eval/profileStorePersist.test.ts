// ============================================================
// Phase 7-B Step 10 — confirm_profile_update persistence tests
// ============================================================
// Verifies the engine-side persistence hook on confirm_profile_update.
// Uses InMemoryProfileStore so the test path stays offline.
// ============================================================

import { describe, expect, it } from "vitest";
import { InMemoryProfileStore } from "../../src/persistence/profileStore.js";
import { confirmProfileUpdateTool, updateProfileTool } from "../../src/agent/index.js";
import type { ToolSession } from "../../src/agent/index.js";
import type { StudentProfile } from "@nyupath/shared";

function buildSession(profileStore?: InMemoryProfileStore): ToolSession {
    const student: StudentProfile = {
        id: "test-student",
        catalogYear: "2025-2026",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
        coursesTaken: [],
        genericTransferCredits: 0,
        flags: [],
        visaStatus: "domestic",
    };
    const session: ToolSession = { student };
    if (profileStore) session.profileStore = profileStore;
    return session;
}

const ctx = (session: ToolSession) => ({
    signal: new AbortController().signal,
    session,
});

describe("confirm_profile_update persistence (Phase 7-B Step 10)", () => {
    it("calls profileStore.persistMutation with the post-mutation profile + audit entry", async () => {
        const store = new InMemoryProfileStore();
        const session = buildSession(store);

        const stage = await updateProfileTool.call(
            { field: "visaStatus", value: "f1" },
            ctx(session),
        );
        await confirmProfileUpdateTool.call(
            { pendingMutationId: stage.pendingMutationId },
            ctx(session),
        );

        expect(session.student!.visaStatus).toBe("f1");
        const persisted = await store.get("test-student");
        expect(persisted).not.toBeNull();
        expect(persisted!.visaStatus).toBe("f1");
        expect(store.auditLog).toHaveLength(1);
        expect(store.auditLog[0]!.field).toBe("visaStatus");
        expect(store.auditLog[0]!.before).toBe("domestic");
        expect(store.auditLog[0]!.after).toBe("f1");
        expect(store.auditLog[0]!.pendingMutationId).toBe(stage.pendingMutationId);
        expect(store.auditLog[0]!.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("works without a ProfileStore (legacy in-memory-only behavior preserved)", async () => {
        const session = buildSession();
        const stage = await updateProfileTool.call(
            { field: "homeSchool", value: "stern" },
            ctx(session),
        );
        const result = await confirmProfileUpdateTool.call(
            { pendingMutationId: stage.pendingMutationId },
            ctx(session),
        );
        expect(result.status).toBe("applied");
        expect(session.student!.homeSchool).toBe("stern");
    });

    it("swallows persistMutation failures without throwing", async () => {
        const session = buildSession();
        session.profileStore = {
            async get() { return null; },
            async persistMutation() { throw new Error("simulated DB outage"); },
        };
        const stage = await updateProfileTool.call(
            { field: "catalogYear", value: "2026-2027" },
            ctx(session),
        );
        const result = await confirmProfileUpdateTool.call(
            { pendingMutationId: stage.pendingMutationId },
            ctx(session),
        );
        expect(result.status).toBe("applied");
        // The in-memory mutation still landed even though the store
        // threw — this is the contract: live session beats persistence.
        expect(session.student!.catalogYear).toBe("2026-2027");
    });
});
