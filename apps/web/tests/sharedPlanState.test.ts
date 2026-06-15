// ============================================================
// sharedPlanState (Phase 4 Task E1.1) — single source of truth
// for chat-page plan state.
// ============================================================
// apps/web does NOT ship a React-DOM render harness
// (@testing-library/react / jsdom / happy-dom); vitest runs in
// the `node` environment. Per the established repo idiom (see
// planActionBubble.test.ts), the lifecycle logic lives in a
// PURE, framework-agnostic module — `apps/web/app/chat/planState.ts`
// — and this suite drives that module directly. The
// `useSyncExternalStore` binding lives in page.tsx, NOT here.
//
// This pins the E1.1 contract:
//   - ONE shared snapshot holds forwardSchedule +
//     schedulePreferences + forwardMaterialization.
//   - both a server-push (SSE) schedule update AND a sidebar
//     /api/plan/confirm-style update write to the SAME object.
//   - after a sidebar edit, a getSnapshot() read returns the
//     edited plan WITHOUT a server round-trip (purely local).
//   - the value the sidebar's `schedule` prop would receive
//     equals what was last set.
//   - subscribe listeners fire on change; getSnapshot returns a
//     STABLE reference across no-op reads (React 19 caching
//     requirement); unsubscribe stops notifications.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { createPlanStore, type PlanState } from "../app/chat/planState";
import type { ForwardSchedule, SchedulePreferences } from "@nyupath/shared";
import type { ForwardMaterializationPayload } from "../lib/chatV2Client";

// ---------------------------------------------------------------------------
// Fixtures — minimal but real-shaped; we only assert identity/reference
// behavior, so the exact field set is not load-bearing here. We cast
// through `unknown` to keep the fixtures small while still typing the
// store with the real types (which is the actual contract under test).
// ---------------------------------------------------------------------------

function makeSchedule(graduationTerm: string): ForwardSchedule {
    return {
        graduationTerm,
        terms: [],
    } as unknown as ForwardSchedule;
}

function makePreferences(): SchedulePreferences {
    return {
        pins: [],
    } as unknown as SchedulePreferences;
}

function makeMaterialization(targetTerm: string): ForwardMaterializationPayload {
    return {
        targetTerm,
        computedAt: 1,
    } as unknown as ForwardMaterializationPayload;
}

// ===========================================================================
// Initial snapshot
// ===========================================================================

describe("createPlanStore — initial state", () => {
    it("defaults all three fields to null", () => {
        const store = createPlanStore();
        const snap = store.getSnapshot();
        expect(snap.forwardSchedule).toBeNull();
        expect(snap.schedulePreferences).toBeNull();
        expect(snap.forwardMaterialization).toBeNull();
    });

    it("accepts a partial initial state", () => {
        const sched = makeSchedule("2028-spring");
        const store = createPlanStore({ forwardSchedule: sched });
        const snap = store.getSnapshot();
        expect(snap.forwardSchedule).toBe(sched);
        expect(snap.schedulePreferences).toBeNull();
        expect(snap.forwardMaterialization).toBeNull();
    });
});

// ===========================================================================
// (a) Both an SSE schedule update AND a sidebar-confirm schedule update land
//     on ONE state object — there is only one source of truth.
// ===========================================================================

describe("single source of truth (E1.1 core)", () => {
    it("an SSE-style update and a sidebar-confirm-style update both write the same snapshot", () => {
        const store = createPlanStore();

        // Server-push (SSE `forward_schedule_update`) path.
        const sseSchedule = makeSchedule("2028-spring");
        store.setForwardSchedule(sseSchedule);
        expect(store.getSnapshot().forwardSchedule).toBe(sseSchedule);

        // Sidebar-driven (/api/plan/confirm result) path writes the SAME field.
        const sidebarSchedule = makeSchedule("2027-fall");
        store.setForwardSchedule(sidebarSchedule);
        const snap = store.getSnapshot();
        expect(snap.forwardSchedule).toBe(sidebarSchedule);
        // The SSE value is fully replaced — there is no second, divergent copy.
        expect(snap.forwardSchedule).not.toBe(sseSchedule);
    });

    it("independent fields coexist on the same snapshot object", () => {
        const store = createPlanStore();
        const sched = makeSchedule("2028-spring");
        const prefs = makePreferences();
        const mat = makeMaterialization("2026-fall");

        store.setForwardSchedule(sched);
        store.setSchedulePreferences(prefs);
        store.setForwardMaterialization(mat);

        const snap = store.getSnapshot();
        expect(snap.forwardSchedule).toBe(sched);
        expect(snap.schedulePreferences).toBe(prefs);
        expect(snap.forwardMaterialization).toBe(mat);
    });
});

// ===========================================================================
// (b) After a sidebar edit, a read returns the edited plan with NO server
//     round-trip — the store is purely synchronous/local.
// ===========================================================================

describe("local read-back (no server round-trip)", () => {
    it("setForwardSchedule is synchronous: the next getSnapshot reflects the edit", () => {
        const store = createPlanStore();
        // No fetch is mocked or available; if the store reached for the
        // network this read would not see the edit.
        const edited = makeSchedule("2025-spring");
        store.setForwardSchedule(edited);
        expect(store.getSnapshot().forwardSchedule).toBe(edited);
    });

    it("a sidebar edit is visible without awaiting anything", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("orig") });
        const edited = makeSchedule("edited");
        store.setForwardSchedule(edited);
        // Purely synchronous read — no await, no microtask flush.
        expect(store.getSnapshot().forwardSchedule).toBe(edited);
    });
});

// ===========================================================================
// (c) The value the sidebar's `schedule` prop would receive equals what was
//     last set into the store.
// ===========================================================================

describe("sidebar prop parity", () => {
    it("the snapshot's three sidebar-facing values equal the last writes", () => {
        const store = createPlanStore();
        const sched = makeSchedule("2028-spring");
        const prefs = makePreferences();
        const mat = makeMaterialization("2026-fall");
        store.setForwardSchedule(sched);
        store.setSchedulePreferences(prefs);
        store.setForwardMaterialization(mat);

        // These are exactly the three props ScheduleSidebar reads:
        //   schedule={…} schedulePreferences={…} materialization={…}
        const snap = store.getSnapshot();
        const sidebarProps = {
            schedule: snap.forwardSchedule,
            schedulePreferences: snap.schedulePreferences,
            materialization: snap.forwardMaterialization,
        };
        expect(sidebarProps.schedule).toBe(sched);
        expect(sidebarProps.schedulePreferences).toBe(prefs);
        expect(sidebarProps.materialization).toBe(mat);
    });
});

// ===========================================================================
// useSyncExternalStore contract: immutable snapshots, stable reference,
// listener notifications, unsubscribe.
// ===========================================================================

describe("useSyncExternalStore contract", () => {
    it("each setter produces a NEW snapshot object (referential change fires React)", () => {
        const store = createPlanStore();
        const before = store.getSnapshot();
        store.setForwardSchedule(makeSchedule("2028-spring"));
        const after = store.getSnapshot();
        expect(after).not.toBe(before);
    });

    it("getSnapshot returns a STABLE reference across no-op reads (React 19 caching)", () => {
        const store = createPlanStore();
        const a = store.getSnapshot();
        const b = store.getSnapshot();
        // No setter ran between reads → same object reference. Allocating
        // a fresh object here would trigger React's "getSnapshot should be
        // cached" infinite-loop warning.
        expect(b).toBe(a);
    });

    it("subscribe listeners fire on every change", () => {
        const store = createPlanStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.setForwardSchedule(makeSchedule("a"));
        store.setSchedulePreferences(makePreferences());
        store.setForwardMaterialization(makeMaterialization("t"));
        expect(listener).toHaveBeenCalledTimes(3);
    });

    it("unsubscribe stops further notifications", () => {
        const store = createPlanStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        store.setForwardSchedule(makeSchedule("a"));
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        store.setForwardSchedule(makeSchedule("b"));
        // No additional calls after unsubscribe.
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("multiple subscribers all receive notifications independently", () => {
        const store = createPlanStore();
        const l1 = vi.fn();
        const l2 = vi.fn();
        store.subscribe(l1);
        const unsub2 = store.subscribe(l2);
        store.setForwardSchedule(makeSchedule("a"));
        expect(l1).toHaveBeenCalledTimes(1);
        expect(l2).toHaveBeenCalledTimes(1);
        unsub2();
        store.setForwardSchedule(makeSchedule("b"));
        expect(l1).toHaveBeenCalledTimes(2);
        expect(l2).toHaveBeenCalledTimes(1);
    });

    it("setting a field to null is a real change (clear-on-reset)", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("x") });
        const listener = vi.fn();
        store.subscribe(listener);
        const before = store.getSnapshot();
        store.setForwardSchedule(null);
        const after = store.getSnapshot();
        expect(after.forwardSchedule).toBeNull();
        expect(after).not.toBe(before);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("a snapshot is not mutated in place by a later setter (immutability)", () => {
        const store = createPlanStore();
        const first = store.getSnapshot();
        expect(first.forwardSchedule).toBeNull();
        store.setForwardSchedule(makeSchedule("later"));
        // The previously-captured snapshot is frozen at its old value —
        // a stale React render holding `first` must not see the new write.
        expect(first.forwardSchedule).toBeNull();
    });
});

// Type-level assertion: the store is typed with the REAL types, not
// redefined locals. If these drift, tsc fails the build.
const _typecheck: PlanState = {
    forwardSchedule: null,
    schedulePreferences: null,
    forwardMaterialization: null,
    // Phase 4 Task E3.1 — the appended staged-proposal overlay slot.
    pendingPreview: null,
};
void _typecheck;
