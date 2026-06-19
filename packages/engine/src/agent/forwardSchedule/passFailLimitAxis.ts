/**
 * passFailLimitAxis — 8th validator axis (Task C1 of Plan 37).
 *
 * Checks the per-school Pass/Fail limits against usage recorded in the
 * (possibly synthetic) DPR. TWO limits combine into a single ValidationResult:
 *
 * ELECTED-ONLY (D-4 false-fire fix, c261395 follow-up): a grade-"P" row can be
 * an ELECTED pass/fail (the student voluntarily P/F-ing a letter-graded course)
 * OR a natively-P/F-only course (PE, 0-credit seminars, labs) OR immutable
 * historical P/F. The DPR conflates them (all show grade:"P"). The per-term (B)
 * and career-COURSES (A) caps therefore count ONLY rows we KNOW are elected —
 * `grade === "P" && passFailElected === true` (set solely by applyPassFailToDpr
 * on the what-if election). Native / historical "P" rows carry no flag → not
 * counted → no false-fire; only OUR elections are HARD-checked. The historical
 * portion is HEDGED (uncounted). The career-CREDITS cap is exempt: it reads
 * `cumulative.passFailUsedUnits`, the registrar's authoritative ELECTED-P/F
 * credit total (the PeopleSoft R1680/10 "Pass/Fail" requirement counter, which
 * native-P courses do not count against) — so no conflation there.
 *
 *   (A) the CAREER limit — three tiers (D-4):
 *     careerLimitType:"credits"            → HARD: passFailUsedUnits > cap ⇒ fail
 *     careerLimitType:"courses"            → HARD: count(ELECTED "P" rows) > cap ⇒ fail
 *     careerLimitType:"percent_of_program" → SOFT:            requires-approval (unit-ambiguous)
 *     careerLimitValue == null             → HEDGE:           assumed-pass + adviser note
 *
 *   (B) the PER-TERM limit (Plan 37 follow-up) — gated on `perTermLimit != null`:
 *     count(ELECTED "P" rows) grouped by SEMESTER (`perTermUnit:"semester"`) or
 *     by ACADEMIC YEAR (`perTermUnit:"academic_year"`); ANY group over the limit
 *     ⇒ HARD fail (HARD on the elections WE can see, D-4). Where an elected P/F
 *     row lacks a parseable term (grouping unreliable), the per-term check
 *     HEDGES — it NEVER hard-fails on unknown-term data.
 *
 *   passFail undefined / canElect:false  → PASS-BY-DEFAULT: axis is opt-in / action blocked upstream
 *
 * COMBINING (A)+(B): the WORSE status wins. A `fail` from EITHER the career cap
 * OR the per-term limit ⇒ `fail` (the career result is preferred when it is the
 * one that fails, so its credit/percentage phrasing is preserved). Otherwise the
 * career result is returned unchanged (per-term only ever ESCALATES to `fail`;
 * it never relaxes a career `fail`/`requires-approval`/`assumed-pass`).
 *
 * PURE: no I/O, no mutation.
 */

import type { ValidationResult, PassFailConfig } from "@nyupath/shared";
import type { DegreeProgressReport, DPRCourseRow } from "../../dpr/schema.js";

/**
 * Count ELECTED Pass/Fail course rows on the DPR (grade === "P" AND
 * passFailElected === true). Only counts P/F elections WE made (a what-if /
 * plan election, flagged by applyPassFailToDpr) — NEVER natively-P/F-only
 * courses (PE, 0-credit seminars, labs) or immutable historical P/F, which
 * carry grade "P" but no `passFailElected` flag (D-4: HARD on the elections we
 * can see; HEDGE the rest, so native/historical P/F never false-fires the cap).
 *
 * LIMITATION (honest LOWER BOUND): the real DPR exposes no authoritative count
 * of HISTORICAL elected-P/F COURSES (only `passFailUsedUnits` credits — see the
 * credits-cap branch), so a `careerLimitType:"courses"` cap can only see OUR
 * what-if elections. That is an acceptable under-count that never false-fires;
 * the historical-courses portion is hedged (uncounted).
 */
function countPassFailCourses(dpr: DegreeProgressReport): number {
    return dpr.courseHistory.filter(
        (r) => r.grade === "P" && r.passFailElected === true,
    ).length;
}

// ---------------------------------------------------------------------------
// Per-term grouping helpers (Plan 37 follow-up)
// ---------------------------------------------------------------------------

const SEASON_TOKEN_TO_LABEL: Record<string, "Spring" | "Summer" | "Fall" | "Winter" | "January"> = {
    Spr: "Spring",
    Spring: "Spring",
    Sum: "Summer",
    Summer: "Summer",
    Fall: "Fall",
    Fa: "Fall",
    Win: "Winter",
    Winter: "Winter",
    "J-Term": "January",
    JTerm: "January",
    Jan: "January",
    January: "January",
};

/**
 * Parse a PeopleSoft-style DPR term string into `{ year, season }`, or `null`
 * when the string is unparseable (so the caller HEDGES rather than mis-group).
 * Accepts both "<year> <season>" (PeopleSoft canonical, e.g. "2026 Fall",
 * "2024 Spr") and the "<season> <year>" display form. Mirrors the private
 * `parseTerm` in dpr/temporalContext.ts (kept local so this axis stays a leaf
 * with no cross-module coupling).
 */
function parseTermYearSeason(
    s: string,
): { year: number; season: "Spring" | "Summer" | "Fall" | "Winter" | "January" } | null {
    const trimmed = s.trim();
    let m = trimmed.match(/^(\d{4})\s+([A-Za-z-]+)$/);
    let year: number;
    let raw: string;
    if (m) {
        year = parseInt(m[1]!, 10);
        raw = m[2]!;
    } else {
        m = trimmed.match(/^([A-Za-z-]+)\s+(\d{4})$/);
        if (!m) return null;
        raw = m[1]!;
        year = parseInt(m[2]!, 10);
    }
    const season = SEASON_TOKEN_TO_LABEL[raw];
    if (!season) return null;
    return { year, season };
}

/**
 * Map a parsed term to its NYU ACADEMIC YEAR (the integer year the academic
 * year OPENS). NYU's academic year runs Fall Y → January(Y+1) → Spring(Y+1) →
 * Summer(Y+1), so a Fall term opens the year and the following J-term, Spring,
 * and Summer all belong to that SAME academic year `Y`.
 *
 *   Fall 2026   → 2026
 *   January 2027→ 2026
 *   Spring 2027 → 2026
 *   Summer 2027 → 2026
 *   Fall 2027   → 2027
 */
function academicYearOf(t: {
    year: number;
    season: "Spring" | "Summer" | "Fall" | "Winter" | "January";
}): number {
    // Fall opens the academic year ⇒ the academic year IS the calendar year.
    // Every other season falls AFTER a Fall, so it belongs to the PRIOR
    // calendar year's academic year (year - 1).
    return t.season === "Fall" ? t.year : t.year - 1;
}

/**
 * Group the DPR's ELECTED P/F-graded rows (grade === "P" AND
 * passFailElected === true) by the key implied by `perTermUnit`:
 *   - "semester"      → the verbatim term string (e.g. "2026 Fall").
 *   - "academic_year" → the academic-year integer (Fall Y opens year Y).
 *
 * Only OUR P/F elections count (flagged by applyPassFailToDpr) — native /
 * historical "P" rows (PE, labs, immutable history) carry no `passFailElected`
 * flag and are NOT counted, so they never false-fire the per-term limit (D-4:
 * HARD on the elections we can see; HEDGE the rest).
 *
 * Returns `{ counts, allTermsParseable }`. `counts` maps each group key to its
 * elected-P/F-row count; `allTermsParseable` is false when ANY elected P/F row
 * had an unparseable term (so the caller hedges instead of hard-failing on a
 * possibly mis-grouped count). Empty input (no elected P rows) is trivially
 * `allTermsParseable`.
 */
function groupPassFailByPeriod(
    rows: DPRCourseRow[],
    perTermUnit: "semester" | "academic_year",
): { counts: Map<string, number>; allTermsParseable: boolean } {
    const counts = new Map<string, number>();
    let allTermsParseable = true;

    for (const row of rows) {
        if (row.grade !== "P" || row.passFailElected !== true) continue;
        const parsed = parseTermYearSeason(row.term);
        if (parsed === null) {
            // A P/F row with an unparseable term: grouping is unreliable.
            allTermsParseable = false;
            continue;
        }
        const key =
            perTermUnit === "academic_year"
                ? String(academicYearOf(parsed))
                : `${parsed.year} ${parsed.season}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return { counts, allTermsParseable };
}

/**
 * Per-term P/F check (limit (B)). Returns a `fail` ValidationResult naming the
 * over-limit group, or `null` when the per-term limit is not violated / not
 * applicable / cannot be reliably evaluated (so the caller falls back to the
 * career result). NEVER returns a fail on unknown-term data.
 */
function checkPerTermPassFail(
    dpr: DegreeProgressReport,
    passFail: PassFailConfig,
): ValidationResult | null {
    const perTermLimit = passFail.perTermLimit;
    // Gate: no per-term limit configured → no per-term check (pass-by-default,
    // so synthetic-config axis tests that set no perTermLimit are UNAFFECTED).
    if (perTermLimit == null) return null;

    const perTermUnit: "semester" | "academic_year" = passFail.perTermUnit ?? "semester";
    const unitLabel = perTermUnit === "academic_year" ? "academic year" : "term";

    const { counts, allTermsParseable } = groupPassFailByPeriod(
        dpr.courseHistory,
        perTermUnit,
    );

    // Find the worst-offending group among those we CAN group reliably.
    let worstKey: string | null = null;
    let worstCount = 0;
    for (const [key, count] of counts) {
        if (count > perTermLimit && count > worstCount) {
            worstKey = key;
            worstCount = count;
        }
    }

    if (worstKey !== null) {
        // HARD fail on what we can see (D-4).
        return {
            status: "fail",
            reason:
                `You have ${worstCount} Pass/Fail courses in ${unitLabel} ${worstKey}, ` +
                `which exceeds your school's limit of ${perTermLimit} per ${unitLabel}.`,
        };
    }

    // No reliable group is over the limit. If some P/F rows had an unparseable
    // term we could not group them — but we still do NOT hard-fail on unknown
    // data; the caller's career result (with its hedge/pass) stands. We simply
    // return null so the per-term check escalates nothing here.
    // (`allTermsParseable` is intentionally unused as an escalation trigger; it
    // only documents that an absent fail under unparseable terms is a hedge,
    // not a clean pass.)
    void allTermsParseable;
    return null;
}

/**
 * 8th validator axis — per-school P/F limits (Plan 37, D-4 + per-term
 * follow-up).
 *
 * Pass-by-default: if no `passFail` config is supplied (school does not have
 * the axis configured) or the school cannot elect P/F at all (`canElect:false`,
 * e.g. Tandon), the axis returns a non-blocking `pass`. The `canElect:false`
 * guard is a safety net; the upstream action-matrix already prevents a student
 * from electing P/F at Tandon, but the axis must not block if it is somehow
 * reached.
 *
 * Returns a SINGLE ValidationResult combining the career cap (A) and the
 * per-term limit (B): a `fail` from EITHER ⇒ `fail`. The per-term check only
 * ever ESCALATES to `fail`; otherwise the career result is returned unchanged.
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

    // ---- (A) Career limit ----
    const careerResult = checkCareerPassFail(dpr, passFail);

    // ---- (B) Per-term limit (gated on perTermLimit != null) ----
    const perTermFail = checkPerTermPassFail(dpr, passFail);

    // ---- Combine: a per-term fail ESCALATES the career result to fail ----
    // If the career result already fails, keep it (preserves its credit/percent
    // phrasing). Otherwise, a per-term fail wins. Never relax a career fail.
    if (careerResult.status === "fail") return careerResult;
    if (perTermFail !== null) return perTermFail;
    return careerResult;
}

/**
 * Career-limit check (limit (A)) — three tiers (D-4). Factored out of
 * `checkPassFailLimits` so the per-term check can be layered on top without
 * duplicating the career logic. Returns the career ValidationResult.
 */
function checkCareerPassFail(
    dpr: DegreeProgressReport,
    passFail: PassFailConfig,
): ValidationResult {
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
        // passFailUsedUnits is the registrar's authoritative ELECTED-P/F credit
        // total (parser.ts ← the PeopleSoft R1680/10 "Pass/Fail" requirement
        // counter; natively-P/F-only courses are not counted against it), so no
        // elected-vs-native conflation here — no passFailElected filter needed.
        // A what-if PASS election increments it in applyPassFailToDpr (D-5).
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
