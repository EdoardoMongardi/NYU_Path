// ============================================================
// materializeSections.test.ts — Phase 15 Task 7 tests
// ============================================================
// Tests for the two-step section-materialization tools:
//   1. materialize_sections (read-only, stages proposalIds)
//   2. confirm_section_combination (write, pins CRNs in-place)
//
// The orchestrator (`materializeSections` from Task 6) is mocked at the
// module boundary via `vi.mock` so each test controls the returned
// `MaterializationResult` shape directly. This isolates the tool's
// staging + confirm contract from FOSE I/O concerns (already covered
// in `materialize.test.ts`).
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
    ForwardSchedule,
    ForwardSemester,
    ScheduleSlot,
    ScheduleSlotPlaceholder,
    ScheduleSlotSpecificPlanned,
    SchedulingPreferences,
} from "@nyupath/shared";
import type {
    MaterializationResult,
    SectionView,
} from "../../../src/agent/sectionMaterialization/types.js";
import type { ToolSession, ToolUseContext } from "../../../src/agent/tool.js";

// ---- Module mock — must be at top, hoisted by vitest ----
//
// The mock factory receives no arguments; we control the return value
// via `vi.mocked(...).mockResolvedValue(...)` inside individual tests.
// Default return is a no-op "unavailable" result that tests override.
vi.mock("../../../src/agent/sectionMaterialization/materialize.js", () => ({
    materializeSections: vi.fn(async () => ({
        state: "unavailable",
        message: "default mock — no result configured",
        schedulingPreferenceCheck: { kind: "absent" },
    } satisfies MaterializationResult)),
}));

import {
    materializeSectionsTool,
    confirmSectionCombinationTool,
} from "../../../src/agent/tools/materializeSections.js";
import { materializeSections as orchestrator } from "../../../src/agent/sectionMaterialization/materialize.js";

const mockedOrchestrator = vi.mocked(orchestrator);

// ---- Fixture helpers ----

const baseRationale = {
    satisfiesRequirements: [],
    termConstraints: [],
    consideredAlternatives: [],
    decisionsApplied: [],
};
const baseFlexibility = {
    earliestPossibleTerm: "2026-fall",
    latestPossibleTerm: "2027-spring",
    alternativeCourses: [],
};
const baseDownstream = {
    courseIds: [],
    graduationDelay: 0,
};

function makeSpecificPlannedSlot(
    courseId: string,
    overrides: Partial<ScheduleSlotSpecificPlanned> = {},
): ScheduleSlotSpecificPlanned {
    return {
        kind: "specific_planned",
        courseId,
        title: courseId,
        credits: 4,
        satisfiesRules: [],
        reason: "test",
        rationale: baseRationale,
        flexibility: baseFlexibility,
        downstreamImpact: baseDownstream,
        workloadTier: "major-required",
        workloadWeight: 1.0,
        bindingState: "bound",
        confidence: "historically_likely",
        isCriticalPath: false,
        ...overrides,
    };
}

function makePlaceholderSlot(category: string, placeholderId: string): ScheduleSlotPlaceholder {
    return {
        kind: "placeholder",
        category,
        credits: 4,
        satisfiesRules: [],
        optional: false,
        reason: "test placeholder",
        rationale: baseRationale,
        flexibility: baseFlexibility,
        downstreamImpact: baseDownstream,
        workloadTier: "major-required",
        workloadWeight: 1.0,
        bindingState: "placeholder-pending",
        placeholderId,
        confidence: "historically_likely",
        isCriticalPath: false,
    };
}

function makeSemester(
    term: string,
    slots: ScheduleSlot[],
    locked = false,
): ForwardSemester {
    return {
        term,
        locked,
        slots,
        plannedCredits: slots.reduce((sum, s) => {
            if (s.kind === "specific_planned" || s.kind === "placeholder" || s.kind === "in_progress" || s.kind === "completed") {
                return sum + (s as { credits: number }).credits;
            }
            return sum;
        }, 0),
        notes: [],
        loadRationale: {
            strategy: "balanced",
            creditsTarget: 16,
            slack: 0,
            weightedCredits: 8,
            hardCount: 2,
            easyCount: 0,
            alternativeDistributionsConsidered: [],
        },
    };
}

function makeSchedule(semesters: ForwardSemester[]): ForwardSchedule {
    return {
        studentId: "test-student",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters,
        dprCourseHistoryHash: "test-hash",
        computedAt: Date.now(),
        feasibility: {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
}

function makeSection(
    courseId: string,
    crn: string,
    overrides: Partial<SectionView> = {},
): SectionView {
    return {
        courseId,
        title: courseId,
        crn,
        credits: "4",
        instructor: "Staff",
        status: "O",
        meetingPatterns: [{ day: "M", startMin: 540, endMin: 615 }],
        isAsynchronous: false,
        rawMeets: "M 9-10:15a",
        meetingTimes: '[{"meet_day":"0","start_time":"900","end_time":"1015"}]',
        schd: "LEC",
        section: "001",
        ...overrides,
    };
}

function makeSession(schedule: ForwardSchedule, overrides: Partial<ToolSession> = {}): ToolSession {
    return {
        forwardSchedule: schedule,
        ...overrides,
    };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session,
    };
}

// ---- Reset mock between tests ----

beforeEach(() => {
    mockedOrchestrator.mockReset();
});

// ============================================================
// Tool contract assertions
// ============================================================

describe("tool contract assertions", () => {
    it("materialize_sections is isReadOnly:true", () => {
        expect(materializeSectionsTool.isReadOnly).toBe(true);
    });

    it("confirm_section_combination is isReadOnly:false", () => {
        expect(confirmSectionCombinationTool.isReadOnly).toBe(false);
    });
});

// ============================================================
// materialize_sections — (a) happy path
// ============================================================

describe("materialize_sections — (a) happy path", () => {
    it("two specific_planned slots → orchestrator returns 2 combos → 2 proposalIds + pendingMaterializations populated", async () => {
        const semester = makeSemester("2026-fall", [
            makeSpecificPlannedSlot("CSCI-UA 101"),
            makeSpecificPlannedSlot("CSCI-UA 201"),
        ]);
        const schedule = makeSchedule([semester]);
        const session = makeSession(schedule);

        const sectionA1 = makeSection("CSCI-UA 101", "1001");
        const sectionA2 = makeSection("CSCI-UA 101", "1002");
        const sectionB1 = makeSection("CSCI-UA 201", "2001");

        mockedOrchestrator.mockResolvedValueOnce({
            state: "full",
            semester: {
                term: "2026-fall",
                courses: [
                    { courseId: "CSCI-UA 101", title: "CSCI-UA 101", sections: [sectionA1, sectionA2] },
                    { courseId: "CSCI-UA 201", title: "CSCI-UA 201", sections: [sectionB1] },
                ],
                combinations: [
                    { sections: [sectionA1, sectionB1], weeklyHours: 5 },
                    { sections: [sectionA2, sectionB1], weeklyHours: 5 },
                ],
                combinationsTruncated: false,
            },
            message: "Found 2 conflict-free section combinations.",
            schedulingPreferenceCheck: { kind: "absent" },
        });

        const out = await materializeSectionsTool.call(
            { targetTerm: "2026-fall" },
            makeCtx(session),
        );

        expect(out.state).toBe("full");
        expect(out.proposals).toHaveLength(2);
        expect(out.proposals![0].proposalId).toBe("prop_2026-fall_1");
        expect(out.proposals![1].proposalId).toBe("prop_2026-fall_2");
        expect(out.targetTerm).toBe("2026-fall");

        // pendingMaterializations populated with both proposals
        expect(session.pendingMaterializations).toBeDefined();
        expect(session.pendingMaterializations!.size).toBe(2);
        expect(session.pendingMaterializations!.get("prop_2026-fall_1")).toEqual({
            termCode: "2026-fall",
            sections: [sectionA1, sectionB1],
        });
        expect(session.pendingMaterializations!.get("prop_2026-fall_2")).toEqual({
            termCode: "2026-fall",
            sections: [sectionA2, sectionB1],
        });

        // Orchestrator called with the right courseIds list (placeholders skipped)
        expect(mockedOrchestrator).toHaveBeenCalledTimes(1);
        const args = mockedOrchestrator.mock.calls[0]![0];
        expect(args.termCode).toBe("2026-fall");
        expect(args.courseIds).toEqual(["CSCI-UA 101", "CSCI-UA 201"]);
    });
});

// ============================================================
// materialize_sections — (b) locked term rejection
// ============================================================

describe("materialize_sections — (b) locked term rejection", () => {
    it("targetTerm is locked → validateInput returns userMessage", async () => {
        const lockedSem = makeSemester(
            "2025-fall",
            [makeSpecificPlannedSlot("CSCI-UA 101")],
            /* locked */ true,
        );
        const futureSem = makeSemester("2026-fall", [makeSpecificPlannedSlot("CSCI-UA 201")]);
        const schedule = makeSchedule([lockedSem, futureSem]);
        const session = makeSession(schedule);

        const v = await materializeSectionsTool.validateInput!(
            { targetTerm: "2025-fall" },
            makeCtx(session),
        );

        expect(v.ok).toBe(false);
        if (!v.ok) {
            expect(v.userMessage.toLowerCase()).toContain("locked");
            expect(v.userMessage).toContain("2025-fall");
        }
    });
});

// ============================================================
// materialize_sections — (c) non-existent term rejection
// ============================================================

describe("materialize_sections — (c) non-existent term rejection", () => {
    it("targetTerm doesn't match any semester → validateInput returns userMessage", async () => {
        const sem = makeSemester("2026-fall", [makeSpecificPlannedSlot("CSCI-UA 101")]);
        const schedule = makeSchedule([sem]);
        const session = makeSession(schedule);

        const v = await materializeSectionsTool.validateInput!(
            { targetTerm: "2099-fall" },
            makeCtx(session),
        );

        expect(v.ok).toBe(false);
        if (!v.ok) {
            expect(v.userMessage).toContain("2099-fall");
            expect(v.userMessage).toContain("2026-fall"); // available terms list
        }
    });

    it("missing forwardSchedule → validateInput returns userMessage", async () => {
        const session: ToolSession = {};

        const v = await materializeSectionsTool.validateInput!(
            { targetTerm: "2026-fall" },
            makeCtx(session),
        );

        expect(v.ok).toBe(false);
        if (!v.ok) {
            expect(v.userMessage).toContain("plan_forward_degree");
        }
    });
});

// ============================================================
// materialize_sections — (d) no specific_planned slots → unavailable
// ============================================================

describe("materialize_sections — (d) no specific_planned slots", () => {
    it("target semester has only placeholders → state: unavailable; pendingMaterializations untouched", async () => {
        const sem = makeSemester("2026-fall", [
            makePlaceholderSlot("Major Elective", "ph_1"),
            makePlaceholderSlot("Free Credit", "ph_2"),
        ]);
        const schedule = makeSchedule([sem]);
        const session = makeSession(schedule);

        const out = await materializeSectionsTool.call(
            { targetTerm: "2026-fall" },
            makeCtx(session),
        );

        expect(out.state).toBe("unavailable");
        expect(out.message.toLowerCase()).toContain("no concrete courses");
        expect(out.proposals).toBeUndefined();
        expect(session.pendingMaterializations).toBeUndefined();

        // Orchestrator never called when there are no concrete courseIds
        expect(mockedOrchestrator).not.toHaveBeenCalled();
    });

    it("empty slot list → also state: unavailable", async () => {
        const sem = makeSemester("2026-fall", []);
        const schedule = makeSchedule([sem]);
        const session = makeSession(schedule);

        const out = await materializeSectionsTool.call(
            { targetTerm: "2026-fall" },
            makeCtx(session),
        );

        expect(out.state).toBe("unavailable");
        expect(session.pendingMaterializations).toBeUndefined();
        expect(mockedOrchestrator).not.toHaveBeenCalled();
    });
});

// ============================================================
// materialize_sections — (e) schedulingPreferences forwarded
// ============================================================

describe("materialize_sections — (e) schedulingPreferences forwarded to orchestrator", () => {
    it("session.schedulePreferences.schedulingPreferences is passed through", async () => {
        const prefs: SchedulingPreferences = {
            avoidDays: [{ day: "F", strict: true }],
            preferTimeWindows: [{ days: ["M", "W"], startMin: 540, endMin: 720, weight: 1.0 }],
        };
        const sem = makeSemester("2026-fall", [makeSpecificPlannedSlot("CSCI-UA 101")]);
        const schedule = makeSchedule([sem]);
        const session = makeSession(schedule, {
            schedulePreferences: { schedulingPreferences: prefs },
        });

        mockedOrchestrator.mockResolvedValueOnce({
            state: "full",
            semester: {
                term: "2026-fall",
                courses: [{ courseId: "CSCI-UA 101", title: "CSCI-UA 101", sections: [makeSection("CSCI-UA 101", "1001")] }],
                combinations: [{ sections: [makeSection("CSCI-UA 101", "1001")], weeklyHours: 1.25 }],
                combinationsTruncated: false,
            },
            message: "ok",
            schedulingPreferenceCheck: { kind: "satisfied" },
        });

        await materializeSectionsTool.call({ targetTerm: "2026-fall" }, makeCtx(session));

        expect(mockedOrchestrator).toHaveBeenCalledTimes(1);
        const args = mockedOrchestrator.mock.calls[0]![0];
        expect(args.schedulingPreferences).toEqual(prefs);
    });

    it("absent schedulePreferences → schedulingPreferences forwarded as undefined", async () => {
        const sem = makeSemester("2026-fall", [makeSpecificPlannedSlot("CSCI-UA 101")]);
        const schedule = makeSchedule([sem]);
        const session = makeSession(schedule); // no schedulePreferences

        mockedOrchestrator.mockResolvedValueOnce({
            state: "unavailable",
            message: "no data",
            schedulingPreferenceCheck: { kind: "absent" },
        });

        await materializeSectionsTool.call({ targetTerm: "2026-fall" }, makeCtx(session));

        expect(mockedOrchestrator).toHaveBeenCalledTimes(1);
        const args = mockedOrchestrator.mock.calls[0]![0];
        expect(args.schedulingPreferences).toBeUndefined();
    });
});

// ============================================================
// materialize_sections — (f) swapHook stub returns null
// ============================================================

describe("materialize_sections — (f) Phase-15 swapHook stub returns null", () => {
    it("swapHook passed to orchestrator returns null for any input (Decision #19 deferred to Phase 16)", async () => {
        const sem = makeSemester("2026-fall", [makeSpecificPlannedSlot("CSCI-UA 101")]);
        const schedule = makeSchedule([sem]);
        const session = makeSession(schedule);

        mockedOrchestrator.mockResolvedValueOnce({
            state: "unavailable",
            message: "no data",
            schedulingPreferenceCheck: { kind: "absent" },
        });

        await materializeSectionsTool.call({ targetTerm: "2026-fall" }, makeCtx(session));

        const args = mockedOrchestrator.mock.calls[0]![0];
        expect(typeof args.swapHook).toBe("function");

        // The stub MUST return null for any input — no structural-solver
        // integration in Phase 15 Task 7.
        const swap1 = await args.swapHook("CSCI-UA 999", "unavailable");
        const swap2 = await args.swapHook("MATH-UA 999", "scheduling-prefs-eliminated");
        expect(swap1).toBeNull();
        expect(swap2).toBeNull();
    });
});

// ============================================================
// confirm_section_combination — (g) happy path
// ============================================================

describe("confirm_section_combination — (g) happy path", () => {
    it("matching slots gain crn/meetingPatterns/instructor/schd/sectionNumber; pending entry consumed", async () => {
        const slot101 = makeSpecificPlannedSlot("CSCI-UA 101");
        const slot201 = makeSpecificPlannedSlot("CSCI-UA 201");
        const sem = makeSemester("2026-fall", [slot101, slot201]);
        const schedule = makeSchedule([sem]);
        const session = makeSession(schedule);

        // Stage two proposals via materialize_sections (real call,
        // orchestrator mocked).
        const sectionA = makeSection("CSCI-UA 101", "1001", {
            instructor: "Prof. Alpha",
            schd: "LEC",
            section: "002",
            meetingPatterns: [
                { day: "Tu", startMin: 480, endMin: 555 },
                { day: "Th", startMin: 480, endMin: 555 },
            ],
        });
        const sectionB = makeSection("CSCI-UA 201", "2001", {
            instructor: "Prof. Beta",
            schd: "LEC",
            section: "001",
            meetingPatterns: [{ day: "M", startMin: 540, endMin: 615 }],
        });

        mockedOrchestrator.mockResolvedValueOnce({
            state: "full",
            semester: {
                term: "2026-fall",
                courses: [
                    { courseId: "CSCI-UA 101", title: "CSCI-UA 101", sections: [sectionA] },
                    { courseId: "CSCI-UA 201", title: "CSCI-UA 201", sections: [sectionB] },
                ],
                combinations: [{ sections: [sectionA, sectionB], weeklyHours: 4 }],
                combinationsTruncated: false,
            },
            message: "ok",
            schedulingPreferenceCheck: { kind: "absent" },
        });
        await materializeSectionsTool.call({ targetTerm: "2026-fall" }, makeCtx(session));

        // Now confirm
        const out = await confirmSectionCombinationTool.call(
            { proposalId: "prop_2026-fall_1" },
            makeCtx(session),
        );

        expect(out.status).toBe("applied");
        expect(out.termCode).toBe("2026-fall");
        expect(out.sectionsBound).toBe(2);
        expect(out.notes).toEqual([]);

        // Slots mutated in-place with concrete-section fields
        expect(slot101.crn).toBe("1001");
        expect(slot101.instructor).toBe("Prof. Alpha");
        expect(slot101.schd).toBe("LEC");
        expect(slot101.sectionNumber).toBe("002");
        expect(slot101.meetingPatterns).toEqual([
            { day: "Tu", startMin: 480, endMin: 555 },
            { day: "Th", startMin: 480, endMin: 555 },
        ]);

        expect(slot201.crn).toBe("2001");
        expect(slot201.instructor).toBe("Prof. Beta");
        expect(slot201.sectionNumber).toBe("001");
        expect(slot201.meetingPatterns).toEqual([
            { day: "M", startMin: 540, endMin: 615 },
        ]);

        // pending entry consumed
        expect(session.pendingMaterializations!.has("prop_2026-fall_1")).toBe(false);
    });
});

// ============================================================
// confirm_section_combination — (h) invalid proposalId
// ============================================================

describe("confirm_section_combination — (h) invalid proposalId rejection", () => {
    it("validateInput returns userMessage when proposalId is unknown", async () => {
        const sem = makeSemester("2026-fall", [makeSpecificPlannedSlot("CSCI-UA 101")]);
        const schedule = makeSchedule([sem]);
        const session = makeSession(schedule);

        const v = await confirmSectionCombinationTool.validateInput!(
            { proposalId: "prop_does_not_exist" },
            makeCtx(session),
        );

        expect(v.ok).toBe(false);
        if (!v.ok) {
            expect(v.userMessage).toContain("prop_does_not_exist");
            expect(v.userMessage.toLowerCase()).toContain("materialize_sections");
        }
    });

    it("missing forwardSchedule → validateInput rejects with userMessage", async () => {
        const session: ToolSession = {
            pendingMaterializations: new Map([
                ["prop_x_1", { termCode: "2026-fall", sections: [] }],
            ]),
        };

        const v = await confirmSectionCombinationTool.validateInput!(
            { proposalId: "prop_x_1" },
            makeCtx(session),
        );

        expect(v.ok).toBe(false);
        if (!v.ok) {
            expect(v.userMessage).toContain("plan_forward_degree");
        }
    });
});

// ============================================================
// confirm_section_combination — (i) idempotency
// ============================================================

describe("confirm_section_combination — (i) idempotency / second confirm rejected", () => {
    it("calling confirm twice with the same proposalId → second call rejected via 'no pending' path", async () => {
        const slot = makeSpecificPlannedSlot("CSCI-UA 101");
        const sem = makeSemester("2026-fall", [slot]);
        const schedule = makeSchedule([sem]);
        const session = makeSession(schedule);

        const sectionA = makeSection("CSCI-UA 101", "1001");
        mockedOrchestrator.mockResolvedValueOnce({
            state: "full",
            semester: {
                term: "2026-fall",
                courses: [{ courseId: "CSCI-UA 101", title: "CSCI-UA 101", sections: [sectionA] }],
                combinations: [{ sections: [sectionA], weeklyHours: 1.25 }],
                combinationsTruncated: false,
            },
            message: "ok",
            schedulingPreferenceCheck: { kind: "absent" },
        });
        await materializeSectionsTool.call({ targetTerm: "2026-fall" }, makeCtx(session));

        // First confirm: succeeds
        const first = await confirmSectionCombinationTool.call(
            { proposalId: "prop_2026-fall_1" },
            makeCtx(session),
        );
        expect(first.status).toBe("applied");
        expect(first.sectionsBound).toBe(1);

        // Second confirm: validateInput rejects via the same "no pending"
        // path because the entry was deleted on the first confirm.
        const v = await confirmSectionCombinationTool.validateInput!(
            { proposalId: "prop_2026-fall_1" },
            makeCtx(session),
        );
        expect(v.ok).toBe(false);
        if (!v.ok) {
            expect(v.userMessage).toContain("prop_2026-fall_1");
            expect(v.userMessage.toLowerCase()).toMatch(/already consumed|materialize_sections/);
        }
    });
});

// ============================================================
// confirm_section_combination — (j) unrelated terms unchanged
// ============================================================

describe("confirm_section_combination — (j) only target semester is mutated", () => {
    it("a confirm for 2026-fall does not touch 2027-spring slots", async () => {
        const fallSlot = makeSpecificPlannedSlot("CSCI-UA 101");
        const springSlot = makeSpecificPlannedSlot("CSCI-UA 201");
        const fallSem = makeSemester("2026-fall", [fallSlot]);
        const springSem = makeSemester("2027-spring", [springSlot]);
        const schedule = makeSchedule([fallSem, springSem]);
        const session = makeSession(schedule);

        const sectionA = makeSection("CSCI-UA 101", "1001", {
            instructor: "Prof. Fall",
            schd: "LEC",
            section: "001",
        });
        mockedOrchestrator.mockResolvedValueOnce({
            state: "full",
            semester: {
                term: "2026-fall",
                courses: [{ courseId: "CSCI-UA 101", title: "CSCI-UA 101", sections: [sectionA] }],
                combinations: [{ sections: [sectionA], weeklyHours: 1.25 }],
                combinationsTruncated: false,
            },
            message: "ok",
            schedulingPreferenceCheck: { kind: "absent" },
        });
        await materializeSectionsTool.call({ targetTerm: "2026-fall" }, makeCtx(session));

        await confirmSectionCombinationTool.call(
            { proposalId: "prop_2026-fall_1" },
            makeCtx(session),
        );

        // Fall slot now has concrete-section fields
        expect(fallSlot.crn).toBe("1001");
        expect(fallSlot.instructor).toBe("Prof. Fall");

        // Spring slot is completely untouched
        expect(springSlot.crn).toBeUndefined();
        expect(springSlot.meetingPatterns).toBeUndefined();
        expect(springSlot.instructor).toBeUndefined();
        expect(springSlot.schd).toBeUndefined();
        expect(springSlot.sectionNumber).toBeUndefined();
    });
});

// ============================================================
// Defensive: confirm with stale proposalId whose semester was
// removed — surfaces a note + still consumes the entry.
// ============================================================

describe("confirm_section_combination — defensive: stale proposalId after schedule mutation", () => {
    it("if target semester disappears between stage + confirm, returns notes + consumes entry", async () => {
        const slot = makeSpecificPlannedSlot("CSCI-UA 101");
        const sem = makeSemester("2026-fall", [slot]);
        const schedule = makeSchedule([sem]);
        const session = makeSession(schedule);

        const sectionA = makeSection("CSCI-UA 101", "1001");
        mockedOrchestrator.mockResolvedValueOnce({
            state: "full",
            semester: {
                term: "2026-fall",
                courses: [{ courseId: "CSCI-UA 101", title: "CSCI-UA 101", sections: [sectionA] }],
                combinations: [{ sections: [sectionA], weeklyHours: 1.25 }],
                combinationsTruncated: false,
            },
            message: "ok",
            schedulingPreferenceCheck: { kind: "absent" },
        });
        await materializeSectionsTool.call({ targetTerm: "2026-fall" }, makeCtx(session));

        // Simulate a structural-plan mutation: the target semester is
        // wiped from the schedule before confirm fires.
        schedule.semesters = [];

        const out = await confirmSectionCombinationTool.call(
            { proposalId: "prop_2026-fall_1" },
            makeCtx(session),
        );

        expect(out.status).toBe("applied");
        expect(out.sectionsBound).toBe(0);
        expect(out.notes.length).toBeGreaterThan(0);
        expect(out.notes[0]).toContain("2026-fall");
        // entry still consumed (defensive — don't strand the id)
        expect(session.pendingMaterializations!.has("prop_2026-fall_1")).toBe(false);
    });
});
