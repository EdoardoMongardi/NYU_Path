/**
 * Phase 13 Task 3.1 — Forward-schedule greedy solver.
 *
 * Decisions covered:
 *   #1  NOT-clause exclusion
 *   #4  prereqSatisfaction helper (Decision #4 truth-table via isPrereqSatisfied)
 *   #5  lenient course-restricted (catalog-absent → placeholder)
 *   #8  optional electives above credit floor
 *   #21 study-abroad-9000-skip
 *   #22a–d term-constraints + rationale
 *   #24 workloadTier per-slot
 *   #25 balanceScore
 *   #26 candidate ranking: prereq-depth-ascending, workload-weight-descending
 *   #27 forwardFeasibilityScreen at every placement
 *   #29 offeringConfidence per slot
 *   #30 IP assumptions
 *   #32 PlanState 4-state
 *   #34 visaValidator per-term invariants
 *   #35 workloadWeight modifiers
 *   #37 placeholder slots
 *   #39 isCriticalPath
 *   #44 alternativeCandidates (Stage 7 stub distribution probe)
 *
 * Phase 13 is a greedy single-pass solver — no backtracking. Phase 15 introduces
 * CSP-style backtracking. The greedy placement IS Stage 6; Stage 7 ships as a
 * stub that probes 3–5 synthetic distributions and emits AlternativePlanSummary.
 */

import type {
    ScheduleSlot,
    ScheduleSlotSpecificPlanned,
    ScheduleSlotPlaceholder,
    ForwardSemester,
    FeasibilityReport,
    SlotRationale,
    SlotFlexibility,
    DownstreamImpact,
    Assumption,
    AlternativePlanSummary,
    LoadRationale,
    ConfidenceTier,
    WorkloadTier,
    TermConstraint,
    PrereqGroup,
    SchedulePreferences,
} from "@nyupath/shared";
import type { SolverInput, SolverOutput } from "./types.js";
import { isPrereqSatisfied } from "../../dpr/prereqSatisfaction.js";
import { visaValidator } from "../../dpr/visaValidator.js";
import { visaNotesForCredits } from "./visaPolicy.js";
import { classifyWorkloadTier } from "./workloadTier.js";
import { computeBalanceScore } from "./balanceScore.js";
import { forwardFeasibilityScreen } from "./forwardFeasibility.js";

// ---------------------------------------------------------------------------
// Term utilities
// ---------------------------------------------------------------------------

const SEASON_RANK: Record<string, number> = { spring: 0, summer: 1, fall: 2, january: 3 };

function parseTerm(t: string): { year: number; season: string } | null {
    const m = t.toLowerCase().match(/^(\d{4})-(spring|summer|fall|january)$/);
    if (!m) return null;
    return { year: parseInt(m[1]!, 10), season: m[2]! };
}

function termOrd(p: { year: number; season: string }): number {
    return p.year * 4 + (SEASON_RANK[p.season] ?? 0);
}

function termCode(p: { year: number; season: string }): string {
    return `${p.year}-${p.season}`;
}

function nextMainTerm(p: { year: number; season: string }): { year: number; season: string } {
    if (p.season === "spring") return { year: p.year, season: "fall" };
    if (p.season === "fall") return { year: p.year + 1, season: "spring" };
    if (p.season === "summer") return { year: p.year, season: "fall" };
    // january
    return { year: p.year, season: "spring" };
}

/** Enumerate fall/spring main terms from start (inclusive) to end (inclusive).
 *  Phase 13 skips summer + january. */
function enumerateMainTerms(start: string, end: string): string[] {
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

/** Compare two solver-format terms. Returns <0 if a < b, 0 if equal, >0 if a > b. */
function compareSolverTerms(a: string, b: string): number {
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
function termsForPlacement(
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
function effectiveTermTarget(
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
function computePrereqDepths(
    courseIds: string[],
    prereqMap: Map<string, import("@nyupath/shared").PrereqGroup[]>,
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
function isExcludedByNotClause(
    courseId: string,
    prereqMap: Map<string, import("@nyupath/shared").PrereqGroup[]>,
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
// Decision #21 — study-abroad-9000-skip
// ---------------------------------------------------------------------------

function isStudyAbroadCourse(courseId: string): boolean {
    // Study-abroad courses have catalog numbers ≥ 9000
    const m = courseId.match(/[- ](\d+)[A-Za-z]*\s*$/);
    if (!m) return false;
    const n = parseInt(m[1]!, 10);
    return !isNaN(n) && n >= 9000;
}

// ---------------------------------------------------------------------------
// Prereq satisfaction check for a single course in a given target term
// Uses the real isPrereqSatisfied helper from prereqSatisfaction.ts.
// ---------------------------------------------------------------------------

interface PrereqCheckResult {
    satisfied: boolean;
    requiresPetition: boolean;
    decisionsApplied: string[];
}

function checkAllPrereqs(
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

function buildDependentsIndex(
    courseIds: string[],
    prereqMap: Map<string, import("@nyupath/shared").PrereqGroup[]>,
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
function computeDownstreamImpact(
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

function isCriticalPath(
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
// LoadRationale builder
// ---------------------------------------------------------------------------

function buildLoadRationale(
    slots: ScheduleSlot[],
    creditTarget: number,
    placed: number,
    alternativeDistributions: LoadRationale["alternativeDistributionsConsidered"],
): LoadRationale {
    let weightedCredits = 0;
    let hardCount = 0;
    let easyCount = 0;

    for (const s of slots) {
        if (s.kind === "specific_planned") {
            weightedCredits += s.credits * (s.workloadWeight ?? 1.0);
            if ((s.workloadWeight ?? 0) >= 1.0) hardCount++;
            else easyCount++;
        } else if (s.kind === "placeholder") {
            weightedCredits += s.credits * (s.workloadWeight ?? 0.3);
            easyCount++;
        }
    }

    return {
        strategy: "balanced",
        creditsTarget: creditTarget,
        slack: Math.max(0, creditTarget - placed),
        weightedCredits,
        hardCount,
        easyCount,
        alternativeDistributionsConsidered: alternativeDistributions,
    };
}

// ---------------------------------------------------------------------------
// Stage 7 — synthetic alternativeCandidates emission (stub)
// Decision #44
// ---------------------------------------------------------------------------

/** The 3-5 candidate credit distributions for Stage 7 probing. */
const ALT_DISTRIBUTIONS: number[][] = [
    [16, 16, 16, 16],
    [18, 14, 18, 14],
    [12, 20, 16, 16],
    [14, 18, 14, 18],
    [20, 12, 16, 16],
];

function buildAlternativeCandidates(
    semesters: ForwardSemester[],
    greedy: { balanceScore: number },
): AlternativePlanSummary[] {
    if (semesters.length === 0) return [];
    const n = semesters.length;

    const candidates: AlternativePlanSummary[] = [];

    for (let i = 0; i < ALT_DISTRIBUTIONS.length; i++) {
        const dist = ALT_DISTRIBUTIONS[i]!;
        // Pad or trim the distribution to match number of semesters
        const credits: number[] = [];
        for (let j = 0; j < n; j++) {
            credits.push(dist[j % dist.length] ?? 16);
        }

        // Build synthetic ForwardSemester array for scoring
        const syntheticSems: ForwardSemester[] = semesters.map((sem, j) => ({
            ...sem,
            plannedCredits: credits[j]!,
            loadRationale: {
                ...sem.loadRationale,
                creditsTarget: credits[j]!,
                slack: Math.max(0, credits[j]! - sem.plannedCredits),
                weightedCredits: credits[j]! * 0.8,
                hardCount: Math.round((credits[j]! / 4) * 0.6),
                easyCount: Math.round((credits[j]! / 4) * 0.4),
            },
        }));

        const altScore = computeBalanceScore(syntheticSems, "balanced");

        // Feasibility check: skip distributions that put any term below f1 floor
        // (simplified — a real check would call forwardFeasibilityScreen)
        const feasible = credits.every(c => c >= 8 && c <= 22);
        if (!feasible) continue;

        const weightedCreditsByTerm: Record<string, number> = {};
        const hardCountByTerm: Record<string, number> = {};
        const easyCountByTerm: Record<string, number> = {};
        const subjectDistributionByTerm: Record<string, Record<string, number>> = {};

        for (let j = 0; j < n; j++) {
            const sem = semesters[j]!;
            weightedCreditsByTerm[sem.term] = credits[j]! * 0.8;
            hardCountByTerm[sem.term] = Math.round((credits[j]! / 4) * 0.6);
            easyCountByTerm[sem.term] = Math.round((credits[j]! / 4) * 0.4);
            subjectDistributionByTerm[sem.term] = {};
            // Extract subjects from greedy slots (simplified)
            for (const slot of sem.slots) {
                if (slot.kind === "specific_planned" || slot.kind === "in_progress") {
                    const subj = (slot.courseId ?? "").replace(/ \d+.*$/, "");
                    subjectDistributionByTerm[sem.term]![subj] =
                        (subjectDistributionByTerm[sem.term]![subj] ?? 0) + slot.credits;
                }
            }
        }

        const topDiffs: Array<{ aspect: string; change: string }> = [];
        if (altScore < greedy.balanceScore) {
            topDiffs.push({
                aspect: "balanceScore",
                change: `${altScore.toFixed(2)} vs greedy ${greedy.balanceScore.toFixed(2)} (more balanced)`,
            });
        } else {
            topDiffs.push({
                aspect: "balanceScore",
                change: `${altScore.toFixed(2)} vs greedy ${greedy.balanceScore.toFixed(2)}`,
            });
        }

        candidates.push({
            planIndex: i + 1,
            balanceScore: altScore,
            weightedCreditsByTerm,
            hardCountByTerm,
            easyCountByTerm,
            subjectDistributionByTerm,
            distinctSubjectsCount: Object.values(subjectDistributionByTerm)
                .flatMap(d => Object.keys(d))
                .filter((v, idx, arr) => arr.indexOf(v) === idx).length,
            // totalPetitionCount uses the WINNER's slots — alternative
            // distributions in this Phase-13 stub are credit-redistribution
            // probes, not full re-solves, so the same petition slots persist
            // across all candidates. Per-variant counts require Phase 15
            // re-solve.
            totalPetitionCount: semesters
                .flatMap(s => s.slots)
                .filter(s => s.kind === "specific_planned" && s.requiresPetition === true)
                .length,
            // totalAssumptionCount is backfilled in solveForwardSchedule's
            // post-pass after buildIpAssumptions runs (also winner-derived;
            // see Phase 15 for per-variant re-solve).
            totalAssumptionCount: 0,
            graduationTerm: semesters[semesters.length - 1]?.term ?? "",
            topDiffsFromWinner: topDiffs,
        });
    }

    // Sort ascending by balanceScore, cap at 5
    return candidates.sort((a, b) => a.balanceScore - b.balanceScore).slice(0, 5);
}

// ---------------------------------------------------------------------------
// IP assumption builder (Decision #30)
// ---------------------------------------------------------------------------

function buildIpAssumptions(
    input: SolverInput,
    placedCourses: Set<string>,
    dependentsIndex: Map<string, string[]>,
): Assumption[] {
    const assumptions: Assumption[] = [];
    for (const ipCourseId of input.coursesInProgress) {
        // Only emit an assumption if this IP course is a prereq for at least one placed slot
        const dependents = dependentsIndex.get(ipCourseId) ?? [];
        const affectedPlaced = dependents.filter(d => placedCourses.has(d));
        if (affectedPlaced.length === 0) continue;

        assumptions.push({
            type: "IP_COURSE_COMPLETION",
            courseId: ipCourseId,
            consequenceIfFalse: `Downstream slots ${affectedPlaced.join(", ")} may need to move to a later term.`,
            cascadingSlots: affectedPlaced,
            contingencyPlanAvailable: false,
        });
    }
    return assumptions;
}

// ---------------------------------------------------------------------------
// PlanState derivation (Decision #32 — coarse Task 3.1 approximation)
// ---------------------------------------------------------------------------

function derivePlanState(
    semesters: ForwardSemester[],
    feasibility: FeasibilityReport,
    assumptions: Assumption[],
): import("@nyupath/shared").PlanState {
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

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function solveForwardSchedule(input: SolverInput): SolverOutput {
    const violations: FeasibilityReport["constraintViolations"] = [];
    const placementRationale: Record<string, string> = {};

    // -----------------------------------------------------------------------
    // Stages 1–4: Input prep
    // -----------------------------------------------------------------------

    // Enumerate future main terms. Phase 13 includes the currentTerm as a
    // planning target (the solver fills it with specific_planned slots).
    // In build.ts the current term's existing IP slots are prepended as locked
    // `in_progress` slots; the solver adds remaining planned slots on top.
    // We do NOT filter currentTerm here — only summer/january are skipped.
    const allFutureTerms = enumerateMainTerms(input.currentTerm, input.graduationTerm);

    // For edge case: if graduation == current term, nothing to plan
    if (allFutureTerms.length === 0) {
        const emptyFeasibility: FeasibilityReport = {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        };
        return {
            semesters: [],
            feasibility: emptyFeasibility,
            balanceScore: 0,
            assumptions: [],
            state: "valid-clean",
        };
    }

    // Initialize per-term tracking
    const perTermSlots = new Map<string, ScheduleSlot[]>();
    const perTermCredits = new Map<string, number>();
    for (const t of allFutureTerms) {
        perTermSlots.set(t, []);
        perTermCredits.set(t, 0);
    }

    // Pre-populate the current term with in-progress slots so that slack
    // accounting is correct during placement. In the full build.ts flow,
    // the solver receives IP courses via `coursesInProgress`; here we mint
    // in_progress ScheduleSlots for each IP course using the catalog (when
    // the course is known) so credit counts are accurate.
    const currentTermSlots = perTermSlots.get(input.currentTerm);
    if (currentTermSlots !== undefined) {
        for (const ipCourseId of input.coursesInProgress) {
            const meta = input.courseCatalog.get(ipCourseId);
            const ipCredits = meta?.credits ?? 4; // default 4cr when catalog absent
            currentTermSlots.push({
                kind: "in_progress",
                courseId: ipCourseId,
                title: meta?.title ?? ipCourseId,
                credits: ipCredits,
            });
            perTermCredits.set(
                input.currentTerm,
                (perTermCredits.get(input.currentTerm) ?? 0) + ipCredits
            );
        }
    }

    // plannedPlacements: courseId → term (for isPrereqSatisfied's future-placement path)
    const plannedPlacements = new Map<string, string>();

    // Gather ALL candidate course IDs across all requirements
    const allCandidateCourseIds: string[] = [];
    for (const req of input.unmetRequirements) {
        for (const cid of req.candidateCourses) allCandidateCourseIds.push(cid);
    }

    // -----------------------------------------------------------------------
    // Stage 5: Candidate ranking (Decision #26)
    // prereq-depth-ascending, workload-weight-descending
    // -----------------------------------------------------------------------

    const prereqDepths = computePrereqDepths(allCandidateCourseIds, input.prereqs);

    // Build per-course workload weights for ranking (use defaults; no rules yet)
    function rankingWeight(courseId: string): number {
        const result = classifyWorkloadTier({
            courseId,
            satisfiesRules: [],
            majorRuleKinds: input.programRules.majorRuleKinds,
            schoolCoreRuleIds: input.programRules.schoolCoreRuleIds,
            generalCategoryRuleIds: input.programRules.generalCategoryRuleIds,
            bulletinTitle: input.courseTitles?.get(courseId),
            bulletinKeywords: input.courseBulletinKeywords?.get(courseId),
        });
        return result.weight;
    }

    // Sort unmetRequirements by (prereq-depth ASC, workload-weight DESC)
    // This ensures courses with no prereqs and high workload-tier place first.
    const sortedRequirements = [...input.unmetRequirements].sort((a, b) => {
        const aCourse = a.candidateCourses[0];
        const bCourse = b.candidateCourses[0];
        const aDepth = aCourse ? (prereqDepths.get(aCourse) ?? 0) : 0;
        const bDepth = bCourse ? (prereqDepths.get(bCourse) ?? 0) : 0;
        if (aDepth !== bDepth) return aDepth - bDepth; // ascending depth
        const aWeight = aCourse ? rankingWeight(aCourse) : 0;
        const bWeight = bCourse ? rankingWeight(bCourse) : 0;
        return bWeight - aWeight; // descending weight
    });

    // Build dependents index for downstream-impact
    const dependentsIndex = buildDependentsIndex(allCandidateCourseIds, input.prereqs);

    // -----------------------------------------------------------------------
    // Stage 6: Candidate-level filters + placement
    // -----------------------------------------------------------------------

    const placeholderRequirements: typeof input.unmetRequirements = [];
    const placedCourseSet = new Set<string>(); // for isCriticalPath and IP assumptions

    // -----------------------------------------------------------------------
    // Phase 14 Task 3 — (d) Pin-placement pass (Decision #10 / #31)
    // Pins are mandatory preferences within the valid candidate set.
    // Pins CANNOT bypass hard filters (offering pattern, catalog-absent).
    // Pins that violate offering pattern emit an offering_pattern violation.
    //
    // Pin / exclusion conflict resolution: if the same courseId appears in
    // both `preferences.pins` and `preferences.exclusions`, the pin wins.
    // Decision #31's hierarchy places student pins (rank 4) ABOVE student
    // soft preferences (rank 5, where exclusions live). Structurally this
    // happens "for free" because the pin loop runs first, the pinned
    // course lands in `plannedPlacements`, and the candidate loop's
    // `plannedPlacements.has(courseId)` skip-check fires before the
    // exclusion set is consulted.
    // -----------------------------------------------------------------------

    for (const pin of input.preferences?.pins ?? []) {
        if (!allFutureTerms.includes(pin.term)) {
            violations.push({
                kind: "other",
                course: pin.courseId,
                detail: `Pinned to ${pin.term}, not a future term in the plan window.`,
            });
            continue;
        }
        const meta = input.courseCatalog.get(pin.courseId);
        if (!meta) {
            violations.push({
                kind: "other",
                course: pin.courseId,
                detail: `Pinned course ${pin.courseId} not in catalog.`,
            });
            continue;
        }
        const offered = input.offerings.get(pin.courseId);
        const seasonOnly = (parseTerm(pin.term)?.season ?? "fall") as "fall" | "spring";
        if (offered && offered.length > 0 && !offered.includes(seasonOnly)) {
            violations.push({
                kind: "offering_pattern",
                course: pin.courseId,
                term: pin.term,
                detail: `${pin.courseId} pinned to ${pin.term}, but offering pattern is ${offered.join(", ")}.`,
            });
            continue;
        }

        // Build full rich fields for the pinned slot (Decision #10 pin hard constraint)
        const confidence: ConfidenceTier =
            input.offeringConfidence.get(pin.courseId) ?? "historically_partial";
        const wtResult = classifyWorkloadTier({
            courseId: pin.courseId,
            satisfiesRules: [],
            majorRuleKinds: input.programRules.majorRuleKinds,
            schoolCoreRuleIds: input.programRules.schoolCoreRuleIds,
            generalCategoryRuleIds: input.programRules.generalCategoryRuleIds,
            bulletinTitle: input.courseTitles?.get(pin.courseId),
            bulletinKeywords: input.courseBulletinKeywords?.get(pin.courseId),
        });

        const latestTermForPin = allFutureTerms[allFutureTerms.length - 1] ?? pin.term;

        const pinRationale: SlotRationale = {
            satisfiesRequirements: [],
            termConstraints: [
                { kind: "offering", detail: `Pinned by student preference to ${pin.term}.` },
            ],
            consideredAlternatives: [],
            decisionsApplied: ["D10-pinHardConstraint", "D31-pinPrecedence"],
        };

        const pinFlexibility: SlotFlexibility = {
            earliestPossibleTerm: pin.term,
            latestPossibleTerm: latestTermForPin,
            alternativeCourses: [],
        };

        const pinDownstream = computeDownstreamImpact(pin.courseId, dependentsIndex);

        const pinnedSlot: ScheduleSlotSpecificPlanned = {
            kind: "specific_planned",
            courseId: pin.courseId,
            title: meta.title,
            credits: meta.credits,
            satisfiesRules: [],
            reason: `Pinned by student preference to ${pin.term}.`,
            rationale: pinRationale,
            flexibility: pinFlexibility,
            downstreamImpact: pinDownstream,
            workloadTier: wtResult.tier,
            workloadWeight: wtResult.weight ?? 1.0,
            bindingState: "bound",
            confidence,
            isCriticalPath: false,
        };

        perTermSlots.get(pin.term)!.push(pinnedSlot);
        perTermCredits.set(pin.term, (perTermCredits.get(pin.term) ?? 0) + meta.credits);
        plannedPlacements.set(pin.courseId, pin.term);
        placedCourseSet.add(pin.courseId);
        placementRationale[pin.courseId] = pinnedSlot.reason;
    }

    // -----------------------------------------------------------------------
    // Phase 14 Task 3 — (e) Build exclusion set (Decision #11)
    // Courses in preferences.exclusions are never placed by the solver.
    // -----------------------------------------------------------------------

    const excludedCourseSet = new Set(
        (input.preferences?.exclusions ?? []).map(e => e.courseId),
    );

    for (const req of sortedRequirements) {
        // --- Stage 6a: candidate-level filters ---

        // Placeholder if no candidates
        if (req.candidateCourses.length === 0) {
            placeholderRequirements.push(req);
            continue;
        }

        // Phase 14 Task 3 — (e) Apply exclusions: skip excluded candidates.
        // Filter the candidate list, then pick the first non-excluded one.
        const filteredCandidates = req.candidateCourses.filter(
            c => !excludedCourseSet.has(c),
        );

        if (filteredCandidates.length === 0) {
            // All candidates excluded — fall through to placeholder
            placeholderRequirements.push(req);
            continue;
        }

        // Pick the first candidate (greedy; Phase 15 would try all)
        const courseId = filteredCandidates[0]!;

        // Skip if already placed by the pin pass
        if (plannedPlacements.has(courseId)) continue;

        const meta = input.courseCatalog.get(courseId);

        // Catalog gap → placeholder (Decision #5 lenient)
        if (!meta) {
            placeholderRequirements.push(req);
            continue;
        }

        // Decision #21: skip study-abroad courses (≥9000)
        if (isStudyAbroadCourse(courseId)) {
            violations.push({
                kind: "other",
                course: courseId,
                detail: `Course ${courseId} is a study-abroad section (≥9000) — skipped in Phase 13 (Decision #21).`,
            });
            continue;
        }

        // Decision #1: NOT-clause exclusion
        if (isExcludedByNotClause(courseId, input.prereqs, input.coursesTaken, plannedPlacements)) {
            violations.push({
                kind: "not_clause",
                course: courseId,
                detail: `Course ${courseId} is excluded by a NOT prereq clause (something in coursesTaken blocks it).`,
            });
            continue;
        }

        // Workload tier + weight for this slot
        const wtResult = classifyWorkloadTier({
            courseId,
            satisfiesRules: [req.rId],
            majorRuleKinds: input.programRules.majorRuleKinds,
            schoolCoreRuleIds: input.programRules.schoolCoreRuleIds,
            generalCategoryRuleIds: input.programRules.generalCategoryRuleIds,
            bulletinTitle: input.courseTitles?.get(courseId),
            bulletinKeywords: input.courseBulletinKeywords?.get(courseId),
        });

        const confidence: ConfidenceTier =
            input.offeringConfidence.get(courseId) ?? "historically_partial";
        const offered = input.offerings.get(courseId);

        // --- Stage 6c: slack-based placement ---
        // Walk terms in preference order (frontload / backload / default chronological).
        let placed = false;

        const termsToTry = termsForPlacement(
            allFutureTerms,
            perTermCredits,
            input.creditTargetPerSemester,
            input.preferences,
        );

        for (const term of termsToTry) {
            const seasonOnly = (parseTerm(term)?.season ?? "fall") as "fall" | "spring";
            const termTarget = effectiveTermTarget(
                term,
                input.creditTargetPerSemester,
                input.preferences,
                input.f1Floor,
                input.domesticPartTimeFloor,
                input.creditCeiling,
            );
            const slack = termTarget - (perTermCredits.get(term) ?? 0);

            // Check offering pattern
            if (offered && offered.length > 0 && !offered.includes(seasonOnly)) {
                continue;
            }

            // Check credit slack
            if (slack < meta.credits) continue;

            // Check prereqs via the real isPrereqSatisfied helper
            const prereqResult = checkAllPrereqs(courseId, term, input, plannedPlacements);
            if (!prereqResult.satisfied && !prereqResult.requiresPetition) {
                // Prereqs not met — try next term
                continue;
            }

            // Phase 14 Task 9 — Decision #14: co-requisite same-term enforcement.
            // If course C has coreqs [X, Y, ...] that are still unmet (not in
            // coursesTaken and not yet placed), all of them must fit in this same
            // term (slack + offering pattern).  If any cannot fit, reject this term
            // and try the next one.
            const coreqIds = input.coreqs?.get(courseId) ?? [];
            let coreqTermRejected = false;
            const coreqTermConstraintDetails: string[] = [];
            for (const coreqId of coreqIds) {
                // If the coreq is already taken, in-progress, or already
                // planned in some prior term, no enforcement is needed.
                // (IP courses count as concurrent satisfaction per
                // Decision #4's optimistic-forward-projection — same
                // semantics as the prereq path's checkAllPrereqs handles.)
                if (input.coursesTaken.has(coreqId)) continue;
                if (input.coursesInProgress.has(coreqId)) continue;
                if (plannedPlacements.has(coreqId)) continue;
                // Coreq is unmet — it must be placeable in this same term.
                const coreqMeta = input.courseCatalog.get(coreqId);
                if (!coreqMeta) {
                    // Catalog absent — coreq can't be confirmed; treat as unsatisfiable
                    // and record it, but do not hard-reject (catalog gaps are lenient).
                    coreqTermConstraintDetails.push(`${coreqId}:catalog-absent`);
                    continue;
                }
                // Check credit slack against the per-term effective target
                // (which honors loadStylePerTerm "light"/"heavy" overrides
                // and explicit creditTargetPerTerm). Falls back to the
                // hard ceiling so a heavy-load term still has its real
                // upper bound. Without this min(), preference-driven
                // light terms would silently accept coreq bundles up to
                // the hard ceiling, defeating the "light" intent.
                const projectedCredits = (perTermCredits.get(term) ?? 0) + meta.credits + coreqMeta.credits;
                const termTargetForCoreq = effectiveTermTarget(
                    term,
                    input.creditTargetPerSemester,
                    input.preferences,
                    input.f1Floor,
                    input.domesticPartTimeFloor,
                    input.creditCeiling,
                );
                const coreqCap = Math.min(input.creditCeiling, termTargetForCoreq);
                if (projectedCredits > coreqCap) {
                    // Effective per-term cap exceeded — can't fit both in this term
                    coreqTermRejected = true;
                    coreqTermConstraintDetails.push(`${coreqId}:ceiling-exceeded`);
                    break;
                }
                // Check offering pattern for coreq
                const coreqOffered = input.offerings.get(coreqId);
                if (coreqOffered && coreqOffered.length > 0 && !coreqOffered.includes(seasonOnly)) {
                    // Coreq not offered this season — can't place together
                    coreqTermRejected = true;
                    coreqTermConstraintDetails.push(`${coreqId}:offering-mismatch`);
                    break;
                }
                // Passes: coreq fits offering and credit ceiling
                coreqTermConstraintDetails.push(`${coreqId}:ok`);
            }
            if (coreqTermRejected) {
                // This term can't accommodate all coreqs — try next term
                continue;
            }

            // Decision #27: forward-feasibility screen after trial placement
            const trialCredits = new Map(perTermCredits);
            trialCredits.set(term, (trialCredits.get(term) ?? 0) + meta.credits);

            const remainingUnmet = sortedRequirements
                .filter(r => {
                    const cid = r.candidateCourses[0];
                    return cid && !plannedPlacements.has(cid) && cid !== courseId;
                })
                .map(r => ({
                    courseId: r.candidateCourses[0]!,
                    credits: r.credits,
                    minDepth: prereqDepths.get(r.candidateCourses[0]!) ?? 0,
                }));

            const remainingTerms = allFutureTerms.filter(
                t => compareSolverTerms(t, term) > 0,
            );

            const creditCeilingMap = new Map<string, number>();
            for (const t of allFutureTerms) {
                creditCeilingMap.set(t, input.creditCeiling);
            }

            const feasible = forwardFeasibilityScreen({
                placedCreditsByTerm: trialCredits,
                creditCeilingByTerm: creditCeilingMap,
                remainingUnmet,
                remainingTerms,
                confidenceByCourse: input.offeringConfidence,
            });

            if (!feasible && remainingTerms.length > 0) {
                // Try next term (per spec: re-tries are within same course's term-search loop)
                continue;
            }

            // Build rationale fields
            const termConstraints: TermConstraint[] = [];
            if (offered && offered.length > 0) {
                termConstraints.push({
                    kind: "offering",
                    detail: `${courseId} offered in: ${offered.join(", ")}`,
                });
            }
            if (slack < meta.credits + 4) {
                // "creditSlack" — slack against creditTargetPerSemester, NOT the
                // hard ceiling input.creditCeiling. Used for the rationale UI to
                // explain "this term filled up the target before another candidate
                // could land here."
                termConstraints.push({
                    kind: "creditSlack",
                    detail: `Slack ${slack} cr constrained placement to term ${term}.`,
                });
            }
            if (prereqResult.decisionsApplied.length > 0) {
                termConstraints.push({
                    kind: "prereqChain",
                    detail: `Prereq chain: ${prereqResult.decisionsApplied.join(", ")}`,
                });
            }
            // Phase 14 Task 9 — record coreq constraint in rationale when coreqs were enforced
            const satisfiedCoreqIds = coreqIds.filter(
                c => !input.coursesTaken.has(c) && !plannedPlacements.has(c),
            );
            if (satisfiedCoreqIds.length > 0) {
                termConstraints.push({
                    kind: "coreqSameTerm",
                    detail: `Coreqs [${satisfiedCoreqIds.join(", ")}] must be taken same term as ${courseId} (Decision #14).`,
                });
            }

            // flexibility.earliestPossibleTerm: first future term matching offering
            const earliestTerm = allFutureTerms.find(t => {
                const s = (parseTerm(t)?.season ?? "fall") as "fall" | "spring";
                return !offered || offered.length === 0 || offered.includes(s);
            }) ?? term;

            // latestPossibleTerm: last future term before graduation
            const latestTerm = allFutureTerms[allFutureTerms.length - 1] ?? term;

            // alternativeCourses: other candidates from same requirement
            const alternativeCourses = req.candidateCourses.filter(c => c !== courseId);

            const rationale: SlotRationale = {
                satisfiesRequirements: [req.rId],
                termConstraints,
                consideredAlternatives: alternativeCourses.map(c => ({
                    courseId: c,
                    rejectedBecause: "greedy-first-candidate-wins (Phase 15 will evaluate all)",
                })),
                decisionsApplied: [
                    ...prereqResult.decisionsApplied,
                    ...(prereqResult.requiresPetition ? ["D3-petitionSoftAllow"] : []),
                ].filter((v, i, arr) => arr.indexOf(v) === i),
                ...(prereqResult.requiresPetition
                    ? {
                          petitionTrigger: {
                              fromCourse: courseId,
                              bulletinText: "Instructor permission required",
                          },
                      }
                    : {}),
            };

            const flexibility: SlotFlexibility = {
                earliestPossibleTerm: earliestTerm,
                latestPossibleTerm: latestTerm,
                alternativeCourses,
            };

            const downstreamImpact = computeDownstreamImpact(courseId, dependentsIndex);

            const criticalPath = isCriticalPath(
                courseId,
                req.rId,
                req.candidateCourses,
                dependentsIndex,
                input.prereqs,
            );

            const slot: ScheduleSlotSpecificPlanned = {
                kind: "specific_planned",
                courseId,
                title: meta.title,
                credits: meta.credits,
                satisfiesRules: [req.rId],
                reason: `Required (${req.category}) placed in ${term} via slack-balanced placement.`,
                ...(prereqResult.requiresPetition ? { requiresPetition: true } : {}),
                rationale,
                flexibility,
                downstreamImpact,
                workloadTier: wtResult.tier,
                workloadWeight: wtResult.weight,
                bindingState: "bound",
                confidence,
                isCriticalPath: criticalPath,
                ...(prereqResult.requiresPetition ? { approvalAuthority: "instructor" as const } : {}),
            };

            perTermSlots.get(term)!.push(slot);
            perTermCredits.set(term, (perTermCredits.get(term) ?? 0) + meta.credits);
            plannedPlacements.set(courseId, term);
            placedCourseSet.add(courseId);
            placementRationale[courseId] = slot.reason;
            placed = true;
            break; // move to next requirement
        }

        if (!placed) {
            const coreqHint = (input.coreqs?.get(courseId) ?? []).length > 0
                ? ` Co-requisites [${(input.coreqs!.get(courseId)!).join(", ")}] may have prevented placement (Decision #14).`
                : "";
            violations.push({
                kind: "prereq_unsatisfiable",
                course: courseId,
                detail: `Could not place ${courseId} — no future term has sufficient slack, matching offering pattern, and satisfied prereqs.${coreqHint}`,
            });
            // Still add placeholder so the plan is visible
            placeholderRequirements.push(req);
        }
    }

    // -----------------------------------------------------------------------
    // Stage 6c: Placeholder slots for requirements with empty candidateCourses
    // or no matching catalog entry (Decision #37)
    // -----------------------------------------------------------------------

    const degreeCreditsMet = input.creditsEarned >= input.graduationCreditMinimum;

    for (const req of placeholderRequirements) {
        // Find the earliest term with sufficient slack (respects per-term target overrides)
        let bestTerm: string | null = null;
        let bestSlack = -Infinity;
        for (const t of allFutureTerms) {
            const tTarget = effectiveTermTarget(
                t,
                input.creditTargetPerSemester,
                input.preferences,
                input.f1Floor,
                input.domesticPartTimeFloor,
                input.creditCeiling,
            );
            const slack = tTarget - (perTermCredits.get(t) ?? 0);
            if (slack >= req.credits && slack > bestSlack) {
                bestSlack = slack;
                bestTerm = t;
            }
        }
        if (!bestTerm) {
            // No room — try force into first term
            bestTerm = allFutureTerms[0] ?? null;
        }
        if (!bestTerm) continue;

        const isImmediate = bestTerm === allFutureTerms[0];
        const bindingState: "placeholder-pending" | "placeholder-deferred" = isImmediate
            ? "placeholder-pending"
            : "placeholder-deferred";

        const wtResult = classifyWorkloadTier({
            courseId: `placeholder-${req.rId}`,
            satisfiesRules: [req.rId],
            majorRuleKinds: input.programRules.majorRuleKinds,
            schoolCoreRuleIds: input.programRules.schoolCoreRuleIds,
            generalCategoryRuleIds: input.programRules.generalCategoryRuleIds,
            isOptional: false,
        });

        const latestTerm = allFutureTerms[allFutureTerms.length - 1] ?? bestTerm;

        const phRationale: SlotRationale = {
            satisfiesRequirements: [req.rId],
            termConstraints: [
                { kind: "offering", detail: "No specific course assigned — pending advising" },
            ],
            consideredAlternatives: req.candidateCourses.map(c => ({
                courseId: c,
                rejectedBecause: "not in course catalog or no offering data",
            })),
            decisionsApplied: ["D37-PlaceholderSlot"],
        };

        const phSlot: ScheduleSlotPlaceholder = {
            kind: "placeholder",
            category: req.title,
            credits: req.credits,
            satisfiesRules: [req.rId],
            optional: false,
            reason: `Placeholder for unmet requirement "${req.title}" (${req.category}).`,
            rationale: phRationale,
            flexibility: {
                earliestPossibleTerm: bestTerm,
                latestPossibleTerm: latestTerm,
                alternativeCourses: req.candidateCourses,
            },
            downstreamImpact: { courseIds: [], graduationDelay: 0 },
            workloadTier: wtResult.tier,
            workloadWeight: 0.3, // Decision #37: placeholder default 0.3
            bindingState,
            placeholderId: `REQ-${req.rId}`,
            confidence: "historically_partial",
            isCriticalPath: req.candidateCourses.length === 0, // only satisfier
        };

        perTermSlots.get(bestTerm)!.push(phSlot);
        perTermCredits.set(bestTerm, (perTermCredits.get(bestTerm) ?? 0) + req.credits);
    }

    // -----------------------------------------------------------------------
    // Fill remaining capacity with free-elective placeholders (Decision #8)
    // -----------------------------------------------------------------------

    for (const term of allFutureTerms) {
        const cur = perTermCredits.get(term) ?? 0;
        const target = effectiveTermTarget(
            term,
            input.creditTargetPerSemester,
            input.preferences,
            input.f1Floor,
            input.domesticPartTimeFloor,
            input.creditCeiling,
        );
        let credits = cur;
        const latestTerm = allFutureTerms[allFutureTerms.length - 1] ?? term;

        // Fill in 4-credit increments; then add a partial-credit top-off slot
        // if the target is not a multiple of 4 (e.g. target=18 → 4+4+4+4+2).
        while (credits < target) {
            const slotCredits = Math.min(4, target - credits);

            // Decision #8: above F-1 floor + degreeCreditsMet → optional
            const aboveFloor =
                credits >= (input.f1Floor ?? input.domesticPartTimeFloor ?? 0);
            const optional = degreeCreditsMet && aboveFloor;

            const freeRationale: SlotRationale = {
                satisfiesRequirements: [],
                termConstraints: [
                    {
                        kind: "creditFloor",
                        detail: optional
                            ? `Above degree minimum + F-1 floor — optional load.`
                            : `Fills term to ${target}-credit target.`,
                    },
                ],
                consideredAlternatives: [],
                decisionsApplied: optional ? ["D8-OptionalElective"] : [],
            };

            const freeSlot: ScheduleSlotPlaceholder = {
                kind: "placeholder",
                category: "Free elective",
                credits: slotCredits,
                satisfiesRules: [],
                optional,
                reason: optional
                    ? "Above degree minimum and credit floor — optional load."
                    : `Brings total to ${target}-credit target.`,
                rationale: freeRationale,
                flexibility: {
                    earliestPossibleTerm: term,
                    latestPossibleTerm: latestTerm,
                    alternativeCourses: [],
                },
                downstreamImpact: { courseIds: [], graduationDelay: 0 },
                workloadTier: "free-elective" as WorkloadTier,
                workloadWeight: 0.3,
                bindingState: "placeholder-deferred",
                placeholderId: `FREE-${term}-${credits}`,
                confidence: "historically_partial",
                isCriticalPath: false,
                ...(optional ? { optionalReason: { droppable: true } } : {}),
            };

            perTermSlots.get(term)!.push(freeSlot);
            credits += slotCredits;
        }
        perTermCredits.set(term, credits);
    }

    // -----------------------------------------------------------------------
    // Stage 6d: per-term visa invariants (Decision #34)
    // -----------------------------------------------------------------------

    const semesters: ForwardSemester[] = allFutureTerms.map(term => {
        const slots = perTermSlots.get(term) ?? [];
        const termCredits = slots.reduce((s, x) => s + x.credits, 0);
        const notes: string[] = [];

        // Visa notes from visaNotesForCredits
        const visaNotes = visaNotesForCredits({
            credits: termCredits,
            visa: input.visaStatus,
            f1Floor: input.f1Floor,
            domesticPartTimeFloor: input.domesticPartTimeFloor,
        });
        notes.push(...visaNotes);

        // Full visaValidator for per-axis fails
        const isLastTerm = term === allFutureTerms[allFutureTerms.length - 1];
        const vResult = visaValidator({
            termCredits,
            term,
            profile: {
                visaStatus: (input.visaStatus as "f1" | "domestic" | "other" | undefined),
                isFinalTerm: isLastTerm,
            },
            f1Floor: input.f1Floor,
            domesticPartTimeFloor: input.domesticPartTimeFloor,
            f1OnlineCreditsPerTermCap: null,
        });

        // Block on any axis returning "fail"
        if (vResult.fullTimeSatisfied.status === "fail") {
            violations.push({
                kind: "credit_floor",
                term,
                detail: `Below F-1 full-time floor (${termCredits} credits). ${vResult.fullTimeSatisfied.reason}`,
            });
        }
        if (vResult.creditMinimumSatisfied.status === "fail") {
            violations.push({
                kind: "credit_floor",
                term,
                detail: `Below minimum enrollment floor (${termCredits} credits). ${vResult.creditMinimumSatisfied.reason}`,
            });
        }

        if (termCredits > input.creditCeiling) {
            notes.push(`Above credit ceiling of ${input.creditCeiling} — overload approval needed.`);
            violations.push({
                kind: "credit_ceiling",
                term,
                detail: `Above ceiling (${termCredits} > ${input.creditCeiling}).`,
            });
        }

        const loadRationale = buildLoadRationale(
            slots,
            input.creditTargetPerSemester,
            termCredits,
            [],
        );

        return {
            term,
            locked: false,
            slots,
            plannedCredits: termCredits,
            notes,
            loadRationale,
        };
    });

    // -----------------------------------------------------------------------
    // Stage 8: global constraint checks
    // -----------------------------------------------------------------------

    // Graduation total
    const totalScheduled =
        input.creditsEarned +
        semesters.reduce((s, sem) => s + sem.plannedCredits, 0);
    if (totalScheduled < input.graduationCreditMinimum) {
        violations.push({
            kind: "graduation_total",
            detail: `Projected total ${totalScheduled} < graduation minimum ${input.graduationCreditMinimum}.`,
        });
    }

    // Pass/fail cap
    if (input.passFailUsed >= input.passFailCap) {
        violations.push({
            kind: "pass_fail_cap",
            detail: `Student has used ${input.passFailUsed} of ${input.passFailCap} P/F units. Any future placement must be letter-graded.`,
        });
    }

    // Online credit cap
    if (input.onlineCreditCap != null && input.onlineCreditsUsed > input.onlineCreditCap) {
        violations.push({
            kind: "online_credit_cap",
            detail: `Student has used ${input.onlineCreditsUsed} online credits, exceeding the ${input.onlineCreditCap}-credit cap. Future online courses will not count.`,
        });
    }

    // Outside-home credit cap
    if (
        input.outsideHomeCreditCap != null &&
        input.outsideHomeCreditsUsed > input.outsideHomeCreditCap
    ) {
        violations.push({
            kind: "outside_home_credit_cap",
            detail: `Student has used ${input.outsideHomeCreditsUsed} credits outside ${input.homeSchoolId}, exceeding the ${input.outsideHomeCreditCap}-credit cap.`,
        });
    }

    // GPA floors
    if (input.cumulativeGpa < input.graduationGpaFloor) {
        violations.push({
            kind: "gpa_floor",
            detail: `Cumulative GPA ${input.cumulativeGpa} is below the ${input.graduationGpaFloor} graduation floor. The plan does not address this.`,
        });
    }
    if (
        input.majorGpaFloor != null &&
        input.majorGpa != null &&
        input.majorGpa < input.majorGpaFloor
    ) {
        violations.push({
            kind: "gpa_floor",
            detail: `Major GPA ${input.majorGpa} is below the ${input.majorGpaFloor} major-completion floor.`,
        });
    }

    // -----------------------------------------------------------------------
    // Post-pass: assumptions, balanceScore, alternativeCandidates, state
    // -----------------------------------------------------------------------

    const assumptions = buildIpAssumptions(input, placedCourseSet, dependentsIndex);

    const balanceScore = computeBalanceScore(semesters, "balanced");

    const feasibility: FeasibilityReport = {
        feasible: violations.length === 0,
        ...(violations.length > 0
            ? { infeasibilityReason: `${violations.length} constraint violation(s).` }
            : {}),
        constraintViolations: violations,
        placementRationale,
    };

    const state = derivePlanState(semesters, feasibility, assumptions);

    // Stage 7: alternativeCandidates
    const alternativeCandidates = buildAlternativeCandidates(semesters, { balanceScore });

    // Backfill totalAssumptionCount on each candidate now that assumptions
    // are computed. Stage 7 emitted summaries with the field set to 0 so
    // the structural shape was complete; this pass populates the real
    // count. (Phase 13 ships a single `assumptions[]` per plan — same value
    // applies to every alternative because the candidates are distribution
    // probes over the same placed slots; future backtracking phases that
    // re-run the solver per candidate will fill per-candidate counts.)
    for (const cand of alternativeCandidates) {
        cand.totalAssumptionCount = assumptions.length;
    }

    return {
        semesters,
        feasibility,
        alternativeCandidates: alternativeCandidates.length > 0 ? alternativeCandidates : undefined,
        balanceScore,
        assumptions,
        state,
    };
}
