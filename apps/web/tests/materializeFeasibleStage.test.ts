// ============================================================
// materializeFeasibleStage.test.ts — Phase 38 Task E1
// ============================================================
// runMaterializeFeasibleStage — the read-only orchestrator stage the
// /api/v2/materialize route delegates to. Bootstraps the session from
// the store, extracts the target term's specific_planned courses, and
// runs the deterministic materialize_feasible engine. R1: it NEVER
// writes students.parsed_dpr (never persists anything) — verified live.
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { runMaterializeFeasibleStage } from "../lib/planActionOrchestrator";
import { resetStoresForTests, getStores } from "../lib/db/store";
import {
    InMemoryProfileStore,
    InMemoryScheduleStore,
    type DegreeProgressReport,
} from "@nyupath/engine";
import type {
    ForwardSchedule,
    ScheduleSlotSpecificPlanned,
    StudentProfile,
} from "@nyupath/shared";

function makeMeta() {
    return {
        parserVersion: "1.0.0", parsedAt: "2026-01-01T00:00:00Z", sourceFingerprint: "sha256:test",
        sourcePdfPageCount: 1, parseDurationMs: 0, warnings: [],
    };
}
function makeDpr(): DegreeProgressReport {
    return {
        _meta: makeMeta(), reportKind: "dpr",
        header: { studentName: "Test", preparedDate: "01/01/2026" },
        programs: [], advisorNotations: [],
        cumulative: {
            creditsRequired: 128, creditsUsed: 96, cumulativeGpa: 3.4, cumulativeGpaRequired: 2.0,
            residencyRequired: 64, residencyUsed: 64, passFailUsedUnits: 0, passFailCapUnits: 32,
            outsideHomeUsedUnits: 0, outsideHomeCapUnits: 16, timeLimitYears: 8,
        },
        requirementGroups: [], courseHistory: [],
    } as unknown as DegreeProgressReport;
}
function makeProfile(id: string): StudentProfile {
    return {
        id, catalogYear: "2024", homeSchool: "cas",
        declaredPrograms: [{ programId: "computer_science", programType: "major" }],
        coursesTaken: [], visaStatus: "f1",
    } as unknown as StudentProfile;
}
function specificPlanned(courseId: string): ScheduleSlotSpecificPlanned {
    return {
        kind: "specific_planned", courseId, title: courseId, credits: 4,
        satisfiesRules: [], reason: "t",
        rationale: { satisfiesRequirements: [], termConstraints: [], consideredAlternatives: [], decisionsApplied: [] },
        flexibility: { earliestPossibleTerm: "2026-fall", latestPossibleTerm: "2027-spring", alternativeCourses: [] },
        downstreamImpact: { courseIds: [], graduationDelay: 0 },
        workloadTier: "major-required", workloadWeight: 1.0, bindingState: "bound",
        confidence: "historically_likely", isCriticalPath: false,
    } as unknown as ScheduleSlotSpecificPlanned;
}
function makeSchedule(studentId: string): ForwardSchedule {
    return {
        studentId, homeSchoolId: "cas", graduationTerm: "2027-spring",
        creditTargetPerSemester: 16, f1Floor: 12, domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128, degreeCreditsMet: false,
        semesters: [
            {
                term: "2026-fall", locked: false,
                slots: [specificPlanned("A"), specificPlanned("B")],
                plannedCredits: 8, notes: [],
                loadRationale: { strategy: "balanced", creditsTarget: 16, slack: 0, weightedCredits: 8, hardCount: 2, easyCount: 0, alternativeDistributionsConsidered: [] },
            },
        ],
        dprCourseHistoryHash: "h", computedAt: 1700000000000,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean", balanceScore: 0, assumptions: [],
    } as unknown as ForwardSchedule;
}

// Injected FOSE: A on Mon 9-10 (open), B on Tue 9-10 (open) → 1 conflict-free combo.
const MON = JSON.stringify([{ meet_day: "0", start_time: "900", end_time: "1000" }]);
const TUE = JSON.stringify([{ meet_day: "1", start_time: "900", end_time: "1000" }]);
function searchFn(_term: string, keyword: string): Promise<unknown[]> {
    const map: Record<string, unknown[]> = {
        A: [{ code: "A", title: "A", crn: "a1", no: "001", schd: "LEC", stat: "O", credits: "4", instr: "Staff", meets: "MON", meetingTimes: MON, total: "30" }],
        B: [{ code: "B", title: "B", crn: "b1", no: "001", schd: "LEC", stat: "O", credits: "4", instr: "Staff", meets: "TUE", meetingTimes: TUE, total: "30" }],
    };
    return Promise.resolve(map[keyword] ?? []);
}

async function seed(studentId: string): Promise<void> {
    const stores = getStores({});
    const profileStore = stores.profileStore as InMemoryProfileStore;
    const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
    await profileStore.persistMutation(
        makeProfile(studentId),
        { pendingMutationId: "seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
        makeDpr(),
    );
    await scheduleStore.persistSchedule(studentId, makeSchedule(studentId), "fp-test");
}

beforeEach(() => resetStoresForTests());

describe("runMaterializeFeasibleStage — E1", () => {
    it("returns the verified candidate set for the target term's specific_planned courses", async () => {
        await seed("stu1");
        const res = await runMaterializeFeasibleStage("stu1", "2026-fall", { searchFn });
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.result.state).toBe("full");
            expect(res.result.candidates.length).toBeGreaterThan(0);
            const codes = res.result.candidates[0]!.courses.map(c => c.code).sort();
            expect(codes).toEqual(["A", "B"]);
        }
    });

    it("R1: the stage NEVER writes students.parsed_dpr (no persist of any kind)", async () => {
        await seed("stu2");
        const stores = getStores({});
        const profileSpy = vi.spyOn(stores.profileStore, "persistMutation");
        const scheduleSpy = vi.spyOn(stores.scheduleStore, "persistSchedule");
        const dprBefore = await stores.profileStore.getParsedDpr!("stu2");

        await runMaterializeFeasibleStage("stu2", "2026-fall", { searchFn });

        expect(profileSpy).not.toHaveBeenCalled();
        expect(scheduleSpy).not.toHaveBeenCalled();
        const dprAfter = await stores.profileStore.getParsedDpr!("stu2");
        expect(dprAfter).toEqual(dprBefore); // parsed_dpr byte-identical (R1)
    });

    it("returns a typed no_schedule error when the student has no plan", async () => {
        const stores = getStores({});
        await (stores.profileStore as InMemoryProfileStore).persistMutation(
            makeProfile("stu3"),
            { pendingMutationId: "seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
            makeDpr(),
        );
        const res = await runMaterializeFeasibleStage("stu3", "2026-fall", { searchFn });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.kind).toBe("no_schedule");
    });
});
