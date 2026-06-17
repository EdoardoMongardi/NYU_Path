// ============================================================
// snapshotIntegrityGuard.test.ts — G0.2
// ============================================================
// Verifies the snapshot-integrity invariant: a DPR whose
// reportKind === "what_if" (either an Albert What-If PDF
// upload or a future in-memory assumption transform) must
// NEVER be persisted as the authoritative students.parsed_dpr
// snapshot. Only reportKind === "dpr" may be written there.
//
// Tests the guard at two layers:
//  1. The guard helper directly (`assertAuthoritativeDpr`)
//  2. The InMemoryProfileStore (used by tests + no-DB fallback)
// ============================================================

import { describe, it, expect } from "vitest";
import { assertAuthoritativeDpr } from "../lib/db/assertAuthoritativeDpr.js";
import { InMemoryProfileStore, type DegreeProgressReport } from "@nyupath/engine";

// ── minimal DPR fixture builder (local — avoids cross-package test path) ──
function makeDpr(reportKind: "dpr" | "what_if"): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0-test",
            parsedAt: "2026-06-01T00:00:00Z",
            sourceFingerprint: "sha256:aabbcc",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        reportKind,
        header: { studentName: "Test Student", preparedDate: "06/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 64,
            cumulativeGpa: 3.5,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 32,
            passFailUsedUnits: 0,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [],
    };
}

// ── minimal StudentProfile stub ───────────────────────────────
const STUDENT_ID = "u_test_snapshot_guard";
const STUB_PROFILE = {
    id: STUDENT_ID,
    declaredPrograms: [],
    catalogYear: "2024-2025",
    homeSchool: "CAS" as const,
    flags: {},
};
const STUB_AUDIT = {
    pendingMutationId: "pm_test_guard_001",
    field: "homeSchool" as const,
    before: null,
    after: null,
    confirmedAt: new Date().toISOString(),
};

// ── 1. assertAuthoritativeDpr helper ─────────────────────────

describe("assertAuthoritativeDpr", () => {
    it("passes silently for reportKind === 'dpr'", () => {
        const dpr = makeDpr("dpr");
        expect(() => assertAuthoritativeDpr(dpr)).not.toThrow();
    });

    it("throws for reportKind === 'what_if'", () => {
        const dpr = makeDpr("what_if");
        expect(() => assertAuthoritativeDpr(dpr)).toThrowError(
            /refusing to persist a non-authoritative.*what_if.*DPR/i,
        );
    });
});

// ── 2. InMemoryProfileStore — persist chokepoint ─────────────

describe("InMemoryProfileStore.persistMutation", () => {
    it("persists normally when parsedDpr.reportKind === 'dpr'", async () => {
        const store = new InMemoryProfileStore();
        const dpr = makeDpr("dpr");
        // Must not throw
        await expect(
            store.persistMutation(STUB_PROFILE as never, STUB_AUDIT, dpr),
        ).resolves.toBeUndefined();
        // The DPR was stored
        const stored = await store.getParsedDpr!(STUDENT_ID);
        expect(stored).not.toBeNull();
        expect(stored?.reportKind).toBe("dpr");
    });

    it("throws when parsedDpr.reportKind === 'what_if'", async () => {
        const store = new InMemoryProfileStore();
        const whatIfDpr = makeDpr("what_if");
        await expect(
            store.persistMutation(STUB_PROFILE as never, STUB_AUDIT, whatIfDpr),
        ).rejects.toThrowError(/refusing to persist a non-authoritative.*what_if.*DPR/i);
        // Confirm nothing was stored — the guard fires before the write
        const stored = await store.getParsedDpr!(STUDENT_ID);
        expect(stored).toBeNull();
    });

    it("omitting parsedDpr leaves existing DPR intact (no guard triggered)", async () => {
        const store = new InMemoryProfileStore();
        const dpr = makeDpr("dpr");
        // First call — sets the authoritative DPR
        await store.persistMutation(STUB_PROFILE as never, STUB_AUDIT, dpr);
        // Second call — profile-only mutation, no parsedDpr argument
        const STUB_AUDIT_2 = { ...STUB_AUDIT, pendingMutationId: "pm_test_guard_002" };
        await expect(
            store.persistMutation(STUB_PROFILE as never, STUB_AUDIT_2),
        ).resolves.toBeUndefined();
        // Original DPR untouched
        const stored = await store.getParsedDpr!(STUDENT_ID);
        expect(stored?.reportKind).toBe("dpr");
    });
});
