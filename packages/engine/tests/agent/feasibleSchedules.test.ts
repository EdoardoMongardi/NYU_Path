// ============================================================
// feasibleSchedules.test.ts — Phase 38 Tasks F1 + 0.2
// ============================================================
// enumerateFeasibleSchedules: across-course, multi-component
// conflict-free enumeration (F1) + the §2①(d) two-state waitlist
// backup rule (0.2). A `W` section keeps a candidate feasible ONLY
// if there is a SPECIFIC open backup section that is conflict-free
// with the REST of the schedule (same-course = trivially grad-safe;
// different-course = via an injected grad-validity resolver).
// ============================================================

import { describe, it, expect } from "vitest";
import {
    enumerateFeasibleSchedules,
    type BackupResolver,
} from "../../src/agent/sectionMaterialization/feasibleSchedules.js";
import { groupByComponent } from "../../src/agent/sectionMaterialization/componentGrouping.js";
import type { MeetingPattern, SectionView } from "../../src/agent/sectionMaterialization/types.js";

function sec(
    courseId: string,
    crn: string,
    schd: string,
    status: string,
    patterns: MeetingPattern[],
): SectionView {
    return {
        courseId,
        title: courseId,
        crn,
        credits: "4",
        instructor: "Staff",
        status,
        meetingPatterns: patterns,
        isAsynchronous: patterns.length === 0,
        rawMeets: "",
        schd,
    };
}

const MON = (s: number, e: number): MeetingPattern => ({ day: "M", startMin: s, endMin: e });
const TUE = (s: number, e: number): MeetingPattern => ({ day: "Tu", startMin: s, endMin: e });
const WED = (s: number, e: number): MeetingPattern => ({ day: "W", startMin: s, endMin: e });

// ---- F1: multi-component, free-pairing across-course conflict ----

describe("enumerateFeasibleSchedules — F1 multi-component", () => {
    it("a fixed LEC + 3 RCT options: only the non-clashing recitation survives", () => {
        // Y is a fixed single lecture on Wed 9–10. X = LEC + 3 RCTs;
        // two RCTs clash with Y, one is clear.
        const Y = groupByComponent("Y", "Y", [sec("Y", "ly", "LEC", "O", [WED(540, 600)])]);
        const X = groupByComponent("X", "X", [
            sec("X", "lx", "LEC", "O", [MON(540, 600)]),
            sec("X", "r-w1", "RCT", "O", [WED(540, 600)]),   // clashes Y
            sec("X", "r-w2", "RCT", "O", [WED(570, 630)]),   // clashes Y
            sec("X", "r-ok", "RCT", "O", [TUE(540, 600)]),   // clear
        ]);
        const { candidates } = enumerateFeasibleSchedules([X, Y]);
        expect(candidates).toHaveLength(1);
        const crns = candidates[0]!.selections.flatMap(s => s.sections.map(x => x.crn)).sort();
        expect(crns).toEqual(["lx", "ly", "r-ok"].sort());
    });

    it("closed sections never appear (input is pre-filtered to O/W) and weeklyHours sums all blocks", () => {
        const A = groupByComponent("A", "A", [sec("A", "a1", "LEC", "O", [MON(540, 600)])]); // 1h
        const B = groupByComponent("B", "B", [sec("B", "b1", "LEC", "O", [TUE(540, 630)])]); // 1.5h
        const { candidates } = enumerateFeasibleSchedules([A, B]);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.weeklyHours).toBeCloseTo(2.5, 2);
        expect(candidates[0]!.hasWaitlist).toBe(false);
    });
});

// ---- 0.2: two-state waitlist backup ----

describe("enumerateFeasibleSchedules — 0.2 waitlist backup", () => {
    it("(a) the only conflict-free schedule requires one specific recitation", () => {
        const A = groupByComponent("A", "A", [sec("A", "la", "LEC", "O", [MON(540, 600)])]);
        const B = groupByComponent("B", "B", [
            sec("B", "lb", "LEC", "O", [TUE(540, 600)]),
            sec("B", "rb-clash", "RCT", "O", [MON(540, 600)]), // clashes A
            sec("B", "rb-ok", "RCT", "O", [WED(540, 600)]),    // clear
        ]);
        const { candidates } = enumerateFeasibleSchedules([A, B]);
        expect(candidates).toHaveLength(1);
        const crns = candidates[0]!.selections.flatMap(s => s.sections.map(x => x.crn)).sort();
        expect(crns).toEqual(["la", "lb", "rb-ok"].sort());
    });

    it("(b) a W section whose only open same-course section CLASHES with the rest is rejected", () => {
        // X: lx is waitlisted (M 9–10); the only open backup lx2 is M 11–12,
        // which clashes with Y's fixed La (M 11–12). No conflict-free backup.
        const X = groupByComponent("X", "X", [
            sec("X", "lx", "LEC", "W", [MON(540, 600)]),
            sec("X", "lx2", "LEC", "O", [MON(660, 720)]),
        ]);
        const Y = groupByComponent("Y", "Y", [sec("Y", "la", "LEC", "O", [MON(660, 720)])]);
        const { candidates } = enumerateFeasibleSchedules([X, Y]);
        expect(candidates).toHaveLength(0);
    });

    it("(c) a W section with a conflict-free same-course backup is accepted; backup CRN recorded", () => {
        const X = groupByComponent("X", "X", [
            sec("X", "lx", "LEC", "W", [MON(540, 600)]),
            sec("X", "lx2", "LEC", "O", [TUE(540, 600)]),
        ]);
        const Y = groupByComponent("Y", "Y", [sec("Y", "la", "LEC", "O", [WED(540, 600)])]);
        const { candidates } = enumerateFeasibleSchedules([X, Y]);
        const wl = candidates.find(c => c.waitlistCrns.includes("lx"));
        expect(wl).toBeDefined();
        expect(wl!.hasWaitlist).toBe(true);
        expect(wl!.openFallbacks).toEqual([{ forCrn: "lx", fallbackCrn: "lx2" }]);
    });

    it("(d) a W whose only backup is a different course failing grad-validity is rejected", () => {
        // X has a single waitlisted lecture, no same-course open backup.
        const X = groupByComponent("X", "X", [sec("X", "lx", "LEC", "W", [MON(540, 600)])]);
        const Y = groupByComponent("Y", "Y", [sec("Y", "la", "LEC", "O", [TUE(540, 600)])]);

        // Resolver simulates: a different-course open section exists but the
        // B-substituted plan FAILS graduation validity (e.g. credit floor).
        const rejectResolver: BackupResolver = () => null;
        const rejected = enumerateFeasibleSchedules([X, Y], { backupResolver: rejectResolver });
        expect(rejected.candidates).toHaveLength(0);

        // Contrast: a resolver that finds a grad-valid different-course backup
        // accepts the candidate and records that backup CRN.
        const acceptResolver: BackupResolver = () => ({ fallbackCrn: "DIFF-OPEN" });
        const accepted = enumerateFeasibleSchedules([X, Y], { backupResolver: acceptResolver });
        expect(accepted.candidates).toHaveLength(1);
        expect(accepted.candidates[0]!.openFallbacks).toEqual([
            { forCrn: "lx", fallbackCrn: "DIFF-OPEN" },
        ]);
    });

    it("two waitlisted sections whose only backups clash with EACH OTHER is rejected (joint two-state feasibility)", () => {
        // X = waitlisted lx (M 9–10) + open backup bx (Tu 9–10).
        // Y = waitlisted ly (W 9–10) + open backup by (Tu 9–10) — by CLASHES bx.
        // The candidate {lx(W), ly(W)} is conflict-free, and each backup is
        // conflict-free with the REST individually, but bx vs by clash, so the
        // all-backups-registered state {bx, by} is unschedulable → reject.
        const X = groupByComponent("X", "X", [
            sec("X", "lx", "LEC", "W", [MON(540, 600)]),
            sec("X", "bx", "LEC", "O", [TUE(540, 600)]),
        ]);
        const Y = groupByComponent("Y", "Y", [
            sec("Y", "ly", "LEC", "W", [WED(540, 600)]),
            sec("Y", "by", "LEC", "O", [TUE(540, 600)]), // clashes bx
        ]);
        const { candidates } = enumerateFeasibleSchedules([X, Y]);
        // No candidate may pair the two waitlisted lectures (their backups clash).
        const bothWaitlisted = candidates.find(
            c => c.waitlistCrns.includes("lx") && c.waitlistCrns.includes("ly"),
        );
        expect(bothWaitlisted).toBeUndefined();
    });

    it("two waitlisted sections with mutually-compatible backups ARE accepted", () => {
        const X = groupByComponent("X", "X", [
            sec("X", "lx", "LEC", "W", [MON(540, 600)]),
            sec("X", "bx", "LEC", "O", [TUE(540, 600)]),
        ]);
        const Y = groupByComponent("Y", "Y", [
            sec("Y", "ly", "LEC", "W", [WED(540, 600)]),
            sec("Y", "by", "LEC", "O", [{ day: "Th", startMin: 540, endMin: 600 }]), // Thu — no clash with bx
        ]);
        const { candidates } = enumerateFeasibleSchedules([X, Y]);
        const both = candidates.find(
            c => c.waitlistCrns.includes("lx") && c.waitlistCrns.includes("ly"),
        );
        expect(both).toBeDefined();
        expect(both!.openFallbacks).toEqual([
            { forCrn: "lx", fallbackCrn: "bx" },
            { forCrn: "ly", fallbackCrn: "by" },
        ]);
    });

    it("an all-open schedule needs no backup and has empty openFallbacks", () => {
        const A = groupByComponent("A", "A", [sec("A", "a1", "LEC", "O", [MON(540, 600)])]);
        const B = groupByComponent("B", "B", [sec("B", "b1", "LEC", "O", [TUE(540, 600)])]);
        const { candidates } = enumerateFeasibleSchedules([A, B]);
        expect(candidates[0]!.hasWaitlist).toBe(false);
        expect(candidates[0]!.openFallbacks).toEqual([]);
        expect(candidates[0]!.waitlistCrns).toEqual([]);
    });

    it("the cap never drops an all-open candidate in favor of waitlist ones (open ≻ waitlist survives truncation)", () => {
        // Group order puts 3 waitlist sections (each with a shared open backup
        // o1) BEFORE the all-open section o1. With a naive single-pass cap of 3,
        // the 3 waitlist candidates would fill the cap and the all-open one
        // would be dropped. The fix must retain the all-open candidate.
        const X = groupByComponent("X", "X", [
            sec("X", "w1", "LEC", "W", [MON(540, 600)]),
            sec("X", "w2", "LEC", "W", [TUE(540, 600)]),
            sec("X", "w3", "LEC", "W", [WED(540, 600)]),
            sec("X", "o1", "LEC", "O", [{ day: "Th", startMin: 540, endMin: 600 }]),
        ]);
        const { candidates, truncated } = enumerateFeasibleSchedules([X], { cap: 3 });
        expect(candidates).toHaveLength(3);
        expect(truncated).toBe(true);
        // The all-open candidate (o1) must be present despite the cap.
        const allOpen = candidates.filter(c => c.waitlistCrns.length === 0);
        expect(allOpen).toHaveLength(1);
        expect(allOpen[0]!.selections[0]!.sections[0]!.crn).toBe("o1");
    });
});
