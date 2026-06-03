// ============================================================
// Phase 16 Task A — InMemoryScheduleStore + pruneCompletedPins
// ============================================================
// The Postgres impl mirrors the same semantics; if these tests pass
// the route layer can swap implementations without behavior drift.
// ============================================================

import { describe, expect, it, beforeEach } from "vitest";
import {
    InMemoryScheduleStore,
    pruneCompletedPins,
} from "../../src/persistence/scheduleStore.js";
import type {
    ForwardSchedule,
    SchedulePreferences,
} from "@nyupath/shared";

// ---- Minimal ForwardSchedule fixture builder ----
// We only exercise persistence here; the planner's invariants are
// covered by the buildForwardSchedule + solver test suites.
function mkSchedule(overrides: Partial<ForwardSchedule> = {}): ForwardSchedule {
    return {
        studentId: "test_student_1",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 6,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "test:hash",
        computedAt: Date.now(),
        feasibility: {
            feasible: true,
            constraintViolations: [],
            unmetRequirements: [],
        },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
        ...overrides,
    } as ForwardSchedule;
}

describe("InMemoryScheduleStore — schedule persistence", () => {
    let store: InMemoryScheduleStore;
    beforeEach(() => {
        store = new InMemoryScheduleStore();
    });

    it("round-trips a schedule + fingerprint via persist + loadLatest", async () => {
        const schedule = mkSchedule();
        await store.persistSchedule("stud_1", schedule, "fp_v1");
        const loaded = await store.loadLatestSchedule("stud_1");
        expect(loaded).not.toBeNull();
        expect(loaded!.dprFingerprint).toBe("fp_v1");
        expect(loaded!.schedule.studentId).toBe("test_student_1");
        expect(loaded!.schedule.graduationTerm).toBe("2027-spring");
    });

    it("returns null when no schedule has been persisted", async () => {
        const loaded = await store.loadLatestSchedule("never-persisted");
        expect(loaded).toBeNull();
    });

    it("supersedes prior rows so loadLatestSchedule returns only the live one", async () => {
        const oldSchedule = mkSchedule({ computedAt: 1000, graduationTerm: "2027-fall" });
        await store.persistSchedule("stud_1", oldSchedule, "fp_old");
        const newSchedule = mkSchedule({ computedAt: 2000, graduationTerm: "2027-spring" });
        await store.persistSchedule("stud_1", newSchedule, "fp_new");
        const loaded = await store.loadLatestSchedule("stud_1");
        expect(loaded!.dprFingerprint).toBe("fp_new");
        expect(loaded!.schedule.graduationTerm).toBe("2027-spring");
    });

    it("isolates schedules by studentId", async () => {
        const s1 = mkSchedule({ graduationTerm: "2027-spring" });
        const s2 = mkSchedule({ graduationTerm: "2028-spring" });
        await store.persistSchedule("stud_a", s1, "fp_a");
        await store.persistSchedule("stud_b", s2, "fp_b");
        const a = await store.loadLatestSchedule("stud_a");
        const b = await store.loadLatestSchedule("stud_b");
        expect(a!.schedule.graduationTerm).toBe("2027-spring");
        expect(b!.schedule.graduationTerm).toBe("2028-spring");
    });

    it("clearScheduleForStudent wipes the live row + history", async () => {
        await store.persistSchedule("stud_1", mkSchedule(), "fp_1");
        await store.persistSchedule("stud_1", mkSchedule(), "fp_2");
        await store.clearScheduleForStudent("stud_1");
        const loaded = await store.loadLatestSchedule("stud_1");
        expect(loaded).toBeNull();
    });

    it("clearScheduleForStudent does NOT touch other students", async () => {
        await store.persistSchedule("stud_a", mkSchedule(), "fp_a");
        await store.persistSchedule("stud_b", mkSchedule(), "fp_b");
        await store.clearScheduleForStudent("stud_a");
        const a = await store.loadLatestSchedule("stud_a");
        const b = await store.loadLatestSchedule("stud_b");
        expect(a).toBeNull();
        expect(b).not.toBeNull();
        expect(b!.dprFingerprint).toBe("fp_b");
    });
});

describe("InMemoryScheduleStore — preferences", () => {
    let store: InMemoryScheduleStore;
    beforeEach(() => {
        store = new InMemoryScheduleStore();
    });

    it("round-trips preferences via persist + load", async () => {
        const prefs: SchedulePreferences = {
            loadStyle: "balanced",
            includeSummer: false,
            pins: [{ courseId: "CSCI-UA 421", term: "2027-spring" }],
        };
        await store.persistPreferences("stud_1", prefs);
        const loaded = await store.loadPreferences("stud_1");
        expect(loaded).toEqual(prefs);
    });

    it("returns null when no preferences have been persisted", async () => {
        const loaded = await store.loadPreferences("never-persisted");
        expect(loaded).toBeNull();
    });

    it("upserts preferences (latest write wins)", async () => {
        await store.persistPreferences("stud_1", { loadStyle: "frontload" });
        await store.persistPreferences("stud_1", { loadStyle: "backload" });
        const loaded = await store.loadPreferences("stud_1");
        expect(loaded!.loadStyle).toBe("backload");
    });
});

// ============================================================
// pruneCompletedPins — pure helper
// ============================================================

describe("pruneCompletedPins", () => {
    it("drops pins whose courseId is in the completed set", () => {
        const prefs: SchedulePreferences = {
            loadStyle: "balanced",
            pins: [
                { courseId: "CSCI-UA 421", term: "2027-spring" },
                { courseId: "MATH-UA 251", term: "2027-fall" },
            ],
        };
        const out = pruneCompletedPins(prefs, new Set(["CSCI-UA 421"]));
        expect(out.pins).toEqual([{ courseId: "MATH-UA 251", term: "2027-fall" }]);
    });

    it("keeps loadStyle, exclusions, and other fields untouched", () => {
        const prefs: SchedulePreferences = {
            loadStyle: "frontload",
            includeSummer: true,
            includeJTerm: false,
            allowBelowF1Floor: false,
            exclusions: [{ courseId: "PHIL-UA 1", term: "2027-fall" }],
            schedulingPreferences: { avoidConsecutiveLongBlocks: true },
            pins: [{ courseId: "CSCI-UA 421", term: "2027-spring" }],
        };
        const out = pruneCompletedPins(prefs, new Set(["CSCI-UA 421"]));
        expect(out.loadStyle).toBe("frontload");
        expect(out.includeSummer).toBe(true);
        expect(out.includeJTerm).toBe(false);
        expect(out.allowBelowF1Floor).toBe(false);
        expect(out.exclusions).toEqual([{ courseId: "PHIL-UA 1", term: "2027-fall" }]);
        expect(out.schedulingPreferences).toEqual({ avoidConsecutiveLongBlocks: true });
    });

    it("returns the same object reference when no pins match (no churn)", () => {
        const prefs: SchedulePreferences = {
            pins: [{ courseId: "CSCI-UA 421", term: "2027-spring" }],
        };
        const out = pruneCompletedPins(prefs, new Set(["UNRELATED-UA 999"]));
        expect(out).toBe(prefs);
    });

    it("drops the pins key entirely when every pin is completed", () => {
        const prefs: SchedulePreferences = {
            loadStyle: "balanced",
            pins: [{ courseId: "CSCI-UA 421", term: "2027-spring" }],
        };
        const out = pruneCompletedPins(prefs, new Set(["CSCI-UA 421"]));
        expect(out.pins).toBeUndefined();
        expect(out.loadStyle).toBe("balanced");
    });

    it("is a no-op when prefs has no pins to start with", () => {
        const prefs: SchedulePreferences = { loadStyle: "balanced" };
        const out = pruneCompletedPins(prefs, new Set(["CSCI-UA 421"]));
        expect(out).toBe(prefs);
    });
});
