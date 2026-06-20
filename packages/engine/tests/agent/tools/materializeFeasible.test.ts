// ============================================================
// materializeFeasible.test.ts — Phase 38 Task 0.3 (tool wrapper)
// ============================================================
// The read-only `materialize_feasible` tool: reads the target term's
// specific_planned courseIds, runs the deterministic orchestrator,
// and returns the schema-validated verified candidate set (§2.5 — the
// agent's ONLY candidate source). The orchestrator is mocked at the
// module boundary; FOSE I/O is covered in materializeFeasible.test.ts.
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
    ForwardSchedule,
    ForwardSemester,
    ScheduleSlot,
    ScheduleSlotSpecificPlanned,
} from "@nyupath/shared";
import type { ToolSession, ToolUseContext } from "../../../src/agent/tool.js";
import type { MaterializeFeasibleResult } from "../../../src/agent/sectionMaterialization/materializeFeasible.js";

vi.mock("../../../src/agent/sectionMaterialization/materializeFeasible.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/agent/sectionMaterialization/materializeFeasible.js")>();
    return {
        ...actual,
        // Re-export the real schema; mock only the orchestrator fn.
        materializeFeasible: vi.fn(async () => ({
            state: "unavailable",
            termCode: "2026-fall",
            message: "default mock",
            candidates: [],
            truncated: false,
            hedges: [],
            unavailableCourses: [],
        } satisfies MaterializeFeasibleResult)),
    };
});

import { materializeFeasibleTool } from "../../../src/agent/tools/materializeFeasible.js";
import {
    materializeFeasible as orchestrator,
    materializeFeasibleResultSchema,
} from "../../../src/agent/sectionMaterialization/materializeFeasible.js";

const mocked = vi.mocked(orchestrator);

// ---- Fixture helpers ----

const baseRationale = { satisfiesRequirements: [], termConstraints: [], consideredAlternatives: [], decisionsApplied: [] };
const baseFlexibility = { earliestPossibleTerm: "2026-fall", latestPossibleTerm: "2027-spring", alternativeCourses: [] };
const baseDownstream = { courseIds: [], graduationDelay: 0 };

function specificPlanned(courseId: string): ScheduleSlotSpecificPlanned {
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
    };
}

function semester(term: string, slots: ScheduleSlot[], locked = false): ForwardSemester {
    return {
        term,
        locked,
        slots,
        plannedCredits: 0,
        notes: [],
        loadRationale: {
            strategy: "balanced", creditsTarget: 16, slack: 0, weightedCredits: 8,
            hardCount: 2, easyCount: 0, alternativeDistributionsConsidered: [],
        },
    };
}

function schedule(semesters: ForwardSemester[]): ForwardSchedule {
    return {
        studentId: "test", homeSchoolId: "cas", graduationTerm: "2027-spring",
        creditTargetPerSemester: 16, f1Floor: 12, domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128, degreeCreditsMet: false, semesters,
        dprCourseHistoryHash: "h", computedAt: 0,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean", balanceScore: 0, assumptions: [],
    };
}

function ctx(session: ToolSession): ToolUseContext {
    return { signal: new AbortController().signal, session };
}

beforeEach(() => mocked.mockReset());

describe("materialize_feasible — tool contract", () => {
    it("is read-only and exposes an outputSchema", () => {
        expect(materializeFeasibleTool.isReadOnly).toBe(true);
        expect(materializeFeasibleTool.outputSchema).toBeDefined();
        expect(materializeFeasibleTool.outputSchema).toBe(materializeFeasibleResultSchema);
    });
});

describe("materialize_feasible — validateInput", () => {
    it("rejects when no forward plan exists", async () => {
        const res = await materializeFeasibleTool.validateInput!({ targetTerm: "2026-fall" }, ctx({}));
        expect(res.ok).toBe(false);
    });
    it("rejects an unknown term", async () => {
        const sess = { forwardSchedule: schedule([semester("2026-fall", [])]) };
        const res = await materializeFeasibleTool.validateInput!({ targetTerm: "2099-fall" }, ctx(sess));
        expect(res.ok).toBe(false);
    });
    it("rejects a locked term", async () => {
        const sess = { forwardSchedule: schedule([semester("2026-fall", [], true)]) };
        const res = await materializeFeasibleTool.validateInput!({ targetTerm: "2026-fall" }, ctx(sess));
        expect(res.ok).toBe(false);
    });
    it("accepts a known non-locked term", async () => {
        const sess = { forwardSchedule: schedule([semester("2026-fall", [])]) };
        const res = await materializeFeasibleTool.validateInput!({ targetTerm: "2026-fall" }, ctx(sess));
        expect(res.ok).toBe(true);
    });
});

describe("materialize_feasible — call", () => {
    it("passes the term's specific_planned courseIds to the orchestrator + returns a schema-valid result", async () => {
        mocked.mockResolvedValue({
            state: "full",
            termCode: "2026-fall",
            message: "ok",
            candidates: [{
                candidateId: "cand_2026-fall_1",
                courses: [{ code: "A", title: "A", components: [{ schd: "LEC", crn: "a1", meets: "M", meetingBlocks: [{ day: "M", startMin: 540, endMin: 600 }], instr: "Staff", status: "O" }] }],
                hasWaitlist: false, waitlistCrns: [], openFallbacks: [], weeklyHours: 1, preScore: 0.5, preRankReason: "all sections open",
            }],
            truncated: false,
            hedges: [],
            unavailableCourses: [],
        });
        const sess = { forwardSchedule: schedule([semester("2026-fall", [specificPlanned("A"), specificPlanned("B")])]) };
        const out = await materializeFeasibleTool.call({ targetTerm: "2026-fall" }, ctx(sess));
        expect(mocked).toHaveBeenCalledTimes(1);
        expect(mocked.mock.calls[0]![0]!.courseIds).toEqual(["A", "B"]);
        expect(out.state).toBe("full");
        expect(materializeFeasibleResultSchema.safeParse(out).success).toBe(true);
    });

    it("returns unavailable without calling the orchestrator when no concrete courses exist", async () => {
        const sess = { forwardSchedule: schedule([semester("2026-fall", [])]) };
        const out = await materializeFeasibleTool.call({ targetTerm: "2026-fall" }, ctx(sess));
        expect(mocked).not.toHaveBeenCalled();
        expect(out.state).toBe("unavailable");
    });

    it("#2: an already-registered (IP) course with no supplied section → result hedges (elicit its section)", async () => {
        mocked.mockResolvedValue({
            state: "full", termCode: "2026-fall", message: "ok",
            candidates: [], truncated: false, hedges: [], unavailableCourses: [],
        });
        const ipSlot = { kind: "in_progress", courseId: "CSCI-UA 101" } as unknown as ScheduleSlot;
        const sess = { forwardSchedule: schedule([semester("2026-fall", [specificPlanned("A"), ipSlot])]) };
        const out = await materializeFeasibleTool.call({ targetTerm: "2026-fall" }, ctx(sess));
        expect(out.hedges.some(h => h.includes("CSCI-UA 101") && /section|crn|conflict/i.test(h))).toBe(true);
    });

    it("#2: supplied IP section times are passed as occupiedBlocks to the orchestrator (no hedge for it)", async () => {
        mocked.mockResolvedValue({
            state: "full", termCode: "2026-fall", message: "ok",
            candidates: [], truncated: false, hedges: [], unavailableCourses: [],
        });
        const ipSlot = { kind: "in_progress", courseId: "CSCI-UA 101" } as unknown as ScheduleSlot;
        const sess = { forwardSchedule: schedule([semester("2026-fall", [specificPlanned("A"), ipSlot])]) };
        const out = await materializeFeasibleTool.call({
            targetTerm: "2026-fall",
            ipSections: [{ courseId: "CSCI-UA 101", meetingTimes: JSON.stringify([{ meet_day: "0", start_time: "900", end_time: "1000" }]) }],
        }, ctx(sess));
        const passed = mocked.mock.calls[0]![0]!.occupiedBlocks;
        expect(passed).toEqual([{ day: "M", startMin: 540, endMin: 600 }]);
        // The IP course's section IS known now → no elicitation hedge for it.
        expect(out.hedges.some(h => h.includes("CSCI-UA 101"))).toBe(false);
    });

    it("#2: an ipSection for a course that is NOT in_progress this term is ignored (no spurious occupiedBlocks)", async () => {
        mocked.mockResolvedValue({
            state: "full", termCode: "2026-fall", message: "ok",
            candidates: [], truncated: false, hedges: [], unavailableCourses: [],
        });
        // No in_progress slot → a stray ipSection must not constrain candidates.
        const sess = { forwardSchedule: schedule([semester("2026-fall", [specificPlanned("A")])]) };
        await materializeFeasibleTool.call({
            targetTerm: "2026-fall",
            ipSections: [{ courseId: "GHOST-UA 1", meetingTimes: JSON.stringify([{ meet_day: "0", start_time: "900", end_time: "1000" }]) }],
        }, ctx(sess));
        expect(mocked.mock.calls[0]![0]!.occupiedBlocks).toBeUndefined();
    });
});
