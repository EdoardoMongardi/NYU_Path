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
// Scope (E1.1 only): the three existing fields + the setters. New
// slots (e.g. the E3.1 "pending preview") are deliberately NOT added
// here, but the shape is open for one field to be appended later.
// ============================================================

import type { ForwardSchedule, SchedulePreferences } from "@nyupath/shared";
import type { ForwardMaterializationPayload } from "../../lib/chatV2Client";

/**
 * The one live plan snapshot every workspace consumer reads. These
 * are exactly the three values `<ScheduleSidebar>` is fed today
 * (`schedule`, `schedulePreferences`, `materialization`).
 */
export interface PlanState {
    forwardSchedule: ForwardSchedule | null;
    schedulePreferences: SchedulePreferences | null;
    forwardMaterialization: ForwardMaterializationPayload | null;
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
}

const EMPTY_STATE: PlanState = {
    forwardSchedule: null,
    schedulePreferences: null,
    forwardMaterialization: null,
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
            snapshot = { ...snapshot, forwardSchedule: s };
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
    };
}
