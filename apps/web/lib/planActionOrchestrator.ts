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
    proposeWhatIfAssumptionTool,
    loadSchoolConfig,
    loadCourses,
    loadPrereqs,
    computeDprFingerprint,
    solveWhatIfAssumption,
    whatIfAssumptionLabel,
    type ToolSession,
    type DegreeProgressReport,
    type WhatIfOutcome,
    type WhatIfAssumptionMarker,
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
import {
    InMemoryPendingMutationStore,
    type WhatIfAssumptionStaged,
} from "./db/pendingMutationStore.js";

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

/**
 * G3.1 — the propose-stage outcome for a WHAT-IF ASSUMPTION
 * ("I withdrew / I'll take pass-fail for course X"). A superset of
 * `PlanActionResponse` plus the `whatIfAssumption` marker the web review
 * card / canvas badge (G3.2) reads to LABEL the proposal as an unverified
 * assumption. `forwardSchedule` is the proposed (un-persisted) plan; CONFIRM
 * persists ONLY that schedule, never the synthetic DPR.
 */
export interface WhatIfAssumptionResponse extends PlanActionResponse {
    whatIfAssumption: WhatIfAssumptionMarker;
}

/** Confirm-stage outcome — the actual apply via confirm_plan_change (or, for
 *  G3.1, a re-applied what-if assumption persisting only the schedule). */
export interface PlanConfirmResponse extends PlanChangeOutcome {
    planDiff?: PlanDiff;
    /** Where the resulting schedule was stored. A plan-change confirm reports
     *  the engine's Decision-#32 slot; a what-if confirm reports
     *  `forwardSchedule` (valid) or `studentDraftPlan` (infeasible). */
    storedIn: "forwardSchedule" | "studentDraftPlan";
    /** The persisted ForwardSchedule (whichever slot it landed in). */
    forwardSchedule?: ForwardSchedule;
    /** The staging-map entry was consumed; the mutationId is no longer
     *  resolvable. */
    consumedMutationId: string;
    /** G3.1 — present iff this confirm applied a what-if ASSUMPTION (so the UI
     *  can re-label the now-committed plan "assumes you withdraw / P-F X").
     *  CRITICAL: this confirm persisted only the schedule — never parsed_dpr. */
    whatIfAssumption?: WhatIfAssumptionMarker;
}

export type RunProposeError =
    | { kind: "no_profile";  message: string }
    | { kind: "no_dpr";      message: string }
    | { kind: "no_schedule"; message: string }
    | { kind: "bad_input";   message: string }
    | { kind: "engine_error"; message: string };

export type RunConfirmError =
    | { kind: "unknown_mutation_id"; message: string }
    | { kind: "studentId_mismatch";  message: string }
    // M1 (plan 37) — the re-solved plan is INFEASIBLE. The confirm path NEVER
    // commits an invalid plan: nothing is persisted, the prior valid plan is
    // untouched, and `message` carries the failing-axis explanation so the
    // caller can surface WHY. The retired `force` override no longer mints a
    // `student-preferred-invalid-draft` — an infeasible confirm is refused.
    | { kind: "infeasible";          message: string }
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

/**
 * Test-only: is `id` currently staged? Lets a test cross-check that an
 * EMITTED pendingMutationId (e.g. on the `plan_proposal` SSE event) is the
 * SAME id that was actually staged — the store is keyed by id. Returns
 * false on the Postgres path (no sync introspection).
 */
export function _pendingMutationHasIdForTests(id: string): boolean {
    const store = getStores().pendingMutationStore;
    if (store instanceof InMemoryPendingMutationStore) {
        return store.hasForTests(id);
    }
    return false;
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
// Stage 1 — propose a WHAT-IF ASSUMPTION (G3.1)
// ---------------------------------------------------------------------------

const VALID_WHATIF_OUTCOMES: readonly WhatIfOutcome[] = ["withdraw", "pass", "fail"];

/**
 * G3.1 — propose a current-term IP-course WHAT-IF ASSUMPTION ("I withdrew /
 * I'll take pass-fail for course X"). READ-ONLY at propose time:
 *
 *   1. Load + build the session (same path as `runProposeStage`).
 *   2. Run `proposeWhatIfAssumptionTool.call` — builds a SYNTHETIC in-memory
 *      DPR via the matching transform, re-solves through the frozen pipeline,
 *      and returns the proposed (un-persisted) plan + the `whatIfAssumption`
 *      marker. Writes NOTHING.
 *   3. Mint a `pendingMutationId` and STAGE the assumption ({courseId, outcome})
 *      via the SAME pendingMutationStore the plan-mutation propose path uses
 *      (carried in the shared `mutations` JSONB as a tagged wrapper — no schema
 *      migration). The follow-up `/api/plan/confirm` re-applies the transform +
 *      persists ONLY the resulting forward_schedule (never the synthetic DPR).
 *
 * Returns the `WhatIfAssumptionResponse` carrying the marker so the web review
 * card / canvas badge can label the proposal as an unverified assumption.
 */
export async function runProposeWhatIfStage(
    studentId: string,
    assumption: { courseId: string; outcome: WhatIfOutcome },
    opts: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<{ ok: true; response: WhatIfAssumptionResponse } | { ok: false; error: RunProposeError }> {
    const env = opts.env ?? process.env;

    // Defensive input validation (the route's Zod schema is the first gate;
    // this is the orchestrator-level backstop).
    if (!assumption.courseId || assumption.courseId.trim().length === 0) {
        return { ok: false, error: { kind: "bad_input", message: "Missing courseId." } };
    }
    if (!VALID_WHATIF_OUTCOMES.includes(assumption.outcome)) {
        return {
            ok: false,
            error: { kind: "bad_input", message: `Invalid outcome '${assumption.outcome}'.` },
        };
    }

    const loaded = await loadSessionState(studentId, env);
    if (!loaded.ok) return { ok: false, error: loaded.error };

    const session = buildSession(loaded.state, env);
    const ctx = { signal: new AbortController().signal, session };

    // ── Guard-bypass fix ────────────────────────────────────────────────────
    // The AGENT path runs validateInput via the tool framework automatically.
    // The ROUTE path (editor + direct /api/plan/whatif callers) calls .call()
    // directly and previously BYPASSED validateInput entirely, skipping:
    //   • D-7 IP-membership guard (E1) — reject non-IP / absent courses
    //   • D-4 P/F-eligibility guard  — reject canElect:false schools (Tandon …)
    //   • DPR-presence guard          — reject when session has no DPR
    // We run validateInput here (once) before .call so the route enforces ALL
    // guards. The agent path runs it again via the framework — harmless double-
    // call; both are read-only guard checks.
    if (proposeWhatIfAssumptionTool.validateInput) {
        const toolInput = {
            courseId: assumption.courseId,
            outcome: assumption.outcome,
            ...(opts.now ? { now: opts.now.toISOString() } : {}),
        } as Parameters<typeof proposeWhatIfAssumptionTool.call>[0];
        const validation = await proposeWhatIfAssumptionTool.validateInput(toolInput, ctx);
        if (!validation.ok) {
            return {
                ok: false,
                error: {
                    // bad_input → HTTP 400: the student-facing message (D-7 /
                    // D-4 text) is surfaced verbatim so the editor + review card
                    // can show WHY the what-if was rejected (e.g. "CSCI-UA 102
                    // isn't in progress" / "Your school doesn't allow P/F").
                    kind: "bad_input",
                    message: validation.userMessage,
                },
            };
        }
    }
    // ── end guard-bypass fix ────────────────────────────────────────────────

    let outcome: Awaited<ReturnType<typeof proposeWhatIfAssumptionTool.call>>;
    try {
        outcome = await proposeWhatIfAssumptionTool.call(
            {
                courseId: assumption.courseId,
                outcome: assumption.outcome,
                ...(opts.now ? { now: opts.now.toISOString() } : {}),
            } as Parameters<typeof proposeWhatIfAssumptionTool.call>[0],
            ctx,
        );
    } catch (err) {
        return {
            ok: false,
            error: {
                kind: "engine_error",
                message: `proposeWhatIfAssumptionTool failed: ${err instanceof Error ? err.message : String(err)}`,
            },
        };
    }

    const proposedForwardSchedule = (outcome as { proposedSchedule?: ForwardSchedule }).proposedSchedule;

    // Stage the ASSUMPTION (not a PlanMutation[]) so the confirm re-applies the
    // SAME transform. The store carries it in the shared `mutations` JSONB.
    const pendingMutationId = randomUUID();
    const stagedAssumption: WhatIfAssumptionStaged = {
        courseId: assumption.courseId,
        outcome: assumption.outcome,
    };
    await getStores(env).pendingMutationStore.stage({
        pendingMutationId,
        studentId,
        mutations: [],
        assumption: stagedAssumption,
        createdAt: Date.now(),
    });

    const response: WhatIfAssumptionResponse = {
        feasible: outcome.feasible,
        diff: outcome.diff,
        consequences: outcome.consequences,
        ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
        ...(outcome.planDiff ? { planDiff: outcome.planDiff } : {}),
        explanation: outcome.whatIfAssumption.label,
        pendingMutationId,
        // A what-if assumption touches an EXISTING current-term enrollment; the
        // "future terms" FOSE hint is not meaningful here.
        futureTerms: [],
        ...(proposedForwardSchedule ? { forwardSchedule: proposedForwardSchedule } : {}),
        whatIfAssumption: outcome.whatIfAssumption,
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
 * M1 (plan 37) — the confirm path is the commit chokepoint and NEVER
 * commits an invalid plan. When the re-solved result is `feasible: false`
 * the persist is refused and the route returns `{ ok:false,
 * kind:"infeasible" }` (→ HTTP 422); the previously-committed valid plan
 * is left untouched. This holds on BOTH confirm sub-paths — the
 * plan-change path (`confirmPlanChangeTool`, guard below) AND the what-if
 * assumption path (`runConfirmWhatIfAssumption`, parallel guard). The
 * retired Phase-17 `opts.force` → "student-preferred-invalid-draft"
 * override no longer exists: `force` is inert (an infeasible confirm is
 * refused regardless of its value).
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

    // ---- G3.1 — what-if ASSUMPTION confirm branch ------------------------
    //
    // A staged assumption is NOT a PlanMutation[] — it is a DPR TRANSFORM
    // ("I withdrew / I'll take pass-fail for course X"). We re-apply the
    // transform to the loaded session DPR + re-solve through the SAME frozen
    // pipeline, then persist ONLY the resulting forward_schedule.
    //
    // CRITICAL (R1 guardrail): this path NEVER writes the synthetic DPR to
    // students.parsed_dpr. It calls scheduleStore.persistSchedule (schedule
    // only) — NOT profileStore.persistMutation with the synthetic DPR. So
    // the assertAuthoritativeDpr guard (which throws on a non-"dpr"
    // reportKind write) is never reached. "Confirming a plan ≠ recording a
    // fact" — the next real DPR re-plans + supersedes via the normal flow.
    if (entry.assumption) {
        const result = await runConfirmWhatIfAssumption(
            studentId,
            entry.assumption,
            loaded.state,
            session,
            pendingMutationId,
            restageBestEffort,
        );
        return result;
    }

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

    // ---- M1 (plan 37) — NEVER commit an invalid plan -------------------
    //
    // The confirm path is the commit chokepoint. When the re-solved plan is
    // INFEASIBLE the engine (`confirmPlanChangeTool`) already kept the change
    // OUT of `session.forwardSchedule` (Decision #32 — it landed only in the
    // in-memory `studentDraftPlan` scratchpad) AND, post-M1, did NOT persist
    // it. So the previously-committed valid plan is untouched in the DB.
    //
    // The route layer's job is to REFUSE the commit and surface WHY: we return
    // `{ ok:false, kind:"infeasible", message }` carrying the failing-axis
    // explanation. The caller (workspace `confirmProposed` via
    // `applyReviewConfirm`, or the chat-bubble Confirm) only commits on
    // `ok:true`, so an invalid result is never written to the canvas committed
    // slot or the DB `forward_schedule`.
    //
    // The Phase-17 `force` → `student-preferred-invalid-draft` override is
    // RETIRED: `force` no longer reclassifies/commits an infeasible result.
    // A `force:true` confirm now behaves IDENTICALLY to a normal confirm — the
    // infeasible result is refused either way. (The `force` param remains in
    // the route signature for back-compat but is inert in the confirm path;
    // referencing it here keeps the no-unused-param lint quiet without
    // reintroducing any override behavior.)
    void force;
    if (!outcome.feasible) {
        return {
            ok: false,
            error: {
                kind: "infeasible",
                message: buildInfeasibleReason(outcome),
            },
        };
    }

    const persistedSchedule = session.forwardSchedule ?? session.studentDraftPlan;

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

/**
 * M1 — build a human-readable refusal reason from an infeasible
 * confirm_plan_change outcome. Prefers the failing-axis detail surfaced by the
 * engine (`conflicts[]` carries the validator's `conflictSource`/`conflictDetail`;
 * `consequences[]` names the failing axes), falling back to a generic message.
 */
function buildInfeasibleReason(outcome: PlanChangeOutcome): string {
    const conflictDetail = outcome.conflicts?.find((c) => c.detail)?.detail;
    if (conflictDetail && conflictDetail.trim().length > 0) {
        return `Can't apply this change — it would make your plan invalid: ${conflictDetail}`;
    }
    const axisConsequence = outcome.consequences?.find((c) =>
        /graduation-path validation|fails/i.test(c),
    );
    if (axisConsequence) {
        return `Can't apply this change — ${axisConsequence}`;
    }
    return "Can't apply this change — the resulting plan fails graduation-path validation, so it was not committed. Your current plan is unchanged.";
}

// ---------------------------------------------------------------------------
// Confirm a WHAT-IF ASSUMPTION (G3.1) — persist the schedule, NEVER parsed_dpr
// ---------------------------------------------------------------------------

/**
 * Re-apply a staged what-if assumption to the loaded session DPR, re-solve
 * through the SAME frozen pipeline (`solveWhatIfAssumption`), and persist ONLY
 * the resulting forward_schedule. The authoritative DPR snapshot
 * (`students.parsed_dpr`) is NEVER overwritten — "confirming a plan ≠ recording
 * a fact." A later real DPR upload re-plans + supersedes via the normal flow.
 *
 * On a persist failure we re-stage the entry (mirrors the plan-change confirm's
 * single-use-only-on-success semantic) and surface an engine_error.
 *
 * R1 GUARDRAIL: this function calls ONLY `scheduleStore.persistSchedule` (the
 * schedule) — it deliberately never calls `profileStore.persistMutation` with
 * the synthetic DPR, so the assertAuthoritativeDpr guard is never reached.
 */
async function runConfirmWhatIfAssumption(
    studentId: string,
    assumption: WhatIfAssumptionStaged,
    state: LoadedSessionState,
    session: ToolSession,
    pendingMutationId: string,
    restageBestEffort: () => Promise<void>,
): Promise<{ ok: true; response: PlanConfirmResponse } | { ok: false; error: RunConfirmError }> {
    const currentPlan = state.forwardSchedule ?? state.studentDraftPlan;
    if (!currentPlan) {
        // The propose-time validateInput already required a plan; if it's gone
        // by confirm time, restage + surface a no_schedule error.
        await restageBestEffort();
        return {
            ok: false,
            error: { kind: "no_schedule", message: "No forward plan to confirm the what-if assumption against." },
        };
    }

    // Re-apply the transform + re-solve READ-ONLY through the shared seam. This
    // builds a SYNTHETIC in-memory DPR; session.degreeProgressReport is never
    // mutated (the transforms deep-copy).
    let result: ReturnType<typeof solveWhatIfAssumption>;
    try {
        result = solveWhatIfAssumption(session, currentPlan, {
            courseId: assumption.courseId,
            outcome: assumption.outcome,
        });
    } catch (err) {
        await restageBestEffort();
        return {
            ok: false,
            error: {
                kind: "engine_error",
                message: `solveWhatIfAssumption failed: ${err instanceof Error ? err.message : String(err)}`,
            },
        };
    }

    // ---- M1 C1 (plan 37) — NEVER commit an invalid what-if plan ----------
    //
    // PARALLEL to the plan-change confirm guard above: the confirm path is the
    // commit chokepoint for what-if assumptions too. A re-solve CAN return
    // `feasible: false` (`solveWhatIfAssumption` → `solveAndDiff`, e.g. a
    // P/F-FAIL re-opens a requirement so an axis fails). Persisting it would
    // call `scheduleStore.persistSchedule`, which SUPERSEDES every prior live
    // row — destroying the previously-committed VALID plan and replacing it
    // with the infeasible one.
    //
    // So we REFUSE the commit BEFORE any persist: return
    // `{ ok:false, kind:"infeasible", message }` carrying the same failing-axis
    // explanation (`buildInfeasibleReason`, shared with the plan-change path —
    // the what-if `result` is structurally a `PlanChangeOutcome`). The route's
    // `mapConfirmError` maps `kind:"infeasible"` → HTTP 422, so the client
    // refuses to commit and the prior valid `forward_schedule` row SURVIVES.
    //
    // R1 + Decision #32: `solveWhatIfAssumption` is READ-ONLY (it builds a
    // synthetic in-memory DPR and never mutates `session` state), so there is
    // no scratchpad write to undo here — refusing the persist is sufficient.
    // The synthetic DPR is never written to `parsed_dpr` on ANY path.
    if (!result.feasible) {
        return {
            ok: false,
            error: {
                kind: "infeasible",
                message: buildInfeasibleReason(result),
            },
        };
    }

    const newSchedule = result.schedule;
    // Reaching here implies `result.feasible === true` (the infeasible case
    // returned above), so a confirmed what-if always commits to forwardSchedule.
    const storedIn: PlanConfirmResponse["storedIn"] = "forwardSchedule";

    // Persist ONLY the resulting forward_schedule. The fingerprint is of the
    // student's REAL DPR (state.dpr) — so a later REAL DPR upload with a
    // different fingerprint supersedes this assumption plan via the normal
    // re-plan-and-supersede flow. The synthetic DPR is NEVER persisted.
    if (session.scheduleStore) {
        try {
            const fingerprint = computeDprFingerprint(state.dpr);
            await session.scheduleStore.persistSchedule(studentId, newSchedule, fingerprint);
        } catch (err) {
            // Persist failed — restage so the assumption stays confirmable on a
            // retry (single-use-only-on-success), and surface the error.
            await restageBestEffort();
            return {
                ok: false,
                error: {
                    kind: "engine_error",
                    message: `persistSchedule (what-if) failed: ${err instanceof Error ? err.message : String(err)}`,
                },
            };
        }
    }

    const marker: WhatIfAssumptionMarker = {
        courseId: assumption.courseId,
        outcome: assumption.outcome,
        label: whatIfAssumptionLabel(assumption.courseId, assumption.outcome),
        hedges: result.hedges,
        ...(result.windowCaveat ? { windowCaveat: result.windowCaveat } : {}),
    };

    const response: PlanConfirmResponse = {
        feasible: result.feasible,
        diff: result.diff,
        consequences: result.consequences,
        ...(result.conflicts ? { conflicts: result.conflicts } : {}),
        ...(result.planDiff ? { planDiff: result.planDiff } : {}),
        storedIn,
        forwardSchedule: newSchedule,
        consumedMutationId: pendingMutationId,
        whatIfAssumption: marker,
    };
    return { ok: true, response };
}
