// ============================================================
// explainShortcut (Phase 4 Task E4.1) — scoped "Explain" question
// builder for the ⋯-menu / canvas-click → chat shortcut.
// ============================================================
// apps/web ships NO DOM render harness (no @testing-library/react,
// no jsdom — vitest runs in node), so the question-building logic is
// extracted into the pure, framework-agnostic helper
// `apps/web/lib/explainQuestion.ts` and unit-tested here directly.
// The React handlers in page.tsx (`handleExplainSlot` /
// `handleExplainTerm`) are thin consumers: they build the text via
// this helper, `addMessage('user', text)`, then `handleSendV2(text)`
// — the SAME injection pattern as `handleProposeSlotChange`. There is
// NO new explanation route; the injected question runs through the
// normal agent loop (which already composes the Phase-3 introspection
// tools).
//
// Coverage:
//   - a `specific_planned` slot → the question CONTAINS the course
//     CODE (e.g. "CSCI-UA 102") AND the HUMAN term label
//     ("Fall 2027"), proving `formatTermLabel` is used (not the raw
//     "2027-fall"). Phrased as a "why" question.
//   - a `completed` / `in_progress` slot → contains the code + the
//     human term label.
//   - a `placeholder` slot (no courseId) → a sensible scoped question
//     naming the category + the human term label, with no
//     `undefined`/empty code leaking in.
//   - `buildExplainTermQuestion` → contains the human term label.
// ============================================================

import { describe, it, expect } from "vitest";
import type { ScheduleSlot } from "@nyupath/shared";
import {
    buildExplainSlotQuestion,
    buildExplainTermQuestion,
    buildExplainProposalQuestion,
} from "../lib/explainQuestion";

// ---------------------------------------------------------------------------
// Fixtures — mirror _planRouteTestUtils.ts's specificSlot / placeholder shapes.
// ---------------------------------------------------------------------------

function specificPlannedSlot(courseId: string): ScheduleSlot {
    return {
        kind: "specific_planned",
        courseId,
        title: `${courseId} — Data Structures`,
        credits: 4,
        satisfiesRules: [],
        reason: "test fixture",
        rationale: {
            satisfiesRequirements: [],
            termConstraints: [],
            consideredAlternatives: [],
            decisionsApplied: [],
        },
        flexibility: {
            earliestPossibleTerm: "2026-fall",
            latestPossibleTerm: "2027-spring",
            alternativeCourses: [],
        },
        downstreamImpact: { courseIds: [], graduationDelay: 0 },
        workloadTier: "free-elective",
        workloadWeight: 1.0,
        bindingState: "bound",
        confidence: "historically_likely",
        isCriticalPath: false,
    };
}

function completedSlot(courseId: string): ScheduleSlot {
    return {
        kind: "completed",
        courseId,
        title: `${courseId} — Intro`,
        credits: 4,
        grade: "A",
    };
}

function inProgressSlot(courseId: string): ScheduleSlot {
    return {
        kind: "in_progress",
        courseId,
        title: `${courseId} — Intro`,
        credits: 4,
    };
}

function placeholderSlot(category: string): ScheduleSlot {
    return {
        kind: "placeholder",
        category,
        credits: 4,
        satisfiesRules: [],
        optional: false,
        reason: "test fixture",
        rationale: {
            satisfiesRequirements: [],
            termConstraints: [],
            consideredAlternatives: [],
            decisionsApplied: [],
        },
        flexibility: {
            earliestPossibleTerm: "2026-fall",
            latestPossibleTerm: "2027-spring",
            alternativeCourses: [],
        },
        downstreamImpact: { courseIds: [], graduationDelay: 0 },
        workloadTier: "free-elective",
        workloadWeight: 1.0,
        bindingState: "placeholder-pending",
        placeholderId: "ph-1",
        confidence: "historically_likely",
        isCriticalPath: false,
    };
}

// ---------------------------------------------------------------------------
// buildExplainSlotQuestion
// ---------------------------------------------------------------------------

describe("buildExplainSlotQuestion", () => {
    it("specific_planned slot → contains course code + human term label, phrased as a why-question", () => {
        const q = buildExplainSlotQuestion(specificPlannedSlot("CSCI-UA 102"), "2027-fall");
        expect(q).toContain("CSCI-UA 102");
        // The HUMAN term label must appear — proving formatTermLabel is
        // used rather than the raw stored "2027-fall".
        expect(q).toContain("Fall 2027");
        expect(q).not.toContain("2027-fall");
        expect(q.toLowerCase()).toContain("why");
        expect(q.trim().endsWith("?")).toBe(true);
    });

    it("completed slot → contains course code + human term label", () => {
        const q = buildExplainSlotQuestion(completedSlot("MATH-UA 121"), "2025-spring");
        expect(q).toContain("MATH-UA 121");
        expect(q).toContain("Spring 2025");
        expect(q).not.toContain("2025-spring");
        expect(q.toLowerCase()).toContain("why");
    });

    it("in_progress slot → contains course code + human term label", () => {
        const q = buildExplainSlotQuestion(inProgressSlot("CSCI-UA 101"), "2026-spring");
        expect(q).toContain("CSCI-UA 101");
        expect(q).toContain("Spring 2026");
        expect(q.toLowerCase()).toContain("why");
    });

    it("placeholder slot (no courseId) → scoped question with category + human term label, no undefined/empty code", () => {
        const q = buildExplainSlotQuestion(placeholderSlot("Liberal Arts Core"), "2027-fall");
        expect(q).toContain("Liberal Arts Core");
        expect(q).toContain("Fall 2027");
        expect(q).not.toContain("2027-fall");
        expect(q.toLowerCase()).toContain("why");
        // No leaked sentinel from a missing course code.
        expect(q).not.toContain("undefined");
        expect(q).not.toContain("null");
        expect(q).not.toMatch(/\bfor\s+\?/); // no empty-code "for ?" fragment
    });
});

// ---------------------------------------------------------------------------
// buildExplainTermQuestion
// ---------------------------------------------------------------------------

describe("buildExplainTermQuestion", () => {
    it("contains the human term label (not the raw stored term)", () => {
        const q = buildExplainTermQuestion("2027-spring");
        expect(q).toContain("Spring 2027");
        expect(q).not.toContain("2027-spring");
        expect(q.toLowerCase()).toContain("why");
        expect(q.trim().endsWith("?")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// buildExplainProposalQuestion (the shared surface the review card's
// "Ask why" reuses — E3.2 → E4.1)
// ---------------------------------------------------------------------------

describe("buildExplainProposalQuestion", () => {
    it("names the specific verb when known + asks for the validity verdict + trade-offs", () => {
        const q = buildExplainProposalQuestion("move");
        expect(q).toContain("move");
        expect(q.toLowerCase()).toContain("trade-off");
        expect(q.toLowerCase()).toContain("validity");
        // A two-sentence "Why …? Explain …." form — the "why" question
        // mark is mid-string, not at the end.
        expect(q).toContain("?");
        expect(q.toLowerCase()).toContain("why");
    });

    it("falls back to a generic subject when the verb is absent (no leaked undefined)", () => {
        const q = buildExplainProposalQuestion();
        expect(q).not.toContain("undefined");
        expect(q.toLowerCase()).toContain("this proposed change");
        expect(q.toLowerCase()).toContain("trade-off");
    });
});
