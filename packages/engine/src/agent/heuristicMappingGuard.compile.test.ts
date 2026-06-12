// ============================================================
// D6.4 — Engine-side Layer-2 compile-guard for the Tier-D
// HEURISTIC_MAPPING SOFT-only invariant + the rung-4 → rung-2
// (`addSoftObjective`) enablement.
// ============================================================
//
// This file lives in `packages/engine/src/` SPECIFICALLY so it is part
// of the engine package's `tsc --noEmit` program (the engine
// `tsconfig.json` includes only `src`, NOT `tests`). `tsc` is the
// assertion — there is no runtime test here. The naming mirrors
// `packages/shared/src/types.heuristicMappingGuard.compile.test.ts`
// (the shared-package Layer-2 pin); vitest does NOT pick this up
// (its globs are `packages/*/tests/**`, never `src`), so it never runs
// as a unit test and never emits a `.js` shadow under `--noEmit`.
//
// The 3-layer Tier-D enforcement (Decision #42):
//   Layer 1 — systemPrompt.ts FOUR_TIER_FALLBACK_RULES ("Tier D is
//             FORBIDDEN for hard constraints").
//   Layer 2 — @nyupath/shared types.ts: the HEURISTIC_MAPPING
//             Assumption variant types `studentConstraintFraming` as
//             the LITERAL "soft" — a hard-framed instance is a TS
//             compile error. THIS FILE pins Layer 2 inside the engine.
//   Layer 3 — preferenceExtraction.eval.ts: the Dneg bucket + its
//             inline asymmetric-stakes invariant unit test.
//
// THE GUARD DIRECTION (RED-before-GREEN proof):
//   The `@ts-expect-error` below MUST be "used" — i.e. the
//   `studentConstraintFraming: "hard"` line MUST genuinely fail to
//   type-check. If a future edit widens the literal (e.g. to
//   `"soft" | "hard"`), the `"hard"` line stops erroring, the
//   `@ts-expect-error` becomes UNUSED, and `tsc --noEmit` fails with
//   `error TS2578: Unused '@ts-expect-error' directive.` — exactly the
//   regression this guard catches. (Verified by the negative-control:
//   flipping the guarded value to "soft" produces TS2578.)
// ============================================================

import type { Assumption } from "@nyupath/shared";

// Narrow to just the HEURISTIC_MAPPING variant so the guard is about
// the framing literal, not union-member ambiguity.
type HeuristicMapping = Extract<Assumption, { type: "HEURISTIC_MAPPING" }>;

// ------------------------------------------------------------
// GUARD — hard framing is a compile error (the `@ts-expect-error`
// MUST fire). This is the load-bearing assertion.
// ------------------------------------------------------------
const HARD_FRAMED_IS_A_COMPILE_ERROR: HeuristicMapping = {
    type: "HEURISTIC_MAPPING",
    studentStatedFactor: "I have to work Tu/Th mornings (childcare)",
    // @ts-expect-error studentConstraintFraming must be the literal "soft" — a hard-framed HEURISTIC_MAPPING is forbidden (Layer 2 of the 3-layer Tier-D guard).
    studentConstraintFraming: "hard",
    mappedToMutation: null,
    confidence: "low",
    reasoning: "compile-guard fixture — must NOT type-check",
    consequenceIfWrong: "compile-guard fixture",
};

// ------------------------------------------------------------
// POSITIVE CONTROL — the same shape with framing "soft" type-checks
// cleanly. mappedToMutation:null is the pre-D6.2 shape (a recorded
// heuristic with no actionable mutation).
// ------------------------------------------------------------
const SOFT_FRAMED_NULL_MUTATION_IS_VALID: HeuristicMapping = {
    type: "HEURISTIC_MAPPING",
    studentStatedFactor: "I'd prefer professors with East-Coast accents",
    studentConstraintFraming: "soft",
    mappedToMutation: null,
    confidence: "low",
    reasoning: "no modeled axis and no actionable mutation",
    consequenceIfWrong: "ranking unaffected; flagged for the student",
};

// ------------------------------------------------------------
// D6.4 ENABLEMENT — rung-4 → rung-2. Before D6.2 a genuinely-new SOFT
// factor reached via HEURISTIC_MAPPING could only map to an EXISTING
// PlanMutation kind or `null`. Now `addSoftObjective` (the rung-2 SOFT,
// ranker-read primitive) exists, so a brand-new soft factor is
// ACTIONABLE while staying strictly SOFT-only. This MUST type-check:
//   - `studentConstraintFraming` stays the literal "soft" (Layer 2).
//   - `mappedToMutation` is an `addSoftObjective` whose `objective.framing`
//     is the literal "soft" (the GenericSoftConstraint guard).
// A future regression that made addSoftObjective's objective accept a
// hard framing, or that widened studentConstraintFraming, breaks this.
// ------------------------------------------------------------
const SOFT_FRAMED_MAPS_TO_ADD_SOFT_OBJECTIVE: HeuristicMapping = {
    type: "HEURISTIC_MAPPING",
    studentStatedFactor: "I'd rather meet fewer times per week even if sessions are longer",
    studentConstraintFraming: "soft",
    mappedToMutation: {
        kind: "addSoftObjective",
        objective: {
            id: "meeting-frequency",
            framing: "soft",
            dimension: "meetingFrequency",
            preference: "fewerLongerSessions",
        },
    },
    confidence: "low",
    reasoning: "no modeled axis; recorded as a generic SOFT ranker objective (rung-2)",
    consequenceIfWrong: "ranking bias only — never changes plan validity",
};

// Export every probe so the file is not flagged as having unused
// top-level bindings (the @ts-expect-error must remain inside a
// type-checked declaration to count as "used").
export const _d64Layer2Probes = {
    HARD_FRAMED_IS_A_COMPILE_ERROR,
    SOFT_FRAMED_NULL_MUTATION_IS_VALID,
    SOFT_FRAMED_MAPS_TO_ADD_SOFT_OBJECTIVE,
};
