// ============================================================
// explainQuestion (Phase 4 Task E4.1) — scoped "Explain" question
// builder for the ⋯-menu / canvas-click → chat shortcut.
// ============================================================
// Pure, framework-agnostic helper. The React handlers in page.tsx
// (`handleExplainSlot` / `handleExplainTerm`) — and the E3.2 review
// card's "Ask why" (`handleReviewAskWhy`) — are thin consumers: they
// build a SCOPED natural-language question here, then inject it via
// the SAME pattern as `handleProposeSlotChange`:
//   addMessage('user', text) → handleSendV2(text)
// `handleSendV2` runs the NORMAL agent loop, which already composes
// the Phase-3 introspection tools (`view_forward_plan`,
// `probe_counterfactual`, the trade-off diff). There is deliberately
// NO new explanation route and NO pre-built explanation logic
// (design §2.6 forbids it) — the agent answers the question.
//
// The HUMAN term label MUST come from `formatTermLabel` (the single
// source of truth for "2027-fall" → "Fall 2027"); we never format
// terms by hand here. The COURSE CODE comes straight off the slot's
// `courseId` for the three course-carrying kinds; a `placeholder`
// names its `category` instead (no fabricated/empty code).
// ============================================================

import type { ScheduleSlot } from "@nyupath/shared";
import { formatTermLabel } from "../app/chat/shared/sidebarFormatters";

/**
 * Build the scoped "why is this slot here?" question for a single
 * slot. The COURSE CODE (for course-carrying kinds) or the placeholder
 * CATEGORY, and the HUMAN term label, both always appear.
 *
 * @param slot the slot whose ⋯ "Explain why" was clicked.
 * @param term the stored term shape (e.g. "2027-fall"); formatted via
 *   `formatTermLabel`.
 */
export function buildExplainSlotQuestion(slot: ScheduleSlot, term: string): string {
    const label = formatTermLabel(term);
    switch (slot.kind) {
        case "specific_planned":
            return `Why is ${slot.courseId} planned for ${label}?`;
        case "completed":
            // Already taken — "planned" would be wrong; phrase as a
            // history question instead.
            return `Why does ${slot.courseId} count toward my plan in ${label}?`;
        case "in_progress":
            return `Why is ${slot.courseId} in ${label}?`;
        case "placeholder":
            return `Why is there a ${slot.category} slot in ${label}?`;
        default: {
            // Exhaustiveness guard — `noImplicitReturns` is off in
            // apps/web/tsconfig.json, so without this a future 5th
            // ScheduleSlot kind would silently fall through to an
            // `undefined` return (→ addMessage('user', undefined)).
            // Matches the engine's `const _x: never = …` convention.
            const _exhaustive: never = slot;
            return `Why is this slot planned for ${label}?`;
        }
    }
}

/**
 * Build the scoped "why is this term the way it is?" question for a
 * whole term header (workload-scoped). Contains the HUMAN term label.
 *
 * @param term the stored term shape (e.g. "2027-spring").
 */
export function buildExplainTermQuestion(term: string): string {
    const label = formatTermLabel(term);
    return `Why is ${label} planned the way it is — including its workload?`;
}

/**
 * Build the scoped "why these trade-offs?" question for a STAGED
 * proposal (the E3.2 review card's "Ask why" button). `verb` is the
 * proposal's edit verb (swap / drop / lock / move / add) when known;
 * absent → a generic "this proposed change". Reuses this module so the
 * three Explain affordances (slot ⋯, term header, review-card Ask-why)
 * share one question-building surface and run through the same agent
 * loop — NO separate explanation route.
 */
export function buildExplainProposalQuestion(verb?: string): string {
    const subject = verb ? `the proposed ${verb} change` : "this proposed change";
    return `Why does ${subject} have these trade-offs? Explain the validity verdict and each trade-off, grounded in my plan.`;
}
