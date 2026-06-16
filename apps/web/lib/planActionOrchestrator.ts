// ============================================================
// planActionOrchestrator (Phase 17 Task B)
// ============================================================
// Shared two-stage orchestrator for the deterministic
// /api/plan/<verb> routes (add | swap | drop | lock | move).
//
// Each route forwards an authenticated request + a constructed
// PlanMutation[] to `runProposeStage` here. The orchestrator:
//
//   1. Loads the student's persisted state (profile, parsed DPR,
//      latest schedule, latest preferences) from the unified store
//      bundle.
//   2. Builds a minimal `ToolSession` with everything
//      `proposePlanChangeTool` reads from session.
//   3. Runs Stage 1 — `proposePlanChangeTool.call({ mutations })` —
//      synchronously. This is the structural validation pass
//      (Phase 13/14 pipeline; ~180–600ms typical, never hits FOSE).
//   4. Mints a `pendingMutationId` (uuid) and stashes
//      `{ studentId, mutations }` in a per-process in-memory map so
//      a follow-up `/api/plan/confirm` can apply the same mutation
//      array atomically.
//   5. Computes the list of `futureTerms` the route layer should
//      hand to Task D's UI for Stage 2 (FOSE section
//      enrichment). Stage 2 itself is NOT forked here — the spec
//      explicitly allows it to be deferred to the UI/SSE channel,
//      and Task D wires the actual `materialize_sections` call.
//
// Confirm flow (`runConfirmStage`) looks up the pending mutation
// by id and applies it through `confirmPlanChangeTool.call`. After
// a successful apply, the staging entry is dropped so a second
// confirm of the same id is a no-op (returns 404).
// ============================================================

import { randomUUID } from "node:crypto";
import {
    proposePlanChangeTool,
    confirmPlanChangeTool,
    loadSchoolConfig,
    loadCourses,
    loadPrereqs,
    type ToolSession,
    type DegreeProgressReport,
} from "@nyupath/engine";
import type {
    Course,
    ForwardSchedule,
    PlanChangeOutcome,
    PlanDiff,
    PlanMutation,
    Prerequisite,
    SchedulePreferences,
    StudentProfile,
} from "@nyupath/shared";
import { getStores } from "./db/store.js";
import { InMemoryPendingMutationStore } from "./db/pendingMutationStore.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Stage-1 outcome surfaced by every plan-action route. The shape is
 * a superset of `PlanChangeOutcome` (the engine's existing type) plus
 * three Phase 17 fields:
 *
 *   - `explanation`: deterministic confirm-bubble template (Task A).
 *   - `pendingMutationId`: opaque uuid the UI hands to
 *     `/api/plan/confirm` to actually apply the staged mutation.
 *   - `futureTerms`: the unique list of term strings touched by the
 *     mutation that fall within the FOSE data window (~6 months
 *     from wall-clock today). Task D's confirm-bubble passes these
 *     to `materialize_sections` for Stage 2 enrichment.
 *   - `forwardSchedule`: the proposed (read-only) schedule the
 *     proposal would produce — included so callers can assert on the
 *     destination-term placement (the load-bearing test case for
 *     drag-to-move).
 */
export interface PlanActionResponse extends PlanChangeOutcome {
    planDiff?: PlanDiff;
    explanation: string;
    pendingMutationId: string;
    futureTerms: string[];
    /** The proposed (read-only, NOT persisted) ForwardSchedule the
     *  caller would land on if it confirmed. Populated when Stage 1
     *  produced one; absent only on the no-plan failure path. */
    forwardSchedule?: ForwardSchedule;
}

/** Confirm-stage outcome — the actual apply via confirm_plan_change. */
export interface PlanConfirmResponse extends PlanChangeOutcome {
    planDiff?: PlanDiff;
    /** Where confirm_plan_change wrote the resulting schedule. */
    storedIn: "forwardSchedule" | "studentDraftPlan";
    /** The persisted ForwardSchedule (whichever slot it landed in). */
    forwardSchedule?: ForwardSchedule;
    /** The staging-map entry was consumed; the mutationId is no longer
     *  resolvable. */
    consumedMutationId: string;
}

export type RunProposeError =
    | { kind: "no_profile";  message: string }
    | { kind: "no_dpr";      message: string }
    | { kind: "no_schedule"; message: string }
    | { kind: "engine_error"; message: string };

export type RunConfirmError =
    | { kind: "unknown_mutation_id"; message: string }
    | { kind: "studentId_mismatch";  message: string }
    | RunProposeError;

// ---------------------------------------------------------------------------
// Pending-mutation staging (durable — Phase 4 Task E6.3)
// ---------------------------------------------------------------------------
//
// The propose → confirm round-trip crosses two route invocations (each
// with its own fresh ToolSession), so the staged mutation array must
// outlive a single request. Pre-E6.3 this lived in a module-scope `Map`
// here: single-instance, lost on restart, invisible to a sibling
// instance. E6.3 moved it behind `getStores().pendingMutationStore` —
// the Postgres `pending_mutations` table when a DB handle exists, an
// in-memory singleton otherwise (dev + offline tests).
//
// The studentId cross-tenant guard + the single-use delete + the
// 10-minute TTL now live INSIDE the store's `take` / `stage` (see
// pendingMutationStore.ts). The orchestrator just calls `stage` on
// propose and `take` on confirm.

/**
 * Test-only: drop every staged mutation. Delegates to the in-memory
 * store (the only path offline tests exercise). On the Postgres path
 * this is a no-op — live cleanup is the table itself (TTL sweep +
 * cascade-on-delete), not this hook.
 */
export function _resetPendingMutationsForTests(): void {
    const store = getStores().pendingMutationStore;
    if (store instanceof InMemoryPendingMutationStore) {
        store.clearForTests();
    }
}

/**
 * Test-only: peek at the staged-entry count. Synchronous; only the
 * in-memory store exposes a sync size, which is all the offline tests
 * need. Returns 0 on the Postgres path (no sync introspection).
 */
export function _pendingMutationsSizeForTests(): number {
    const store = getStores().pendingMutationStore;
    if (store instanceof InMemoryPendingMutationStore) {
        return store.sizeForTests();
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Future-term computation (Stage 2 hint)
// ---------------------------------------------------------------------------

const SEASON_ORD: Record<string, number> = { spring: 0, summer: 1, fall: 2, january: 3, winter: 3 };

/** Parse a solver-style "YYYY-season" term. Returns null if not parseable. */
function parseSolverTerm(t: string): { year: number; season: string } | null {
    const m = t.match(/^(\d{4})-(spring|summer|fall|january|winter)$/i);
    if (!m) return null;
    return { year: parseInt(m[1]!, 10), season: m[2]!.toLowerCase() };
}

/** Map a wall-clock date → the "YYYY-season" term roughly N months out
 *  by adding `monthsAhead` to the current month and bucketing
 *  Jan-May→spring, Jun-Aug→summer, Sep-Dec→fall. Used as the
 *  "Stage 2 FOSE window" upper bound. */
function termOrdinal(t: { year: number; season: string }): number {
    return t.year * 4 + (SEASON_ORD[t.season] ?? 0);
}

function todayTerm(now: Date): { year: number; season: string } {
    const m = now.getUTCMonth() + 1; // 1..12
    const y = now.getUTCFullYear();
    if (m <= 5) return { year: y, season: "spring" };
    if (m <= 8) return { year: y, season: "summer" };
    return { year: y, season: "fall" };
}

/** Given an array of mutations, return the unique term strings the
 *  mutation touches that:
 *   - parse as solver-style "YYYY-season",
 *   - are NOT in the past (current term or later),
 *   - are within ~6 months from wall-clock today (FOSE data window).
 *
 *  Mutations that don't carry a term (e.g., bare `exclude` without
 *  `term`, `clearSchedulingPreference`) are ignored. The output is
 *  the hint Task D's UI uses to decide which terms to background-
 *  materialize. */
export function computeFutureTerms(mutations: PlanMutation[], now: Date = new Date()): string[] {
    const today = todayTerm(now);
    const todayOrd = termOrdinal(today);
    const windowEnd = todayOrd + 2; // today + 2 seasons ahead ≈ 6 months window

    const out = new Set<string>();
    const collect = (raw: string): void => {
        const t = parseSolverTerm(raw);
        if (!t) return;
        const ord = termOrdinal(t);
        if (ord >= todayOrd && ord <= windowEnd) {
            out.add(`${t.year}-${t.season}`);
        }
    };

    for (const m of mutations) {
        switch (m.kind) {
            case "pin":     collect(m.term); break;
            case "exclude": if (m.term) collect(m.term); break;
            case "swap":    collect(m.term); break;
            case "move":    collect(m.fromTerm); collect(m.toTerm); break;
            case "unpin":   collect(m.term); break;
            case "addTerm": collect(m.term); break;
            case "loadStyleOverride": if (m.term) collect(m.term); break;
            // Other kinds carry no term reference.
            default: break;
        }
    }

    // Sort CHRONOLOGICALLY (not alphabetically) so Task D's UI consumer
    // can render the bubbles in calendar order. May 2026 review caught
    // the alphabetical-sort bug where ["2026-fall", "2026-spring"] would
    // surface fall before spring even though spring comes first.
    const parsed = Array.from(out).map((s) => {
        const t = parseSolverTerm(s)!;
        return { term: s, ord: termOrdinal(t) };
    });
    parsed.sort((a, b) => a.ord - b.ord);
    return parsed.map((p) => p.term);
}

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

interface LoadedSessionState {
    profile: StudentProfile;
    dpr: DegreeProgressReport;
    forwardSchedule: ForwardSchedule | null;
    studentDraftPlan: ForwardSchedule | null;
    schedulePreferences: SchedulePreferences | null;
}

/**
 * Load everything the engine's plan-change tools need to evaluate a
 * mutation. Returns null on the slices that are non-fatal (no
 * preferences row yet); throws a typed `RunProposeError` on the
 * fatal misses.
 */
async function loadSessionState(
    studentId: string,
    env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; state: LoadedSessionState } | { ok: false; error: RunProposeError }> {
    const stores = getStores(env);

    let profile: StudentProfile | null = null;
    try {
        profile = await stores.profileStore.get(studentId);
    } catch (err) {
        return {
            ok: false,
            error: {
                kind: "no_profile",
                message: `profileStore.get failed: ${err instanceof Error ? err.message : String(err)}`,
            },
        };
    }
    if (!profile) {
        return {
            ok: false,
            error: {
                kind: "no_profile",
                message: "No persisted student profile. Onboard first via /api/onboard.",
            },
        };
    }
    // Defensive: the profile id must match the auth subject so engine
    // writes (which key on session.student.id) land on the right row.
    profile = { ...profile, id: studentId };

    let dpr: DegreeProgressReport | null = null;
    try {
        dpr = (await stores.profileStore.getParsedDpr?.(studentId)) ?? null;
    } catch (err) {
        return {
            ok: false,
            error: {
                kind: "no_dpr",
                message: `profileStore.getParsedDpr failed: ${err instanceof Error ? err.message : String(err)}`,
            },
        };
    }
    if (!dpr) {
        return {
            ok: false,
            error: {
                kind: "no_dpr",
                message: "No parsed DPR on file. Re-onboard or upload a DPR via /api/onboard/refresh-dpr.",
            },
        };
    }

    let forwardSchedule: ForwardSchedule | null = null;
    let studentDraftPlan: ForwardSchedule | null = null;
    try {
        const loaded = await stores.scheduleStore.loadLatestSchedule(studentId);
        if (loaded) {
            const isDraft =
                loaded.schedule.state === "infeasible-draft" ||
                loaded.schedule.state === "student-preferred-invalid-draft";
            if (isDraft) studentDraftPlan = loaded.schedule;
            else         forwardSchedule  = loaded.schedule;
        }
    } catch (err) {
        // No-op — propose_plan_change has its own validateInput hook
        // that bails with a friendly error when neither slot is set.
        // Surface a typed error if neither slot resolves.
        return {
            ok: false,
            error: {
                kind: "no_schedule",
                message: `scheduleStore.loadLatestSchedule failed: ${err instanceof Error ? err.message : String(err)}`,
            },
        };
    }
    if (!forwardSchedule && !studentDraftPlan) {
        return {
            ok: false,
            error: {
                kind: "no_schedule",
                message: "No forward plan exists. Call plan_forward_degree first via the chat agent.",
            },
        };
    }

    let schedulePreferences: SchedulePreferences | null = null;
    try {
        schedulePreferences = await stores.scheduleStore.loadPreferences(studentId);
    } catch {
        // best-effort — empty prefs are valid
    }

    return {
        ok: true,
        state: {
            profile,
            dpr,
            forwardSchedule,
            studentDraftPlan,
            schedulePreferences,
        },
    };
}

// Cache the bundled courses + prereqs at module scope so a flurry of
// plan-action route calls doesn't re-read the same JSON N times. The
// engine's `loadCourses` / `loadPrereqs` are synchronous fs reads.
let CACHED_COURSES: Course[] | null = null;
let CACHED_PREREQS: Prerequisite[] | null = null;

function getBundledCourses(): Course[] | null {
    if (CACHED_COURSES) return CACHED_COURSES;
    try {
        CACHED_COURSES = loadCourses();
        return CACHED_COURSES;
    } catch {
        return null;
    }
}

function getBundledPrereqs(): Prerequisite[] | null {
    if (CACHED_PREREQS) return CACHED_PREREQS;
    try {
        CACHED_PREREQS = loadPrereqs();
        return CACHED_PREREQS;
    } catch {
        return null;
    }
}

/** Build a minimal ToolSession from the loaded state. Pre-load the
 *  home-school config + bundled course catalog + prereqs so the
 *  solver can place pinned slots (the solver rejects pins on
 *  courses absent from `courseCatalog`; see solver.ts:773). */
function buildSession(state: LoadedSessionState, env: Record<string, string | undefined> = process.env): ToolSession {
    const stores = getStores(env);
    const schoolConfig = (() => {
        try {
            return loadSchoolConfig(state.profile.homeSchool);
        } catch {
            return null;
        }
    })();
    const courses = getBundledCourses();
    const prereqs = getBundledPrereqs();

    const session: ToolSession = {
        student: state.profile,
        degreeProgressReport: state.dpr,
        scheduleStore: stores.scheduleStore,
        profileStore: stores.profileStore,
        ...(state.forwardSchedule  ? { forwardSchedule:  state.forwardSchedule  } : {}),
        ...(state.studentDraftPlan ? { studentDraftPlan: state.studentDraftPlan } : {}),
        ...(state.schedulePreferences ? { schedulePreferences: state.schedulePreferences } : {}),
        ...(schoolConfig ? { schoolConfig } : {}),
        ...(courses ? { courses } : {}),
        ...(prereqs ? { prereqs } : {}),
    };
    return session;
}

// ---------------------------------------------------------------------------
// Stage 1 — propose
// ---------------------------------------------------------------------------

/**
 * Run the propose stage. Returns either a typed error (the route
 * maps to 400/500) or the staged outcome plus the mintedpendingMutationId.
 *
 * The proposed `forwardSchedule` is included on the response so the
 * route's caller can assert on its contents (in particular, the
 * load-bearing assertion that the dragged course actually lands in
 * the toTerm semesters[].slots after the route returns).
 */
export async function runProposeStage(
    studentId: string,
    mutations: PlanMutation[],
    opts: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<{ ok: true; response: PlanActionResponse } | { ok: false; error: RunProposeError }> {
    const env = opts.env ?? process.env;
    const loaded = await loadSessionState(studentId, env);
    if (!loaded.ok) return { ok: false, error: loaded.error };

    const session = buildSession(loaded.state, env);
    const ctx = { signal: new AbortController().signal, session };

    let outcome: Awaited<ReturnType<typeof proposePlanChangeTool.call>>;
    try {
        // The engine's PlanMutationSchema is the source of truth; the
        // structurally-equivalent Zod-inferred input type collapses the
        // discriminated union into a different (but isomorphic) shape.
        // Cast through `unknown` to satisfy the input contract without
        // weakening the public PlanMutation type at the call sites.
        outcome = await proposePlanChangeTool.call(
            { mutations: mutations as unknown as Parameters<typeof proposePlanChangeTool.call>[0]["mutations"] },
            ctx,
        );
    } catch (err) {
        return {
            ok: false,
            error: {
                kind: "engine_error",
                message: `proposePlanChangeTool failed: ${err instanceof Error ? err.message : String(err)}`,
            },
        };
    }

    // Phase 17 Task B follow-up (May 2026 review) — read the proposed
    // schedule directly from the propose tool's output. Previously this
    // path ran a SECOND solver invocation via a clone-session
    // confirm_plan_change call (purely to extract the post-mutation
    // schedule), doubling Stage 1 latency from ~180-600ms to
    // ~360-1200ms — over the budget the Phase 17 plan committed to.
    // proposePlanChange now returns `proposedSchedule` as a pure
    // preview (no writes), so a single solver pass is sufficient.
    const proposedForwardSchedule = (outcome as { proposedSchedule?: ForwardSchedule })
        .proposedSchedule;

    // Mint a pendingMutationId and stage the mutations for confirm via
    // the durable store (E6.3) so the entry survives a restart /
    // multi-instance deploy. The store's `stage` runs its own TTL sweep.
    const pendingMutationId = randomUUID();
    await getStores(env).pendingMutationStore.stage({
        pendingMutationId,
        studentId,
        mutations,
        createdAt: Date.now(),
    });

    const futureTerms = computeFutureTerms(mutations, opts.now);

    const response: PlanActionResponse = {
        feasible: outcome.feasible,
        diff: outcome.diff,
        consequences: outcome.consequences,
        ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
        ...(outcome.planDiff ? { planDiff: outcome.planDiff } : {}),
        explanation: outcome.explanation,
        pendingMutationId,
        futureTerms,
        ...(proposedForwardSchedule ? { forwardSchedule: proposedForwardSchedule } : {}),
    };

    return { ok: true, response };
}

// ---------------------------------------------------------------------------
// Stage Confirm — actually apply
// ---------------------------------------------------------------------------

/**
 * Run the confirm stage. Looks up the staged mutations by
 * `pendingMutationId`, refuses if the studentId doesn't match the
 * staging entry, and applies via `confirmPlanChangeTool.call`. On
 * success the staging entry is dropped so the same id cannot be
 * confirmed twice.
 *
 * Phase 17 Task D — `opts.force` toggles the Decision #32
 * "student-preferred-invalid-draft" route. When `force === true`
 * AND the engine returns `feasible: false`, the persisted schedule
 * is reclassified from `infeasible-draft` to
 * `student-preferred-invalid-draft` (the engine itself only emits
 * 3 of the 4 PlanState members; the route-layer reclassification
 * keeps the engine scope unchanged).
 */
export async function runConfirmStage(
    studentId: string,
    pendingMutationId: string,
    opts: { env?: Record<string, string | undefined>; force?: boolean } = {},
): Promise<{ ok: true; response: PlanConfirmResponse } | { ok: false; error: RunConfirmError }> {
    const env = opts.env ?? process.env;
    const force = opts.force === true;
    const pendingStore = getStores(env).pendingMutationStore;

    // Atomically read-validate-tenant-check-delete via the durable store
    // (E6.3). `take` enforces the cross-tenant guard + single-use delete +
    // TTL; the discriminated result lets us preserve the two distinct
    // route errors below.
    const taken = await pendingStore.take(pendingMutationId, studentId);
    if (taken.status === "not_found") {
        return {
            ok: false,
            error: {
                kind: "unknown_mutation_id",
                message: `No staged mutation found for id ${pendingMutationId}. It may have expired (10 min TTL) or already been confirmed.`,
            },
        };
    }
    if (taken.status === "tenant_mismatch") {
        return {
            ok: false,
            error: {
                kind: "studentId_mismatch",
                message: `pendingMutationId belongs to a different student.`,
            },
        };
    }
    const entry = taken.entry;

    // `take` already CONSUMED (deleted) the entry. The pre-E6.3 Map flow
    // deleted only AFTER a successful apply, so on a session-load / engine
    // failure we RE-STAGE the (unchanged, original-`createdAt`) entry to keep
    // the "consume only on a successful apply" semantic. Best-effort: a
    // re-stage DB blip must NOT propagate as an unhandled rejection or it
    // would lose the entry harder than the old flow — log + degrade to the
    // "re-run propose" fallback that any lost staging already has.
    const restageBestEffort = async (): Promise<void> => {
        try {
            await pendingStore.stage({ ...entry });
        } catch (restageErr) {
            console.warn(
                `[planActionOrchestrator] best-effort re-stage after a confirm failure errored: ${restageErr instanceof Error ? restageErr.message : String(restageErr)}`,
            );
        }
    };

    const loaded = await loadSessionState(studentId, env);
    if (!loaded.ok) {
        // Loading the session failed for reasons unrelated to the staged
        // mutation (e.g. profile/DPR gone) — restage so the id stays
        // confirmable on a retry.
        await restageBestEffort();
        return { ok: false, error: loaded.error };
    }

    const session = buildSession(loaded.state, env);
    const ctx = { signal: new AbortController().signal, session };

    let outcome: Awaited<ReturnType<typeof confirmPlanChangeTool.call>>;
    try {
        outcome = await confirmPlanChangeTool.call(
            { mutations: entry.mutations as unknown as Parameters<typeof confirmPlanChangeTool.call>[0]["mutations"] },
            ctx,
        );
    } catch (err) {
        // Engine failure — restage so the staged id is not burned by a
        // transient apply error (preserves single-use-only-on-success).
        await restageBestEffort();
        return {
            ok: false,
            error: {
                kind: "engine_error",
                message: `confirmPlanChangeTool failed: ${err instanceof Error ? err.message : String(err)}`,
            },
        };
    }

    // The staging entry was already consumed by `take` above, so a
    // second confirm of the same id returns 404 (no accidental
    // double-apply).

    let persistedSchedule = session.forwardSchedule ?? session.studentDraftPlan;

    // Phase 17 Task D — Override-anyway reclassification. The engine's
    // derivePlanState emits at most `infeasible-draft` for an
    // infeasible apply; the 4th PlanState member
    // `student-preferred-invalid-draft` is the route layer's signal
    // that the student explicitly chose to keep the plan despite
    // hard violations. We mutate ONLY the persisted schedule's
    // `state` field (and the studentDraftPlan slot in the session)
    // so the sidebar's 4-state banner picks it up on the next
    // restore.
    if (force && !outcome.feasible && persistedSchedule) {
        const reclassified: ForwardSchedule = {
            ...persistedSchedule,
            state: "student-preferred-invalid-draft",
        };
        // Keep the session + persistence layer in lockstep.
        if (session.studentDraftPlan === persistedSchedule) {
            session.studentDraftPlan = reclassified;
        }
        if (session.forwardSchedule === persistedSchedule) {
            session.forwardSchedule = reclassified;
        }
        persistedSchedule = reclassified;
        // Persist the reclassified state so login restore agrees with
        // the live UI. Failures are logged but never throw — the
        // in-memory mutation already landed.
        if (session.scheduleStore && session.student) {
            try {
                const fingerprint = persistedSchedule.dprCourseHistoryHash;
                await session.scheduleStore.persistSchedule(
                    session.student.id,
                    persistedSchedule,
                    fingerprint,
                );
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[confirm/force] persistSchedule failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    const response: PlanConfirmResponse = {
        feasible: outcome.feasible,
        diff: outcome.diff,
        consequences: outcome.consequences,
        ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
        ...(outcome.planDiff ? { planDiff: outcome.planDiff } : {}),
        storedIn: outcome.storedIn,
        ...(persistedSchedule ? { forwardSchedule: persistedSchedule } : {}),
        consumedMutationId: pendingMutationId,
    };
    return { ok: true, response };
}
