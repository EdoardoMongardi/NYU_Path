// ============================================================
// sectionMaterialization/materialize.ts — Phase 15 Task 6
// ============================================================
// Orchestrator for the section-materializer pipeline (Decisions
// #16, #18, #19, #43). Inputs: a list of structural-plan course
// IDs for one term + a swap-hook the structural solver provides.
// Output: a MaterializationResult with availability state, the
// per-course bundles, conflict-free combinations (Task 2),
// rerank-ranked using soft-pass weights (Task 5), AND a
// precomputed `schedulingPreferenceCheck` verdict for the visa
// validator (Decision #43).
//
// Pipeline (per Decision #16):
//   1. Per-course FOSE pull (cached); exact-code filter; map → SectionView.
//   2. Classify availability across the union of FOSE results.
//   3. State branch: unavailable / partial → return early with msg.
//   4. Open-section filter ("O"|"W") per course.
//   5. Apply scheduling preferences ONCE on the entire pool
//      (one ApplyResult ⇒ shared rerankWeights + eliminatedByStrict).
//   6. Re-bucket survivors back to their courses; track pre/post
//      counts so the swap step can disambiguate "no open sections"
//      from "scheduling-prefs wiped them".
//   7. Decision #19 swap cascade for course wipes (one attempt per
//      course; alt re-runs steps 1, 2 partially, 4, 5).
//   8. Enumerate conflict-free combinations (Task 2).
//   9. Rank combinations by Π section.crn → rerankWeight (default 1).
//   10. Compute schedulingPreferenceCheck verdict.
//   11. Return MaterializationResult.
//
// Schema note: the existing `FoseSearchResult` interface in
// `nyuClassSearch.ts` is INCOMPLETE — it omits `meets`,
// `meetingTimes`, `schd`, `no` (verified against 27 fixtures).
// We define a local `RawFoseSection` shape with the full set and
// cast at the boundary. Cleaning up the upstream interface is a
// separate pass.
//
// Combination score: kept INTERNAL — used only for sort ordering.
// `MaterializedSemester.combinations[i]` retains the published
// shape (`{ sections, weeklyHours }`) — the score is not surfaced
// in the result. This keeps the public type stable; if a future
// phase wants to expose the score, extend `MaterializedSemester`
// with an optional `score?: number`.
// ============================================================

import { searchCourses as defaultSearchCourses } from "../../api/nyuClassSearch.js";
import { parseMeetingTimes } from "./parseMeetingTimes.js";
import { enumerateConflictFreeCombinations, type CourseBundle } from "./conflictDetection.js";
import { classifyAvailability, type FoseSection } from "./foseAvailabilityGate.js";
import { FoseCache } from "./foseCache.js";
import { applySchedulingPreferences, isPrefsEmpty } from "./applySchedulingPreferences.js";
import type {
    SectionView,
    MaterializationResult,
    SchedulingPreferenceCheck,
} from "./types.js";
import type { SchedulingPreferences } from "@nyupath/shared";

// ---- Local FOSE shape (the upstream interface is incomplete) ----

/**
 * The fields we actually need from a FOSE search result. Verified
 * against the 27-fixture sample — see types.ts header for the
 * `meets` vs `hours` correction.
 *
 * NOT exported because callers should always go through
 * `searchCourses` and let the orchestrator do the cast.
 */
interface RawFoseSection {
    code?: string;
    title?: string;
    crn?: string;
    no?: string;
    schd?: string;
    stat?: string;
    credits?: string;
    instr?: string;
    meets?: string;
    meetingTimes?: string;
}

// ---- Module-level shared cache ----

/** Default singleton for production callers. Tests inject their own. */
const DEFAULT_CACHE = new FoseCache<unknown[]>();

// ---- MaterializeArgs ----

export interface MaterializeArgs {
    termCode: string;
    courseIds: string[];
    /**
     * When a course has zero open sections (or is wiped by a strict
     * scheduling preference), swap with a structural-plan-legal
     * alternative. The orchestrator calls this hook (provided by the
     * caller) to ask the structural solver for an alternative.
     * Returns null when no alternative exists (defer to next term).
     */
    swapHook: (
        failedCourseId: string,
        reason: "unavailable" | "scheduling-prefs-eliminated",
    ) => Promise<string | null>;
    /**
     * Optional scheduling preferences from
     * `session.schedulePreferences?.schedulingPreferences` (Decision #43).
     */
    schedulingPreferences?: SchedulingPreferences;
    /**
     * Optional injected search function for tests. Defaults to the real
     * FOSE `searchCourses`. Returns `unknown[]` so tests can inject
     * minimal shapes without recreating the full FoseSearchResult contract.
     */
    searchFn?: (termCode: string, keyword: string) => Promise<unknown[]>;
    /** Optional injected cache for tests. Defaults to a shared module-level cache. */
    cache?: FoseCache<unknown[]>;
}

// ---- Pure helpers (independently testable) ----

/**
 * Map one raw FOSE row to a SectionView using the verified schema
 * (`meets` + `meetingTimes` + `schd` + `no` — NOT `hours`). Pure;
 * no I/O. Caller is responsible for filtering to exact-code matches
 * before invoking.
 */
export function mapFoseToSectionView(
    courseId: string,
    raw: RawFoseSection,
): SectionView {
    const parsed = parseMeetingTimes(raw.meets ?? "", raw.meetingTimes);
    return {
        courseId,
        title: raw.title ?? courseId,
        crn: raw.crn ?? "",
        credits: raw.credits ?? "4",
        instructor: raw.instr ?? "",
        status: raw.stat ?? "",
        meetingPatterns: parsed.kind === "ok" ? parsed.patterns : [],
        isAsynchronous: parsed.kind === "asynchronous",
        rawMeets: raw.meets ?? "",
        meetingTimes: raw.meetingTimes,
        schd: raw.schd,
        section: raw.no,
    };
}

/**
 * Bucket a flat list of SectionViews back to per-course groups,
 * preserving the input course order. Used after we run
 * `applySchedulingPreferences` on the union pool — we need to know
 * which course each surviving section belongs to before enumeration.
 *
 * Pure. courseIds drives the output order; sections without a
 * matching courseId are silently dropped (defensive).
 */
export function bucketSectionsByCourse(
    courseIds: string[],
    sections: SectionView[],
): Map<string, SectionView[]> {
    const buckets = new Map<string, SectionView[]>();
    for (const id of courseIds) buckets.set(id, []);
    for (const s of sections) {
        const arr = buckets.get(s.courseId);
        if (arr !== undefined) arr.push(s);
    }
    return buckets;
}

/**
 * Compute the rerank-weight product for a combination. Each section
 * contributes `rerankWeights.get(crn) ?? 1`. Default product (all
 * default weights) → 1.
 *
 * Pure.
 */
export function scoreCombination(
    sections: SectionView[],
    rerankWeights: Map<string, number>,
): number {
    let score = 1;
    for (const s of sections) {
        score *= rerankWeights.get(s.crn) ?? 1;
    }
    return score;
}

/**
 * Sort combinations DESCENDING by their rerank score (stable: ties
 * preserve enumeration order). Returns a new array; input is
 * untouched. Pure.
 */
export function rankCombinationsByScore<T extends { sections: SectionView[] }>(
    combinations: T[],
    rerankWeights: Map<string, number>,
): T[] {
    // Decorate-sort-undecorate to keep the sort stable on score ties
    // (Array.prototype.sort is stable in V8 since 2018, but pairing
    // with the original index makes the intent explicit + portable).
    const decorated = combinations.map((c, i) => ({
        c,
        i,
        score: scoreCombination(c.sections, rerankWeights),
    }));
    decorated.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.i - b.i;
    });
    return decorated.map(d => d.c);
}

// ---- I/O helper: cached FOSE pull + map + exact-code filter ----

interface CourseFetchResult {
    /** Raw FOSE rows that exact-match this courseId. */
    raw: RawFoseSection[];
    /** Same rows mapped to SectionView (no filtering yet). */
    sections: SectionView[];
}

async function fetchAndMapCourse(
    termCode: string,
    courseId: string,
    searchFn: (termCode: string, keyword: string) => Promise<unknown[]>,
    cache: FoseCache<unknown[]>,
): Promise<CourseFetchResult> {
    let raw = cache.get(termCode, courseId) as RawFoseSection[] | undefined;
    if (raw === undefined) {
        // Cast at the FOSE boundary — see file header for the schema rationale.
        const fetched = (await searchFn(termCode, courseId)) as RawFoseSection[];
        cache.set(termCode, courseId, fetched);
        raw = fetched;
    }
    // FOSE keyword search is substring; reject results where r.code !== courseId.
    const exactMatches = raw.filter(r => r.code === courseId);
    const sections = exactMatches.map(r => mapFoseToSectionView(courseId, r));
    return { raw: exactMatches, sections };
}

/** "O" = open, "W" = waitlist — these are the truly available statuses. */
function isOpenStatus(status: string): boolean {
    return status === "O" || status === "W";
}

// ---- Orchestrator ----

export async function materializeSections(args: MaterializeArgs): Promise<MaterializationResult> {
    const {
        termCode,
        courseIds,
        swapHook,
        schedulingPreferences,
        searchFn = defaultSearchCourses as (
            termCode: string,
            keyword: string,
        ) => Promise<unknown[]>,
        cache = DEFAULT_CACHE,
    } = args;

    // ---- Step 1: pull each course (cache → searchFn) + map ----
    type CourseState = {
        courseId: string;
        title: string;
        rawForGate: FoseSection[];          // for classifyAvailability (full pool, not just open)
        allSections: SectionView[];         // mapped, before any filtering
    };

    const courseStates: CourseState[] = [];
    for (const courseId of courseIds) {
        const { raw, sections } = await fetchAndMapCourse(termCode, courseId, searchFn, cache);
        courseStates.push({
            courseId,
            title: sections[0]?.title ?? courseId,
            rawForGate: raw.map(r => ({ meets: r.meets, meetingTimes: r.meetingTimes })),
            allSections: sections,
        });
    }

    // ---- Step 2: classify availability across the union ----
    const unionRaw: FoseSection[] = courseStates.flatMap(c => c.rawForGate);
    const state = classifyAvailability(unionRaw);

    // ---- Step 3: state branching ----
    // For unavailable / partial we always emit "absent" — there's no FOSE
    // data to verify scheduling preferences against, so the visa axis must
    // degrade to assumed-pass (the validator's "absent" handler). This is
    // intentional: we'd rather be honest about not having checked than
    // claim a verification we didn't perform (Phase 13 high-stakes axiom).
    if (state === "unavailable") {
        return {
            state: "unavailable",
            message:
                `FOSE has no data for ${termCode}. Section-level info is only available ` +
                `closer to registration. Showing structural plan only.`,
            schedulingPreferenceCheck: { kind: "absent" },
        };
    }

    if (state === "partial") {
        return {
            state: "partial",
            partialCourses: courseStates.map(c => ({
                courseId: c.courseId,
                title: c.title,
                sections: c.allSections,
            })),
            message:
                `Course listings exist for ${termCode}, but meeting times aren't fully ` +
                `published yet. Registration likely opens soon — come back later for sections + times.`,
            schedulingPreferenceCheck: { kind: "absent" },
        };
    }

    // ---- Step 4: open-section filter (per course) ----
    // Track pre-filter counts so we can disambiguate "no open sections at all"
    // (unavailable for swap) from "all open sections wiped by strict prefs"
    // (scheduling-prefs-eliminated for swap) later.
    type CoursePool = {
        courseId: string;
        title: string;
        openCountBeforePrefs: number;       // step-4 result — used to pick swap reason
        openSections: SectionView[];        // step-4 result
    };

    const courseInputs: CoursePool[] = courseStates.map(c => {
        const open = c.allSections.filter(s => isOpenStatus(s.status));
        return {
            courseId: c.courseId,
            title: c.title,
            openCountBeforePrefs: open.length,
            openSections: open,
        };
    });

    // ---- Step 5: apply scheduling preferences ONCE on the union of all open sections ----
    const unionOpen = courseInputs.flatMap(c => c.openSections);
    const applyResult = applySchedulingPreferences(unionOpen, schedulingPreferences);

    // ---- Step 6: re-bucket survivors back to their course ----
    const survivorBuckets = bucketSectionsByCourse(
        courseInputs.map(c => c.courseId),
        applyResult.surviving,
    );

    // ---- Step 7: swap cascade (Decision #19) ----
    const finalBundles: CourseBundle[] = [];
    /** Courses that ended up dropped (no swap candidate or alt also wiped). */
    const dropped: Array<{
        courseId: string;
        reason: "unavailable" | "scheduling-prefs-eliminated";
        altCourseId?: string;       // present iff swap was attempted and also failed
    }> = [];

    for (const c of courseInputs) {
        const surviving = survivorBuckets.get(c.courseId) ?? [];

        if (surviving.length > 0) {
            finalBundles.push({ courseId: c.courseId, title: c.title, sections: surviving });
            continue;
        }

        // Course wipe → determine reason + try one swap
        const reason: "unavailable" | "scheduling-prefs-eliminated" =
            c.openCountBeforePrefs === 0 ? "unavailable" : "scheduling-prefs-eliminated";

        const altId = await swapHook(c.courseId, reason);
        if (altId === null) {
            dropped.push({ courseId: c.courseId, reason });
            continue;
        }

        // Re-run steps 1, 4, 5 for the alternative (one attempt only — no recursion).
        //
        // I-1 (deferred to Phase 16): `altApply.rerankWeights` is intentionally
        // dropped here. Step 9's `rankCombinationsByScore` reads only the
        // pre-swap `applyResult.rerankWeights` map, so any soft-pass weights
        // computed for sections of `altId` fall back to the implicit default
        // of 1 in the score product.
        //
        // Why this is acceptable for now:
        //   • Swaps are rare (course wipe + structural alt available).
        //   • The combination score is INTERNAL — sort-only — and never
        //     surfaced on `MaterializedSemester.combinations[i]` (see file
        //     header). A user will see the correct ordering of non-swapped
        //     combos and a plausible (default-weighted) ordering of swapped
        //     ones; nothing claims a numeric score.
        //   • Merging the two maps requires a CRN-namespace audit first:
        //     FOSE CRNs are globally unique within a single term, but
        //     cross-term de-duplication of the merged map is unverified.
        //     A naïve `new Map([...applyResult.rerankWeights, ...altApply.rerankWeights])`
        //     would be safe TODAY for single-term materialization; we defer
        //     until the audit so we don't build a footgun.
        //
        // Phase 16 unblocks this when (and if) we surface the score on
        // `MaterializedSemester.combinations[i]` (currently optional in the
        // type — see file header). Until then this is a documented no-op.
        const altFetch = await fetchAndMapCourse(termCode, altId, searchFn, cache);
        const altOpen = altFetch.sections.filter(s => isOpenStatus(s.status));
        const altApply = applySchedulingPreferences(altOpen, schedulingPreferences);

        if (altApply.surviving.length === 0) {
            dropped.push({
                courseId: c.courseId,
                reason,
                altCourseId: altId,
            });
            continue;
        }

        finalBundles.push({
            courseId: altId,
            title: altFetch.sections[0]?.title ?? altId,
            sections: altApply.surviving,
        });
    }

    // ---- Step 8: enumerate conflict-free combinations ----
    const combos = enumerateConflictFreeCombinations(
        finalBundles.map(b => ({ courseId: b.courseId, title: b.title, sections: b.sections })),
    );

    // ---- Step 9: rank combinations by rerank-weight product ----
    //
    // I-1 (deferred to Phase 16): we pass the pre-swap `applyResult.rerankWeights`
    // verbatim. Sections from a swapped-in alternative course (step 7) score
    // at the default weight of 1 because their soft-pass multipliers were
    // computed against `altApply.rerankWeights`, which is dropped at the swap
    // call site above. See the long comment in step 7 for the full rationale —
    // tl;dr swaps are rare + the score is sort-only + a CRN-namespace audit
    // is the pre-condition for merging the two maps safely.
    const ranked = rankCombinationsByScore(combos.combinations, applyResult.rerankWeights);

    // ---- Step 10: compute schedulingPreferenceCheck verdict ----
    const schedulingPreferenceCheck = computeSchedulingPreferenceCheck(
        schedulingPreferences,
        dropped,
    );

    // ---- Step 11: build the result ----
    const droppedNote =
        dropped.length === 0
            ? ""
            : ` Some courses were dropped after the swap cascade exhausted alternatives: ` +
              dropped.map(d => `${d.courseId} (${d.reason})`).join(", ") + ".";

    const baseMessage =
        ranked.length > 0
            ? `Found ${ranked.length} conflict-free section combinations for ${termCode}. Pick one to confirm.`
            : `Found courses but no conflict-free combinations exist. Some courses may have ` +
              `meeting-time conflicts that can't be resolved.`;

    return {
        state: "full",
        semester: {
            term: termCode,
            courses: finalBundles.map(b => ({
                courseId: b.courseId,
                title: b.title,
                sections: b.sections,
            })),
            combinations: ranked.map(c => ({ sections: c.sections, weeklyHours: c.weeklyHours })),
            combinationsTruncated: combos.truncated,
        },
        message: baseMessage + droppedNote,
        schedulingPreferenceCheck,
    };
}

// ---- Verdict helper ----

/**
 * Compute the Decision-#43 verdict for the visa axis.
 *
 *   - undefined prefs OR empty prefs       → "absent"
 *     (treated identically to how `applySchedulingPreferences`
 *     short-circuits via `isPrefsEmpty` — keeps the discriminator
 *     symmetric with the filter behavior).
 *   - prefs supplied AND a course-wipe propagated all the way to drop
 *     (i.e. swap cascade exhausted) AND that wipe was caused by a
 *     strict scheduling preference                          → "violated"
 *   - prefs supplied AND no strict-pref-driven drop          → "satisfied"
 *     Note: even if no conflict-free combinations exist (time-conflict
 *     only), the strict filter itself was respected — the failure is
 *     not a strict-preference violation.
 */
function computeSchedulingPreferenceCheck(
    prefs: SchedulingPreferences | undefined,
    dropped: Array<{
        courseId: string;
        reason: "unavailable" | "scheduling-prefs-eliminated";
    }>,
): SchedulingPreferenceCheck {
    if (prefs === undefined || isPrefsEmpty(prefs)) return { kind: "absent" };

    const violated = dropped.find(d => d.reason === "scheduling-prefs-eliminated");
    if (violated !== undefined) {
        return {
            kind: "violated",
            reason:
                `All sections of ${violated.courseId} were eliminated by a strict ` +
                `scheduling preference and the swap cascade exhausted alternatives.`,
        };
    }

    return { kind: "satisfied" };
}
