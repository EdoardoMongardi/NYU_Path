// ============================================================
// D1.2 — Explain-why affordance eval
// ============================================================
// Proves the agent answers "why is course X planned for term Y?" by
// COMPOSING the existing `view_forward_plan` tool (its detail:"rich"
// mode carries the recorded rationale) — NOT via a new keyword-routed
// handler. The affordance was wired by D1.1 (rich slot detail in
// view_forward_plan) + D4.1 (CORE RULE 9 directs the agent to explain
// WHY citing the recorded rationale). THIS file PROVES the composition
// works and that the agent cites the recorded reason WITHOUT
// fabricating one.
//
// Two layers, mirroring planClaims.eval.ts / preferenceExtraction.eval.ts:
//
//   PART 1 — deterministic affordance pin (runs in CI, no API key).
//     Builds a ForwardSchedule with a specific_planned slot carrying a
//     KNOWN `reason` + flexibility window + isCriticalPath, drives
//     view_forward_plan with { detail: "rich" } over a session carrying
//     that schedule, and asserts the tool output CONTAINS the recorded
//     reason string + the flexibility terms — i.e. the explain-why
//     material the agent would cite is REACHABLE through the tool. This
//     is the "compose, don't fabricate" DATA CONTRACT; no LLM needed.
//     Also a light wiring check: the tool description references rich
//     detail for "why" questions (so the affordance is discoverable).
//
//   PART 2 — ANTHROPIC_API_KEY-gated real-LLM agent-loop eval.
//     Drives a REAL agent turn (runAgentTurn + buildDefaultRegistry +
//     buildSystemPrompt over a ToolSession carrying the fixture
//     forwardSchedule) asking "Why is CSCI-UA 102 planned for <term>?"
//     and asserts the final reply (a) CITES the slot's recorded reason
//     and/or flexibility window, (b) did so by CALLING view_forward_plan
//     (composition, not a hardcoded handler), and (c) does NOT fabricate
//     a different rationale. Gated so it never runs in CI (no API key).
//
// Tier note: a plan-placement rationale is Tier-1 (engine-grounded).
// The reason text is RECORDED in the slot; the agent must cite it, not
// invent one ("because the professor is good" is a fabrication).
// ============================================================

import { describe, expect, it } from "vitest";
import type {
    ForwardSchedule,
    ForwardSemester,
    LoadRationale,
    ScheduleSlot,
    ScheduleSlotCompleted,
    ScheduleSlotSpecificPlanned,
} from "@nyupath/shared";
import { viewForwardPlanTool } from "../../src/agent/tools/viewForwardPlan.js";
import type { ToolSession, ToolUseContext } from "../../src/agent/tool.js";

// ============================================================
// Known explain-why facts — the load-bearing strings the agent
// must cite VERBATIM (and the term we ask about).
// ============================================================

/** The course the explain-why question is about. */
export const TARGET_COURSE = "CSCI-UA 102";
/** The term the target course sits in (solver-term code + human label). */
export const TARGET_TERM = "2027-fall";
export const TARGET_TERM_HUMAN = "Fall 2027";

/** The RECORDED rationale on the slot — the WHY. The agent must cite
 *  this (exact or near-verbatim), never invent a different reason. */
export const RECORDED_REASON =
    "placed in 2027-fall to satisfy the CS-required core before its dependents; " +
    "earliest it can sit given its prerequisite CSCI-UA 101";

/** The flexibility window recorded on the slot. */
export const FLEX_EARLIEST = "2027-fall";
export const FLEX_LATEST = "2028-spring";
export const FLEX_ALTERNATIVE = "CSCI-UA 310";

// ============================================================
// Fixture — a valid ForwardSchedule with a fully-populated
// specific_planned slot carrying the recorded reason + flexibility.
// ============================================================
//
// The rich-mode renderer (viewForwardPlan.ts:appendRichSlot) reads the
// full ScheduleSlotSpecificPlanned shape (reason, rationale,
// flexibility, downstreamImpact, workloadTier, isCriticalPath), so we
// build a REAL slot (not a minimal cast) — this is the data contract
// under test.

const LOAD_RATIONALE: LoadRationale = {
    strategy: "balanced",
    creditsTarget: 16,
    slack: 0,
    weightedCredits: 4,
    hardCount: 1,
    easyCount: 0,
    alternativeDistributionsConsidered: [],
};

function completedSlot(courseId: string): ScheduleSlotCompleted {
    return { kind: "completed", courseId, title: courseId, credits: 4, grade: "A" };
}

/** The target slot — CSCI-UA 102 in 2027-fall, critical path, with the
 *  recorded reason + flexibility window the agent must cite. */
function targetSlot(): ScheduleSlotSpecificPlanned {
    return {
        kind: "specific_planned",
        courseId: TARGET_COURSE,
        title: "Data Structures",
        credits: 4,
        satisfiesRules: ["cs_core_data_structures"],
        reason: RECORDED_REASON,
        rationale: {
            satisfiesRequirements: ["cs_core_data_structures"],
            termConstraints: [
                { kind: "prereqChain", detail: "requires CSCI-UA 101 (completed 2025-fall)" },
            ],
            consideredAlternatives: [],
            decisionsApplied: [],
        },
        flexibility: {
            earliestPossibleTerm: FLEX_EARLIEST,
            latestPossibleTerm: FLEX_LATEST,
            alternativeCourses: [FLEX_ALTERNATIVE],
        },
        downstreamImpact: {
            courseIds: ["CSCI-UA 201"],
            graduationDelay: 1,
        },
        workloadTier: "major-required",
        workloadWeight: 1.2,
        bindingState: "bound",
        confidence: "high",
        isCriticalPath: true,
    };
}

function semester(term: string, locked: boolean, slots: ScheduleSlot[]): ForwardSemester {
    return {
        term,
        locked,
        slots,
        plannedCredits: slots.reduce((sum, s) => sum + ("credits" in s ? s.credits : 0), 0),
        notes: [],
        loadRationale: LOAD_RATIONALE,
    };
}

export function makeExplainWhySchedule(): ForwardSchedule {
    return {
        studentId: "stu-explain-why",
        homeSchoolId: "cas",
        graduationTerm: "2028-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: null,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters: [
            semester("2025-fall", true, [completedSlot("CSCI-UA 101")]),
            semester(TARGET_TERM, false, [targetSlot()]),
        ],
        dprCourseHistoryHash: "sha256:explain-why",
        computedAt: 1_746_000_000_000,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
}

export const EXPLAIN_WHY_SCHEDULE: ForwardSchedule = makeExplainWhySchedule();

/** Plain-English ground truth — used in PART 2's user-visible question
 *  context only as a sanity reference; the AGENT must reach the reason
 *  through the tool, not from this string. */
export const EXPLAIN_WHY_GROUND_TRUTH = [
    `${TARGET_COURSE} (Data Structures) is planned for ${TARGET_TERM_HUMAN}.`,
    `Recorded reason: ${RECORDED_REASON}.`,
    `Flexibility: earliest ${FLEX_EARLIEST} → latest ${FLEX_LATEST}; alternative ${FLEX_ALTERNATIVE}.`,
    `It is on the critical path.`,
].join("\n");

// ============================================================
// PART 1 — deterministic affordance pin (runs in CI, no API key).
// The explain-why material must be REACHABLE through the tool.
// ============================================================

function makeCtx(session: ToolSession): ToolUseContext {
    return { signal: new AbortController().signal, session };
}

describe("explainWhy eval — affordance pin (the compose-don't-fabricate data contract)", () => {
    it("view_forward_plan rich surfaces the slot's RECORDED reason verbatim (the WHY the agent cites)", async () => {
        const session: ToolSession = { forwardSchedule: EXPLAIN_WHY_SCHEDULE };
        const output = await viewForwardPlanTool.call({ detail: "rich" }, makeCtx(session));
        const summary = viewForwardPlanTool.summarizeResult(output);

        // The recorded reason (the load-bearing WHY) is present verbatim,
        // so the agent can cite it without inventing one.
        expect(
            summary,
            `rich summary must contain the recorded reason so the agent can cite it. Summary:\n${summary}`,
        ).toContain(RECORDED_REASON);
        // And it is attached to the right course.
        expect(summary).toContain(TARGET_COURSE);
    });

    it("view_forward_plan rich surfaces the flexibility window (earliest/latest + alternative)", async () => {
        const session: ToolSession = { forwardSchedule: EXPLAIN_WHY_SCHEDULE };
        const output = await viewForwardPlanTool.call({ detail: "rich" }, makeCtx(session));
        const summary = viewForwardPlanTool.summarizeResult(output);

        expect(summary, `rich summary must surface earliest term. Summary:\n${summary}`).toContain(FLEX_EARLIEST);
        expect(summary, `rich summary must surface latest term. Summary:\n${summary}`).toContain(FLEX_LATEST);
        expect(summary, `rich summary must surface the alternative course. Summary:\n${summary}`).toContain(
            FLEX_ALTERNATIVE,
        );
        // The critical-path flag is part of the explain-why material too.
        expect(summary.toLowerCase()).toContain("critical path");
    });

    it("the recorded reason is NOT reachable in terse mode — rich is required (so the affordance is detail-gated)", async () => {
        const session: ToolSession = { forwardSchedule: EXPLAIN_WHY_SCHEDULE };
        const terse = viewForwardPlanTool.summarizeResult(
            await viewForwardPlanTool.call({ detail: "terse" }, makeCtx(session)),
        );
        // Terse mode is the compact one-line-per-term view — it must NOT
        // carry the recorded reason. This is WHY the model must reach for
        // detail:"rich" to answer a "why" question (proves the gating).
        expect(
            terse,
            `terse mode must NOT carry the recorded reason (rich-only). Terse:\n${terse}`,
        ).not.toContain(RECORDED_REASON);
    });

    it("the tool description advertises rich detail for 'why is <course> in <term>?' questions (discoverability wiring)", () => {
        const desc = viewForwardPlanTool.description;
        // The model routes from the tool description (no central router),
        // so the affordance must be discoverable there.
        expect(desc.toLowerCase()).toContain("rich");
        expect(desc.toLowerCase()).toContain("why is");
        // And it must tell the model to CITE the recorded reason, not invent one.
        expect(desc.toLowerCase()).toContain("never invent");
    });
});

// ============================================================
// PART 2 — ANTHROPIC_API_KEY-gated real-LLM agent-loop eval.
// Drives a REAL agent turn over a session carrying the fixture
// schedule and asserts cite-not-fabricate + the view_forward_plan
// invocation. Gated so it never runs in CI (no API key).
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... npx vitest run packages/engine/tests/agent/explainWhy.eval.ts
//   ANTHROPIC_API_KEY=sk-... npx tsx   packages/engine/tests/agent/explainWhy.eval.ts
// ============================================================

export interface ExplainWhyTurnResult {
    reply: string;
    invokedTools: string[];
    /** Load-bearing content of the recorded reason appears in the reply. */
    citesRecordedReason: boolean;
    /** The flexibility window (earliest/latest/alternative) appears. */
    citesFlexibility: boolean;
    /** The agent reached the answer by calling view_forward_plan. */
    calledViewForwardPlan: boolean;
    /** A fabricated, non-recorded rationale was detected in the reply. */
    fabricated: boolean;
}

// Phrases that would indicate an INVENTED rationale absent from the
// recorded slot (the "because the professor is good" failure mode).
const FABRICATION_MARKERS = [
    "professor is good",
    "professor is great",
    "highly rated",
    "best instructor",
    "easier in the fall",
    "more fun",
    "popular course",
    "good reviews",
];

/** True if the reply reproduces the load-bearing content of the recorded
 *  reason (prereq-gated earliest placement before dependents). We check
 *  for the distinctive substrings rather than exact-string equality so
 *  near-verbatim paraphrase that preserves the meaning still passes. */
function replyCitesRecordedReason(reply: string): boolean {
    const r = reply.toLowerCase();
    const mentionsPrereq = r.includes("csci-ua 101") || r.includes("prerequisite") || r.includes("prereq");
    const mentionsEarliest =
        r.includes("earliest") || r.includes("earliest it can") || r.includes("before its dependent") ||
        r.includes("can't sit") || r.includes("cannot sit") || r.includes("can't be placed") ||
        r.includes("before its dependents");
    // Either the exact recorded string OR (prereq + earliest-placement)
    // semantics — both prove the agent surfaced the recorded WHY.
    return reply.includes(RECORDED_REASON) || (mentionsPrereq && mentionsEarliest);
}

function replyCitesFlexibility(reply: string): boolean {
    const r = reply.toLowerCase();
    return (
        reply.includes(FLEX_LATEST) ||
        reply.includes(FLEX_ALTERNATIVE) ||
        r.includes("earliest") ||
        r.includes("latest")
    );
}

function replyFabricates(reply: string): boolean {
    const r = reply.toLowerCase();
    return FABRICATION_MARKERS.some((m) => r.includes(m));
}

/** Drive ONE real agent turn over a session carrying the fixture
 *  forwardSchedule, asking the explain-why question. */
export async function runExplainWhyTurn(): Promise<ExplainWhyTurnResult> {
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error(
            "ANTHROPIC_API_KEY is not set. Set it to run the explain-why agent-loop eval.",
        );
    }

    // Lazy imports — the SDK + agent loop are only needed when running
    // with the API key, so the file compiles + PART 1 runs without them.
    const { runAgentTurn, buildDefaultRegistry, buildSystemPrompt } = await import(
        "../../src/agent/index.js"
    );
    const { AnthropicEngineClient, DEFAULT_PRIMARY_MODEL } = await import(
        "../../src/agent/clients/index.js"
    );

    const client = new AnthropicEngineClient({
        modelId: process.env.NYUPATH_PRIMARY_MODEL ?? DEFAULT_PRIMARY_MODEL,
        apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Session carries the fixture forwardSchedule — the agent must reach
    // the recorded reason through view_forward_plan (rich), not a router.
    const session: ToolSession = { forwardSchedule: EXPLAIN_WHY_SCHEDULE };
    const systemPrompt = buildSystemPrompt({
        graduationTerm: "Spring 2028",
        today: new Date().toISOString().split("T")[0],
    });

    const result = await runAgentTurn(
        client,
        buildDefaultRegistry(),
        session,
        `Why is ${TARGET_COURSE} planned for ${TARGET_TERM_HUMAN}?`,
        { systemPrompt, maxTurns: 6 },
    );

    const reply = result.kind === "ok" || result.kind === "context_limit" ? result.finalText : "";
    const invokedTools = result.invocations.map((i) => i.toolName);

    return {
        reply,
        invokedTools,
        citesRecordedReason: replyCitesRecordedReason(reply),
        citesFlexibility: replyCitesFlexibility(reply),
        calledViewForwardPlan: invokedTools.includes("view_forward_plan"),
        fabricated: replyFabricates(reply),
    };
}

describe("explainWhy eval — real-LLM agent-loop (gated on ANTHROPIC_API_KEY)", () => {
    if (!process.env.ANTHROPIC_API_KEY) {
        it.skip("requires ANTHROPIC_API_KEY — agent composes view_forward_plan rich + cites recorded reason", () => {
            /* gated: no API key in this environment */
        });
        return;
    }

    it("agent answers 'why is <course> in <term>?' by composing view_forward_plan rich and citing the recorded reason (no fabrication)", async () => {
        const res = await runExplainWhyTurn();

        // Log the prompt + reply on any failure so the operator can see
        // exactly what the model produced.
        const logOnFail = () => {
            console.error(
                `EXPLAIN-WHY TURN\n` +
                    `  question: Why is ${TARGET_COURSE} planned for ${TARGET_TERM_HUMAN}?\n` +
                    `  tools called: [${res.invokedTools.join(", ")}]\n` +
                    `  reply: ${res.reply}`,
            );
        };

        // (b) Composition: the agent reached the answer through the tool,
        // NOT a hardcoded keyword handler.
        if (!res.calledViewForwardPlan) logOnFail();
        expect(
            res.calledViewForwardPlan,
            `agent must call view_forward_plan (composition, not a hardcoded handler); tools: [${res.invokedTools.join(", ")}]`,
        ).toBe(true);

        // (a) Cite: the load-bearing recorded reason and/or flexibility
        // window appears in the reply.
        if (!(res.citesRecordedReason || res.citesFlexibility)) logOnFail();
        expect(
            res.citesRecordedReason || res.citesFlexibility,
            "reply must cite the recorded reason (prereq-gated earliest placement) and/or the flexibility window",
        ).toBe(true);

        // (c) No fabrication: no invented, non-recorded rationale.
        if (res.fabricated) logOnFail();
        expect(
            res.fabricated,
            "reply must NOT fabricate a rationale absent from the recorded slot",
        ).toBe(false);
    }, 60_000);
});

// ============================================================
// Direct-invocation entry (tsx) — prints the turn result.
//   ANTHROPIC_API_KEY=sk-... npx tsx packages/engine/tests/agent/explainWhy.eval.ts
// The package is ESM ("type":"module"), so require.main is never set;
// the ANTHROPIC_API_KEY gate is the run condition (same pattern as
// planClaims.eval.ts / preferenceExtraction.eval.ts).
// ============================================================
if (process.env.ANTHROPIC_API_KEY) {
    runExplainWhyTurn()
        .then((res) => {
            console.log("\n=== Explain-why agent-loop eval (D1.2) ===\n");
            console.log(`question: Why is ${TARGET_COURSE} planned for ${TARGET_TERM_HUMAN}?`);
            console.log(`tools called: [${res.invokedTools.join(", ")}]`);
            console.log(`called view_forward_plan: ${res.calledViewForwardPlan ? "yes" : "NO"}`);
            console.log(`cites recorded reason: ${res.citesRecordedReason ? "yes" : "no"}`);
            console.log(`cites flexibility: ${res.citesFlexibility ? "yes" : "no"}`);
            console.log(`fabricated: ${res.fabricated ? "YES (BAD)" : "no"}`);
            console.log(`\nreply:\n${res.reply}\n`);
            const pass =
                res.calledViewForwardPlan &&
                (res.citesRecordedReason || res.citesFlexibility) &&
                !res.fabricated;
            console.log(pass ? "PASS" : "FAIL");
            if (!pass) process.exit(1);
        })
        .catch((err) => {
            console.error("Explain-why eval failed:", err);
            process.exit(1);
        });
}
