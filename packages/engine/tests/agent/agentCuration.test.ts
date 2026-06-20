// ============================================================
// agentCuration.test.ts — Phase 38 Tasks 0.4 + 0.5
// ============================================================
// The agent ⇄ deterministic guardrails (§2.5):
//   0.4 — the agent's schema-forced top-5 selection over candidateIds
//         (it cannot name a schedule the tool didn't return) + the
//         deterministic pre-rank fallback when no model curation runs.
//   0.5 — re-validate the pick (a tampered/infeasible candidate is
//         rejected) + the top-5 / see-more pagination cursor.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    agentSelectionSchema,
    validateAgentSelection,
    deterministicTop5,
    revalidatePick,
    paginate,
    buildAutoSwapAdvice,
} from "../../src/agent/sectionMaterialization/agentCuration.js";
import type { FeasibleCandidateView } from "../../src/agent/sectionMaterialization/materializeFeasible.js";

function candidate(
    id: string,
    opts: {
        status?: "O" | "W";
        blocks?: Array<{ day: string; startMin: number; endMin: number }>;
        secondBlocks?: Array<{ day: string; startMin: number; endMin: number }>;
        waitlistCrns?: string[];
        openFallbacks?: Array<{ forCrn: string; fallbackCrn: string }>;
        preScore?: number;
        preRankReason?: string;
    } = {},
): FeasibleCandidateView {
    const status = opts.status ?? "O";
    return {
        candidateId: id,
        courses: [
            {
                code: "A",
                title: "A",
                components: [
                    {
                        schd: "LEC",
                        crn: `${id}-a`,
                        meets: "M",
                        meetingBlocks: opts.blocks ?? [{ day: "M", startMin: 540, endMin: 600 }],
                        instr: "Staff",
                        status,
                    },
                ],
            },
            {
                code: "B",
                title: "B",
                components: [
                    {
                        schd: "LEC",
                        crn: `${id}-b`,
                        meets: "Tu",
                        meetingBlocks: opts.secondBlocks ?? [{ day: "Tu", startMin: 540, endMin: 600 }],
                        instr: "Staff",
                        status: "O",
                    },
                ],
            },
        ],
        hasWaitlist: (opts.waitlistCrns ?? []).length > 0,
        waitlistCrns: opts.waitlistCrns ?? [],
        openFallbacks: opts.openFallbacks ?? [],
        weeklyHours: 2,
        preScore: opts.preScore ?? 0.5,
        preRankReason: opts.preRankReason ?? "all sections open",
    };
}

// ---- 0.4 — agent selection contract ----

describe("agentSelectionSchema", () => {
    it("accepts a well-formed selection and rejects malformed shapes", () => {
        expect(agentSelectionSchema.safeParse({ picked: [{ candidateId: "x", why: "best" }], more: [] }).success).toBe(true);
        expect(agentSelectionSchema.safeParse({ picked: [{ candidateId: "x" }], more: [] }).success).toBe(false);
        expect(agentSelectionSchema.safeParse({ picked: [], more: "nope" }).success).toBe(false);
    });

    it("caps picked at 5", () => {
        const picked = Array.from({ length: 6 }, (_, i) => ({ candidateId: `c${i}`, why: "w" }));
        expect(agentSelectionSchema.safeParse({ picked, more: [] }).success).toBe(false);
    });
});

describe("validateAgentSelection", () => {
    it("resolves a selection that references only real candidateIds", () => {
        const cands = [candidate("c1"), candidate("c2"), candidate("c3")];
        const res = validateAgentSelection(
            { picked: [{ candidateId: "c2", why: "morning" }], more: ["c1"] },
            cands,
        );
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.picked.map(c => c.candidateId)).toEqual(["c2"]);
            expect(res.more.map(c => c.candidateId)).toEqual(["c1"]);
        }
    });

    it("rejects a selection naming a candidateId the tool never returned (no fabrication)", () => {
        const cands = [candidate("c1")];
        const res = validateAgentSelection(
            { picked: [{ candidateId: "ghost", why: "made up" }], more: [] },
            cands,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.unknownIds).toContain("ghost");
    });

    it("rejects a selection that repeats a candidateId across picked + more (no double-surfacing)", () => {
        const cands = [candidate("c1"), candidate("c2")];
        const res = validateAgentSelection(
            { picked: [{ candidateId: "c1", why: "a" }, { candidateId: "c1", why: "b" }], more: ["c1"] },
            cands,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.duplicateIds).toContain("c1");
    });
});

describe("deterministicTop5 (fallback order)", () => {
    it("picks the top 5 in pre-rank order with the pre-rank reason as the why; rest become 'more'", () => {
        // Already pre-ranked: open first, then a waitlist candidate.
        const cands = [
            candidate("open1", { preRankReason: "all sections open" }),
            candidate("wl1", { status: "W", waitlistCrns: ["wl1-a"], openFallbacks: [{ forCrn: "wl1-a", fallbackCrn: "bk" }], preRankReason: "1 waitlisted section (lower priority)" }),
            ...Array.from({ length: 5 }, (_, i) => candidate(`x${i}`)),
        ];
        const sel = deterministicTop5(cands);
        expect(sel.picked).toHaveLength(5);
        expect(sel.picked[0]!.candidateId).toBe("open1");
        expect(sel.picked[0]!.why).toContain("open");
        expect(sel.more).toEqual(["x3", "x4"]);
    });
});

// ---- 0.5 — re-validate pick + pagination ----

describe("revalidatePick (guardrail)", () => {
    it("passes a genuinely feasible candidate", () => {
        const c = candidate("ok");
        const res = revalidatePick([c]);
        expect(res.valid.map(v => v.candidateId)).toEqual(["ok"]);
        expect(res.rejected).toEqual([]);
    });

    it("rejects a candidate whose component blocks actually conflict", () => {
        // Both courses meet M 9–10 → a real time conflict slipped in.
        const tampered = candidate("bad", {
            blocks: [{ day: "M", startMin: 540, endMin: 600 }],
            secondBlocks: [{ day: "M", startMin: 540, endMin: 600 }],
        });
        const res = revalidatePick([tampered]);
        expect(res.valid).toEqual([]);
        expect(res.rejected[0]!.candidateId).toBe("bad");
        expect(res.rejected[0]!.reason.toLowerCase()).toContain("conflict");
    });

    it("rejects a waitlisted candidate missing its open backup", () => {
        const noBackup = candidate("nb", { status: "W", waitlistCrns: ["nb-a"], openFallbacks: [] });
        const res = revalidatePick([noBackup]);
        expect(res.valid).toEqual([]);
        expect(res.rejected[0]!.reason.toLowerCase()).toContain("backup");
    });
});

describe("buildAutoSwapAdvice (G3)", () => {
    it("names both CRNs + the course for a waitlisted section with a verified backup", () => {
        const c = candidate("wl", {
            status: "W",
            waitlistCrns: ["wl-a"],
            openFallbacks: [{ forCrn: "wl-a", fallbackCrn: "BK-OPEN" }],
        });
        const advice = buildAutoSwapAdvice(c);
        expect(advice).toHaveLength(1);
        expect(advice[0]).toContain("wl-a");      // the waitlisted CRN
        expect(advice[0]).toContain("BK-OPEN");   // the verified open backup CRN
        expect(advice[0]).toContain("A");         // the course code
        expect(advice[0].toLowerCase()).toContain("auto-swap");
    });

    it("returns no advice for an all-open candidate", () => {
        expect(buildAutoSwapAdvice(candidate("open"))).toEqual([]);
    });

    it("never invents a backup the tool didn't verify (a waitlist with no recorded fallback yields a hedge, not a fabricated CRN)", () => {
        const c = candidate("nb", { status: "W", waitlistCrns: ["nb-a"], openFallbacks: [] });
        const advice = buildAutoSwapAdvice(c);
        // No fabricated backup CRN; the copy is an honest hedge.
        expect(advice.join(" ")).not.toMatch(/CRN\s+\S*BK/i);
        expect(advice.join(" ").toLowerCase()).toContain("verify");
    });
});

describe("paginate (top-5 / see-more)", () => {
    it("page 1 = first 5, page 2 = next 5, last page flags hasMore=false", () => {
        const cands = Array.from({ length: 12 }, (_, i) => candidate(`c${i}`));
        const p1 = paginate(cands, 1);
        expect(p1.items).toHaveLength(5);
        expect(p1.items.map(c => c.candidateId)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
        expect(p1.hasMore).toBe(true);
        const p2 = paginate(cands, 2);
        expect(p2.items.map(c => c.candidateId)).toEqual(["c5", "c6", "c7", "c8", "c9"]);
        expect(p2.hasMore).toBe(true);
        const p3 = paginate(cands, 3);
        expect(p3.items).toHaveLength(2);
        expect(p3.hasMore).toBe(false);
    });
});
