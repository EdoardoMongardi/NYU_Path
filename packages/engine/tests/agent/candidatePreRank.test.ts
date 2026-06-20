// ============================================================
// candidatePreRank.test.ts — Phase 38 Task G1 (+ §2②)
// ============================================================
// Status helpers (O vs W are now distinct — a `W` is no longer
// "plainly open") and the cheap deterministic pre-rank:
//   open ≻ waitlist (penalty per waitlisted section), fewer
//   waitlisted sections better, then the student's soft rerank
//   weights (Decision #43, keyed by CRN). Stable on ties.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    isAvailableStatus,
    isOpenStatus,
    isWaitlistStatus,
} from "../../src/agent/sectionMaterialization/statusHelpers.js";
import { preRankCandidates } from "../../src/agent/sectionMaterialization/candidatePreRank.js";
import type { FeasibleCandidate } from "../../src/agent/sectionMaterialization/feasibleSchedules.js";
import type { SectionView } from "../../src/agent/sectionMaterialization/types.js";

describe("status helpers", () => {
    it("isAvailableStatus is true for O and W (the keep-in-pool predicate)", () => {
        expect(isAvailableStatus("O")).toBe(true);
        expect(isAvailableStatus("W")).toBe(true);
        expect(isAvailableStatus("C")).toBe(false);
        expect(isAvailableStatus("A")).toBe(false);
    });
    it("isOpenStatus is true ONLY for O (W is no longer plainly open)", () => {
        expect(isOpenStatus("O")).toBe(true);
        expect(isOpenStatus("W")).toBe(false);
    });
    it("isWaitlistStatus is true ONLY for W", () => {
        expect(isWaitlistStatus("W")).toBe(true);
        expect(isWaitlistStatus("O")).toBe(false);
    });
});

function section(crn: string, status: string): SectionView {
    return {
        courseId: "C",
        title: "C",
        crn,
        credits: "4",
        instructor: "Staff",
        status,
        meetingPatterns: [],
        isAsynchronous: true,
        rawMeets: "",
        schd: "LEC",
    };
}

function candidate(crns: Array<[string, string]>, fallbacks: Array<{ forCrn: string; fallbackCrn: string }> = []): FeasibleCandidate {
    const sections = crns.map(([crn, st]) => section(crn, st));
    const waitlistCrns = sections.filter(s => s.status === "W").map(s => s.crn);
    return {
        selections: [{ courseId: "C", title: "C", sections }],
        weeklyHours: 3,
        hasWaitlist: waitlistCrns.length > 0,
        waitlistCrns,
        openFallbacks: fallbacks,
    };
}

describe("preRankCandidates — G1", () => {
    it("an all-open candidate ranks above an equal waitlist candidate; the waitlist one is labeled", () => {
        const open = candidate([["a", "O"]]);
        const waitlisted = candidate([["b", "W"]], [{ forCrn: "b", fallbackCrn: "b2" }]);
        const ranked = preRankCandidates([waitlisted, open]); // input order: waitlist first
        expect(ranked[0]!.candidate).toBe(open);
        expect(ranked[1]!.candidate).toBe(waitlisted);
        expect(ranked[0]!.preScore).toBeGreaterThan(ranked[1]!.preScore);
        expect(ranked[1]!.preRankReason.toLowerCase()).toContain("waitlist");
        expect(ranked[0]!.preRankReason.toLowerCase()).toContain("open");
    });

    it("fewer waitlisted sections ranks higher", () => {
        const one = candidate([["a", "W"], ["b", "O"]], [{ forCrn: "a", fallbackCrn: "a2" }]);
        const two = candidate([["c", "W"], ["d", "W"]], [
            { forCrn: "c", fallbackCrn: "c2" },
            { forCrn: "d", fallbackCrn: "d2" },
        ]);
        const ranked = preRankCandidates([two, one]);
        expect(ranked[0]!.candidate).toBe(one);
        expect(ranked[1]!.candidate).toBe(two);
    });

    it("soft rerank weights break ties within the same waitlist tier", () => {
        const liked = candidate([["liked", "O"]]);
        const plain = candidate([["plain", "O"]]);
        // Both all-open → tie on waitlist; rerank weight favors 'liked'.
        const weights = new Map([["liked", 2.0], ["plain", 1.0]]);
        const ranked = preRankCandidates([plain, liked], weights);
        expect(ranked[0]!.candidate).toBe(liked);
    });

    it("is stable on full ties (preserves enumeration order)", () => {
        const a = candidate([["a", "O"]]);
        const b = candidate([["b", "O"]]);
        const ranked = preRankCandidates([a, b]);
        expect(ranked.map(r => r.candidate)).toEqual([a, b]);
    });

    it("open ≻ waitlist holds even when a soft weight is negative (no NaN, no flip)", () => {
        // A negative rerank multiplier on the open candidate would, without a
        // clamp, drive softTerm negative (or to ±Infinity at weight -1) and let
        // the waitlist candidate outrank it. The clamp must prevent that.
        const open = candidate([["o1", "O"]]);
        const wl = candidate([["w1", "W"]], [{ forCrn: "w1", fallbackCrn: "bk" }]);
        const weights = new Map([["o1", -0.5]]); // negative multiplier on the open candidate
        const ranked = preRankCandidates([wl, open], weights);
        expect(ranked[0]!.candidate).toBe(open);
        expect(Number.isFinite(ranked[0]!.preScore)).toBe(true);
        expect(Number.isFinite(ranked[1]!.preScore)).toBe(true);
    });

    it("a multiplier of exactly -1 (softProduct+1 === 0, would divide by zero) does not produce NaN/Infinity", () => {
        const open = candidate([["o1", "O"]]);
        const weights = new Map([["o1", -1]]); // softProduct -1 → -1/0 = -Infinity without the clamp
        const ranked = preRankCandidates([open], weights);
        expect(Number.isFinite(ranked[0]!.preScore)).toBe(true);
    });
});
