// ============================================================
// Phase 16 Task B — /api/onboard/refresh-dpr route tests
// ============================================================
// Validates the four contract paths:
//   - missing auth → 401
//   - same DPR re-uploaded → fingerprint matches → no-op (`changed: false`)
//   - DPR with at least one new completion → fingerprint differs →
//     stored schedule cleared + replanned + persisted; pins on the
//     now-completed course are dropped; other prefs survive
//   - bad PDF → 400 with parse error
//
// We mock `unpdf` so the route's `extractText` returns canned
// fixture text without needing a real binary PDF. The DPR parser
// runs for real against the redacted sample; the engine's existing
// `computeDprFingerprint` and `planForwardDegreeTool` are exercised
// end-to-end (no internal mocks).
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import {
    parseDpr,
    computeDprFingerprint,
    InMemoryScheduleStore,
    InMemoryProfileStore,
    type DegreeProgressReport,
} from "@nyupath/engine";
import { resetStoresForTests, getStores } from "../lib/db/store";
import { SESSION_COOKIE } from "../lib/auth/session";
import type { SchedulePreferences, ForwardSchedule } from "@nyupath/shared";

const TEST_SECRET = "test-secret-for-refresh-dpr-route-tests-32+++";

const FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);

// `unpdf` exports `extractText`; we mock it to return the fixture
// text so the route doesn't need a binary PDF on disk. Each test
// rigs the next return value via `setNextExtractedText`.
let nextExtractedText = FIXTURE;
function setNextExtractedText(t: string): void {
    nextExtractedText = t;
}

vi.mock("unpdf", () => ({
    extractText: vi.fn(async () => ({
        text: nextExtractedText,
        totalPages: 9,
    })),
}));

async function issueTestToken(sub: string): Promise<string> {
    return new SignJWT({ email: `${sub}@nyu.edu` })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(new TextEncoder().encode(TEST_SECRET));
}

interface FakeRequest {
    cookies?: { get: (name: string) => { value: string } | undefined };
    headers: { get: (name: string) => string | null };
    formData: () => Promise<FormData>;
}

function makePdfFile(name = "dpr.pdf", bytes = "fake-pdf-bytes-OK-for-test"): File {
    // The route only inspects `.name`, `.arrayBuffer()`, and the
    // mocked unpdf reads from the buffer. Any non-empty buffer works.
    return new File([bytes], name, { type: "application/pdf" });
}

function fakeRequest(cookieValue: string | undefined, file: File | null): FakeRequest {
    const fd = new FormData();
    if (file) fd.append("dpr", file);
    return {
        cookies: cookieValue
            ? { get: (n: string) => (n === SESSION_COOKIE ? { value: cookieValue } : undefined) }
            : { get: () => undefined },
        headers: { get: () => null },
        formData: async () => fd,
    };
}

function loadFixtureDpr(): DegreeProgressReport {
    const r = parseDpr(FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("fixture parse failed");
    return r.report;
}

describe("/api/onboard/refresh-dpr (Phase 16 Task B)", () => {
    const ORIGINAL_SECRET = process.env.SECRET_KEY;
    const ORIGINAL_DB_URL = process.env.DATABASE_URL;

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        process.env.SECRET_KEY = TEST_SECRET;
        resetStoresForTests();
        setNextExtractedText(FIXTURE); // reset to canonical fixture
    });
    afterEach(() => {
        if (ORIGINAL_SECRET === undefined) delete process.env.SECRET_KEY;
        else process.env.SECRET_KEY = ORIGINAL_SECRET;
        if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = ORIGINAL_DB_URL;
        resetStoresForTests();
    });

    it("returns 401 when the request carries no session cookie", async () => {
        const { POST } = await import("../app/api/onboard/refresh-dpr/route");
        const res = await POST(fakeRequest(undefined, makePdfFile()) as never);
        expect(res.status).toBe(401);
    });

    it("returns { changed: false } when the new DPR matches the stored fingerprint (no-op path)", async () => {
        const studentId = "match_student";
        const stores = getStores({});
        const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;

        // Seed a stored schedule with the SAME fingerprint as the
        // one the parser will compute from the fixture.
        const fixtureDpr = loadFixtureDpr();
        const fp = computeDprFingerprint(fixtureDpr);
        const seedSchedule: ForwardSchedule = {
            studentId,
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
        };
        await scheduleStore.persistSchedule(studentId, seedSchedule, fp);

        const { POST } = await import("../app/api/onboard/refresh-dpr/route");
        const token = await issueTestToken(studentId);
        const res = await POST(fakeRequest(token, makePdfFile()) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.changed).toBe(false);

        // Stored schedule survived untouched (same fingerprint, no
        // supersede-and-replace on no-op).
        const after = await scheduleStore.loadLatestSchedule(studentId);
        expect(after).not.toBeNull();
        expect(after!.dprFingerprint).toBe(fp);
        expect(after!.schedule.computedAt).toBe(seedSchedule.computedAt);
    });

    it("clears the stored schedule, prunes pins on now-completed courses, and re-plans on fingerprint mismatch", async () => {
        const studentId = "mismatch_student";
        const stores = getStores({});
        const profileStore = stores.profileStore as InMemoryProfileStore;
        const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;

        // Seed a profile so the route's persist path has a target.
        await profileStore.persistMutation(
            {
                id: studentId,
                catalogYear: "2024-2025",
                homeSchool: "cas",
                declaredPrograms: [{ programId: "computer_science", programType: "major" }],
                coursesTaken: [],
                genericTransferCredits: 0,
                flags: [],
                visaStatus: "domestic",
            },
            { pendingMutationId: "pm_seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
        );

        // Seed a stored schedule under a DIFFERENT fingerprint so the
        // mismatch branch fires.
        await scheduleStore.persistSchedule(
            studentId,
            { studentId, homeSchoolId: "cas", graduationTerm: "2027-spring", creditTargetPerSemester: 16, f1Floor: null, domesticPartTimeFloor: 8, graduationCreditMinimum: 128, degreeCreditsMet: true, semesters: [], dprCourseHistoryHash: "old:hash", computedAt: 1, feasibility: { feasible: true, constraintViolations: [], placementRationale: {} }, state: "valid-clean" as const, balanceScore: 0, assumptions: [] },
            "old_fingerprint_does_not_match",
        );

        // Seed prefs with TWO pins:
        //   - "CSCI-UA 102" — appears as completed in the fixture →
        //     should be pruned.
        //   - "CSCI-UA 9999" — never appears anywhere → must survive.
        const prefs: SchedulePreferences = {
            loadStyle: "balanced",
            pins: [
                { courseId: "CSCI-UA 102", term: "2027-spring" },
                { courseId: "CSCI-UA 9999", term: "2027-spring" },
            ],
        };
        await scheduleStore.persistPreferences(studentId, prefs);

        const { POST } = await import("../app/api/onboard/refresh-dpr/route");
        const token = await issueTestToken(studentId);
        const res = await POST(fakeRequest(token, makePdfFile()) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.changed).toBe(true);
        expect(json.schedule).toBeDefined();
        expect(json.state).toBeDefined();

        // The new schedule must be persisted (replacing the old fp).
        const after = await scheduleStore.loadLatestSchedule(studentId);
        expect(after).not.toBeNull();
        expect(after!.dprFingerprint).not.toBe("old_fingerprint_does_not_match");

        // Pins were pruned: completed course gone; uncompleted survives.
        const afterPrefs = await scheduleStore.loadPreferences(studentId);
        expect(afterPrefs).not.toBeNull();
        expect(afterPrefs!.loadStyle).toBe("balanced"); // unrelated field survives
        const remainingPins = (afterPrefs!.pins ?? []).map((p) => p.courseId);
        expect(remainingPins).not.toContain("CSCI-UA 102"); // pruned
        expect(remainingPins).toContain("CSCI-UA 9999"); // survived

        // The parsed DPR must be persisted onto students.parsed_dpr so
        // the next /api/session/restore returns it.
        const restoredDpr = await profileStore.getParsedDpr(studentId);
        expect(restoredDpr).not.toBeNull();
    });

    it("returns 400 when the uploaded PDF cannot be parsed by parseDpr", async () => {
        // Rig the unpdf mock to return text that the DPR parser
        // cannot recognize as a DPR (random non-DPR content).
        setNextExtractedText("Random text that is NOT a Degree Progress Report.");
        const { POST } = await import("../app/api/onboard/refresh-dpr/route");
        const token = await issueTestToken("bad_pdf_student");
        const res = await POST(fakeRequest(token, makePdfFile()) as never);
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toMatch(/parse failed/i);
    });
});
