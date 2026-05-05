// ============================================================
// planActionBubbleHelpers (Phase 17 Task D follow-up)
// ============================================================
// Pure logic for the chat-thread `plan_action_bubble` message
// kind. Extracted from `apps/web/app/chat/page.tsx` so:
//
//   1. The page-side wiring stays slim (one helper invocation per
//      route response → one Message inserted; one polish event →
//      one Message patched; one Stage 2 event → one Message
//      patched). Keeping the lifecycle math out of the JSX makes
//      the component itself easier to read.
//
//   2. The behaviors that matter (clean-applies-no-bubble, hard
//      refusal-no-buttons, soft refusal-with-override-anyway,
//      polish-replaces-template, Stage 2 enrichment append) are
//      unit-testable without a DOM render harness — `apps/web`
//      doesn't ship `@testing-library/react`.
//
// The helpers in this file own three concerns:
//
//   • `classifyPlanActionOutcome()` — derives the bubble kind
//     (clean | trade_offs | soft_refusal | hard_refusal) from a
//     route response. The classification drives which buttons the
//     bubble renders.
//   • `applyPolishEvent()` / `applyStage2Event()` — pure reducer
//     functions that take a current bubble state + an SSE event
//     and return the patched bubble state.
//   • `bubbleSlotKey()` — stable key construction so the page can
//     route polish + Stage 2 events back to the right bubble in a
//     multi-bubble UI.
//
// The classification is intentionally INFORMATIONAL — it follows
// the locked design choice in `docs/PHASE_17_PLAN.md` §7 (hard
// refusals show a refusal-bubble with no buttons; soft refusals
// show one with Override-anyway). It does not influence engine
// behavior — `force: true` is the wire-level signal the route
// uses to reclassify an infeasible apply via Decision #32.
// ============================================================

import type { PlanActionRouteResponse } from "./planActionClient.js";
import type { PlanActionBubbleSseEvent } from "./chatV2Client.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated bubble kind. Drives the button set the bubble
 * renders.
 *
 *   - `clean`        → bubble is NOT injected (silent commit). Returned
 *                      so the call site can branch and skip insertion.
 *   - `trade_offs`   → feasible apply with non-empty consequences.
 *                      Buttons: Confirm + Keep-as-is.
 *   - `soft_refusal` → feasible: false, but the violations are caps /
 *                      floors / exclusion sets the student can
 *                      override. Buttons: Confirm + Keep-as-is +
 *                      Override-anyway.
 *   - `hard_refusal` → feasible: false with prereq / graduation /
 *                      offering violations the student cannot
 *                      override at the engine level. NO buttons —
 *                      pure refusal text.
 */
export type PlanActionBubbleKind =
    | "clean"
    | "trade_offs"
    | "soft_refusal"
    | "hard_refusal";

/**
 * Conflict-kind strings produced by the solver that the UI treats
 * as HARD (no Override-anyway). Anything else → soft.
 *
 * The list is intentionally narrow — solver kinds tagged here all
 * correspond to violations the student literally cannot satisfy by
 * "going anyway" (you can't take a course whose prereqs aren't
 * scheduled yet; an offering pattern of "fall only" is not a
 * preference). Capacity / floor / cap kinds stay soft because
 * Decision #32's `student-preferred-invalid-draft` slot is exactly
 * the affordance for "I know it's over the cap, do it anyway".
 */
export const HARD_CONFLICT_KINDS: ReadonlySet<string> = new Set([
    "prereq_unsatisfiable",
    "prereqChain",
    "not_clause",
    "graduation_total",
    "offering",
    "offering_pattern",
    "no_plan",
]);

/**
 * Classify a route response into the bubble kind. Pure function;
 * the caller skips bubble insertion when this returns "clean".
 */
export function classifyPlanActionOutcome(
    response: PlanActionRouteResponse,
): PlanActionBubbleKind {
    // Clean apply: feasible AND no trade-offs. Bubble suppressed.
    if (response.feasible && response.consequences.length === 0) {
        return "clean";
    }
    // Trade-offs: feasible BUT non-empty consequences (e.g., bumped a
    // term over its cap, surfaced an unmet major requirement, etc).
    if (response.feasible) {
        return "trade_offs";
    }
    // Refusal — distinguish hard from soft via the engine-supplied
    // conflict kind list.
    const conflicts = response.conflicts ?? [];
    const anyHard = conflicts.some((c) => HARD_CONFLICT_KINDS.has(c.kind));
    return anyHard ? "hard_refusal" : "soft_refusal";
}

/**
 * Whether the bubble should render buttons at all. Hard refusals
 * carry no buttons; everything else (clean is suppressed, but if the
 * caller forces a bubble for a clean apply for some reason — e.g.
 * a debug-mode override — buttons render).
 */
export function bubbleHasButtons(kind: PlanActionBubbleKind): boolean {
    return kind !== "hard_refusal";
}

/**
 * Whether the bubble should render the Override-anyway button.
 * Only soft refusals expose the Decision #32 override path.
 * Trade-offs are already feasible — there's nothing to override.
 */
export function bubbleHasOverrideButton(kind: PlanActionBubbleKind): boolean {
    return kind === "soft_refusal";
}

/**
 * Stable identifier for the bubble. Used as the SSE event's
 * `slotKey` so polish + Stage 2 events route back to the right
 * bubble even if multiple are open at once.
 *
 * Keyed on `pendingMutationId` because each route response mints a
 * fresh uuid; the bubble lifecycle ends when the user hits
 * Confirm / Keep-as-is / Override-anyway, which consumes (or
 * discards) the mutation. So the id is unique per bubble lifetime.
 */
export function bubbleSlotKey(pendingMutationId: string): string {
    return `bubble:${pendingMutationId}`;
}

// ---------------------------------------------------------------------------
// SSE event reducers
// ---------------------------------------------------------------------------

/**
 * Snapshot of a bubble's mutable display state. Lives inside the
 * page's `Message` discriminated-union member; this helper module
 * works against it as a plain object so it can be tested without
 * the React harness.
 */
export interface PlanActionBubbleState {
    /** The bubble's stable key (matches SSE slotKey). */
    slotKey: string;
    /** What's currently rendered as the bubble body. Starts at the
     *  deterministic template; replaced when polish lands. */
    text: string;
    /** Whether the polish call has completed (or errored). The
     *  bubble shows a subtle "polishing…" indicator while this is
     *  false AND polish was opted-in. */
    polishStatus: "idle" | "streaming" | "done" | "error";
    /** Stage 2 enrichment per future term. Keyed by term so a
     *  multi-term mutation (e.g. drag-to-move across the FOSE
     *  window) appends N independent signals. */
    stage2: Map<string, { status: "pending" | "ok" | "warn" | "unavailable"; message: string }>;
    /** Echo of the response's bubble kind so the reducer doesn't
     *  re-classify on every reduce. */
    kind: PlanActionBubbleKind;
    /** The pendingMutationId — Confirm / Override-anyway fire a
     *  /api/plan/confirm with this id. */
    pendingMutationId: string;
    /** Future-term hint copied from the route response — drives
     *  Stage 2 fan-out. */
    futureTerms: string[];
}

/** Build the initial bubble state from a route response. */
export function initBubbleState(response: PlanActionRouteResponse): PlanActionBubbleState {
    const kind = classifyPlanActionOutcome(response);
    return {
        slotKey: bubbleSlotKey(response.pendingMutationId),
        text: response.explanation,
        polishStatus: "idle",
        stage2: new Map(),
        kind,
        pendingMutationId: response.pendingMutationId,
        futureTerms: response.futureTerms,
    };
}

/**
 * Reduce a polish SSE event into a new bubble state. Returns the
 * SAME state object when the event is for a different slot —
 * callers route by `slotKey` upstream, but this guard keeps the
 * function safe for naive callers.
 */
export function applyPolishEvent(
    state: PlanActionBubbleState,
    ev: PlanActionBubbleSseEvent,
): PlanActionBubbleState {
    if (ev.slotKey !== state.slotKey) return state;
    switch (ev.kind) {
        case "plan_action_explanation_polish_chunk": {
            // Streamed delta — accumulate but only START accumulating
            // on the first chunk. Until the first chunk arrives, the
            // bubble keeps showing the deterministic template; the
            // moment a chunk lands we replace it (the spec says the
            // polish REPLACES the template, not appends).
            const accumulated = state.polishStatus === "streaming"
                ? state.text + ev.deltaText
                : ev.deltaText;
            return { ...state, text: accumulated, polishStatus: "streaming" };
        }
        case "plan_action_explanation_polish_done": {
            // Final full text wins — server may have buffered or
            // post-processed; trust this field over the chunk
            // accumulator. Mirrors the v2 chat stream's `done` event.
            return { ...state, text: ev.polishedText, polishStatus: "done" };
        }
        case "plan_action_explanation_polish_error": {
            // Polish failed — keep the deterministic template intact.
            // The bubble's button set is unaffected (the polish path
            // is purely cosmetic per the design choice).
            return { ...state, polishStatus: "error" };
        }
        // Stage 2 + done events: not polish events; ignore.
        default:
            return state;
    }
}

/**
 * Reduce a Stage 2 enrichment event into a new bubble state.
 */
export function applyStage2Event(
    state: PlanActionBubbleState,
    ev: PlanActionBubbleSseEvent,
): PlanActionBubbleState {
    if (ev.slotKey !== state.slotKey) return state;
    if (ev.kind !== "plan_action_stage2_enrichment") return state;
    // Each term replaces its prior entry — a "pending" signal that
    // arrives FIRST (the route may emit it before kicking off
    // materialize_sections) gets overwritten by the eventual ok /
    // warn / unavailable when the engine returns. Stage 2 is
    // append-only across terms, but per-term it's last-write-wins.
    //
    // Per-term keying isn't part of the SSE event payload because
    // `slotKey` already identifies the bubble; the enrichment
    // signal carries `message` text that names the term inline.
    // We key by `message` substring to keep the Map bounded and
    // distinct per term — but the signature surfaces the term in
    // a separate field for cleanliness.
    const entry = {
        status: ev.status,
        message: ev.message,
    } as const;
    const next = new Map(state.stage2);
    // Identify a unique slot per term so re-runs (pending → ok)
    // overwrite. Use the message's leading "[term]" prefix when
    // present; otherwise fall back to the message itself (which
    // means a single signal). The route emits `[term] …` form.
    const m = ev.message.match(/^\[([^\]]+)\]/);
    const key = m ? m[1]! : ev.message;
    next.set(key, entry);
    return { ...state, stage2: next };
}

// ---------------------------------------------------------------------------
// Stage 2 SSE event union (browser-side typed payload). Mirrors the
// shape the /api/plan/stage2 route emits.
// ---------------------------------------------------------------------------

export interface Stage2EnrichmentEvent {
    kind: "plan_action_stage2_enrichment";
    slotKey: string;
    /** The term the signal applies to; carried separately so the
     *  reducer doesn't have to parse it from the message. */
    term: string;
    status: "pending" | "ok" | "warn" | "unavailable";
    message: string;
}

export interface Stage2DoneEvent {
    kind: "plan_action_stage2_done";
    slotKey: string;
}
