/**
 * Pure placement primitives extracted from solver.ts (Phase 2 P2.1a) so
 * constraintModel/search can reuse them without an import cycle.
 */

import type {
    PrereqGroup,
    SchedulePreferences,
    DownstreamImpact,
    ForwardSemester,
    FeasibilityReport,
    Assumption,
    PlanState,
} from "@nyupath/shared";
import type { SolverInput } from "./types.js";
// TYPE-ONLY import (erased at compile, no runtime edge) — keeps solverHelpers a
// cycle-free leaf even though constraintModel.ts imports values from here.
import type { ConstraintContext } from "./constraintModel.js";
import { isPrereqSatisfied } from "../../dpr/prereqSatisfaction.js";

// ---------------------------------------------------------------------------
// Term utilities
// ---------------------------------------------------------------------------

export const SEASON_RANK: Record<string, number> = { spring: 0, summer: 1, fall: 2, january: 3 };

export function parseTerm(t: string): { year: number; season: string } | null {
    const m = t.toLowerCase().match(/^(\d{4})-(spring|summer|fall|january)$/);
    if (!m) return null;
    return { year: parseInt(m[1]!, 10), season: m[2]! };
}

export function termOrd(p: { year: number; season: string }): number {
    return p.year * 4 + (SEASON_RANK[p.season] ?? 0);
}

export function termCode(p: { year: number; season: string }): string {
    return `${p.year}-${p.season}`;
}

export function nextMainTerm(p: { year: number; season: string }): { year: number; season: string } {
    if (p.season === "spring") return { year: p.year, season: "fall" };
    if (p.season === "fall") return { year: p.year + 1, season: "spring" };
    if (p.season === "summer") return { year: p.year, season: "fall" };
    // january
    return { year: p.year, season: "spring" };
}

/**
 * T2b — Advance a graduation term by one main term and return the solver-shape
 * string, or null when the input is not a recognised spring/fall term.
 *
 * Exported so build.ts can use it for the add-a-term relax loop without
 * duplicating the logic that alternatives.ts previously kept private.
 *
 * Mapping:
 *   YYYY-spring → YYYY-fall   (same year)
 *   YYYY-fall   → (YYYY+1)-spring
 *   Any other season (summer, january) → null
 */
export function nextMainTermOrNull(term: string): string | null {
    const p = parseTerm(term);
    if (!p) return null;
    if (p.season === "spring") return termCode({ year: p.year, season: "fall" });
    if (p.season === "fall") return termCode({ year: p.year + 1, season: "spring" });
    return null;
}

/** Enumerate fall/spring main terms from start (inclusive) to end (inclusive).
 *  Phase 13 skips summer + january. */
export function enumerateMainTerms(start: string, end: string): string[] {
    const a = parseTerm(start);
    const b = parseTerm(end);
    if (!a || !b) return [];
    const out: string[] = [];
    let cur = a;
    while (termOrd(cur) <= termOrd(b)) {
        if (cur.season === "fall" || cur.season === "spring") out.push(termCode(cur));
        if (termOrd(cur) >= termOrd(b)) break;
        cur = nextMainTerm(cur);
        // Safety guard against infinite loops
        if (cur.year > b.year + 10) break;
    }
    return out;
}

/** Seasons that the system treats as OPTIONAL terms (P2.8 / PLAN-5): an F-1
 *  student need not be full-time, the free-elective fill does not pad them, and
 *  the workload-balance proxies exclude them. Fall/spring are the normal
 *  full-load terms; summer + january are optional. */
export function isOptionalTerm(term: string): boolean {
    const p = parseTerm(term);
    return p !== null && (p.season === "summer" || p.season === "january");
}

/** Season decode for a `termOrd` (inverse of SEASON_RANK): index = ord % 4. */
const SEASON_BY_RANK = ["spring", "summer", "fall", "january"] as const;

/**
 * Enumerate EVERY season chronologically from `start` (inclusive) to `end`
 * (inclusive), emitting:
 *   - fall + spring  ALWAYS;
 *   - summer  only when `opts.includeSummer`;
 *   - january only when `opts.includeJTerm`.
 *
 * Chronological order is exactly increasing `termOrd`
 * (spring → summer → fall → january → next-year spring …), so the optional
 * terms land in their correct calendar position relative to the main terms.
 *
 * Back-compat: `enumerateTerms(start, end)` with no flags returns EXACTLY what
 * `enumerateMainTerms(start, end)` returns (fall/spring only).
 */
export function enumerateTerms(
    start: string,
    end: string,
    opts?: { includeSummer?: boolean; includeJTerm?: boolean },
): string[] {
    const a = parseTerm(start);
    const b = parseTerm(end);
    if (!a || !b) return [];
    const startOrd = termOrd(a);
    const endOrd = termOrd(b);
    const includeSummer = opts?.includeSummer === true;
    const includeJTerm = opts?.includeJTerm === true;

    const out: string[] = [];
    // Iterate ordinals directly — each ordinal decodes to a unique {year, season}
    // and the natural integer order IS chronological order. Cycle-guard mirrors
    // enumerateMainTerms (bail well past the end year).
    const guardOrd = (b.year + 10) * 4;
    for (let ord = startOrd; ord <= endOrd && ord <= guardOrd; ord++) {
        const season = SEASON_BY_RANK[ord % 4]!;
        if (season === "summer" && !includeSummer) continue;
        if (season === "january" && !includeJTerm) continue;
        const year = Math.floor(ord / 4);
        out.push(termCode({ year, season }));
    }
    return out;
}

/** Compare two solver-format terms. Returns <0 if a < b, 0 if equal, >0 if a > b. */
export function compareSolverTerms(a: string, b: string): number {
    const pa = parseTerm(a);
    const pb = parseTerm(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    return termOrd(pa) - termOrd(pb);
}

// ---------------------------------------------------------------------------
// Phase 14 Task 3 — load-style ordering + per-term effective target
// ---------------------------------------------------------------------------

/**
 * termsForPlacement — returns the ordered list of terms to try when placing
 * a course, respecting the student's global loadStyle preference.
 *
 * - "frontload"  → earliest-first (same as default iteration order)
 * - "backload"   → latest-first (reversed)
 * - undefined / "balanced" → earliest-first (Phase 13 default; Phase 15 will
 *   add a true slack-balancing pass)
 *
 * Decision #9 (frontload / backload); Decision #26 partial (term ordering).
 */
export function termsForPlacement(
    futureTerms: string[],
    _perTermCredits: Map<string, number>,
    _target: number,
    preferences: SchedulePreferences | undefined,
): string[] {
    if (preferences?.loadStyle === "frontload") return [...futureTerms]; // earliest first
    if (preferences?.loadStyle === "backload") return [...futureTerms].reverse();
    // Default (balanced): chronological — Phase 13 greedy fills earliest term first.
    return [...futureTerms];
}

/**
 * effectiveTermTarget — returns the credit target for a given term,
 * respecting per-term and global preference overrides.
 *
 * Priority for "light":
 *   F-1 floor (typically 12) when set; otherwise the domestic
 *   part-time floor (typically 8); otherwise defaultTarget. Without
 *   the domesticPartTimeFloor fallback, a non-F-1 student opting into
 *   "light" Spring would fall through to defaultTarget=16, defeating
 *   the override's intent.
 *
 * Priority overall:
 *   1. creditTargetPerTerm[term] — explicit numeric override
 *   2. loadStylePerTerm[term] === "light"  → f1Floor ?? domesticPartTimeFloor ?? defaultTarget
 *   3. loadStylePerTerm[term] === "heavy"  → ceiling
 *   4. defaultTarget
 *
 * Decision #9 (5 load styles, including per-term light/heavy
 * overrides). Decision #26 partial — Stage-5 candidate-ranking
 * workload-tier-aware bias is wired in Task 5.
 */
export function effectiveTermTarget(
    term: string,
    defaultTarget: number,
    preferences: SchedulePreferences | undefined,
    f1Floor: number | null,
    domesticPartTimeFloor: number | null,
    ceiling: number,
): number {
    const explicit = preferences?.creditTargetPerTerm?.[term];
    if (explicit != null) return explicit;
    const styleOverride = preferences?.loadStylePerTerm?.[term];
    if (styleOverride === "light") return f1Floor ?? domesticPartTimeFloor ?? defaultTarget;
    if (styleOverride === "heavy") return ceiling;
    return defaultTarget;
}

// ---------------------------------------------------------------------------
// Prereq-depth computation
// ---------------------------------------------------------------------------

/** Compute the prereq depth (max chain length from root) for every course
 *  in the given map. Courses not in the prereqMap have depth 0. */
export function computePrereqDepths(
    courseIds: string[],
    prereqMap: Map<string, PrereqGroup[]>,
): Map<string, number> {
    const depths = new Map<string, number>();

    function depth(cid: string, visiting: Set<string>): number {
        if (depths.has(cid)) return depths.get(cid)!;
        if (visiting.has(cid)) return 0; // cycle guard
        visiting.add(cid);
        const groups = prereqMap.get(cid) ?? [];
        let maxDep = 0;
        for (const g of groups) {
            if (g.type === "NOT") continue;
            for (const dep of g.courses) {
                maxDep = Math.max(maxDep, 1 + depth(dep, visiting));
            }
        }
        visiting.delete(cid);
        depths.set(cid, maxDep);
        return maxDep;
    }

    for (const cid of courseIds) depth(cid, new Set());
    return depths;
}

// ---------------------------------------------------------------------------
// NOT-clause exclusion check
// ---------------------------------------------------------------------------

/** Returns true if the course is excluded by a NOT prereq clause
 *  (something in coursesTaken or placedBefore blocks it).
 *  placedBefore can be a Set<string> or Map<string, string> — both support .has(). */
export function isExcludedByNotClause(
    courseId: string,
    prereqMap: Map<string, PrereqGroup[]>,
    coursesTaken: Set<string>,
    placedBefore: { has(key: string): boolean },
): boolean {
    const groups = prereqMap.get(courseId) ?? [];
    for (const g of groups) {
        if (g.type !== "NOT") continue;
        const notCourses = g.notCourses ?? [];
        for (const c of notCourses) {
            if (coursesTaken.has(c) || placedBefore.has(c)) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Shared course-id parsing
// ---------------------------------------------------------------------------

/** Parse a course id into its department prefix + catalog number.
 *  "CORE-UA 412" → { dept: "CORE-UA", num: 412 }; "MATH-UA 9 101" → { dept: "MATH-UA 9", num: 101 }.
 *  Single source of the trailing-number regex shared by isStudyAbroadCourse,
 *  constraintModel's pool expansion, and workloadTier's parseCourseNumber.
 *  Returns null when no numeric suffix is present. */
export function parseCourseComponents(courseId: string): { dept: string; num: number } | null {
    const m = courseId.match(/[- ](\d+)[A-Za-z]*\s*$/);
    if (!m) return null;
    const num = parseInt(m[1]!, 10);
    if (isNaN(num)) return null;
    // dept = everything before the matched number token (trimmed of the separator).
    const dept = courseId.slice(0, m.index! + 1).trimEnd();
    return { dept, num };
}

// ---------------------------------------------------------------------------
// Decision #21 — study-abroad-9000-skip
// ---------------------------------------------------------------------------

export function isStudyAbroadCourse(courseId: string): boolean {
    // Study-abroad courses have catalog numbers ≥ 9000.
    return (parseCourseComponents(courseId)?.num ?? -1) >= 9000;
}

// ---------------------------------------------------------------------------
// Prereq satisfaction check for a single course in a given target term
// Uses the real isPrereqSatisfied helper from prereqSatisfaction.ts.
// ---------------------------------------------------------------------------

export interface PrereqCheckResult {
    satisfied: boolean;
    requiresPetition: boolean;
    decisionsApplied: string[];
}

export function checkAllPrereqs(
    courseId: string,
    dependentTerm: string,
    input: SolverInput,
    plannedPlacements: Map<string, string>,
): PrereqCheckResult {
    const groups = input.prereqs.get(courseId) ?? [];
    const decisions: string[] = [];
    let requiresPetition = false;

    // Walk each prereq group; all non-NOT groups must pass
    for (const g of groups) {
        if (g.type === "NOT") continue; // handled by isExcludedByNotClause

        if (g.requiresPetition) {
            requiresPetition = true;
            decisions.push("D3-petitionSoftAllow");
        }

        if (g.type === "AND") {
            for (const prereqCourseId of g.courses) {
                // Skip empty strings
                if (!prereqCourseId) continue;
                const result = isPrereqSatisfied({
                    prereqCourseId,
                    dependentTerm,
                    dpr: input.dpr,
                    plannedPlacements,
                    minGrades: input.minGrades?.get(courseId),
                    mode: "prereq",
                });
                if (!result.satisfied) {
                    if (g.requiresPetition) {
                        // Petition covers the unsatisfied prereq — soft-allow
                        decisions.push("D3-petitionSoftAllow");
                    } else {
                        return { satisfied: false, requiresPetition, decisionsApplied: decisions };
                    }
                } else {
                    if (result.reason === "ip-attempt") decisions.push("D4-IPProjection");
                    if (result.reason === "future-placement") decisions.push("D4-FuturePlacement");
                }
            }
        } else if (g.type === "OR") {
            if (g.courses.length === 0) {
                // Empty OR — satisfied by petition alone
                if (!g.requiresPetition) {
                    return { satisfied: false, requiresPetition, decisionsApplied: decisions };
                }
            } else {
                let anySatisfied = false;
                for (const prereqCourseId of g.courses) {
                    if (!prereqCourseId) continue;
                    const result = isPrereqSatisfied({
                        prereqCourseId,
                        dependentTerm,
                        dpr: input.dpr,
                        plannedPlacements,
                        minGrades: input.minGrades?.get(courseId),
                        mode: "prereq",
                    });
                    if (result.satisfied) {
                        anySatisfied = true;
                        if (result.reason === "ip-attempt") decisions.push("D4-IPProjection");
                        if (result.reason === "future-placement") decisions.push("D4-FuturePlacement");
                        break;
                    }
                }
                if (!anySatisfied && !g.requiresPetition) {
                    return { satisfied: false, requiresPetition, decisionsApplied: decisions };
                }
            }
        }
    }

    return { satisfied: true, requiresPetition, decisionsApplied: decisions };
}

// ---------------------------------------------------------------------------
// Downstream-impact helper: build prereq DAG and find dependents
// ---------------------------------------------------------------------------

export function buildDependentsIndex(
    courseIds: string[],
    prereqMap: Map<string, PrereqGroup[]>,
): Map<string, string[]> {
    // For each course X, find all courses Y where X appears as a prereq of Y
    const dependents = new Map<string, string[]>();
    for (const cid of courseIds) dependents.set(cid, []);

    for (const cid of courseIds) {
        const groups = prereqMap.get(cid) ?? [];
        for (const g of groups) {
            if (g.type === "NOT") continue;
            for (const prereq of g.courses) {
                if (!dependents.has(prereq)) dependents.set(prereq, []);
                dependents.get(prereq)!.push(cid);
            }
        }
    }
    return dependents;
}

/** Compute the DownstreamImpact for a placed slot. */
export function computeDownstreamImpact(
    courseId: string,
    dependentsIndex: Map<string, string[]>,
): DownstreamImpact {
    const directDependents = dependentsIndex.get(courseId) ?? [];
    // graduationDelay: 1 per direct dependent, 0 if none
    return {
        courseIds: directDependents,
        graduationDelay: directDependents.length > 0 ? 1 : 0,
    };
}

// ---------------------------------------------------------------------------
// Critical-path check (Decision #39)
// ---------------------------------------------------------------------------

export function isCriticalPath(
    courseId: string,
    _rId: string,
    allCandidateCourses: string[],
    dependentsIndex: Map<string, string[]>,
    prereqMap: Map<string, PrereqGroup[]>,
): boolean {
    // Decision #39 — true if EITHER:
    //   1. This is the only satisfier of its requirement (single candidate), OR
    //   2. This course is the SOLE prereq for ≥2 downstream slots in the plan.
    //
    // "Sole prereq" check (rule 2): for each direct dependent Y, count the
    // distinct courses Y depends on across all its prereq groups; courseId is
    // the sole prereq iff that distinct-set is exactly {courseId}. Counting
    // dependents only (without the sole-prereq filter) over-flags any course
    // with ≥2 dependents whose dependents have multiple prereqs — which would
    // mislead Phase 14's mutation logic into treating common low-stakes
    // satisfactions as critical-path. The strict reading matches the spec.
    if (allCandidateCourses.length === 1) return true;

    const directDeps = dependentsIndex.get(courseId) ?? [];
    let soleCount = 0;
    for (const dep of directDeps) {
        const groups = prereqMap.get(dep);
        if (!groups || groups.length === 0) continue;
        // Collect every distinct course-id referenced across all groups
        // (excluding NOT-clause exclusions, which are filters, not satisfiers).
        const referenced = new Set<string>();
        for (const g of groups) {
            if (g.type === "NOT") continue;
            for (const c of g.courses) referenced.add(c);
        }
        if (referenced.size === 1 && referenced.has(courseId)) soleCount++;
        if (soleCount >= 2) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// IP assumption builder (Decision #30)
//
// Moved here from solver.ts (P2 review M2) to break the solver ↔ materializePlan
// import cycle: materializePlan re-uses buildIpAssumptions + derivePlanState, and
// both are pure, so they belong in this cycle-free leaf. Emits one
// IP_COURSE_COMPLETION assumption per in-progress course that is a prereq of at
// least one PLACED (requirement/pin) slot.
// ---------------------------------------------------------------------------

export function buildIpAssumptions(
    input: SolverInput,
    placedCourses: Set<string>,
    dependentsIndex: Map<string, string[]>,
    ctx: ConstraintContext,
): Assumption[] {
    const assumptions: Assumption[] = [];
    for (const [ipCourseId, { term: ipTerm }] of input.coursesInProgress) {
        // Only emit an assumption if this IP course is a prereq for at least one placed slot
        const dependents = dependentsIndex.get(ipCourseId) ?? [];
        const affectedPlaced = dependents.filter(d => placedCourses.has(d));
        if (affectedPlaced.length === 0) continue;

        assumptions.push({
            type: "IP_COURSE_COMPLETION",
            courseId: ipCourseId,
            consequenceIfFalse: `Downstream slots ${affectedPlaced.join(", ")} may need to move to a later term.`,
            cascadingSlots: affectedPlaced,
            // STRUCTURAL contingency: a contingency exists for this IP course iff EVERY
            // affected downstream slot could be re-placed in a LATER term within the
            // window (offering-legal). See contingencyAvailableFor — no full re-solve.
            contingencyPlanAvailable: contingencyAvailableFor(input, ctx, ipTerm, affectedPlaced),
        });
    }
    return assumptions;
}

/**
 * STRUCTURAL determination of `contingencyPlanAvailable` for an IP course
 * (Decision #30). A contingency IS available iff EVERY affected (cascading)
 * downstream slot could be re-placed in a LATER term within the planning window —
 * i.e. for each dependent there exists a future term STRICTLY AFTER the IP course's
 * own term whose season the dependent's offering allows. This is a structural
 * offering/window check only — it does NOT re-run the search (no full re-solve),
 * matching the "structural check" mandate. A dependent with no/empty offerings is
 * treated as season-agnostic (any later term works). When there are no affected
 * slots the caller does not emit an assumption, so this is only consulted with ≥1.
 */
function contingencyAvailableFor(
    input: SolverInput,
    ctx: ConstraintContext,
    ipTerm: string,
    affectedSlots: string[],
): boolean {
    // Future terms strictly AFTER the IP course's term (chronological window order).
    const ipIdx = ctx.futureTerms.indexOf(ipTerm);
    const laterTerms = ipIdx >= 0 ? ctx.futureTerms.slice(ipIdx + 1) : ctx.futureTerms;
    if (laterTerms.length === 0) return false; // nowhere later to move anything

    return affectedSlots.every(dep => {
        const offered = input.offerings.get(dep);
        // No/empty offering ⇒ season-agnostic ⇒ any later term is legal.
        if (!offered || offered.length === 0) return true;
        // Needs ≥1 later term whose season the dependent is offered in.
        return laterTerms.some(term => {
            const season = parseTerm(term)?.season;
            return season !== undefined && offered.includes(season as "fall" | "spring" | "summer" | "january");
        });
    });
}

// ---------------------------------------------------------------------------
// PlanState derivation (Decision #32 — coarse Task 3.1 approximation)
//
// Moved here from solver.ts (P2 review M2) alongside buildIpAssumptions to break
// the solver ↔ materializePlan import cycle. Pure: derived from the materialised
// semesters + feasibility + assumptions.
// ---------------------------------------------------------------------------

export function derivePlanState(
    semesters: ForwardSemester[],
    feasibility: FeasibilityReport,
    assumptions: Assumption[],
): PlanState {
    // Returns 3 of the 4 PlanState members. The fourth state
    // ("student-preferred-invalid-draft") is set by Phase 14's mutation
    // layer when a student confirms a plan despite hard violations — that
    // input is not available to the solver, so it is not emittable here.
    if (!feasibility.feasible) return "infeasible-draft";

    // Check for trade-off signals
    const hasTradeoff =
        assumptions.length > 0 ||
        semesters.some(sem =>
            sem.slots.some(
                s =>
                    (s.kind === "specific_planned" && (
                        s.requiresPetition === true ||
                        s.confidence === "irregular" ||
                        s.confidence === "permission_only" ||
                        (s.approvalAuthority !== undefined)
                    )) ||
                    s.kind === "placeholder"
            )
        );

    return hasTradeoff ? "valid-with-trade-offs" : "valid-clean";
}
