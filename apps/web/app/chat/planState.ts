// ============================================================
// planState — single source of truth for the chat page's live
// plan state (Phase 4 Task E1.1).
// ============================================================
// Today the chat page held three INDEPENDENT `useState`s for the
// plan, written ONLY by server-push sources (SSE events +
// /api/plan/* HTTP responses). That meant a chat-driven update and
// a sidebar-driven edit could not write to the same place, and
// every consumer had to be threaded the right setter. This module
// lifts those three fields into ONE shared, subscribable store so
// chat-driven updates and sidebar-driven edits write to the SAME
// state and every consumer re-renders from it.
//
// This module is PURE TypeScript with NO React import on purpose:
//   - apps/web has no React-DOM render harness (vitest runs in the
//     node env), so the store must be unit-testable in isolation
//     (see apps/web/tests/sharedPlanState.test.ts).
//   - the `useSyncExternalStore` BINDING lives in page.tsx; this
//     module just exposes the vanilla `subscribe` / `getSnapshot`
//     surface React 19 expects.
//
// Contract for React 19's useSyncExternalStore:
//   - getSnapshot MUST return a STABLE reference when nothing has
//     changed (we keep the current snapshot in a field and return
//     it; we never allocate on a plain read), otherwise React logs
//     "getSnapshot should be cached" and can infinite-loop.
//   - each setter replaces the snapshot with a NEW object so React's
//     referential-equality check fires and consumers re-render.
//
// Scope: the three E1.1 fields + their setters, PLUS the E3.1
// "pending preview" slot appended here (the E1.1 doc left room for
// exactly one such field). The pending preview is a STAGED proposal
// the canvas overlays read-only; it is NEVER the committed plan and
// is cleared on Confirm / Cancel / Keep-as-is.
// ============================================================

import type { ForwardSchedule, PlanDiff, SchedulePreferences } from "@nyupath/shared";
import type { ForwardMaterializationPayload } from "../../lib/chatV2Client";
import type { InvalidProposalCard } from "../../lib/reviewCard";
import type { WhatIfAssumptionMarker } from "@nyupath/engine";

/**
 * Phase 4 Task E3.1 — a STAGED (not-yet-committed) plan proposal the
 * canvas previews. Pushed when a deterministic plan-action route
 * returns a feasible proposal (`forwardSchedule` + `pendingMutationId`);
 * the sidebar overlays `proposedSchedule` read-only, marked PENDING,
 * with the credit deltas. Cleared on Confirm (after the now-committed
 * plan is written) and on Cancel / Keep-as-is (without committing).
 *
 * Crucially this is a DISTINCT slot from `forwardSchedule` (the
 * committed plan): pushing a preview NEVER mutates the committed plan.
 */
export interface PendingPreview {
    /** The read-only proposed schedule the student would land on. */
    proposedSchedule: ForwardSchedule;
    /** Opaque id the Confirm round-trip hands to /api/plan/confirm. */
    pendingMutationId: string;
    /** Human-readable trade-offs / advisories surfaced by the route. */
    consequences: string[];
    /** Structured per-axis diff, when the route produced one. */
    planDiff?: PlanDiff;
    /** Which verb staged this proposal (add | swap | drop | lock | move). */
    verb?: string;
    /** G3.2 — present when this proposal is a WHAT-IF ASSUMPTION (Branch B:
     *  W/P-F). The review card shows this marker as a clearly-labelled
     *  assumption ("Assumes you withdraw from X — not yet on your DPR") so
     *  the student knows they are confirming a plan UNDER an assumption, not
     *  recording a fact. Absent for ordinary add/swap/drop/lock/move proposals. */
    whatIfAssumption?: WhatIfAssumptionMarker;
}

/**
 * The one live plan snapshot every workspace consumer reads. The first
 * three are exactly the values `<ScheduleSidebar>` is fed today
 * (`schedule`, `schedulePreferences`, `materialization`); `pendingPreview`
 * is the E3.1 staged-proposal overlay (null at rest).
 */
export interface PlanState {
    forwardSchedule: ForwardSchedule | null;
    schedulePreferences: SchedulePreferences | null;
    forwardMaterialization: ForwardMaterializationPayload | null;
    /** Phase 4 Task E3.1 — staged proposal overlay; null when no
     *  proposal is pending. NEVER the committed plan. */
    pendingPreview: PendingPreview | null;
    /** Phase 4 Task E3.3 — an engine-REJECTED (`feasible:false`)
     *  proposal's RED card: the binding constraint(s) from the
     *  response's OWN fields (conflicts ∪ feasibility.constraintViolations).
     *  Null at rest. MUTUALLY EXCLUSIVE with `pendingPreview` — an
     *  invalid proposal NEVER previews, and a feasible preview clears
     *  any stale red card. NEVER the committed plan. */
    invalidProposal: InvalidProposalCard | null;
}

/**
 * A vanilla external store compatible with React 19's
 * `useSyncExternalStore`. `subscribe` + `getSnapshot` are the two
 * React reads for; the typed setters are how chat (SSE) and sidebar
 * (HTTP) writers dispatch into the single snapshot.
 */
export interface PlanStore {
    /** Stable-reference snapshot read (never allocates on a no-op read). */
    getSnapshot(): PlanState;
    /** Register a listener; returns an unsubscribe fn. */
    subscribe(listener: () => void): () => void;
    setForwardSchedule(s: ForwardSchedule | null): void;
    setSchedulePreferences(p: SchedulePreferences | null): void;
    setForwardMaterialization(m: ForwardMaterializationPayload | null): void;
    /** E3.1 — stage a proposal overlay (NEVER touches forwardSchedule). */
    setPendingPreview(p: PendingPreview | null): void;
    /** E3.1 — clear the staged overlay (Confirm / Cancel / Keep-as-is). */
    clearPendingPreview(): void;
    /** E3.3 — stage the RED invalid-proposal card (NEVER touches
     *  forwardSchedule; mutually exclusive with pendingPreview). */
    setInvalidProposal(c: InvalidProposalCard | null): void;
    /** E3.3 — clear the RED card (Dismiss, or a later feasible preview). */
    clearInvalidProposal(): void;
}

const EMPTY_STATE: PlanState = {
    forwardSchedule: null,
    schedulePreferences: null,
    forwardMaterialization: null,
    pendingPreview: null,
    invalidProposal: null,
};

/**
 * Build a fresh plan store. Pass `initial` to seed any subset of the
 * three fields (the rest default to null).
 */
export function createPlanStore(initial?: Partial<PlanState>): PlanStore {
    // The current snapshot is held in a single field; getSnapshot returns
    // it by reference so React's caching check is satisfied. Setters swap
    // this field for a NEW object (never mutate in place) so prior snapshots
    // captured by a stale render stay frozen.
    let snapshot: PlanState = initial
        ? { ...EMPTY_STATE, ...initial }
        : EMPTY_STATE;

    const listeners = new Set<() => void>();

    function emit(): void {
        for (const listener of listeners) listener();
    }

    return {
        getSnapshot(): PlanState {
            return snapshot;
        },
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        setForwardSchedule(s: ForwardSchedule | null): void {
            // Committing a new plan supersedes ANY pending proposal card —
            // a staged preview (E3.1) or an invalid-proposal red card (E3.3)
            // both describe a proposal against the PRIOR committed plan, so
            // they are stale the moment the committed plan changes. Clearing
            // both here (the single commit chokepoint) is intentional: it
            // closes the stale-card lingering that an explicit per-call-site
            // clear would otherwise have to enumerate (clean apply, bubble
            // confirm, override-anyway, SSE forward_schedule_update, DPR
            // refresh all commit through this one setter).
            snapshot = { ...snapshot, forwardSchedule: s, pendingPreview: null, invalidProposal: null };
            emit();
        },
        setSchedulePreferences(p: SchedulePreferences | null): void {
            snapshot = { ...snapshot, schedulePreferences: p };
            emit();
        },
        setForwardMaterialization(m: ForwardMaterializationPayload | null): void {
            snapshot = { ...snapshot, forwardMaterialization: m };
            emit();
        },
        setPendingPreview(p: PendingPreview | null): void {
            // Swap ONLY the pendingPreview slot — forwardSchedule (the
            // committed plan) is carried over by reference, so staging a
            // preview can never mutate the committed plan.
            snapshot = { ...snapshot, pendingPreview: p };
            emit();
        },
        clearPendingPreview(): void {
            snapshot = { ...snapshot, pendingPreview: null };
            emit();
        },
        setInvalidProposal(c: InvalidProposalCard | null): void {
            // Swap ONLY the invalidProposal slot — forwardSchedule (the
            // committed plan) is carried over by reference, so staging a
            // red card can never mutate the committed plan.
            snapshot = { ...snapshot, invalidProposal: c };
            emit();
        },
        clearInvalidProposal(): void {
            snapshot = { ...snapshot, invalidProposal: null };
            emit();
        },
    };
}
