// ============================================================
// Phase 7-B Step 7 — store-factory fallback behavior
// ============================================================
// Without DATABASE_URL the factory must return engine-side
// in-memory / file-backed adapters so dev + tests still work.
// ============================================================

import { describe, expect, it, beforeEach } from "vitest";
import {
    InMemoryProfileStore,
    InMemorySessionStore,
    FileBackedSessionStore,
} from "@nyupath/engine";
import { getStores, resetStoresForTests } from "../lib/db/store";
import { issueOtp, verifyOtp } from "../lib/auth/otp";

describe("getStores fallback (Phase 7-B Step 7)", () => {
    beforeEach(() => {
        resetStoresForTests();
    });

    it("returns in-memory adapters when DATABASE_URL and NYUPATH_SESSION_STORE_PATH are unset", () => {
        const stores = getStores({});
        expect(stores.sessionStore).toBeInstanceOf(InMemorySessionStore);
        expect(stores.profileStore).toBeInstanceOf(InMemoryProfileStore);
    });

    it("returns FileBackedSessionStore when NYUPATH_SESSION_STORE_PATH is set (no DATABASE_URL)", () => {
        const stores = getStores({ NYUPATH_SESSION_STORE_PATH: "/tmp/nyupath-test-sessions" });
        expect(stores.sessionStore).toBeInstanceOf(FileBackedSessionStore);
    });

    it("cohortLookup falls back to engine in-memory userInCohort when DB is absent", async () => {
        const stores = getStores({});
        // Default cohort is "alpha" per gate.ts
        expect(await stores.cohortLookup("anonymous")).toBe("alpha");
    });
});

describe("issueOtp / verifyOtp input validation (Phase 7-B Step 11)", () => {
    it("rejects non-NYU email at issuance", async () => {
        const result = await issueOtp("user@example.com", {});
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("invalid_email");
    });

    it("rejects non-NYU email at verification", async () => {
        const result = await verifyOtp("user@gmail.com", "123456", {});
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("invalid_email");
    });

    it("returns db_unavailable when DATABASE_URL is unset", async () => {
        const result = await issueOtp("student@nyu.edu", {});
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("db_unavailable");
    });
});
