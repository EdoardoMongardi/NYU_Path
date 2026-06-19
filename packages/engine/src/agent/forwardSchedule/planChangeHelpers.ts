/**
 * Phase 14 Task 5 — Pure helpers shared by proposePlanChange and
 * confirmPlanChange tools.
 *
 * No I/O, no module state — all functions are pure transformations.
 */

import { z } from "zod";
import type {
    PlanMutation,
    SchedulePreferences,
    ForwardSchedule,
    ScheduleSlot,
    PlanChangeOutcome,
    PlanDiff,
    PlanState,
    ValidationResult,
} from "@nyupath/shared";
import type { SolverInput } from "./types.js";
import type { ToolSession } from "../tool.js";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import { classifyBalanceDelta, computeBalanceScore } from "./balanceScore.js";
import { buildSolverInput, buildSolverInputWithRules, type SolverInputWithRules } from "./buildSolverInput.js";
import { diffPlanTradeOffs } from "./tradeOffEngine.js";

// ---------------------------------------------------------------------------
// Shared Zod schemas (used by propose_plan_change + confirm_plan_change)
// ---------------------------------------------------------------------------

/**
 * D6.2 — zod mirror of `GenericSoftConstraint` from `@nyupath/shared`. Lives in
 * the engine (not shared) because shared carries no runtime zod dependency; the
 * TYPE is the source of truth in shared, this schema validates it at the tool /
 * mutation boundary.
 *
 * `framing: z.literal("soft")` is the boundary guard: a HARD-framed instance
 * fails `safeParse` (runtime) just as it is a TS error against the type
 * (compile-time). Hard constraints route through Tiers A/C, never this soft
 * primitive (Decision #42).
 */
export const GenericSoftConstraintSchema = z.object({
    id: z.string(),
    framing: z.literal("soft"),
    dimension: z.string(),
    preference: z.string(),
    weight: z.number().min(0).max(1).optional(),
});

/** Mirrors `SchedulingPreferences` from `@nyupath/shared` (Decision #43). */
export const SchedulingPreferencesSchema = z.object({
    avoidDays: z.array(z.object({ day: z.string(), strict: z.boolean() })).optional(),
    avoidTimeWindows: z.array(z.object({
        days: z.array(z.string()),
        startMin: z.number(),
        endMin: z.number(),
        strict: z.boolean(),
    })).optional(),
    preferTimeWindows: z.array(z.object({
        days: z.array(z.string()),
        startMin: z.number(),
        endMin: z.number(),
        weight: z.number(),
    })).optional(),
    desiredFreeDay: z.object({ day: z.string(), strict: z.boolean() }).optional(),
    avoidConsecutiveLongBlocks: z.boolean().optional(),
}).passthrough();

/** Mirrors `PlanMutation` discriminated union from `@nyupath/shared`
 *  (Decision #23). Single source of truth for both propose + confirm
 *  tools — adding a new PlanMutation kind requires updating ONLY this
 *  schema (and the corresponding `applyMutationsToPreferences` switch
 *  below, where TypeScript's exhaustiveness check will flag the
 *  default: never branch). */
export const PlanMutationSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("pin"),
        courseId: z.string(),
        term: z.string(),
        /**
         * Phase 17 — Whether the pin is a permanent solver freeze.
         * Defaults to `true` when omitted (backwards-compatible with
         * Phase 14, where every pin was a freeze). `false` is sent by
         * the Phase 17 "Add" sidebar verb (place without lock).
         */
        freeze: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("exclude"), courseId: z.string(), term: z.string().optional() }),
    z.object({ kind: z.literal("swap"), drop: z.string(), add: z.string(), term: z.string() }),
    /**
     * Phase 17 — drag-to-move primitive. Atomic shorthand for
     * `[exclude(courseId), pin(courseId, toTerm, freeze: false)]`.
     */
    z.object({ kind: z.literal("move"), courseId: z.string(), fromTerm: z.string(), toTerm: z.string() }),
    /**
     * Phase 17 Task B — inverse of pin(freeze: true). Removes the
     * matching `(courseId, term)` entry from `SchedulePreferences.pins[]`
     * so a previously locked slot becomes solver-eligible for
     * re-placement on the next re-plan. The sidebar's Lock verb sends
     * this when the student toggles `locked: false`.
     */
    z.object({ kind: z.literal("unpin"), courseId: z.string(), term: z.string() }),
    z.object({ kind: z.literal("addTerm"), term: z.string() }),
    z.object({
        kind: z.literal("loadStyleOverride"),
        term: z.string().optional(),
        style: z.enum(["balanced", "frontload", "backload", "light", "heavy"]),
    }),
    z.object({ kind: z.literal("bindFreeElective"), slotId: z.string(), courseId: z.string() }),
    z.object({ kind: z.literal("unbindFreeElective"), slotId: z.string() }),
    z.object({ kind: z.literal("bindPoolSlot"), slotId: z.string(), courseId: z.string() }),
    z.object({ kind: z.literal("setSchedulingPreference"), value: SchedulingPreferencesSchema }),
    z.object({ kind: z.literal("clearSchedulingPreference") }),
    /**
     * D6.2 — rung-2 SOFT-objective mutation. Sets a generic, structured soft
     * factor (`GenericSoftConstraint`) into `prefs.softObjectives[]`.
     * `clearSoftObjectives` is its inverse (empties the array).
     *
     * PRECEDENCE / CONTRACT (binding): this grows the mutation union by exactly
     * ONE *soft* kind (plus its clear-inverse), but the HARD SOLVER CONTRACT
     * stays CLOSED — because the ONLY reader of `prefs.softObjectives` is the
     * RANKER (`scorePlan`, constraintModel.ts). The solver's feasibility/validity
     * logic (`buildRequirementVariables`, `checkPrereqsSatisfied`,
     * `checkRequirementCoverage`, the validator axes) NEVER reads it. This is the
     * owner's "contract-preserving" choice: the FROZEN solver contract is the
     * hard feasibility, which is untouched; a SOFT-only ranking signal is
     * additive and cannot make a valid plan invalid or vice-versa. The schema's
     * `framing: z.literal("soft")` rejects any hard-framed instance at this
     * boundary, so the soft-only invariant cannot be smuggled past parse.
     */
    z.object({ kind: z.literal("addSoftObjective"), objective: GenericSoftConstraintSchema }),
    z.object({ kind: z.literal("clearSoftObjectives") }),
]);

/** Top-level input shape: `{ mutations: PlanMutation[] }` with min(1). */
export const PlanChangeInputSchema = z.object({
    mutations: z.array(PlanMutationSchema).min(1),
});

// ---------------------------------------------------------------------------
// resolveBindMutations — slot-level bind → pin translation (Plan 37 Task J2)
// ---------------------------------------------------------------------------

/**
 * Translate slot-level `bindPoolSlot` / `bindFreeElective` mutations into a
 * `pin(courseId, slotTerm)` so the binding SURVIVES confirm.
 *
 * WHY THIS LIVES HERE (and not in applyMutationsToPreferences): the bind
 * mutations carry only a `slotId`, while the persisted `SchedulePreferences`
 * carry pins keyed on `(courseId, term)`. Resolving `slotId → term` requires
 * the ACTIVE PLAN, which `applyMutationsToPreferences(base, mutations)` does
 * NOT receive — that is exactly why those two mutation kinds were dead no-ops.
 * This pre-pass runs at the propose/confirm tool boundary, where the plan
 * (`session.forwardSchedule ?? session.studentDraftPlan`) IS in hand, and
 * rewrites each resolvable bind into a `pin` BEFORE the prefs walk.
 *
 * The solver's pin-coverage pass (solver.ts) then sets the pin's `satisfiesRId`
 * to the first unmet requirement whose `candidateCourses` include the bound
 * course, so `materializePlan` writes `satisfiesRules: [rId]` on the placed
 * slot and the authoritative validator credits the requirement leaf — i.e. the
 * binding is PLACED in the slot's term AND satisfies the leaf after the
 * re-solve.
 *
 * `freeze: true` (the pin default) is deliberate: a binding is the student's
 * explicit choice of a specific course for a specific requirement slot, so the
 * solver must not silently re-place it on a future re-plan. (The student can
 * later `unbind` / `unpin` to release it.)
 *
 * Purity: returns a NEW mutations array; the input is never mutated. A bind
 * whose `slotId` cannot be resolved to a placeholder in the plan is passed
 * THROUGH unchanged — `applyMutationsToPreferences` will then surface its
 * existing no-op consequence (preserving today's behavior for bad input).
 * `unbindFreeElective` is also passed through (handled as a no-op downstream;
 * a future J-task can map it to `unpin` once the bound courseId is tracked).
 *
 * @param plan the active plan used to resolve a bind's `slotId → term`
 * @param mutations the raw mutation array from the tool input
 * @returns a new mutation array with binds rewritten to pins where resolvable
 */
export function resolveBindMutations(
    plan: ForwardSchedule | undefined,
    mutations: PlanMutation[],
): PlanMutation[] {
    return mutations.map((m): PlanMutation => {
        if (m.kind !== "bindPoolSlot" && m.kind !== "bindFreeElective") {
            return m;
        }
        const term = findPlaceholderTerm(plan, m.slotId);
        if (term == null) {
            // Unresolvable slot — leave the bind in place so the prefs walk
            // emits its no-op consequence (unchanged behavior for bad input).
            return m;
        }
        // A binding is the student's explicit, durable choice → freeze: true.
        return { kind: "pin", courseId: m.courseId, term, freeze: true };
    });
}

/**
 * Find the containing semester `term` of the placeholder slot with
 * `placeholderId === slotId`, or null when absent. Mirrors the
 * `findSlotWithTerm` lookup used by the bind tools.
 */
function findPlaceholderTerm(
    plan: ForwardSchedule | undefined,
    slotId: string,
): string | null {
    if (!plan) return null;
    for (const sem of plan.semesters) {
        for (const slot of sem.slots) {
            if (slot.kind === "placeholder" && slot.placeholderId === slotId) {
                return sem.term;
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// applyMutationsToPreferences — pure left-to-right walk
// ---------------------------------------------------------------------------

/**
 * Return a NEW SchedulePreferences object (no mutation of the input)
 * after applying all mutations left-to-right. Later mutations override
 * earlier ones for the same field.
 *
 * Slot-level mutations (bindFreeElective, unbindFreeElective, bindPoolSlot)
 * cannot be applied to SchedulePreferences because they target
 * session.forwardSchedule.semesters[].slots[]. Phase 14 Task 6 wires the
 * real logic; for now they are no-ops that emit a consequence string.
 *
 * @returns { prefs, noOpConsequences }
 */
export function applyMutationsToPreferences(
    base: SchedulePreferences,
    mutations: PlanMutation[],
): { prefs: SchedulePreferences; noOpConsequences: string[] } {
    // Deep-clone the base so we never mutate the caller's object.
    const prefs: SchedulePreferences = {
        ...base,
        pins: base.pins ? [...base.pins] : undefined,
        exclusions: base.exclusions ? [...base.exclusions] : undefined,
        loadStylePerTerm: base.loadStylePerTerm ? { ...base.loadStylePerTerm } : undefined,
        creditTargetPerTerm: base.creditTargetPerTerm ? { ...base.creditTargetPerTerm } : undefined,
        softObjectives: base.softObjectives ? [...base.softObjectives] : undefined,
    };

    const noOpConsequences: string[] = [];

    for (const m of mutations) {
        switch (m.kind) {
            case "pin": {
                // Phase 17 — `freeze` defaults to `true` when omitted to
                // preserve Phase 14 semantics (every pin was a freeze).
                // The Phase 17 "Add" verb sends `freeze: false` to express
                // "place without lock"; in that mode we deliberately skip
                // the `prefs.pins[]` write so the placement does not
                // survive a future re-plan as a permanent solver freeze.
                const freeze = m.freeze ?? true;
                if (!freeze) {
                    // No-op at the preferences layer. The route layer
                    // (Phase 17 Task B `/api/plan/add`) handles the
                    // transient placement directly; the helper records
                    // the user's freeze-vs-place intent purely by NOT
                    // writing the pin.
                    break;
                }
                if (!prefs.pins) prefs.pins = [];
                // Remove any existing pin for the same courseId + term to avoid dupes.
                prefs.pins = prefs.pins.filter(p => !(p.courseId === m.courseId && p.term === m.term));
                prefs.pins.push({ courseId: m.courseId, term: m.term });
                break;
            }
            case "exclude": {
                if (!prefs.exclusions) prefs.exclusions = [];
                prefs.exclusions = prefs.exclusions.filter(
                    e => !(e.courseId === m.courseId && e.term === m.term),
                );
                prefs.exclusions.push({ courseId: m.courseId, term: m.term });
                break;
            }
            case "swap": {
                // swap = exclude drop + pin add to term.
                if (!prefs.exclusions) prefs.exclusions = [];
                prefs.exclusions = prefs.exclusions.filter(e => e.courseId !== m.drop);
                prefs.exclusions.push({ courseId: m.drop });

                if (!prefs.pins) prefs.pins = [];
                prefs.pins = prefs.pins.filter(p => !(p.courseId === m.add && p.term === m.term));
                prefs.pins.push({ courseId: m.add, term: m.term });
                break;
            }
            case "move": {
                // Phase 17 — `move` = atomic drag-to-move. Semantically
                // equivalent to `[exclude(courseId), pin(courseId, toTerm,
                // freeze: false)]`. The exclusion clears any
                // solver-driven re-placement of the course in fromTerm
                // (or anywhere else, since the solver's exclusion set is
                // term-agnostic). The toTerm placement itself is the
                // route layer's responsibility (Phase 17 Task B
                // `/api/plan/move`) — `move` deliberately does NOT write
                // to `prefs.pins[]` because moving a course is a
                // transient placement gesture, not a request to freeze
                // the solver against future re-plans.
                //
                // Dedupe-by-courseId-only matches `swap`'s semantics
                // (line 159 above); both rely on the solver's exclusion
                // set being keyed on courseId only (materializePlan.ts
                // builds `excludedCourseIds` from preferences.exclusions
                // by courseId). If the solver ever becomes term-aware on
                // exclusions, both `swap` and `move` need to switch to
                // dedupe by the (courseId, term) tuple together.
                if (!prefs.exclusions) prefs.exclusions = [];
                prefs.exclusions = prefs.exclusions.filter(e => e.courseId !== m.courseId);
                prefs.exclusions.push({ courseId: m.courseId, term: m.fromTerm });
                break;
            }
            case "unpin": {
                // Phase 17 Task B — inverse of pin(freeze: true).
                // Removes the matching `(courseId, term)` entry from
                // `prefs.pins[]` so the solver may re-place the course
                // on the next re-plan. No-op when no matching pin
                // exists (the helper is purely a state transform; the
                // route layer can detect a no-op via `pins[]` length
                // delta if it cares).
                if (!prefs.pins || prefs.pins.length === 0) break;
                prefs.pins = prefs.pins.filter(
                    p => !(p.courseId === m.courseId && p.term === m.term),
                );
                break;
            }
            case "addTerm": {
                const lower = m.term.toLowerCase();
                if (lower.includes("summer")) {
                    prefs.includeSummer = true;
                } else if (lower.includes("january") || lower.includes("jterm") || lower.includes("j-term")) {
                    prefs.includeJTerm = true;
                }
                // fall/spring terms are always included; no-op.
                break;
            }
            case "loadStyleOverride": {
                if (m.term) {
                    // Per-term override. SchedulePreferences.loadStylePerTerm
                    // is typed `Record<string, "light" | "heavy" | "balanced">`
                    // but the PlanMutation union also allows "frontload" /
                    // "backload" (which are global-only styles). Reject those
                    // at the per-term layer and surface a no-op consequence
                    // instead of silently storing a value the solver will
                    // misinterpret.
                    if (m.style === "frontload" || m.style === "backload") {
                        noOpConsequences.push(
                            `loadStyleOverride(${m.term}, ${m.style}) is a no-op — ` +
                            `"frontload" / "backload" are plan-level styles only; per-term overrides accept "light" / "heavy" / "balanced".`,
                        );
                    } else {
                        if (!prefs.loadStylePerTerm) prefs.loadStylePerTerm = {};
                        prefs.loadStylePerTerm[m.term] = m.style;
                    }
                } else {
                    // Plan-level: SchedulePreferences.loadStyle is
                    // "balanced" | "frontload" | "backload". "light" / "heavy"
                    // are per-term styles only — surface a no-op consequence
                    // when the agent attempts a global light/heavy override.
                    if (m.style === "light" || m.style === "heavy") {
                        noOpConsequences.push(
                            `loadStyleOverride(${m.style}) without a term is a no-op — ` +
                            `"light" / "heavy" are per-term styles; pass a term to apply them.`,
                        );
                    } else {
                        prefs.loadStyle = m.style;
                    }
                }
                break;
            }
            case "bindFreeElective": {
                noOpConsequences.push(
                    `bindFreeElective(slotId=${m.slotId}, courseId=${m.courseId}) is a no-op in the solver — ` +
                    "Phase 14 Task 6 wires the real slot-level binding logic.",
                );
                break;
            }
            case "unbindFreeElective": {
                noOpConsequences.push(
                    `unbindFreeElective(slotId=${m.slotId}) is a no-op in the solver — ` +
                    "Phase 14 Task 6 wires the real slot-level binding logic.",
                );
                break;
            }
            case "bindPoolSlot": {
                noOpConsequences.push(
                    `bindPoolSlot(slotId=${m.slotId}, courseId=${m.courseId}) is a no-op in the solver — ` +
                    "Phase 14 Task 6 wires the real slot-level binding logic.",
                );
                break;
            }
            case "setSchedulingPreference": {
                prefs.schedulingPreferences = m.value;
                break;
            }
            case "clearSchedulingPreference": {
                delete prefs.schedulingPreferences;
                break;
            }
            case "addSoftObjective": {
                // D6.2 — append a rung-2 SOFT objective. De-dupe by id so
                // re-issuing the same objective replaces (not duplicates) it.
                // SOFT-only: only scorePlan reads prefs.softObjectives; the
                // solver's hard feasibility logic never does.
                if (!prefs.softObjectives) prefs.softObjectives = [];
                prefs.softObjectives = prefs.softObjectives.filter(o => o.id !== m.objective.id);
                prefs.softObjectives.push(m.objective);
                break;
            }
            case "clearSoftObjectives": {
                // D6.2 — inverse of addSoftObjective; empties the array.
                prefs.softObjectives = [];
                break;
            }
            default: {
                // Exhaustiveness guard — TS will error here if a new kind is added
                // to PlanMutation without updating this switch.
                const _exhaustive: never = m;
                void _exhaustive;
                break;
            }
        }
    }

    // NOTE: a resolvable bindFreeElective/bindPoolSlot is rewritten to a real
    // `pin` by resolveBindMutations() BEFORE this walk (it needs the active
    // plan to resolve slotId→term), so it persists and is NOT a no-op here.
    // Only the unbind path (unbindFreeElective) remains a no-op at this level
    // — a bind/unbind pair for the same slotId therefore does NOT cancel out;
    // wiring unbind→unpin is a tracked follow-up (Phase F's "drop a bound
    // course" needs the inverse). An unresolvable bind (missing plan / unknown
    // slotId) falls through to its no-op branch above unchanged.

    return { prefs, noOpConsequences };
}

// ---------------------------------------------------------------------------
// buildSolverInputFromSession — thin wrapper over the unified builder
// ---------------------------------------------------------------------------

/**
 * Construct a SolverInput from a ToolSession + DPR.
 *
 * Task 1.10 (RC-4/PLAN-2): this function is a thin wrapper over the unified
 * buildSolverInput() in buildSolverInput.ts. The three divergences that
 * existed in the old implementation are eliminated:
 *   1. Graduation term now honors session.graduationTarget (was credits-only)
 *   2. currentTerm now uses wall-clock via deriveTemporalContext (was last-IP)
 *   3. coreqs are now built (were missing entirely)
 *
 * P2.10 (d): when `preferences` is supplied it is passed through as an explicit
 * `preferencesOverride` — the builder uses it WITHOUT mutating the session. The
 * old save→`session.schedulePreferences = preferences`→build→restore dance is
 * gone (it briefly mutated the session, a hazard the override eliminates).
 * When `preferences` is NOT supplied, session.schedulePreferences is used as-is
 * (the confirm_plan_change caller persists its own value separately before the
 * read-only build — that intended write is unaffected).
 */
export function buildSolverInputFromSession(
    session: ToolSession,
    dpr: DegreeProgressReport,
    preferences?: SchedulePreferences,
): SolverInput {
    return buildSolverInput(
        session,
        dpr,
        preferences !== undefined ? { preferencesOverride: preferences } : {},
    );
}

/**
 * P2.10 (b)+(d) — rules-aware sibling of buildSolverInputFromSession used by the
 * edit tools (propose / confirm). Returns the SolverInput AND `validatorRules`
 * from a SINGLE buildProgramRules call, so the tools no longer make a redundant
 * second buildProgramRules call for the validator path. `preferences` is applied
 * as a non-mutating override exactly as in buildSolverInputFromSession.
 */
export function buildSolverInputWithRulesFromSession(
    session: ToolSession,
    dpr: DegreeProgressReport,
    preferences?: SchedulePreferences,
): SolverInputWithRules {
    return buildSolverInputWithRules(
        session,
        dpr,
        preferences !== undefined ? { preferencesOverride: preferences } : {},
    );
}

// ---------------------------------------------------------------------------
// computeSlotDiff — simple before/after comparison
// ---------------------------------------------------------------------------

/**
 * Compare two ForwardSchedule objects and return the lists of
 * (term, slot) pairs that were added or removed.
 */
export function computeSlotDiff(
    before: ForwardSchedule | undefined,
    after: ForwardSchedule,
): PlanChangeOutcome["diff"] {
    const beforeSlots = indexSlots(before);
    const afterSlots  = indexSlots(after);

    const added: Array<{ term: string; slot: ScheduleSlot }> = [];
    const removed: Array<{ term: string; slot: ScheduleSlot }> = [];

    // Slots present in after but not in before → added
    for (const [key, entry] of afterSlots) {
        if (!beforeSlots.has(key)) {
            added.push(entry);
        }
    }
    // Slots present in before but not in after → removed
    for (const [key, entry] of beforeSlots) {
        if (!afterSlots.has(key)) {
            removed.push(entry);
        }
    }

    return { added, removed };
}

/** Build a stable slot-key → {term, slot} index from a ForwardSchedule. */
function indexSlots(schedule: ForwardSchedule | undefined): Map<string, { term: string; slot: ScheduleSlot }> {
    const out = new Map<string, { term: string; slot: ScheduleSlot }>();
    if (!schedule) return out;
    for (const sem of schedule.semesters) {
        for (const slot of sem.slots) {
            const key = slotKey(sem.term, slot);
            out.set(key, { term: sem.term, slot });
        }
    }
    return out;
}

function slotKey(term: string, slot: ScheduleSlot): string {
    if (slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress") {
        return `${term}::${slot.kind}::${slot.courseId}`;
    }
    if (slot.kind === "placeholder") {
        return `${term}::placeholder::${slot.placeholderId}`;
    }
    return `${term}::unknown`;
}

// ---------------------------------------------------------------------------
// deriveConsequences — human-readable effect strings
// ---------------------------------------------------------------------------

/**
 * Build plain-English consequence strings for the outcome.
 * Combines no-op warnings, feasibility notes, and high-level diff summary.
 */
export function deriveConsequences(
    diff: PlanChangeOutcome["diff"],
    afterSchedule: ForwardSchedule,
    noOpConsequences: string[],
): string[] {
    const consequences: string[] = [];

    // No-op slot mutations from Phase 14 Task 6 deferred work
    consequences.push(...noOpConsequences);

    // Overall feasibility verdict
    if (!afterSchedule.feasibility.feasible) {
        consequences.push(
            `Plan is infeasible after mutation: ${afterSchedule.feasibility.infeasibilityReason ?? "unknown reason"}`
        );
        for (const v of afterSchedule.feasibility.constraintViolations.slice(0, 3)) {
            consequences.push(`  Conflict (${v.kind}): ${v.detail}`);
        }
    } else {
        consequences.push("Plan remains feasible after mutation.");
    }

    // Diff summary
    if (diff.added.length > 0) {
        const added = diff.added.map(({ term, slot }) => {
            const id = "courseId" in slot ? slot.courseId : "placeholder";
            return `${id} → ${term}`;
        }).join(", ");
        consequences.push(`Added: ${added}`);
    }
    if (diff.removed.length > 0) {
        const removed = diff.removed.map(({ term, slot }) => {
            const id = "courseId" in slot ? slot.courseId : "placeholder";
            return `${id} (was in ${term})`;
        }).join(", ");
        consequences.push(`Removed: ${removed}`);
    }

    return consequences;
}

// ---------------------------------------------------------------------------
// buildPlanDiff — rich delta object
// ---------------------------------------------------------------------------

/**
 * Build a rich PlanDiff from the before and after ForwardSchedule.
 *
 * Credit / weighted-credit / workload-tier / balance / graduation-term /
 * planState deltas are computed inline below. The consequence (trade-off)
 * fields — newRequiresPetition, removedRequiresPetition, newUnmetRequirements,
 * cascadedShifts, newAssumptions — are delegated to `diffPlanTradeOffs`
 * (tradeOffEngine.ts, P2.6), which diffs the two schedules' slots directly.
 *
 * `validationResultsChanges` (P2.7): when `validatorAxes` is supplied, every
 * axis whose `before`/`after` ValidationResult differs (structurally — by
 * status OR reason/payload) is recorded as `{ before, after }`. When omitted,
 * it stays `{}` (backward-compatible: the build path never passes axes).
 */
export function buildPlanDiff(
    before: ForwardSchedule | undefined,
    after: ForwardSchedule,
    validatorAxes?: {
        before?: Record<string, ValidationResult>;
        after: Record<string, ValidationResult>;
    },
): PlanDiff {
    // creditsByTermDelta
    const beforeCreditsByTerm: Record<string, number> = {};
    if (before) {
        for (const sem of before.semesters) {
            beforeCreditsByTerm[sem.term] = sem.plannedCredits;
        }
    }
    const creditsByTermDelta: Record<string, number> = {};
    const weightedCreditsByTermDelta: Record<string, number> = {};
    const workloadTierShifts: PlanDiff["workloadTierShifts"] = [];

    const afterTerms = new Set(after.semesters.map(s => s.term));
    const allTerms = new Set([
        ...Object.keys(beforeCreditsByTerm),
        ...afterTerms,
    ]);

    for (const term of allTerms) {
        const bCred = beforeCreditsByTerm[term] ?? 0;
        const aSem = after.semesters.find(s => s.term === term);
        const aCred = aSem?.plannedCredits ?? 0;
        const delta = aCred - bCred;
        if (delta !== 0) creditsByTermDelta[term] = delta;

        const bSem = before?.semesters.find(s => s.term === term);
        const bWC = bSem?.loadRationale.weightedCredits ?? 0;
        const aWC = aSem?.loadRationale.weightedCredits ?? 0;
        const wcDelta = aWC - bWC;
        if (wcDelta !== 0) weightedCreditsByTermDelta[term] = wcDelta;

        if (aSem || bSem) {
            const bR = bSem?.loadRationale;
            const aR = aSem?.loadRationale;
            if (bR && aR &&
                (bR.hardCount !== aR.hardCount ||
                 bR.easyCount !== aR.easyCount ||
                 bR.weightedCredits !== aR.weightedCredits)) {
                workloadTierShifts.push({
                    term,
                    before: {
                        hardCount: bR.hardCount,
                        easyCount: bR.easyCount,
                        weightedCredits: bR.weightedCredits,
                    },
                    after: {
                        hardCount: aR.hardCount,
                        easyCount: aR.easyCount,
                        weightedCredits: aR.weightedCredits,
                    },
                });
            }
        }
    }

    // graduationTermShift (in semesters; + = later)
    const gradShift = termDelta(before?.graduationTerm, after.graduationTerm);

    // Balance impact
    const loadStyle = "balanced" as const;  // default for score comparison
    const beforeScore = before ? computeBalanceScore(before.semesters, loadStyle) : after.balanceScore;
    const afterScore  = computeBalanceScore(after.semesters, loadStyle);
    const balanceImpact: PlanDiff["balanceImpact"] = {
        before: beforeScore,
        after:  afterScore,
        delta:  afterScore - beforeScore,
        classification: classifyBalanceDelta(beforeScore, afterScore),
    };

    // planStateChange
    let planStateChange: PlanDiff["planStateChange"];
    if (before && before.state !== after.state) {
        planStateChange = { from: before.state, to: after.state };
    }

    // Consequence (trade-off) fields — petitions, newly-unmet requirements,
    // cascaded term shifts, and new assumptions — diffed directly from the
    // two schedules (P2.6).
    const tradeOffs = diffPlanTradeOffs(before, after);

    // validationResultsChanges (P2.7) — per-axis ValidationResult transitions.
    // Only populated when the caller supplies the validator's before+after axis
    // results; the build path omits them and gets an empty record.
    const validationResultsChanges: Record<string, { before: ValidationResult; after: ValidationResult }> = {};
    if (validatorAxes) {
        const beforeAxes = validatorAxes.before ?? {};
        const afterAxes = validatorAxes.after;
        for (const axis of Object.keys(afterAxes)) {
            const a = afterAxes[axis]!;
            const b = beforeAxes[axis];
            // Record an axis only when a `before` exists AND the result changed
            // (by status or reason/payload). The validator always emits the same
            // 7 axes for both plans, so a missing `before` is not an expected
            // transition and is skipped rather than recorded as before===after.
            if (b && !validationResultsEqual(b, a)) {
                validationResultsChanges[axis] = { before: b, after: a };
            }
        }
    }

    return {
        creditsByTermDelta,
        graduationTermShift: gradShift,
        newRequiresPetition: tradeOffs.newRequiresPetition,
        removedRequiresPetition: tradeOffs.removedRequiresPetition,
        newUnmetRequirements: tradeOffs.newUnmetRequirements,
        cascadedShifts: tradeOffs.cascadedShifts,
        weightedCreditsByTermDelta,
        workloadTierShifts,
        balanceImpact,
        newAssumptions: tradeOffs.newAssumptions,
        validationResultsChanges,
        planStateChange,
    };
}

/**
 * Structural equality for two ValidationResult values. Two results are equal
 * iff they share a `status` AND the status-specific payload matches:
 *   - pass             → same `verifiedFrom`
 *   - assumed-pass     → same `assumption` + `whatWouldFlipIt`
 *   - requires-approval→ same `authority`
 *   - fail             → same `reason`
 * Used by buildPlanDiff to decide whether an axis transitioned (P2.7). A
 * pass→fail flip, or a fail whose reason changed, both count as a change.
 */
function validationResultsEqual(a: ValidationResult, b: ValidationResult): boolean {
    if (a.status !== b.status) return false;
    switch (a.status) {
        case "pass":
            return a.verifiedFrom === (b as { verifiedFrom: string }).verifiedFrom;
        case "assumed-pass": {
            const bb = b as { assumption: string; whatWouldFlipIt: string };
            return a.assumption === bb.assumption && a.whatWouldFlipIt === bb.whatWouldFlipIt;
        }
        case "requires-approval":
            return a.authority === (b as { authority: string }).authority;
        case "fail":
            return a.reason === (b as { reason: string }).reason;
        default: {
            const _exhaustive: never = a;
            void _exhaustive;
            return true;
        }
    }
}

// ---------------------------------------------------------------------------
// Private helpers (termDelta used by buildPlanDiff above)
// ---------------------------------------------------------------------------

const SEASON_ORD: Record<string, number> = { spring: 0, summer: 1, fall: 2, january: 3 };

function parseTerm(t: string): { year: number; season: string } | null {
    const m = t.match(/^(\d{4})-(spring|summer|fall|january)$/);
    if (!m) return null;
    return { year: parseInt(m[1]!, 10), season: m[2]! };
}

/** Signed semester distance from `a` to `b` (+ = b is later). */
function termDelta(a: string | undefined, b: string): number {
    if (!a) return 0;
    const pa = parseTerm(a);
    const pb = parseTerm(b);
    if (!pa || !pb) return 0;
    const ordA = pa.year * 4 + (SEASON_ORD[pa.season] ?? 0);
    const ordB = pb.year * 4 + (SEASON_ORD[pb.season] ?? 0);
    return ordB - ordA;
}

// Re-export PlanState for tools that need it
export type { PlanState };
