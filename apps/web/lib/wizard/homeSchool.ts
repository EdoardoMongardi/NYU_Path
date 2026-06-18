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

// Client-safe entry (NOT the "@nyupath/engine" barrel) — homeSchool runs in the
// browser via the OnboardingWizard; the barrel drags node:fs/url/crypto into the
// client bundle. See packages/engine/src/client.ts. (The DegreeProgressReport
// type below is a type-only import — erased at build, no runtime pull.)
import { SCHOOL_DISPLAY_NAMES } from "@nyupath/engine/client";
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
    /**
     * F2 — whether the home school was CONFIDENTLY derived from the DPR
     * (`deriveHomeSchool` returned a real school code, not `"unknown"`).
     *
     * `true`  → the DPR deterministically shows the home school: it is a
     *           DPR-derived (read-only) field. The Confirm-profile step
     *           renders it as a fixed value with a "to change it, upload a
     *           corrected DPR" note — NO editable picker.
     * `false` → the DPR could NOT determine the school (`"unknown"`): the
     *           student may pick one (the ONLY editable home-school case),
     *           so the step renders the school picker.
     *
     * This is the SAME signal the v2 route gate uses to decide whether to
     * accept a `body.homeSchool` override — kept in lockstep so the UI and
     * the server agree on what's overridable.
     */
    derivedFromDpr: boolean;
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
        // The DPR could NOT determine the school — the student may pick one
        // (the only editable home-school case). NOT a DPR-derived field.
        return { proposed: null, needsPrompt: true, derivedFromDpr: false };
    }
    // The DPR deterministically shows the school — a read-only DPR-derived
    // field (F2). The wizard renders it fixed; the route ignores overrides.
    return { proposed: derived, needsPrompt: false, derivedFromDpr: true };
}

/** True when `code` is one of the selectable home schools. */
export function isValidSchoolCode(code: string): boolean {
    return SCHOOL_CODE_SET.has(code);
}
