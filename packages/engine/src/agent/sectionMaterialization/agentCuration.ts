// ============================================================
// sectionMaterialization/agentCuration.ts — Phase 38 Tasks 0.4 + 0.5
// ============================================================
// The agent ⇄ deterministic guardrails (§2.5). The agent ranks +
// curates the VERIFIED candidate set from `materialize_feasible`, but
// it can only CHOOSE among returned candidateIds (never fabricate a
// schedule), and its pick is RE-VALIDATED before any confirm.
//
//   0.4 — `agentSelectionSchema` (forced structured output) + a
//         validator that rejects any candidateId the tool never
//         returned, and a deterministic top-5 fallback (the pre-rank
//         order) for when no model curation runs.
//   0.5 — `revalidatePick` re-asserts section feasibility on the
//         chosen candidates (conflict-free, open/waitlist, every
//         waitlist section has a recorded open backup) — a tampered /
//         infeasible candidate cannot reach a confirm — plus the
//         top-5 / see-more `paginate` cursor.
//
// Pure module — no I/O, no engine coupling.
// ============================================================

import { z } from "zod";
import { conflicts } from "./conflictDetection.js";
import type { FeasibleCandidateView } from "./materializeFeasible.js";

/** The agent's schema-forced top-5 selection over candidateIds. */
export const agentSelectionSchema = z.object({
    picked: z
        .array(z.object({ candidateId: z.string(), why: z.string() }))
        .max(5),
    more: z.array(z.string()),
});

export type AgentSelection = z.infer<typeof agentSelectionSchema>;

export type ValidateAgentSelectionResult =
    | { ok: true; picked: FeasibleCandidateView[]; more: FeasibleCandidateView[] }
    | { ok: false; unknownIds: string[]; duplicateIds: string[] };

/**
 * Resolve an agent selection against the verified candidate set. Every
 * `candidateId` (in `picked` and `more`) MUST exist in `candidates` —
 * an id the tool never returned is a fabrication and fails the guard —
 * and no id may repeat across the combined picked+more list (the
 * top-5 / see-more contract assumes a deduplicated, disjoint set; a
 * repeat would double-surface a candidate). Pure.
 */
export function validateAgentSelection(
    selection: AgentSelection,
    candidates: FeasibleCandidateView[],
): ValidateAgentSelectionResult {
    const byId = new Map(candidates.map(c => [c.candidateId, c]));
    const pickedIds = selection.picked.map(p => p.candidateId);
    const allIds = [...pickedIds, ...selection.more];

    const unknownIds = allIds.filter(id => !byId.has(id));

    const seen = new Set<string>();
    const duplicateIds: string[] = [];
    for (const id of allIds) {
        if (seen.has(id)) {
            if (!duplicateIds.includes(id)) duplicateIds.push(id);
        } else {
            seen.add(id);
        }
    }

    if (unknownIds.length > 0 || duplicateIds.length > 0) {
        return { ok: false, unknownIds, duplicateIds };
    }

    return {
        ok: true,
        picked: pickedIds.map(id => byId.get(id)!),
        more: selection.more.map(id => byId.get(id)!),
    };
}

/**
 * Deterministic fallback selection (§2.5): when no model curation runs
 * (model slow/unavailable), use the pre-rank order verbatim — the top
 * `topN` as `picked` (with each candidate's `preRankReason` as the
 * `why`) and the next `topN` ids as `more`. `candidates` is assumed
 * already pre-ranked (the orchestrator's output). Pure.
 */
export function deterministicTop5(
    candidates: FeasibleCandidateView[],
    topN = 5,
): AgentSelection {
    const picked = candidates.slice(0, topN).map(c => ({
        candidateId: c.candidateId,
        why: c.preRankReason,
    }));
    const more = candidates.slice(topN, topN * 2).map(c => c.candidateId);
    return { picked, more };
}

export interface RevalidateResult {
    valid: FeasibleCandidateView[];
    rejected: Array<{ candidateId: string; reason: string }>;
}

/**
 * Re-validate the chosen candidates before surfacing/confirming
 * (§2.5 guardrail; §2①(d)). Re-asserts, per candidate:
 *   - every component status is O or W;
 *   - no two component blocks conflict in time;
 *   - every waitlisted section has a recorded open backup;
 *   - the waitlist tag is consistent with the W-status components.
 * A candidate failing any check is rejected with a reason — a
 * tampered / infeasible pick can never reach a confirm. Pure.
 */
export function revalidatePick(picked: FeasibleCandidateView[]): RevalidateResult {
    const valid: FeasibleCandidateView[] = [];
    const rejected: Array<{ candidateId: string; reason: string }> = [];

    for (const c of picked) {
        const components = c.courses.flatMap(course => course.components);

        // 1. status must be O or W (closed/cancelled never feasible)
        const badStatus = components.find(comp => comp.status !== "O" && comp.status !== "W");
        if (badStatus) {
            rejected.push({ candidateId: c.candidateId, reason: `section ${badStatus.crn} is not open/waitlist` });
            continue;
        }

        // 2. no two blocks may conflict in time
        let conflictFound = false;
        const blocks = components.map(comp => comp.meetingBlocks);
        for (let i = 0; i < blocks.length && !conflictFound; i++) {
            for (let j = i + 1; j < blocks.length; j++) {
                if (conflicts(blocks[i]!, blocks[j]!)) {
                    rejected.push({ candidateId: c.candidateId, reason: `time conflict between ${components[i]!.crn} and ${components[j]!.crn}` });
                    conflictFound = true;
                    break;
                }
            }
        }
        if (conflictFound) continue;

        // 3. the waitlist tag must match the W-status sections
        const wStatusCrns = components.filter(comp => comp.status === "W").map(comp => comp.crn).sort();
        const taggedCrns = [...c.waitlistCrns].sort();
        if (JSON.stringify(wStatusCrns) !== JSON.stringify(taggedCrns)) {
            rejected.push({ candidateId: c.candidateId, reason: "waitlist tag inconsistent with section statuses" });
            continue;
        }

        // 4. every waitlisted section needs a recorded open backup (§2①(d))
        const backedUp = new Set(c.openFallbacks.map(f => f.forCrn));
        const missing = c.waitlistCrns.find(crn => !backedUp.has(crn));
        if (missing) {
            rejected.push({ candidateId: c.candidateId, reason: `waitlisted section ${missing} has no open backup` });
            continue;
        }

        valid.push(c);
    }

    return { valid, rejected };
}

export interface Page<T> {
    page: number;
    pageSize: number;
    total: number;
    items: T[];
    hasMore: boolean;
}

/**
 * 1-indexed page over a list (top-5 / see-more cursor). `page <= 0` is
 * clamped to 1. Pure.
 */
export function paginate<T>(items: T[], page: number, pageSize = 5): Page<T> {
    const p = Math.max(1, Math.floor(page));
    const start = (p - 1) * pageSize;
    const slice = items.slice(start, start + pageSize);
    return {
        page: p,
        pageSize,
        total: items.length,
        items: slice,
        hasMore: start + pageSize < items.length,
    };
}
