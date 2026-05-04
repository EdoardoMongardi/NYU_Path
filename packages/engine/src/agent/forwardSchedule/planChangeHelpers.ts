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
} from "@nyupath/shared";
import type { SolverInput } from "./types.js";
import type { ToolSession } from "../tool.js";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import { notSatisfiedRequirements, walkRequirements } from "../../dpr/schema.js";
import { meetsGradeThreshold } from "../../dpr/gradeComparison.js";
import { classifyBalanceDelta, computeBalanceScore } from "./balanceScore.js";
import { hashDprCourseHistory } from "./reconcile.js";

// ---------------------------------------------------------------------------
// Shared Zod schemas (used by propose_plan_change + confirm_plan_change)
// ---------------------------------------------------------------------------

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
    z.object({ kind: z.literal("pin"), courseId: z.string(), term: z.string() }),
    z.object({ kind: z.literal("exclude"), courseId: z.string(), term: z.string().optional() }),
    z.object({ kind: z.literal("swap"), drop: z.string(), add: z.string(), term: z.string() }),
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
]);

/** Top-level input shape: `{ mutations: PlanMutation[] }` with min(1). */
export const PlanChangeInputSchema = z.object({
    mutations: z.array(PlanMutationSchema).min(1),
});

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
    };

    const noOpConsequences: string[] = [];

    for (const m of mutations) {
        switch (m.kind) {
            case "pin": {
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
            default: {
                // Exhaustiveness guard — TS will error here if a new kind is added
                // to PlanMutation without updating this switch.
                const _exhaustive: never = m;
                void _exhaustive;
                break;
            }
        }
    }

    // Bind/unbind for the same slotId in one call cancel out.
    // (Already handled implicitly since unbind produces a no-op consequence
    //  and bind is also a no-op at this level — both are deferred to Task 6.)

    return { prefs, noOpConsequences };
}

// ---------------------------------------------------------------------------
// buildSolverInputFromSession — factors the SolverInput construction from
// build.ts so proposePlanChange / confirmPlanChange don't duplicate it.
// ---------------------------------------------------------------------------

/**
 * Construct a SolverInput from a ToolSession + DPR, optionally overriding
 * the preferences field. This is a pure refactor of the construction
 * block in build.ts (steps 1–10, minus step 11 which calls the solver).
 *
 * When `preferences` is supplied it overrides `session.schedulePreferences`.
 */
export function buildSolverInputFromSession(
    session: ToolSession,
    dpr: DegreeProgressReport,
    preferences?: SchedulePreferences,
): SolverInput {
    const student = session.student;
    const schoolConfig = session.schoolConfig ?? null;

    const creditsEarned = dpr.cumulative.creditsUsed ?? 0;
    const graduationCreditMinimum = dpr.cumulative.creditsRequired ?? schoolConfig?.totalCreditsRequired ?? 128;
    const creditCeiling = schoolConfig?.maxCreditsPerSemester ?? 18;
    const creditTargetPerSemester = 16;
    const cumulativeGpa = dpr.cumulative.cumulativeGpa ?? 0;
    const f1Floor =
        student?.visaStatus === "f1"
            ? (schoolConfig?.f1FullTimeMinCredits ?? 12)
            : null;
    const domesticPartTimeFloor = 8;

    const passFailCap = dpr.cumulative.passFailCapUnits ?? 32;
    const passFailUsed = dpr.cumulative.passFailUsedUnits ?? 0;
    const outsideHomeCreditCap = dpr.cumulative.outsideHomeCapUnits ?? null;
    const outsideHomeCreditsUsed = dpr.cumulative.outsideHomeUsedUnits ?? 0;

    const studentId = student?.id ?? "unknown";
    const homeSchoolId = student?.homeSchool ?? schoolConfig?.schoolId ?? "cas";
    const visaStatus = student?.visaStatus;

    const coursesTaken = new Set<string>();
    const coursesInProgress = new Set<string>();
    for (const row of dpr.courseHistory) {
        const key = `${row.subject} ${row.catalogNbr}`;
        if (row.type === "IP") {
            coursesInProgress.add(key);
            continue;
        }
        if (row.grade && meetsGradeThreshold(row.grade, "D")) {
            coursesTaken.add(key);
        }
    }

    const currentTerm = inferCurrentTermFromDpr(dpr);
    const graduationTerm = deriveGraduationTermFromCredits(currentTerm, creditsEarned, graduationCreditMinimum, creditTargetPerSemester);

    const unmetReqs = notSatisfiedRequirements(dpr.requirementGroups);
    const unmetRequirements: SolverInput["unmetRequirements"] = unmetReqs.map(req => ({
        rId: req.rId,
        title: req.title,
        category: inferCategory(req.rId, req.title),
        credits: inferRequirementCredits(req),
        candidateCourses: extractCandidateCourseIds(req),
    }));

    const prereqsMap = new Map<string, import("@nyupath/shared").PrereqGroup[]>();
    if (session.prereqs) {
        for (const p of session.prereqs) {
            prereqsMap.set(p.course, p.prereqGroups);
        }
    }

    const courseCatalog = new Map<string, { title: string; credits: number }>();
    if (session.courses) {
        for (const c of session.courses) {
            courseCatalog.set(c.id, { title: c.title, credits: c.credits });
        }
    }

    const programRules = buildProgramRulesFromSession(session, dpr, graduationTerm, graduationCreditMinimum);
    const dprCourseHistoryHash = hashDprCourseHistory(dpr);

    const effectivePreferences = preferences ?? session.schedulePreferences;

    return {
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
        graduationGpaFloor: schoolConfig?.overallGpaMin ?? 2.0,
        majorGpaFloor: null,
        unmetRequirements,
        prereqs: prereqsMap,
        offerings: new Map(),
        offeringConfidence: new Map(),
        courseCatalog,
        dprCourseHistoryHash,
        dpr,
        programRules: programRules.solverRules,
        preferences: effectivePreferences,
    };
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
 * For Task 5 all fields are populated as accurately as possible
 * from the two schedules; some advanced fields (cascadedShifts,
 * validationResultsChanges) require more context than is available
 * here and are left as empty arrays / empty records.
 */
export function buildPlanDiff(
    before: ForwardSchedule | undefined,
    after: ForwardSchedule,
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

    return {
        creditsByTermDelta,
        graduationTermShift: gradShift,
        newRequiresPetition: [],
        removedRequiresPetition: [],
        newUnmetRequirements: [],
        cascadedShifts: [],
        weightedCreditsByTermDelta,
        workloadTierShifts,
        balanceImpact,
        newAssumptions: [],
        validationResultsChanges: {},
        planStateChange,
    };
}

// ---------------------------------------------------------------------------
// Private helpers (mirrors the private section of build.ts)
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

function inferCurrentTermFromDpr(dpr: DegreeProgressReport): string {
    const ipRows = dpr.courseHistory.filter(r => r.type === "IP");
    if (ipRows.length > 0) {
        const latestTerm = ipRows[ipRows.length - 1]!.term;
        const converted = psTermToSolverTerm(latestTerm);
        if (converted) return converted;
    }
    return "2026-fall";
}

function psTermToSolverTerm(psTerm: string): string | null {
    const m = psTerm.match(/^(\d{4})\s+(Fall|Spring|Summer|J Term|Spr|Sum)$/i);
    if (!m) return null;
    const year = m[1]!;
    const seasonRaw = m[2]!.toLowerCase();
    const season =
        seasonRaw.startsWith("fa") ? "fall" :
        seasonRaw.startsWith("sp") ? "spring" :
        seasonRaw.startsWith("su") ? "summer" :
        seasonRaw.startsWith("j")  ? "january" : null;
    if (!season) return null;
    return `${year}-${season}`;
}

function deriveGraduationTermFromCredits(
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
    for (let i = 0; i < Math.max(1, semestersNeeded); i++) {
        if (season === "spring") { season = "fall"; }
        else if (season === "fall") { year += 1; season = "spring"; }
        else if (season === "summer") { season = "fall"; }
        else { season = "spring"; }
    }
    return `${year}-${season}`;
}

const COURSE_ID_RE = /\b([A-Z][A-Z0-9]*-[A-Z]{2,3})\s+(\d{1,4}[A-Z]?)\b/g;

function extractCandidateCourseIds(req: { description?: string; statusText: string; title: string }): string[] {
    const sources = [req.description ?? "", req.statusText, req.title].join(" ");
    const out = new Set<string>();
    for (const m of sources.matchAll(COURSE_ID_RE)) {
        out.add(`${m[1]} ${m[2]}`);
    }
    return Array.from(out);
}

function inferCategory(rId: string, title: string): string {
    const blob = `${rId} ${title}`.toLowerCase();
    if (blob.includes("major")) return "cs_major_required";
    if (blob.includes("core"))  return "cas_core";
    if (blob.includes("elective")) return "free_elective";
    return "general";
}

function inferRequirementCredits(req: { counter?: import("../../dpr/schema.js").DPRCounter }): number {
    if (!req.counter) return 4;
    if (req.counter.kind === "units") {
        const needed = "needed" in req.counter ? (req.counter.needed ?? 0) : Math.max(0, req.counter.required - req.counter.used);
        return needed > 0 ? needed : 4;
    }
    return 4;
}

interface ProgramRulesBundle {
    solverRules: SolverInput["programRules"];
}

function buildProgramRulesFromSession(
    session: ToolSession,
    dpr: DegreeProgressReport,
    _graduationTerm: string,
    _degreeCreditMinimum: number,
): ProgramRulesBundle {
    const schoolConfig = session.schoolConfig ?? null;
    const leaves = walkRequirements(dpr.requirementGroups);
    const majorRuleKinds = new Map<string, "must_take" | "choose_n">();
    const schoolCoreRuleIds = new Set<string>();
    const generalCategoryRuleIds = new Set<string>();

    for (const leaf of leaves) {
        const blob = `${leaf.rId} ${leaf.title}`.toLowerCase();
        if (blob.includes("major") || blob.includes("concentration")) {
            majorRuleKinds.set(leaf.rId, blob.includes("required") ? "must_take" : "choose_n");
        } else if (blob.includes("core") || blob.includes("cas core")) {
            schoolCoreRuleIds.add(leaf.rId);
        } else {
            generalCategoryRuleIds.add(leaf.rId);
        }
    }

    const residencyMin = dpr.cumulative.residencyRequired ?? schoolConfig?.residency?.minCredits ?? null;

    const solverRules: SolverInput["programRules"] = {
        majorRuleKinds,
        schoolCoreRuleIds,
        generalCategoryRuleIds,
        residencyMinCredits: typeof residencyMin === "number" ? residencyMin : null,
        majorCreditMinimum: null,
        upperLevelMinCredits: null,
    };

    return { solverRules };
}

// Re-export PlanState for tools that need it
export type { PlanState };
