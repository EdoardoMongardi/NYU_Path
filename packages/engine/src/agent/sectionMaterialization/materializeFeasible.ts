// ============================================================
// sectionMaterialization/materializeFeasible.ts — Phase 38 Task 0.3
// ============================================================
// The deterministic orchestrator behind the `materialize_feasible`
// tool (§2 ①). It is the agent's ONLY source of section candidates
// (§2.5 hybrid boundary): the agent NEVER enumerates or judges
// validity — it only ranks/curates this verified set.
//
// Pipeline (per term):
//   1. Pull each course's live sections (cached) + map → SectionView.
//   2. classifyAvailability across the union; early-return on
//      unavailable / partial (no candidates to verify against).
//   3. Filter each course to open/waitlist (closed dropped).
//   4. Apply strict scheduling preferences (strict-drop + soft
//      rerank weights) — Decision #43.
//   5. Group each course's survivors by component (`schd`).
//   6. Enumerate the feasible candidate schedules (multi-component
//      conflict-free + the §2①(d) two-state waitlist backup).
//   7. Deterministic pre-rank (open ≻ waitlist, then soft weights).
//   8. Build the UI-complete candidate set + cite-or-hedge notes.
//
// FROZEN-CONTRACT SAFE: this never touches the solver / validator /
// search. The different-course waitlist backup re-validation reaches
// `finalizeForwardSchedule` only through the injected `backupResolver`
// (Phase A/B/C); default = same-course backups only.
// ============================================================

import { z } from "zod";
import { fetchAndMapCourse } from "./materialize.js";
import { searchCourses as defaultSearchCourses } from "../../api/nyuClassSearch.js";
import { classifyAvailability, type FoseSection } from "./foseAvailabilityGate.js";
import { FoseCache } from "./foseCache.js";
import { applySchedulingPreferences } from "./applySchedulingPreferences.js";
import { groupByComponent, type CourseComponents } from "./componentGrouping.js";
import {
    enumerateFeasibleSchedules,
    type BackupResolver,
    type FeasibleCandidate,
    type OpenFallback,
} from "./feasibleSchedules.js";
import { preRankCandidates } from "./candidatePreRank.js";
import { isAvailableStatus } from "./statusHelpers.js";
import { MAX_COMBINATIONS } from "./conflictDetection.js";
import type { AvailabilityState, MeetingPattern, SectionView } from "./types.js";
import type { SchedulingPreferences } from "@nyupath/shared";

/** Default singleton cache for production callers. Tests inject their own. */
const DEFAULT_CACHE = new FoseCache<unknown[]>();

// ---- UI-complete output shape (Phase 0.3 — the locked engine↔UI contract) ----

export interface ComponentView {
    /** Component type (`schd`): LEC / RCT / LAB / TUT … */
    schd: string;
    crn: string;
    /** FOSE section number (`no`, e.g. "002"). */
    no?: string;
    /** Raw human-readable meeting string. */
    meets: string;
    /** Parsed meeting-time blocks (the conflict-graph input). */
    meetingBlocks: MeetingPattern[];
    /** Instructor name(s), verbatim from FOSE (may be empty → TBA). */
    instr: string;
    /** Open or Waitlist (closed/cancelled are never emitted). */
    status: "O" | "W";
    /** Section capacity (FOSE `total`) — NOT an enrolled/waitlist count. */
    capacity?: string;
}

export interface CandidateCourseView {
    /** Course code, e.g. "CHEM-UA 125". */
    code: string;
    title: string;
    /** One picked section per required component type. */
    components: ComponentView[];
}

export interface FeasibleCandidateView {
    candidateId: string;
    courses: CandidateCourseView[];
    hasWaitlist: boolean;
    waitlistCrns: string[];
    /** Verified open backup per waitlisted section (§2①(d)). */
    openFallbacks: OpenFallback[];
    weeklyHours: number;
    preScore: number;
    preRankReason: string;
}

export interface MaterializeFeasibleResult {
    state: AvailabilityState;
    termCode: string;
    message: string;
    /** The verified candidate set, pre-ranked best-first ([] if not full). */
    candidates: FeasibleCandidateView[];
    /** True when enumeration hit the candidate cap. */
    truncated: boolean;
    /** Cite-or-hedge notes (free-pairing, waitlist queue-length). */
    hedges: string[];
    /**
     * Requested courses with NO open/waitlist section this term (all sections
     * closed/cancelled, or wiped by a strict scheduling preference). These are
     * NOT in `candidates` — the candidate schedules omit them — so the result
     * is honestly flagged as incomplete (never presented as complete). The
     * deferred escalation ladder consumes this to trigger a re-plan. The
     * north-star: never imply a feasibility we didn't verify.
     */
    unavailableCourses: string[];
}

// ---- Zod schema (the structured-output contract; §2.5 guardrail) ----

const meetingBlockSchema = z.object({
    day: z.string(),
    startMin: z.number(),
    endMin: z.number(),
});

const componentViewSchema = z.object({
    schd: z.string(),
    crn: z.string(),
    no: z.string().optional(),
    meets: z.string(),
    meetingBlocks: z.array(meetingBlockSchema),
    instr: z.string(),
    status: z.enum(["O", "W"]),
    capacity: z.string().optional(),
});

const candidateViewSchema = z.object({
    candidateId: z.string(),
    courses: z.array(
        z.object({
            code: z.string(),
            title: z.string(),
            components: z.array(componentViewSchema).min(1),
        }),
    ),
    hasWaitlist: z.boolean(),
    waitlistCrns: z.array(z.string()),
    openFallbacks: z.array(z.object({ forCrn: z.string(), fallbackCrn: z.string() })),
    weeklyHours: z.number(),
    preScore: z.number(),
    preRankReason: z.string(),
});

export const materializeFeasibleResultSchema = z.object({
    state: z.enum(["full", "partial", "unavailable"]),
    termCode: z.string(),
    message: z.string(),
    candidates: z.array(candidateViewSchema),
    truncated: z.boolean(),
    hedges: z.array(z.string()),
    unavailableCourses: z.array(z.string()),
});

// ---- Hedge copy (deterministic; cite-or-hedge) ----

const PAIRING_HEDGE =
    "This course has multiple components (e.g. lecture + recitation/lab). NYU's course " +
    "data does not say which recitation pairs with which lecture, so any compatible pairing " +
    "is shown — verify the exact section pairing in Albert.";

const WAITLIST_HEDGE =
    "A waitlisted section is included with a registrable open backup (Albert auto-swap). " +
    "NYU's course data does not expose the waitlist queue length — check your position in Albert.";

// ---- Args ----

export interface MaterializeFeasibleArgs {
    termCode: string;
    courseIds: string[];
    schedulingPreferences?: SchedulingPreferences;
    /** Different-course grad-valid waitlist backup resolver (Phase A/B/C). */
    backupResolver?: BackupResolver;
    cap?: number;
    searchFn?: (termCode: string, keyword: string) => Promise<unknown[]>;
    cache?: FoseCache<unknown[]>;
}

// ---- View mapping ----

function toComponentView(s: SectionView): ComponentView {
    return {
        schd: s.schd ?? "LEC",
        crn: s.crn,
        no: s.section,
        meets: s.rawMeets,
        meetingBlocks: s.meetingPatterns,
        instr: s.instructor,
        // Guaranteed O|W by the upstream filter; narrow defensively.
        status: s.status === "W" ? "W" : "O",
        capacity: s.capacity,
    };
}

function toCandidateView(candidate: FeasibleCandidate, candidateId: string, preScore: number, preRankReason: string): FeasibleCandidateView {
    return {
        candidateId,
        courses: candidate.selections.map(sel => ({
            code: sel.courseId,
            title: sel.title,
            components: sel.sections.map(toComponentView),
        })),
        hasWaitlist: candidate.hasWaitlist,
        waitlistCrns: candidate.waitlistCrns,
        openFallbacks: candidate.openFallbacks,
        weeklyHours: candidate.weeklyHours,
        preScore,
        preRankReason,
    };
}

// ---- Orchestrator ----

export async function materializeFeasible(
    args: MaterializeFeasibleArgs,
): Promise<MaterializeFeasibleResult> {
    const {
        termCode,
        courseIds,
        schedulingPreferences,
        backupResolver,
        cap = MAX_COMBINATIONS,
        searchFn = defaultSearchCourses as (t: string, k: string) => Promise<unknown[]>,
        cache = DEFAULT_CACHE,
    } = args;

    // ---- 1. fetch + map each course ----
    const fetched = [];
    for (const courseId of courseIds) {
        const { raw, sections } = await fetchAndMapCourse(termCode, courseId, searchFn, cache);
        fetched.push({ courseId, title: sections[0]?.title ?? courseId, raw, sections });
    }

    // ---- 2. classify availability across the union ----
    const unionRaw: FoseSection[] = fetched.flatMap(c =>
        c.raw.map(r => ({ meets: r.meets, meetingTimes: r.meetingTimes })),
    );
    const state = classifyAvailability(unionRaw);

    if (state === "unavailable") {
        return {
            state: "unavailable",
            termCode,
            message:
                `FOSE has no section data for ${termCode}. Section-level info is only available ` +
                `closer to registration; showing the structural plan only.`,
            candidates: [],
            truncated: false,
            hedges: [],
            unavailableCourses: [],
        };
    }
    if (state === "partial") {
        return {
            state: "partial",
            termCode,
            message:
                `Course listings exist for ${termCode}, but meeting times aren't fully published yet. ` +
                `Come back closer to registration for sections + times — verify with your adviser.`,
            candidates: [],
            truncated: false,
            hedges: [],
            unavailableCourses: [],
        };
    }

    // ---- 3. filter each course to open/waitlist (drop closed) ----
    const available = fetched.map(c => ({
        ...c,
        sections: c.sections.filter(s => isAvailableStatus(s.status)),
    }));

    // ---- 4. apply strict scheduling preferences (strict-drop + soft rerank) ----
    const unionAvailable = available.flatMap(c => c.sections);
    const applyResult = applySchedulingPreferences(unionAvailable, schedulingPreferences);
    const survivingCrns = new Set(applyResult.surviving.map(s => s.crn));

    // ---- 5. group each course's survivors by component ----
    const withSurvivors = available.map(c => ({
        ...c,
        sections: c.sections.filter(s => survivingCrns.has(s.crn)),
    }));
    const courses: CourseComponents[] = withSurvivors
        .filter(c => c.sections.length > 0)
        .map(c => groupByComponent(c.courseId, c.title, c.sections));

    // Honesty guard (§north-star): any requested course with NO surviving
    // open/waitlist section (all closed/cancelled, or wiped by a strict pref)
    // is omitted from every candidate — flag it, never present the term as
    // complete. (classifyAvailability runs on the UNION, so one healthy course
    // can mask a fully-closed one; this catches that.)
    const scheduledSet = new Set(courses.map(c => c.courseId));
    const unavailableCourses = courseIds.filter(id => !scheduledSet.has(id));

    // ---- 6. enumerate feasible candidate schedules ----
    const { candidates: rawCandidates, truncated } = enumerateFeasibleSchedules(courses, {
        cap,
        backupResolver,
    });

    // ---- 7. deterministic pre-rank ----
    const ranked = preRankCandidates(rawCandidates, applyResult.rerankWeights);

    // ---- 8. build the UI-complete candidate set + hedges ----
    const candidates = ranked.map((r, i) =>
        toCandidateView(r.candidate, `cand_${termCode}_${i + 1}`, r.preScore, r.preRankReason),
    );

    const hedges: string[] = [];
    const hasMultiComponent = courses.some(c => c.components.size > 1);
    if (hasMultiComponent) hedges.push(PAIRING_HEDGE);
    if (candidates.some(c => c.hasWaitlist)) hedges.push(WAITLIST_HEDGE);
    if (unavailableCourses.length > 0) {
        hedges.push(
            `These planned courses have NO open or waitlist section in ${termCode}: ` +
            `${unavailableCourses.join(", ")}. The schedules below OMIT them — a re-plan ` +
            `(move the course to a later term or pick an alternative) may be needed; verify in Albert.`,
        );
    }

    const incompleteNote =
        unavailableCourses.length > 0
            ? ` (NOTE: ${unavailableCourses.join(", ")} ${unavailableCourses.length === 1 ? "has" : "have"} no open/waitlist section and ${unavailableCourses.length === 1 ? "is" : "are"} omitted)`
            : "";

    const message =
        candidates.length > 0
            ? `Found ${candidates.length} feasible section schedule${candidates.length === 1 ? "" : "s"} for ${termCode}` +
              `${truncated ? ` (showing the first ${candidates.length})` : ""}. Ranked best-first; open schedules first.${incompleteNote}`
            : `No conflict-free, registrable section schedule exists for ${termCode} with the current course set. ` +
              `Some courses may clash in time or have no open/waitlist sections — a re-plan may be needed.${incompleteNote}`;

    return { state: "full", termCode, message, candidates, truncated, hedges, unavailableCourses };
}
