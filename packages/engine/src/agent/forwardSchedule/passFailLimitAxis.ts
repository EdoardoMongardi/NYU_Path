/**
 * passFailLimitAxis — 8th validator axis (Task C1 of Plan 37).
 *
 * Checks the per-school career Pass/Fail limit against usage recorded in the
 * (possibly synthetic) DPR.  Three limit tiers (D-4):
 *
 *   careerLimitType:"credits"            → HARD:            used > cap ⇒ fail
 *   careerLimitType:"courses"            → HARD:            count("P" rows) > cap ⇒ fail
 *   careerLimitType:"percent_of_program" → SOFT:            requires-approval (unit-ambiguous)
 *   careerLimitValue == null             → HEDGE:           assumed-pass + adviser note
 *   passFail undefined / canElect:false  → PASS-BY-DEFAULT: axis is opt-in / action blocked upstream
 *
 * PURE: no I/O, no mutation.
 */

import type { ValidationResult, PassFailConfig } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../dpr/schema.js";

/** Count pass/fail-graded course rows on the DPR (grade === "P"). */
function countPassFailCourses(dpr: DegreeProgressReport): number {
    return dpr.courseHistory.filter((r) => r.grade === "P").length;
}

/**
 * 8th validator axis — per-school career P/F limit (Plan 37, D-4).
 *
 * Pass-by-default: if no `passFail` config is supplied (school does not have
 * the axis configured) or the school cannot elect P/F at all (`canElect:false`,
 * e.g. Tandon), the axis returns a non-blocking `pass`.  The `canElect:false`
 * guard is a safety net; the upstream action-matrix already prevents a student
 * from electing P/F at Tandon, but the axis must not block if it is somehow
 * reached.
 */
export function checkPassFailLimits(
    dpr: DegreeProgressReport,
    passFail: PassFailConfig | undefined,
): ValidationResult {
    // Axis is opt-in: no config → pass.
    if (!passFail) {
        return { status: "pass", verifiedFrom: "bulletin" };
    }

    // canElect:false school → P/F is not available; axis cannot block.
    if (passFail.canElect === false) {
        return { status: "pass", verifiedFrom: "bulletin" };
    }

    // No cap on file → hedge, never block.
    if (passFail.careerLimitValue == null) {
        return {
            status: "assumed-pass",
            assumption:
                "Your school may have a Pass/Fail career limit we don't have on file; no cap enforced.",
            whatWouldFlipIt:
                "Obtaining and confirming the official P/F career cap with your adviser would resolve this.",
        };
    }

    const cap = passFail.careerLimitValue;

    if (passFail.careerLimitType === "credits") {
        const used = dpr.cumulative.passFailUsedUnits ?? 0;
        if (used > cap) {
            return {
                status: "fail",
                reason: `Pass/Fail credits used (${used}) exceed your school's ${cap}-credit career limit.`,
            };
        }
        return { status: "pass", verifiedFrom: "DPR" };
    }

    if (passFail.careerLimitType === "courses") {
        const used = countPassFailCourses(dpr);
        if (used > cap) {
            return {
                status: "fail",
                reason: `Pass/Fail courses used (${used}) exceed your school's ${cap}-course career limit.`,
            };
        }
        return { status: "pass", verifiedFrom: "DPR" };
    }

    // percent_of_program — unit-ambiguous; never a hard fail.
    return { status: "requires-approval", authority: "advisor" };
}
