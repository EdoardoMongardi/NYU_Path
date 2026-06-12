/**
 * D6.3 — rung-3 LLM re-rank provenance.
 *
 * When the agent re-ranks `alternativeCandidates` (Tier B) and applies the
 * chosen one via `confirm_plan_change`, the chosen plan's provenance (which
 * alternative, why, which dimensions) must be recorded DURABLY as an
 * `LLM_RANKED_ALTERNATIVE` Assumption on the confirmed schedule's
 * `assumptions[]` — so it persists, survives the P3.1 hydration path, and is
 * re-explainable on a later turn.
 *
 * Test contract:
 *  (a) emission: confirm_plan_change with a `rankedAlternative` →
 *      the confirmed/persisted ForwardSchedule.assumptions[] contains a
 *      LLM_RANKED_ALTERNATIVE Assumption carrying reasoning +
 *      dimensionsConsidered + studentStatedFactor + selectedPlanIndex.
 *  (b) durability (KEY): after confirm persists, loadLatestSchedule(studentId)
 *      returns a schedule whose assumptions[] STILL contains that assumption —
 *      survives persistence + hydration (re-readable on a later turn).
 *  (c) no-provenance control: confirm WITHOUT rankedAlternative → no
 *      LLM_RANKED_ALTERNATIVE Assumption added (not always-on).
 *  (d) exactly-one: re-confirming the SAME rankedAlternative still yields
 *      exactly one assumption (finalize rebuilds assumptions fresh — nothing
 *      to stack against).
 *  (e) compare stays read-only: compare_plan_alternatives is byte-identical-
 *      session (no write, no persist).
 */

import { describe, it, expect } from "vitest";
import { confirmPlanChangeTool } from "../../../src/agent/tools/confirmPlanChange.js";
import { comparePlanAlternativesTool } from "../../../src/agent/tools/comparePlanAlternatives.js";
import { InMemoryScheduleStore } from "../../../src/persistence/scheduleStore.js";
import type { ToolSession, ToolUseContext } from "../../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../../src/dpr/schema.js";
import type {
    Assumption,
    ForwardSchedule,
    AlternativePlanSummary,
} from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures (mirror packages/engine/tests/agent/comparePlanAlternatives.test.ts)
// ---------------------------------------------------------------------------

const STUDENT_ID = "test-student";

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:test",
        sourcePdfPageCount: 1,
        parseDurationMs: 0,
        warnings: [],
    };
}

function makeDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 96,
            cumulativeGpa: 3.4,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 4,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [],
        ...overrides,
    };
}

function makeAlternativeCandidate(
    overrides: Partial<AlternativePlanSummary> = {},
): AlternativePlanSummary {
    return {
        planIndex: 0,
        balanceScore: 0.85,
        weightedCreditsByTerm: { "2026-fall": 16, "2027-spring": 16 },
        hardCountByTerm: { "2026-fall": 2, "2027-spring": 2 },
        easyCountByTerm: { "2026-fall": 2, "2027-spring": 2 },
        subjectDistributionByTerm: { "2026-fall": { "CSCI-UA": 2, "MATH-UA": 2 } },
        distinctSubjectsCount: 4,
        totalPetitionCount: 0,
        totalAssumptionCount: 1,
        graduationTerm: "2027-spring",
        topDiffsFromWinner: [{ aspect: "balanceScore", change: "+0.05" }],
        ...overrides,
    };
}

function makeMinimalFeasibleSchedule(
    overrides: Partial<ForwardSchedule> = {},
): ForwardSchedule {
    return {
        studentId: STUDENT_ID,
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "test-hash",
        computedAt: Date.now(),
        feasibility: {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        },
        state: "valid-clean",
        balanceScore: 0.8,
        assumptions: [],
        ...overrides,
    };
}

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
    return {
        student: {
            id: STUDENT_ID,
            catalogYear: "2024",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "major" }],
            coursesTaken: [],
            visaStatus: "f1",
        },
        schoolConfig: {
            schoolId: "cas",
            name: "College of Arts and Science",
            degreeType: "BA",
            courseSuffix: ["-UA"],
            totalCreditsRequired: 128,
            overallGpaMin: 2.0,
            acceptsTransferCredit: true,
            maxCreditsPerSemester: 18,
            f1FullTimeMinCredits: 12,
            residency: { minCredits: 64, note: null },
        },
        degreeProgressReport: makeDpr(),
        forwardSchedule: makeMinimalFeasibleSchedule(),
        ...overrides,
    };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session,
    };
}

/** The provenance an agent passes after re-ranking Tier-B candidates. */
const RANKED_ALTERNATIVE = {
    studentStatedFactor: "I prefer graduating in fall to avoid summer work",
    selectedPlanIndex: 1,
    reasoning:
        "Candidate 1 graduates in 2027-fall (matches your stated fall preference) " +
        "with comparable balance and zero added petitions.",
    dimensionsConsidered: ["graduationTerm", "balanceScore", "totalPetitionCount"],
};

/** The slot the confirm result actually landed in. */
function resolvedSlot(session: ToolSession): ForwardSchedule | undefined {
    return session.forwardSchedule ?? session.studentDraftPlan;
}

function findRankedAssumption(assumptions: Assumption[]): Assumption | undefined {
    return assumptions.find((a) => a.type === "LLM_RANKED_ALTERNATIVE");
}

// ---------------------------------------------------------------------------
// (a) emission — the provenance Assumption lands on the confirmed schedule
// ---------------------------------------------------------------------------

describe("confirm_plan_change — re-rank provenance emission (D6.3)", () => {
    it("(a) appends an LLM_RANKED_ALTERNATIVE assumption carrying the full provenance", async () => {
        const store = new InMemoryScheduleStore();
        const session = makeSession({
            scheduleStore: store,
            forwardSchedule: makeMinimalFeasibleSchedule({
                alternativeCandidates: [
                    makeAlternativeCandidate({ planIndex: 0, graduationTerm: "2027-spring" }),
                    makeAlternativeCandidate({ planIndex: 1, graduationTerm: "2027-fall" }),
                ],
            }),
        });
        const ctx = makeCtx(session);

        await confirmPlanChangeTool.call(
            {
                mutations: [{ kind: "loadStyleOverride", style: "balanced" }],
                rankedAlternative: RANKED_ALTERNATIVE,
            },
            ctx,
        );

        // The assumption rides on whichever slot the confirm result landed in.
        const slot = resolvedSlot(session);
        expect(slot).toBeDefined();
        const ranked = findRankedAssumption(slot!.assumptions);
        expect(ranked).toBeDefined();
        expect(ranked).toMatchObject({
            type: "LLM_RANKED_ALTERNATIVE",
            studentStatedFactor: RANKED_ALTERNATIVE.studentStatedFactor,
            selectedPlanIndex: RANKED_ALTERNATIVE.selectedPlanIndex,
            reasoning: RANKED_ALTERNATIVE.reasoning,
            dimensionsConsidered: RANKED_ALTERNATIVE.dimensionsConsidered,
        });
    });

    it("(a) surfaces the recorded rationale in summarizeResult", async () => {
        const store = new InMemoryScheduleStore();
        const session = makeSession({ scheduleStore: store });
        const ctx = makeCtx(session);

        const output = await confirmPlanChangeTool.call(
            {
                mutations: [{ kind: "loadStyleOverride", style: "balanced" }],
                rankedAlternative: RANKED_ALTERNATIVE,
            },
            ctx,
        );

        const summary = confirmPlanChangeTool.summarizeResult!(output);
        expect(summary).toContain(RANKED_ALTERNATIVE.reasoning);
        expect(summary).toContain("graduationTerm");
    });
});

// ---------------------------------------------------------------------------
// (b) durability — provenance survives persistence + the P3.1 hydration path
// ---------------------------------------------------------------------------

describe("confirm_plan_change — re-rank provenance durability (D6.3)", () => {
    it("(b) loadLatestSchedule after confirm STILL carries the LLM_RANKED_ALTERNATIVE assumption", async () => {
        const store = new InMemoryScheduleStore();
        const session = makeSession({
            scheduleStore: store,
            forwardSchedule: makeMinimalFeasibleSchedule({
                alternativeCandidates: [
                    makeAlternativeCandidate({ planIndex: 0 }),
                    makeAlternativeCandidate({ planIndex: 1, graduationTerm: "2027-fall" }),
                ],
            }),
        });
        const ctx = makeCtx(session);

        // Confirm with the re-rank provenance → confirm persists via the store.
        await confirmPlanChangeTool.call(
            {
                mutations: [{ kind: "loadStyleOverride", style: "balanced" }],
                rankedAlternative: RANKED_ALTERNATIVE,
            },
            ctx,
        );

        // Re-load from the store as the P3.1 hydration path would on a LATER turn.
        const reloaded = await store.loadLatestSchedule(STUDENT_ID);
        expect(reloaded).not.toBeNull();
        const ranked = findRankedAssumption(reloaded!.schedule.assumptions);
        expect(ranked).toBeDefined();
        expect(ranked).toMatchObject({
            type: "LLM_RANKED_ALTERNATIVE",
            studentStatedFactor: RANKED_ALTERNATIVE.studentStatedFactor,
            selectedPlanIndex: RANKED_ALTERNATIVE.selectedPlanIndex,
            reasoning: RANKED_ALTERNATIVE.reasoning,
            dimensionsConsidered: RANKED_ALTERNATIVE.dimensionsConsidered,
        });
    });
});

// ---------------------------------------------------------------------------
// (c) no-provenance control — not always-on
// ---------------------------------------------------------------------------

describe("confirm_plan_change — no re-rank provenance (control, D6.3)", () => {
    it("(c) confirm WITHOUT rankedAlternative adds NO LLM_RANKED_ALTERNATIVE assumption", async () => {
        const store = new InMemoryScheduleStore();
        const session = makeSession({ scheduleStore: store });
        const ctx = makeCtx(session);

        await confirmPlanChangeTool.call(
            { mutations: [{ kind: "loadStyleOverride", style: "balanced" }] },
            ctx,
        );

        const slot = resolvedSlot(session);
        expect(slot).toBeDefined();
        expect(findRankedAssumption(slot!.assumptions)).toBeUndefined();

        const reloaded = await store.loadLatestSchedule(STUDENT_ID);
        expect(reloaded).not.toBeNull();
        expect(findRankedAssumption(reloaded!.schedule.assumptions)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// (d) exactly-one — re-confirming the SAME provenance still yields exactly one
//     (finalizeForwardSchedule rebuilds assumptions fresh each confirm, so a
//     prior provenance is never carried forward to stack against)
// ---------------------------------------------------------------------------

describe("confirm_plan_change — re-rank provenance: exactly one, no stacking (D6.3)", () => {
    it("(d) re-confirming the same rankedAlternative does not duplicate the assumption", async () => {
        const store = new InMemoryScheduleStore();
        const session = makeSession({ scheduleStore: store });
        const ctx = makeCtx(session);

        await confirmPlanChangeTool.call(
            {
                mutations: [{ kind: "loadStyleOverride", style: "balanced" }],
                rankedAlternative: RANKED_ALTERNATIVE,
            },
            ctx,
        );
        await confirmPlanChangeTool.call(
            {
                mutations: [{ kind: "loadStyleOverride", style: "balanced" }],
                rankedAlternative: RANKED_ALTERNATIVE,
            },
            ctx,
        );

        const slot = resolvedSlot(session);
        expect(slot).toBeDefined();
        const rankedCount = slot!.assumptions.filter(
            (a) => a.type === "LLM_RANKED_ALTERNATIVE",
        ).length;
        expect(rankedCount).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// (e) compare stays read-only — no write, no persist (byte-identical session)
// ---------------------------------------------------------------------------

describe("compare_plan_alternatives — read-only (regression for D6.3)", () => {
    it("(e) compare does not mutate session bytes and does not persist", async () => {
        const store = new InMemoryScheduleStore();
        const session = makeSession({
            scheduleStore: store,
            forwardSchedule: makeMinimalFeasibleSchedule({
                alternativeCandidates: [
                    makeAlternativeCandidate({ planIndex: 0 }),
                    makeAlternativeCandidate({ planIndex: 1, graduationTerm: "2027-fall" }),
                ],
            }),
        });
        const ctx = makeCtx(session);

        const before = JSON.stringify(session);
        await comparePlanAlternativesTool.call(
            { studentStatedFactor: "I prefer graduating in fall to avoid summer work" },
            ctx,
        );
        const after = JSON.stringify(session);
        expect(after).toBe(before);

        // No write to the store either.
        const reloaded = await store.loadLatestSchedule(STUDENT_ID);
        expect(reloaded).toBeNull();
        expect(comparePlanAlternativesTool.isReadOnly).toBe(true);
    });
});
