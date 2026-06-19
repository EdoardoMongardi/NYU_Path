/**
 * Task 1.10 — RC-4/PLAN-2: ONE shared SolverInput builder for both the
 * initial-plan path (buildForwardSchedule in build.ts) and the edit path
 * (proposePlanChange / confirmPlanChange / simulateAlternatives).
 *
 * Previously two independent builders existed:
 *   - build.ts's inline construction (steps 1–10 in buildForwardSchedule)
 *   - planChangeHelpers.ts's buildSolverInputFromSession
 *
 * The edit path had three divergences, all eliminated here:
 *   1. Graduation term: edit path used deriveGraduationTermFromCredits (credits-only)
 *      and ignored session.graduationTarget. The unified builder honors:
 *      graduationTermOverride ?? toSolverShape(session.graduationTarget) ?? deriveGraduationTerm(...)
 *   2. Current term: edit path inferred from the last IP row. The unified builder
 *      uses wall-clock deriveTemporalContext (the May 2026 post-mortem fix).
 *   3. Coreqs: edit path built NO coreq map. The unified builder builds coreqs
 *      from session.prereqs exactly as build.ts always did.
 *
 * Both buildForwardSchedule and buildSolverInputFromSession now delegate here.
 */

import type { ToolSession } from "../tool.js";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import { walkRequirements, notSatisfiedRequirements } from "../../dpr/schema.js";
import { meetsGradeThreshold } from "../../dpr/gradeComparison.js";
import { deriveTemporalContext } from "../../dpr/temporalContext.js";
import { hashDprCourseHistory } from "./reconcile.js";
import { classifyRequirementKind } from "./requirementKind.js";
import { psTermToSolverTerm } from "./termLabel.js";
import { compareSolverTerms } from "./solverHelpers.js";
import type { SolverInput } from "./types.js";
import { loadOffCatalogCredits, loadOfferings } from "../../dataLoader.js";
import type { ConfidenceTier } from "@nyupath/shared";
import {
    DEFAULT_CREDIT_TARGET_PER_SEMESTER,
    DEFAULT_DOMESTIC_PARTTIME_FLOOR,
} from "../../data/schoolDefaults.js";
import type { GraduationPathValidatorArgs } from "./graduationPathValidator.js";
import type { ProgramDeclaration } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Module-level caches (same pattern as build.ts — read once per process)
// ---------------------------------------------------------------------------

type Season = "fall" | "spring" | "summer" | "january";
let OFF_CATALOG_CACHE: Map<string, { title: string; credits: number }> | null = null;
function getOffCatalogCredits(): Map<string, { title: string; credits: number }> {
    if (!OFF_CATALOG_CACHE) {
        try {
            OFF_CATALOG_CACHE = loadOffCatalogCredits();
        } catch {
            OFF_CATALOG_CACHE = new Map();
        }
    }
    return OFF_CATALOG_CACHE;
}

let OFFERINGS_CACHE: Map<string, { termsOffered: Season[]; confidence: ConfidenceTier }> | null = null;
function getOfferings(): Map<string, { termsOffered: Season[]; confidence: ConfidenceTier }> {
    if (!OFFERINGS_CACHE) {
        try {
            OFFERINGS_CACHE = loadOfferings();
        } catch {
            OFFERINGS_CACHE = new Map();
        }
    }
    return OFFERINGS_CACHE;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildSolverInputOpts {
    /**
     * Explicit graduation term in solver shape ("{year}-{season}").
     * When present it takes precedence over session.graduationTarget AND
     * the credit-derived default.
     */
    graduationTermOverride?: string;
    /**
     * P2.10 (d) — explicit preference override. When supplied it is used as
     * the effective preferences INSTEAD of session.schedulePreferences,
     * WITHOUT mutating the session. Replaces the old session mutate→build→
     * restore dance in buildSolverInputFromSession.
     */
    preferencesOverride?: import("@nyupath/shared").SchedulePreferences;
}

/**
 * P2.10 (b) — the bundle returned by the rules-aware builder: the SolverInput
 * plus BOTH program-rule shapes from the SINGLE buildProgramRules call. The
 * validator path (build.ts / propose / confirm) reads `validatorRules` straight
 * from here instead of re-deriving it with a second buildProgramRules call.
 */
export interface SolverInputWithRules {
    solverInput: SolverInput;
    validatorRules: GraduationPathValidatorArgs["programRules"];
    solverRules: SolverInput["programRules"];
}

/**
 * Construct a SolverInput from a ToolSession + DPR.
 *
 * This is the ONE authoritative SolverInput builder shared by both
 * the initial-plan path (buildForwardSchedule) and the edit path
 * (proposePlanChange / confirmPlanChange / simulateAlternatives).
 *
 * Graduation term resolution priority:
 *   1. opts.graduationTermOverride (explicit override, e.g. "what-if" probes)
 *   2. session.graduationTarget (onboarding-stated goal, converted from display form)
 *   3. Credit-derived default (deriveGraduationTerm from current term + credits remaining)
 *
 * Preferences: opts.preferencesOverride ?? session.schedulePreferences (P2.10 (d)).
 * When preferencesOverride is set it is used WITHOUT mutating the session.
 *
 * Thin wrapper over buildSolverInputWithRules — returns just `.solverInput` so
 * it stays a drop-in for existing callers. buildProgramRules runs exactly once.
 */
export function buildSolverInput(
    session: ToolSession,
    dpr: DegreeProgressReport,
    opts: BuildSolverInputOpts = {},
): SolverInput {
    return buildSolverInputWithRules(session, dpr, opts).solverInput;
}

/**
 * P2.10 (b) — rules-aware builder. Calls buildProgramRules ONCE and assembles
 * the SolverInput from `solverRules`, returning the SolverInput alongside both
 * rule shapes so the validator path never re-computes them.
 */
export function buildSolverInputWithRules(
    session: ToolSession,
    dpr: DegreeProgressReport,
    opts: BuildSolverInputOpts = {},
): SolverInputWithRules {
    const { graduationTermOverride, preferencesOverride } = opts;

    // P2.10 (d) — effective preferences: explicit override wins, else the
    // session's. No session mutation either way.
    const effectivePreferences = preferencesOverride ?? session.schedulePreferences;

    const student = session.student;
    const schoolConfig = session.schoolConfig ?? null;

    // ---- 0. Build-time advisories (P2.10 (a)) ----
    const warnings: string[] = [];

    // ---- 1. Derive credit parameters from DPR + school config ----

    const creditsEarned = dpr.cumulative.creditsUsed ?? 0;
    const graduationCreditMinimum = dpr.cumulative.creditsRequired ?? 128;
    if (dpr.cumulative.creditsRequired == null) {
        warnings.push(
            `Degree credit minimum not found in the DPR — assuming ${graduationCreditMinimum} credits. ` +
            "Verify the requirement with your school.",
        );
    }
    const creditCeiling = schoolConfig?.maxCreditsPerSemester ?? 18;
    const creditTargetPerSemester = schoolConfig?.creditTargetPerSemester ?? DEFAULT_CREDIT_TARGET_PER_SEMESTER;
    const cumulativeGpa = dpr.cumulative.cumulativeGpa ?? 0;
    const f1Floor =
        student?.visaStatus === "f1"
            ? (schoolConfig?.f1FullTimeMinCredits ?? 12)
            : null;
    const domesticPartTimeFloor = schoolConfig?.domesticPartTimeFloor ?? DEFAULT_DOMESTIC_PARTTIME_FLOOR;

    const passFailCap = dpr.cumulative.passFailCapUnits ?? 32;
    const passFailUsed = dpr.cumulative.passFailUsedUnits ?? 0;
    const outsideHomeCreditCap = dpr.cumulative.outsideHomeCapUnits ?? null;
    const outsideHomeCreditsUsed = dpr.cumulative.outsideHomeUsedUnits ?? 0;

    // ---- 2. Derive student identifiers ----

    const studentId = student?.id ?? "unknown";
    const homeSchoolId = student?.homeSchool ?? schoolConfig?.schoolId ?? "unknown";
    const visaStatus = student?.visaStatus;

    // ---- 3. currentTerm — wall-clock via deriveTemporalContext ----
    //
    // RC (May 2026 post-mortem): the prior edit-path implementation picked
    // the LAST IP-tagged DPR row as "current term". With a student mid-Spring
    // 2026 who has Fall 2026 already pre-registered, that picked Fall 2026 —
    // so the planner started building forward from Fall 2026 and stacked new
    // unmet-requirement courses on top of the 3 IP rows already in that term,
    // producing a 28-credit semester (well over the 18-credit cap).
    //
    // The fix routes through deriveTemporalContext (which does wall-clock vs.
    // DPR reconciliation correctly) and returns its currentTerm in solver shape.

    const currentTerm = inferCurrentTerm(dpr);

    // ---- 4. Build coursesTaken + coursesInProgress from DPR ----
    //
    // K1 — PAST/STALE IP reconciliation. An IP row whose term is STRICTLY BEFORE
    // the (wall-clock-derived) currentTerm is a finished-but-ungraded course from a
    // term that is already over — the same "past / stale IP row → closed" notion
    // ipCourseChangeability.ts already encodes. It must NOT enter coursesInProgress:
    // the solver maps an out-of-window IP term to `currentTerm` (solver.ts), and a
    // past SPRING IP (e.g. MATH-UA 334, spring-only) then lands in a SUMMER current
    // term and fails the forward offering-season check on that FIXED placement —
    // poisoning EVERY search trial (the fixed set is offering-invalid and can never
    // be cleared) so the search returns no plan and ALL unmet leaves degrade to
    // empty placeholders. A past/stale IP is treated as TAKEN instead: it still
    // satisfies prereqs and counts toward earned credits, but occupies no forward
    // term and faces no forward offering check. Only CURRENT/FUTURE IP rows remain
    // in coursesInProgress (the genuine in-flight courses the planner schedules
    // around). currentTerm itself is wall-clock-correct (deriveTemporalContext).
    const coursesTaken = new Set<string>();
    const coursesInProgress = new Map<string, { term: string }>();
    for (const row of dpr.courseHistory) {
        const key = `${row.subject} ${row.catalogNbr}`;
        if (row.type === "IP") {
            const rowTerm = psTermToSolverTerm(row.term);
            // Past/stale IP (term strictly before currentTerm) → reconcile as taken.
            if (rowTerm !== null && compareSolverTerms(rowTerm, currentTerm) < 0) {
                coursesTaken.add(key);
                continue;
            }
            coursesInProgress.set(key, { term: rowTerm ?? currentTerm });
            continue;
        }
        if (row.grade && meetsGradeThreshold(row.grade, "D")) {
            coursesTaken.add(key);
        }
    }

    // ---- 5. Determine graduation term ----
    //
    // Priority:
    //   1. explicit graduationTermOverride (from plan_forward_degree input or test)
    //   2. session.graduationTarget (onboarding-stated, display form → converted)
    //   3. Credit-derived default (same algorithm build.ts always used)

    const graduationTerm =
        graduationTermOverride
        ?? toSolverShape(session.graduationTarget)
        ?? deriveGraduationTerm(currentTerm, creditsEarned, graduationCreditMinimum, creditTargetPerSemester);

    // T2b — true when the term fell through to the credit-derived default (no
    // stated target, no override). build.ts reads this flag to decide whether
    // a too-short horizon may be automatically extended by one main term.
    // A student-stated HARD target is never silently extended (PLAN-13).
    const graduationTermWasDerived =
        graduationTermOverride == null && toSolverShape(session.graduationTarget) == null;

    // ---- 6. Build unmet requirements from DPR ----

    const kindByRId = classifyRequirementKind({
        groups: dpr.requirementGroups,
        declaredPrograms: student?.declaredPrograms ?? [],
    });

    const unmetReqs = notSatisfiedRequirements(dpr.requirementGroups);
    const unmetRequirements: SolverInput["unmetRequirements"] = unmetReqs.map(req => {
        const { candidateCourses, pool } = extractCandidatesAndPool(req);
        return {
            rId: req.rId,
            title: req.title,
            category: kindByRId.get(req.rId) ?? "unknown",
            credits: inferRequirementCredits(req),
            candidateCourses,
            ...(pool !== undefined ? { pool } : {}),
        };
    });

    // ---- 7. Build prereq map + coreq map from session.prereqs ----
    //
    // RC-4: the old edit-path builder (buildSolverInputFromSession) built
    // prereqs but NOT coreqs. The unified builder builds both, exactly as
    // build.ts always did.

    const prereqs = new Map<string, import("@nyupath/shared").PrereqGroup[]>();
    const coreqs = new Map<string, string[]>();
    if (session.prereqs) {
        for (const p of session.prereqs) {
            prereqs.set(p.course, p.prereqGroups);
            if (p.coreqs && p.coreqs.length > 0) {
                coreqs.set(p.course, p.coreqs);
            }
        }
    }

    // ---- 8. Build course catalog from session.courses ----

    const courseCatalog = new Map<string, { title: string; credits: number }>();
    if (session.courses) {
        for (const c of session.courses) {
            courseCatalog.set(c.id, { title: c.title, credits: c.credits });
        }
    }

    // ---- 9. Build program rules (SINGLE buildProgramRules call, P2.10 (b)) ----

    const programRules = buildProgramRules(session, dpr, graduationTerm, graduationCreditMinimum);

    // ---- 10. DPR hash ----

    const dprCourseHistoryHash = hashDprCourseHistory(dpr);

    // ---- 11. Build and return SolverInput ----

    const solverInput: SolverInput = {
        studentId,
        homeSchoolId,
        visaStatus,
        coursesTaken,
        coursesInProgress,
        currentTerm,
        graduationTerm,
        creditTargetPerSemester,
        f1Floor,
        domesticPartTimeFloor,
        creditCeiling,
        graduationCreditMinimum,
        creditsEarned,
        passFailCap,
        passFailUsed,
        onlineCreditCap: null,
        onlineCreditsUsed: 0,
        outsideHomeCreditCap,
        outsideHomeCreditsUsed,
        cumulativeGpa,
        majorGpa: null,
        graduationGpaFloor: dpr.cumulative.cumulativeGpaRequired ?? 2.0,
        majorGpaFloor: null,
        unmetRequirements,
        prereqs,
        ...(() => {
            const offeringsData = getOfferings();
            const offerings = new Map<string, Season[]>();
            const offeringConfidence = new Map<string, ConfidenceTier>();
            // The global offerings cache is AUTHORITATIVE — real NYU offering
            // data populates the maps first.
            for (const [id, v] of offeringsData) {
                offerings.set(id, v.termsOffered);
                offeringConfidence.set(id, v.confidence);
            }
            // Gap-fill from session.courses for ids the global cache LACKS
            // (e.g. a session-injected / synthetic non-CAS catalog). Precedence:
            // the global cache wins byte-for-byte for any id it already has;
            // session.courses fills ONLY the gaps. A course with empty
            // termsOffered is intentionally skipped (no known offering → stays
            // a placeholder). Tier "historically_likely": a catalog's static
            // termsOffered is a STRUCTURAL "offered in these seasons" signal,
            // not a live-FOSE confirmation — so NOT "confirmed", and NOT a
            // low-confidence tier that would needlessly force valid-with-trade-
            // offs. Course.termsOffered is already Season[] — no conversion.
            if (session.courses) {
                for (const c of session.courses) {
                    // `?? []` guards partial course objects (some test factories
                    // omit termsOffered) — a missing field behaves exactly like an
                    // empty one: no known offering, so it is skipped (placeholder).
                    const terms = c.termsOffered ?? [];
                    if (!offerings.has(c.id) && terms.length > 0) {
                        offerings.set(c.id, terms);
                        offeringConfidence.set(c.id, "historically_likely");
                    }
                }
            }
            // K1 — an IN-PROGRESS course is an ESTABLISHED enrollment, not a
            // forward prediction: the student is already registered for it in its
            // term (the DPR is authoritative). A forward offering-season constraint
            // is therefore meaningless for it — and HARMFUL when the static
            // termsOffered data is stale/partial for that section (e.g. MATH-UA 251
            // pre-registered in Fall though the historical pattern is spring-only):
            // the fixed IP placement would fail checkOfferingSeasonMatch and poison
            // EVERY search trial, degrading all unmet leaves to empty placeholders.
            // We drop the forward offering entry for IP course-ids (AFTER the
            // gap-fill, so neither the global cache nor session.courses can re-add
            // it) so the IP placement faces no offering check — mirroring how
            // checkPrereqsSatisfied already exempts source:"ip". (A normal forward
            // candidate of the same id does not arise: a course the student is
            // currently taking is not also an unmet-requirement candidate to
            // schedule again.)
            for (const ipId of coursesInProgress.keys()) {
                offerings.delete(ipId);
                offeringConfidence.delete(ipId);
            }
            return { offerings, offeringConfidence };
        })(),
        courseCatalog,
        offCatalogCredits: getOffCatalogCredits(),
        dprCourseHistoryHash,
        dpr,
        programRules: programRules.solverRules,
        ...(coreqs.size > 0 ? { coreqs } : {}),
        preferences: effectivePreferences,
        warnings,
        graduationTermWasDerived,
    };

    return {
        solverInput,
        validatorRules: programRules.validatorRules,
        solverRules: programRules.solverRules,
    };
}

// ---------------------------------------------------------------------------
// Program rules builder
// ---------------------------------------------------------------------------

interface ProgramRulesBundle {
    validatorRules: GraduationPathValidatorArgs["programRules"];
    solverRules: SolverInput["programRules"];
}

/**
 * Bridges session/DPR to the solver's programRules shape.
 * Shared by both the initial-plan path (via buildSolverInput) and the
 * validator path (buildForwardSchedule calls validatorRules separately).
 */
export function buildProgramRules(
    session: ToolSession,
    dpr: DegreeProgressReport,
    graduationTerm: string,
    degreeCreditMinimum: number,
): ProgramRulesBundle {
    const declaredPrograms = session.student?.declaredPrograms ?? [];

    const kindByRId = classifyRequirementKind({
        groups: dpr.requirementGroups,
        declaredPrograms,
    });

    const majorRuleKinds = new Map<string, "must_take" | "choose_n">();
    const schoolCoreRuleIds = new Set<string>();
    const generalCategoryRuleIds = new Set<string>();

    const leaves = walkRequirements(dpr.requirementGroups);
    for (const leaf of leaves) {
        const kind = kindByRId.get(leaf.rId);
        if (kind === "major-required") {
            majorRuleKinds.set(leaf.rId, "must_take");
        } else if (kind === "major-elective") {
            majorRuleKinds.set(leaf.rId, "choose_n");
        } else if (kind === "school-core") {
            schoolCoreRuleIds.add(leaf.rId);
        } else {
            generalCategoryRuleIds.add(leaf.rId);
        }
    }

    // Residency floor
    let residencyMin: number | null = dpr.cumulative.residencyRequired ?? null;
    if (dpr.cumulative.residencyAll) {
        for (const row of dpr.cumulative.residencyAll) {
            if (typeof row.required === "number") {
                residencyMin = residencyMin === null ? row.required : Math.max(residencyMin, row.required);
            }
        }
    }

    // Major credit floor.
    //
    // P2.10 (c) — DEFERRED: course-count major floors are intentionally NOT
    // captured here. We sum only units-counter (`kind:"units"`) major leaves
    // into a CREDIT floor. A DPR counter of `kind:"courses"` (e.g. "complete 18
    // courses for the major") is a DIFFERENT axis — a course COUNT, not a credit
    // total — and no current fixture exercises one. Building a new validator
    // axis + hard predicate for an absent case would violate the project's
    // "general fixes only / don't build for cases that don't arise" philosophy
    // (mirrors the non-CAS deferral). Revisit when a real DPR fixture exercises
    // a course-count major floor; until then a `kind:"courses"` major leaf
    // contributes nothing to majorCreditMin (it is simply skipped below).
    //
    // K1 — FORWARD-REMAINING, not full-requirement. `checkMajorCreditFloor`
    // (and validator axis-4 / checkThresholdsMet) compare this floor against the
    // major credits placed in the FORWARD schedule ONLY — they do NOT add the
    // major credits already earned (read from the DPR). So the floor must itself
    // be net of completed major credits: the credits STILL NEEDED forward, i.e.
    // `max(0, required - used)` per units-counter major leaf. A leaf that is
    // already satisfied (used >= required, e.g. the joint-major residency
    // "36 required, 56 used") then contributes 0 — otherwise its full 36 would be
    // demanded from the forward plan alone, falsely making an otherwise-valid plan
    // infeasible (the sample-DPR "major credits 0 < 36" shortfall). This is a
    // derivation fix only; the frozen search predicate + validator axis are
    // untouched and now agree because they share this single derived floor.
    let majorCreditMin: number | null = null;
    for (const leaf of leaves) {
        const kind = kindByRId.get(leaf.rId);
        if (kind === "major-required" || kind === "major-elective") {
            if (leaf.counter?.kind === "units") {
                const remainingCredits = Math.max(0, leaf.counter.required - leaf.counter.used);
                if (remainingCredits > 0) {
                    majorCreditMin = (majorCreditMin ?? 0) + remainingCredits;
                }
            }
        }
    }

    const validatorRules: GraduationPathValidatorArgs["programRules"] = {
        degreeCreditMinimum,
        residencyMinCredits: typeof residencyMin === "number" ? residencyMin : null,
        majorCreditMinimum: majorCreditMin,
        minorCreditMinimum: null,
        upperLevelMinCredits: null,
        schoolCoreMinCredits: null,
        graduationTargetTerm: graduationTerm,
    };

    const solverRules: SolverInput["programRules"] = {
        majorRuleKinds,
        schoolCoreRuleIds,
        generalCategoryRuleIds,
        residencyMinCredits: typeof residencyMin === "number" ? residencyMin : null,
        majorCreditMinimum: majorCreditMin,
        upperLevelMinCredits: null,
    };

    return { validatorRules, solverRules };
}

// ---------------------------------------------------------------------------
// Test-only export (mirrored from build.ts, now delegates here)
// ---------------------------------------------------------------------------

/**
 * Exposed for unit tests that need to inspect the programRules maps
 * directly without constructing a full session. Returns only the
 * solver-facing rule maps (majorRuleKinds, schoolCoreRuleIds,
 * generalCategoryRuleIds) so tests can assert the classifier output.
 *
 * @internal — test use only
 */
export function buildProgramRulesForTest(
    dpr: DegreeProgressReport,
    declaredPrograms: ProgramDeclaration[],
): {
    majorRuleKinds: Map<string, "must_take" | "choose_n">;
    schoolCoreRuleIds: Set<string>;
    generalCategoryRuleIds: Set<string>;
} {
    const kindByRId = classifyRequirementKind({
        groups: dpr.requirementGroups,
        declaredPrograms,
    });

    const majorRuleKinds = new Map<string, "must_take" | "choose_n">();
    const schoolCoreRuleIds = new Set<string>();
    const generalCategoryRuleIds = new Set<string>();

    const leaves = walkRequirements(dpr.requirementGroups);
    for (const leaf of leaves) {
        const kind = kindByRId.get(leaf.rId);
        if (kind === "major-required") {
            majorRuleKinds.set(leaf.rId, "must_take");
        } else if (kind === "major-elective") {
            majorRuleKinds.set(leaf.rId, "choose_n");
        } else if (kind === "school-core") {
            schoolCoreRuleIds.add(leaf.rId);
        } else {
            generalCategoryRuleIds.add(leaf.rId);
        }
    }

    return { majorRuleKinds, schoolCoreRuleIds, generalCategoryRuleIds };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Infer the current term using the wall clock (NOT the latest IP row).
 *
 * RC (May 2026 post-mortem): the prior implementation picked the LAST
 * IP-tagged DPR row as "current term". With a student mid-Spring 2026
 * who has Fall 2026 already pre-registered, that picked Fall 2026 — so
 * the planner started building forward from Fall 2026 and stacked new
 * unmet-requirement courses on top of the 3 IP rows already in that
 * term, producing a 28-credit semester (well over the 18-credit cap).
 *
 * `now` is injectable for deterministic tests; defaults to wall clock.
 */
function inferCurrentTerm(dpr: DegreeProgressReport, now: Date = new Date()): string {
    const temporal = deriveTemporalContext(dpr, { now });
    const solverShape = temporal.currentTerm
        ? psTermToSolverTerm(temporal.currentTerm)
        : null;
    if (solverShape) return solverShape;
    // Defensive fallback — keeps the legacy default so we never crash
    // on a malformed temporal output.
    return "2026-fall";
}

// `psTermToSolverTerm` now lives in ./termLabel.ts (extracted in D5.1 so
// the response validator's checkPlanClaims shares ONE normalizer and can't
// drift). Imported at the top of this file.

/**
 * Convert a display-form graduation target ("Spring 2027", "2027 Spr",
 * "spring2027", "2027-spring") to the solver's "{year}-{season}" shape.
 * Returns undefined when the input is undefined or unparseable so the
 * caller falls through to the credit-derived default.
 *
 * Mirrors the local toSolverShape() in planForwardDegree.ts.
 */
function toSolverShape(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (/^\d{4}-(?:fall|spring|summer|january)$/i.test(trimmed)) return trimmed.toLowerCase();
    const m = trimmed.match(/^(\d{4})\s+(Fall|Spring|Summer|J Term|J-Term|January|Spr|Sum)$/i)
        ?? trimmed.match(/^(Fall|Spring|Summer|J Term|J-Term|January|Spr|Sum)\s+(\d{4})$/i);
    if (!m) return undefined;
    const yearStr = /^\d{4}$/.test(m[1]!) ? m[1]! : m[2]!;
    const seasonRaw = (/^\d{4}$/.test(m[1]!) ? m[2]! : m[1]!).toLowerCase();
    const season =
        seasonRaw.startsWith("fa") ? "fall" :
        seasonRaw.startsWith("sp") ? "spring" :
        seasonRaw.startsWith("su") ? "summer" :
        seasonRaw.startsWith("j")  ? "january" : null;
    return season ? `${yearStr}-${season}` : undefined;
}

/** Derive graduation term from current term + credits needed. */
function deriveGraduationTerm(
    currentTerm: string,
    creditsEarned: number,
    graduationCreditMinimum: number,
    creditTargetPerSemester: number,
): string {
    const creditsNeeded = Math.max(0, graduationCreditMinimum - creditsEarned);
    const semestersNeeded = Math.ceil(creditsNeeded / creditTargetPerSemester);

    const m = currentTerm.match(/^(\d{4})-(spring|summer|fall|january)$/);
    if (!m) return "2028-spring";

    let year = parseInt(m[1]!, 10);
    let season = m[2]!;

    // Advance N semesters (spring/fall only, skipping summer/january)
    for (let i = 0; i < Math.max(1, semestersNeeded); i++) {
        if (season === "spring") {
            season = "fall";
        } else if (season === "fall") {
            year += 1;
            season = "spring";
        } else if (season === "summer") {
            season = "fall";
        } else {
            season = "spring";
        }
    }
    return `${year}-${season}`;
}

const COURSE_ID_RE = /\b([A-Z][A-Z0-9]*-[A-Z]{2,3})\s+(\d{1,4}[A-Z]?)\b/g;
// Range: "CSCI-UA 400-499" or "CSCI-UA 400–499" (en-dash) or "CSCI-UA 400 to 499".
const COURSE_RANGE_RE = /\b([A-Z][A-Z0-9]*-[A-Z]{2,3})\s+(\d{2,4})\s*(?:-|–|to)\s*(\d{2,4})\b/g;

export function extractCandidatesAndPool(req: { description?: string; statusText: string; title: string }): {
    candidateCourses: string[];
    pool?: { dept: string; levelMin: number; levelMax: number };
} {
    const sources = [req.description ?? "", req.statusText, req.title].join(" ");
    // 1. Detect the FIRST range; emit a pool descriptor and BLANK every range span so the
    //    single-course regex below cannot turn "400" / "499" into phantom courses.
    let pool: { dept: string; levelMin: number; levelMax: number } | undefined;
    let m: RegExpExecArray | null;
    COURSE_RANGE_RE.lastIndex = 0;
    while ((m = COURSE_RANGE_RE.exec(sources)) !== null) {
        const dept = m[1]!;
        const levelMin = parseInt(m[2]!, 10);
        const levelMax = parseInt(m[3]!, 10);
        if (levelMax >= levelMin && pool === undefined) {
            pool = { dept, levelMin, levelMax }; // first valid range becomes the pool descriptor
        }
    }
    const masked = pool !== undefined ? sources.replace(COURSE_RANGE_RE, " ") : sources;
    // 2. Enumerate explicit single course ids from the (range-masked) text.
    const out = new Set<string>();
    for (const mm of masked.matchAll(COURSE_ID_RE)) out.add(`${mm[1]} ${mm[2]}`);
    return { candidateCourses: Array.from(out), ...(pool !== undefined ? { pool } : {}) };
}

function inferRequirementCredits(req: { counter?: import("../../dpr/schema.js").DPRCounter }): number {
    if (!req.counter) return 4;
    if (req.counter.kind === "units") {
        const needed = "needed" in req.counter ? (req.counter.needed ?? 0) : Math.max(0, req.counter.required - req.counter.used);
        return needed > 0 ? needed : 4;
    }
    return 4;
}
