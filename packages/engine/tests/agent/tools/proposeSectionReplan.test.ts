// ============================================================
// proposeSectionReplan.test.ts — Phase 38 Task E3 (tool)
// ============================================================
// The agent-facing escalation tool: when materialize_feasible has no
// feasible candidate / the student rejects all, the agent calls
// propose_section_replan. It runs the §2⑤ bounded outer loop (mocked
// here) and returns a narration summary + the recommended mutations
// (the route re-derives + stages them via the existing plan_proposal
// path). READ-ONLY — it computes a proposal, never commits.
// ============================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ForwardSchedule } from "@nyupath/shared";
import type { ToolSession, ToolUseContext } from "../../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../../src/dpr/schema.js";
import type { SectionReplanLoopResult } from "../../../src/agent/sectionMaterialization/sectionReplanBridge.js";

vi.mock("../../../src/agent/sectionMaterialization/sectionReplanBridge.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/agent/sectionMaterialization/sectionReplanBridge.js")>();
    return { ...actual, runSectionReplanLoop: vi.fn() };
});
// The wiring factory composes real (non-FOSE) functions; the mocked loop never
// invokes the deps, so no FOSE/solver runs in these tests.

import { proposeSectionReplanTool } from "../../../src/agent/tools/proposeSectionReplan.js";
import { runSectionReplanLoop } from "../../../src/agent/sectionMaterialization/sectionReplanBridge.js";

const mockedLoop = vi.mocked(runSectionReplanLoop);

const plan = { graduationTerm: "2027-spring", semesters: [{ term: "2026-fall", locked: false, slots: [] }] } as unknown as ForwardSchedule;
const dpr = { _meta: {}, programs: [], requirementGroups: [], courseHistory: [], cumulative: {} } as unknown as DegreeProgressReport;

function ctx(overrides: Partial<ToolSession> = {}): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session: { forwardSchedule: plan, degreeProgressReport: dpr, ...overrides },
    };
}

beforeEach(() => mockedLoop.mockReset());

describe("propose_section_replan — tool contract", () => {
    it("is read-only", () => {
        expect(proposeSectionReplanTool.isReadOnly).toBe(true);
    });
    it("rejects when there is no forward plan", async () => {
        const res = await proposeSectionReplanTool.validateInput!({}, ctx({ forwardSchedule: undefined }));
        expect(res.ok).toBe(false);
    });
});

describe("propose_section_replan — call", () => {
    it("a valid re-plan → kind 'replan' carrying the recommended mutations + moved courses", async () => {
        mockedLoop.mockResolvedValue({
            kind: "replan",
            mutations: [{ kind: "move", courseId: "CSCI-UA 421", fromTerm: "2026-fall", toTerm: "2027-spring" }],
            movedCourseIds: ["CSCI-UA 421"],
            finalPlan: plan,
            nearTerm: "2026-fall",
            cycles: 1,
            gradTermChanged: false,
            gradTerm: "2027-spring",
        } satisfies SectionReplanLoopResult);
        const out = await proposeSectionReplanTool.call({}, ctx());
        expect(out.kind).toBe("replan");
        expect(out.mutations).toEqual([{ kind: "move", courseId: "CSCI-UA 421", fromTerm: "2026-fall", toTerm: "2027-spring" }]);
        expect(out.movedCourseIds).toEqual(["CSCI-UA 421"]);
        expect(out.summary.toLowerCase()).toContain("csci-ua 421");
    });

    it("graduation shift is surfaced honestly in the summary", async () => {
        mockedLoop.mockResolvedValue({
            kind: "replan",
            mutations: [{ kind: "move", courseId: "X", fromTerm: "2026-fall", toTerm: "2027-fall" }],
            movedCourseIds: ["X"], finalPlan: plan, nearTerm: "2026-fall", cycles: 1,
            gradTermChanged: true, gradTerm: "2027-fall",
        } satisfies SectionReplanLoopResult);
        const out = await proposeSectionReplanTool.call({}, ctx());
        expect(out.gradTermChanged).toBe(true);
        expect(out.summary.toLowerCase()).toMatch(/graduat/);
    });

    it("no valid re-plan → kind 'no-op' relaying the honest reason (never invents one)", async () => {
        mockedLoop.mockResolvedValue({ kind: "no-op", reason: "would push graduation past your target", cycles: 2, nearTerm: "2026-fall" });
        const out = await proposeSectionReplanTool.call({}, ctx());
        expect(out.kind).toBe("no-op");
        expect(out.reason).toContain("graduation");
        expect(out.mutations).toBeUndefined();
    });

    it("near-term already feasible → kind 'feasible' (no escalation needed)", async () => {
        mockedLoop.mockResolvedValue({ kind: "feasible", nearTerm: "2026-fall", cycles: 0 });
        const out = await proposeSectionReplanTool.call({}, ctx());
        expect(out.kind).toBe("feasible");
    });

    it("passes rejectedCourseIds through to the loop", async () => {
        mockedLoop.mockResolvedValue({ kind: "feasible", nearTerm: "2026-fall", cycles: 0 });
        await proposeSectionReplanTool.call({ rejectedCourseIds: ["CSCI-UA 421"] }, ctx());
        expect(mockedLoop.mock.calls[0]![2]).toMatchObject({ rejectedCourseIds: ["CSCI-UA 421"] });
    });
});
