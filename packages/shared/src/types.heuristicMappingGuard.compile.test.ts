// packages/shared/src/types.heuristicMappingGuard.compile.test.ts
//
// Layer-2 of the Tier-D 3-layer enforcement (Decision #42). Asserts that
// HEURISTIC_MAPPING.studentConstraintFraming is the literal "soft", not
// the union "hard" | "soft". A hard-framed instance must be a TS compile
// error. tsc is the assertion.

import type { Assumption } from "./types.js";

// Should compile (soft framing is permitted):
const okSoft: Assumption = {
    type: "HEURISTIC_MAPPING",
    studentStatedFactor: "...",
    studentConstraintFraming: "soft",
    mappedToMutation: { kind: "loadStyleOverride", style: "balanced" },
    confidence: "low",
    reasoning: "...",
    consequenceIfWrong: "...",
};

// Active assertion: hard framing fails to compile.
// The @ts-expect-error is placed on the line that TS flags (the property
// assignment), which is where TS2322 is reported for discriminated unions.
const badHard: Assumption = {
    type: "HEURISTIC_MAPPING",
    studentStatedFactor: "x",
    // @ts-expect-error -- studentConstraintFraming "hard" is not assignable to "soft"
    studentConstraintFraming: "hard",
    mappedToMutation: { kind: "loadStyleOverride", style: "balanced" },
    confidence: "low",
    reasoning: "x",
    consequenceIfWrong: "x",
};

// Reference both so the file isn't flagged as unused.
export const _layer2Probes = { okSoft, badHard };
