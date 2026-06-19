// ============================================================
// planState — single source of truth for the chat page's live
// plan state.
// ============================================================
// ORIGIN (Phase 4 Task E1.1). The chat page once held three
// INDEPENDENT `useState`s for the plan, written ONLY by server-push
// sources (SSE events + /api/plan/* HTTP responses). That meant a
// chat-driven update and a sidebar-driven edit could not write to the
// same place, and every consumer had to be threaded the right setter.
// E1.1 lifted those three fields into ONE shared, subscribable store;
// E3.1/E3.3 appended the staged-proposal preview + the invalid-proposal
// red card.
//
// H0.2 (plan 36 — scenarios workspace). The store's INTERNAL state is
// now the pure `ScenarioState` model (apps/web/lib/scenarios/scenarioModel.ts:
// a committed anchor + a list of proposed/whatif scenarios + an activeId
// + a compare pair) PLUS the two orthogonal fields the scenario model
// does NOT own (`schedulePreferences`, `forwardMaterialization`). The
// state-transition logic lives in the model's PURE reducers — this module
// only wraps them in a `useSyncExternalStore`-compatible subscribe/snapshot
// surface and exposes BOTH:
//   - the NEW scenario API (setCommitted/addScenario/setActive/openCompare/
//     closeCompare/discardScenario/confirmProposed/setInvalidProposal +
//     selectors getCommitted/getScenarios/getActiveScenario/getScenarioState),
//   - a backward-COMPAT facade (the original `PlanState` snapshot shape +
//     the original setters) so the pre-H2 consumers (page.tsx, the sidebar)
//     and the existing tests keep working UNCHANGED. The 3-zone UI that
//     fully adopts the scenario model is a LATER task (H2/H4/H5); H0.2 only
//     lands the foundation and keeps everything green.
//
// This module is PURE TypeScript with NO React import on purpose:
//   - apps/web has no React-DOM render harness (vitest runs in the
//     node env), so the store must be unit-testable in isolation
//     (see apps/web/tests/sharedPlanState.test.ts + planStore.scenarios.test.ts).
//   - the `useSyncExternalStore` BINDING lives in page.tsx; this
//     module just exposes the vanilla `subscribe` / `getSnapshot`
//     surface React 19 expects.
//
// Contract for React 19's useSyncExternalStore:
//   - getSnapshot MUST return a STABLE reference when nothing has
//     changed (we materialize the compat snapshot ONCE per mutation
//     and return that cached object on every plain read), otherwise
//     React logs "getSnapshot should be cached" and can infinite-loop.
//   - each mutation re-materializes the snapshot as a NEW object so
//     React's referential-equality check fires and consumers re-render.
// ============================================================

import type { ForwardSchedule, PlanDiff, SchedulePreferences } from "@nyupath/shared";
import type { ForwardMaterializationPayload } from "../../lib/chatV2Client";
import type { InvalidProposalCard } from "../../lib/reviewCard";
import type { WhatIfAssumptionMarker } from "@nyupath/engine";
import {
    initialState,
    setCommitted as reduceSetCommitted,
    addScenario as reduceAddScenario,
    setActive as reduceSetActive,
    openCompare as reduceOpenCompare,
    closeCompare as reduceCloseCompare,
    discardScenario as reduceDiscardScenario,
    confirmProposed as reduceConfirmProposed,
    setInvalidProposal as reduceSetInvalidProposal,
    activeScenario,
    type Scenario,
    type ScenarioState,
} from "../../lib/scenarios/scenarioModel";

// Re-export the scenario-model types so consumers of the new store API can
// import them from a single place (the store) without reaching into the model.
export type { Scenario, ScenarioState } from "../../lib/scenarios/scenarioModel";

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
 *
 * H0.2 — in the scenario model a preview is a `kind:"proposed"` scenario;
 * this `PendingPreview` is the COMPAT view the legacy consumers still read.
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
 * The one live plan snapshot every LEGACY workspace consumer reads (the
 * backward-COMPAT facade — see the module header). The first three are
 * exactly the values `<ScheduleSidebar>` is fed today (`schedule`,
 * `schedulePreferences`, `materialization`); `pendingPreview` is the
 * E3.1 staged-proposal overlay (null at rest), DERIVED from the active
 * `kind:"proposed"` scenario; `invalidProposal` is the model's red card.
 *
 * H0.2 derivation: `forwardSchedule ⇐ scenario.committed`;
 * `pendingPreview ⇐` the active scenario when it is `kind:"proposed"`
 * (else null); `invalidProposal ⇐ scenario.invalidProposal`.
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
 *
 * Exposes BOTH the backward-COMPAT facade (the original `PlanState`
 * snapshot + original setters) AND the H0.2 scenario API.
 */
export interface PlanStore {
    // ---- React 19 useSyncExternalStore surface ----
    /** Stable-reference COMPAT snapshot read (never allocates on a no-op read). */
    getSnapshot(): PlanState;
    /** Register a listener; returns an unsubscribe fn. */
    subscribe(listener: () => void): () => void;

    // ---- backward-COMPAT facade (legacy setters; unchanged semantics) ----
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

    // ---- H0.2 scenario API (thin wrappers over scenarioModel reducers) ----
    /** Replace the committed anchor schedule (does NOT clear scenarios). */
    setCommitted(schedule: ForwardSchedule): void;
    /** Append (or replace by id) a scenario; makes it active; clears compare. */
    addScenario(scenario: Scenario): void;
    /** Set the active tab ("committed" or a scenario id); clears compare. */
    setActive(id: string): void;
    /** Open the side-by-side compare view. */
    openCompare(leftId: string, rightId: string): void;
    /** Close the compare view. */
    closeCompare(): void;
    /** Remove a scenario by id (no-op if absent; falls back to "committed"). */
    discardScenario(id: string): void;
    /** Confirm a proposed scenario — commits its schedule, drops it, active→committed. */
    confirmProposed(id: string): void;

    // ---- H0.2 scenario selectors ----
    /** The committed anchor schedule (null when no DPR loaded). */
    getCommitted(): ForwardSchedule | null;
    /** The proposed + whatif scenarios (NOT the committed anchor). */
    getScenarios(): Scenario[];
    /** Resolve the currently-active scenario (or undefined). */
    getActiveScenario(): Scenario | undefined;
    /** The full underlying scenario state (for compare-view consumers). */
    getScenarioState(): ScenarioState;
}

// ---------------------------------------------------------------------------
// Internal store state: the scenario model + the two orthogonal fields the
// model does not own, + a side-table preserving the EXACT PendingPreview
// object a legacy `setPendingPreview` was handed (the scenario model's
// `Scenario` has no PendingPreview slot, but the compat facade's identity
// contract — `getSnapshot().pendingPreview === the object passed in` — must
// be preserved, so we stash it here keyed by the proposed scenario's id).
// ---------------------------------------------------------------------------

/** A monotonically-increasing id for compat-facade-staged previews. */
let previewSeq = 0;

/**
 * Build a fresh plan store. Pass `initial` to seed any subset of the
 * legacy `PlanState` fields (the rest default to null). The `initial`
 * fields are mapped onto the scenario model:
 *   - `forwardSchedule` → the committed anchor,
 *   - `pendingPreview` → a staged proposed scenario (active),
 *   - `invalidProposal` → the model's red card,
 *   - `schedulePreferences` / `forwardMaterialization` → orthogonal fields.
 */
export function createPlanStore(initial?: Partial<PlanState>): PlanStore {
    // --- core scenario state (pure model) ---
    let scenario: ScenarioState = initialState(initial?.forwardSchedule ?? null);
    if (initial?.invalidProposal != null) {
        scenario = reduceSetInvalidProposal(scenario, initial.invalidProposal);
    }

    // --- orthogonal fields the scenario model does not own ---
    let schedulePreferences: SchedulePreferences | null = initial?.schedulePreferences ?? null;
    let forwardMaterialization: ForwardMaterializationPayload | null =
        initial?.forwardMaterialization ?? null;

    // --- side-table: proposed-scenario id → the exact PendingPreview object ---
    const previewObjects = new Map<string, PendingPreview>();

    // Seed an initial pendingPreview (if any) as a proposed scenario.
    if (initial?.pendingPreview != null) {
        const id = `preview-${previewSeq++}`;
        previewObjects.set(id, initial.pendingPreview);
        scenario = reduceAddScenario(scenario, previewToScenario(id, initial.pendingPreview));
    }

    const listeners = new Set<() => void>();

    // The cached COMPAT snapshot — materialized once per mutation, returned
    // by reference on every plain read (React 19 caching requirement).
    let snapshot: PlanState = materialize();

    function materialize(): PlanState {
        const active = activeScenario(scenario);
        const pendingPreview =
            active && active.kind === "proposed"
                ? previewObjects.get(active.id) ?? scenarioToPreview(active)
                : null;
        return {
            forwardSchedule: scenario.committed,
            schedulePreferences,
            forwardMaterialization,
            pendingPreview,
            invalidProposal: scenario.invalidProposal,
        };
    }

    /** Re-materialize the compat snapshot and notify subscribers. */
    function commit(): void {
        snapshot = materialize();
        for (const listener of listeners) listener();
    }

    /**
     * Apply a scenario-model reducer. If it returns the SAME reference (a
     * model no-op, e.g. discarding an absent scenario), we skip the commit
     * so subscribers don't needlessly re-render (referential stability).
     */
    function applyScenario(next: ScenarioState): void {
        if (next === scenario) return;
        scenario = next;
        commit();
    }

    return {
        // ---- React surface ----
        getSnapshot(): PlanState {
            return snapshot;
        },
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        // ---- backward-COMPAT facade ----
        setForwardSchedule(s: ForwardSchedule | null): void {
            // Decision #32 STATE-ROUTING (M1 fix — align client with server).
            //
            // The server's /api/session/restore route already routes
            // infeasible-draft and student-preferred-invalid-draft to the
            // draft slot (never the committed anchor). The client must mirror
            // that contract: a DRAFT/INVALID plan must NOT overwrite the
            // committed anchor.
            //
            // - null: clear the committed anchor (explicit reset; kept as-is).
            // - valid-clean / valid-with-trade-offs: committable — write to
            //   the committed anchor (the ONLY states that should live there).
            // - infeasible-draft / student-preferred-invalid-draft: draft/invalid
            //   — do NOT overwrite the committed anchor. The plan is surfaced
            //   through the 4-state banner via the existing `forwardSchedule`
            //   field (which still returns the last VALID committed plan or null)
            //   — the draft is NOT stored in the committed slot. Preserving the
            //   prior valid committed plan is the correct behavior (the client
            //   mirrors the server: the committed anchor holds a valid plan or
            //   null, never a draft).
            //
            //   NOTE: the compat facade has no dedicated "draft slot" separate
            //   from the committed anchor (the scenario model's draft
            //   representation is a proposed/whatif scenario, not committed).
            //   For now we simply skip the commit so the anchor is not
            //   corrupted. The 4-state banner in the UI reads `forwardSchedule`
            //   and already flags `infeasible-draft` / `student-preferred-
            //   invalid-draft` state values, so the draft IS surfaced correctly
            //   when the prior valid committed plan carries those states — the
            //   key invariant we restore is that the committed anchor is NEVER
            //   set to a draft/invalid plan that arrived AFTER a valid one.
            //
            // Committing a new VALID plan supersedes any pending proposal card —
            // a staged preview (E3.1) or invalid-proposal red card (E3.3) both
            // describe a proposal against the PRIOR committed plan, so they are
            // stale the moment the committed plan changes.
            if (s !== null) {
                const isDraft =
                    s.state === "infeasible-draft" ||
                    s.state === "student-preferred-invalid-draft";
                if (isDraft) {
                    // Do NOT overwrite the committed anchor with a draft/invalid
                    // plan. The committed anchor (and whatever the prior valid
                    // plan was) is preserved.
                    return;
                }
            }
            previewObjects.clear();
            const cleared: ScenarioState = {
                committed: s,
                scenarios: [],
                activeId: "committed",
                compare: null,
                invalidProposal: null,
            };
            applyScenario(cleared);
        },
        setSchedulePreferences(p: SchedulePreferences | null): void {
            schedulePreferences = p;
            commit();
        },
        setForwardMaterialization(m: ForwardMaterializationPayload | null): void {
            forwardMaterialization = m;
            commit();
        },
        setPendingPreview(p: PendingPreview | null): void {
            // Legacy single-preview semantics: at most ONE staged preview at
            // a time. Drop any prior compat-staged proposed scenario, then —
            // when `p` is non-null — stage it as a fresh proposed scenario
            // (active), stashing the exact object for identity-preserving
            // reads. Staging a preview NEVER touches the committed anchor.
            let next = dropCompatPreviews(scenario);
            if (p == null) {
                // Returned to the committed anchor with no preview.
                if (next.activeId !== "committed") next = reduceSetActive(next, "committed");
            } else {
                const id = `preview-${previewSeq++}`;
                previewObjects.set(id, p);
                next = reduceAddScenario(next, previewToScenario(id, p));
            }
            applyScenario(next);
        },
        clearPendingPreview(): void {
            // Confirm / Cancel / Keep-as-is: drop the compat-staged preview
            // (if any) and return active → committed. Committed plan untouched.
            let next = dropCompatPreviews(scenario);
            if (next.activeId !== "committed") next = reduceSetActive(next, "committed");
            applyScenario(next);
        },
        setInvalidProposal(c: InvalidProposalCard | null): void {
            applyScenario(reduceSetInvalidProposal(scenario, c));
        },
        clearInvalidProposal(): void {
            applyScenario(reduceSetInvalidProposal(scenario, null));
        },

        // ---- H0.2 scenario API ----
        setCommitted(schedule: ForwardSchedule): void {
            applyScenario(reduceSetCommitted(scenario, schedule));
        },
        addScenario(s: Scenario): void {
            applyScenario(reduceAddScenario(scenario, s));
        },
        setActive(id: string): void {
            applyScenario(reduceSetActive(scenario, id));
        },
        openCompare(leftId: string, rightId: string): void {
            applyScenario(reduceOpenCompare(scenario, leftId, rightId));
        },
        closeCompare(): void {
            applyScenario(reduceCloseCompare(scenario));
        },
        discardScenario(id: string): void {
            previewObjects.delete(id);
            applyScenario(reduceDiscardScenario(scenario, id));
        },
        confirmProposed(id: string): void {
            previewObjects.delete(id);
            applyScenario(reduceConfirmProposed(scenario, id));
        },

        // ---- H0.2 selectors ----
        getCommitted(): ForwardSchedule | null {
            return scenario.committed;
        },
        getScenarios(): Scenario[] {
            return scenario.scenarios;
        },
        getActiveScenario(): Scenario | undefined {
            return activeScenario(scenario);
        },
        getScenarioState(): ScenarioState {
            return scenario;
        },
    };

    // --- closures over `previewObjects` ---

    /**
     * PURE w.r.t. `scenario`: returns a new ScenarioState with every
     * compat-staged proposed scenario removed (returns `s` unchanged when
     * there are none, preserving referential stability). Also clears the
     * `previewObjects` identity-cache side-table for the dropped ids.
     */
    function dropCompatPreviews(s: ScenarioState): ScenarioState {
        let next = s;
        for (const id of previewObjects.keys()) {
            next = reduceDiscardScenario(next, id);
        }
        previewObjects.clear();
        return next;
    }
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (compat ⇆ scenario model)
// ---------------------------------------------------------------------------

/** Map a legacy `PendingPreview` to a `kind:"proposed"` Scenario. */
function previewToScenario(id: string, p: PendingPreview): Scenario {
    return {
        id,
        kind: "proposed",
        label: p.verb ? `Proposed: ${p.verb}` : "Proposed change",
        schedule: p.proposedSchedule,
        // The compat facade has no engine verdict here (the review card is
        // computed elsewhere from the route response); a staged feasible
        // preview is at least "trade-offs" when it carries consequences,
        // else "valid". This verdict is advisory metadata only — the legacy
        // consumers read `pendingPreview`, not the scenario verdict.
        verdict: p.consequences.length > 0 ? "trade-offs" : "valid",
        ...(p.consequences.length > 0 ? { hedges: p.consequences } : {}),
        pendingMutationId: p.pendingMutationId,
        ...(p.whatIfAssumption ? { whatIfAssumption: p.whatIfAssumption } : {}),
        createdAt: 0,
    };
}

/**
 * Fallback map of a proposed Scenario back to a `PendingPreview` — used ONLY
 * when a proposed scenario was created via the NEW `addScenario` API (not the
 * compat `setPendingPreview`), so there is no stashed original object. The
 * legacy consumers can still read a coherent preview overlay from it.
 */
function scenarioToPreview(s: Scenario): PendingPreview {
    return {
        proposedSchedule: s.schedule,
        pendingMutationId: s.pendingMutationId ?? "",
        consequences: s.hedges ?? [],
        ...(s.whatIfAssumption ? { whatIfAssumption: s.whatIfAssumption } : {}),
    };
}
