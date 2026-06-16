// ============================================================
// homeSchool — Phase 4 Task E5.2 (home-school PROPOSE + confirm)
// ============================================================
// PURE, framework-agnostic helpers for the Confirm-profile wizard step
// (no React import — node-testable, the planState.ts / wizardMachine.ts
// idiom: logic pure + unit-tested, the component a thin renderer).
//
// What this module does:
//   - SCHOOL_OPTIONS: the selectable home schools — ALL 11 home-school
//     codes (incl. NYU Shanghai + NYU Abu Dhabi), sourced from the
//     engine's SCHOOL_DISPLAY_NAMES registry so the list never drifts
//     from the single source of truth (no hardcoded partial list).
//   - computeHomeSchoolProposal(dpr): PROPOSES the DPR-derived home
//     school by REUSING the real derivation (buildStudentProfileFromDpr
//     → deriveHomeSchool). When the DPR carries no school indicator the
//     derivation degrades to the school-agnostic "unknown"; we turn that
//     into a PROMPT — never auto-pick "cas".
//   - isValidSchoolCode(code): membership in SCHOOL_OPTIONS.
//
// BINDING — NEVER SILENT CAS (core_philosophy.md:4/26, "for ALL NYU
// undergrad, never CAS-only"): an unknown derivation MUST surface as a
// PROMPT the student answers explicitly. The wizard must never default
// a home school to "cas".
// ============================================================

import { SCHOOL_DISPLAY_NAMES } from "@nyupath/engine";
import type { DegreeProgressReport } from "@nyupath/engine";
import { buildStudentProfileFromDpr } from "../buildSession";

/** A selectable home school: the code threaded as `body.homeSchool` and
 *  its user-facing display label. */
export interface SchoolOption {
    code: string;
    label: string;
}

/**
 * The selectable home schools — ALL 11 codes from the engine's
 * SCHOOL_DISPLAY_NAMES registry, INCLUDING `nyuad` (NYU Abu Dhabi) and
 * `shanghai` (NYU Shanghai). Reusing the registry (rather than a
 * hardcoded list) keeps this in lockstep with the engine's school
 * configs — adding a school there surfaces it here automatically.
 *
 * Frozen so a leaked reference can't mutate the option set.
 */
export const SCHOOL_OPTIONS: readonly SchoolOption[] = Object.freeze(
    (Object.entries(SCHOOL_DISPLAY_NAMES) as Array<[string, string]>).map(
        ([code, label]) => Object.freeze({ code, label }),
    ),
);

/** Fast membership set for `isValidSchoolCode`. */
const SCHOOL_CODE_SET: ReadonlySet<string> = new Set(SCHOOL_OPTIONS.map((o) => o.code));

/**
 * The DPR-derived home-school proposal for the Confirm-profile step.
 *
 * - `proposed` is the derived school CODE when the DPR clearly indicates
 *   one (e.g. "cas", "stern", "tandon", …), else `null`.
 * - `needsPrompt` is `true` when the derivation was inconclusive — the
 *   wizard MUST prompt the student to pick a home school with NO default
 *   pre-selected (never silently CAS).
 */
export interface HomeSchoolProposal {
    proposed: string | null;
    needsPrompt: boolean;
}

/**
 * Compute the home-school proposal from the parsed DPR. REUSES the real
 * derivation (`buildStudentProfileFromDpr(dpr).homeSchool` →
 * `deriveHomeSchool`) — does NOT re-implement the school-label ladder.
 *
 * `deriveHomeSchool` degrades to the school-agnostic sentinel "unknown"
 * when no indicator matched; we map that to a PROMPT
 * (`{ proposed: null, needsPrompt: true }`) so the student confirms an
 * explicit home school. A matched school is proposed (pre-selected but
 * overridable in the UI).
 *
 * BINDING: "unknown" NEVER becomes "cas" here — never silent CAS.
 */
export function computeHomeSchoolProposal(dpr: DegreeProgressReport): HomeSchoolProposal {
    const derived = buildStudentProfileFromDpr(dpr).homeSchool;
    // "unknown" is the explicit school-agnostic fallback deriveHomeSchool
    // emits when no indicator matched. An empty/missing value is treated
    // the same way (defensive). Anything else is a real matched school.
    if (!derived || derived === "unknown") {
        return { proposed: null, needsPrompt: true };
    }
    return { proposed: derived, needsPrompt: false };
}

/** True when `code` is one of the selectable home schools. */
export function isValidSchoolCode(code: string): boolean {
    return SCHOOL_CODE_SET.has(code);
}
