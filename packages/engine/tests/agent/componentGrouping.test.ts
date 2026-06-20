// ============================================================
// componentGrouping.test.ts — Phase 38 Task 0.1 (multi-component)
// ============================================================
// A course's live sections are grouped by component type (`schd`:
// LEC / RCT / LAB / TUT …). A *course selection* picks one section
// of EACH required component type present (free-pairing: any RCT may
// pair with any LEC — the FOSE API exposes no LEC↔RCT linkage; see
// the 2026-06-20 live probe). Internally-conflicting selections
// (a LEC + RCT that overlap in time) are dropped.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    groupByComponent,
    enumerateCourseSelections,
} from "../../src/agent/sectionMaterialization/componentGrouping.js";
import type { MeetingPattern, SectionView } from "../../src/agent/sectionMaterialization/types.js";

function sec(
    courseId: string,
    crn: string,
    schd: string | undefined,
    patterns: MeetingPattern[],
): SectionView {
    return {
        courseId,
        title: courseId,
        crn,
        credits: "4",
        instructor: "Staff",
        status: "O",
        meetingPatterns: patterns,
        isAsynchronous: patterns.length === 0,
        rawMeets: "",
        schd,
    };
}

// Distinct, non-overlapping blocks so cartesian products survive.
const MON: MeetingPattern = { day: "M", startMin: 540, endMin: 600 };   // M 9–10
const TUE: MeetingPattern = { day: "Tu", startMin: 540, endMin: 600 };  // Tu 9–10
const WED: MeetingPattern = { day: "W", startMin: 540, endMin: 600 };   // W 9–10
const THU: MeetingPattern = { day: "Th", startMin: 540, endMin: 600 };  // Th 9–10

describe("groupByComponent", () => {
    it("lecture-only course (CSCI-UA 101 shape) → a single LEC group", () => {
        const sections = [
            sec("CSCI-UA 101", "1", "LEC", [MON]),
            sec("CSCI-UA 101", "2", "LEC", [TUE]),
        ];
        const grouped = groupByComponent("CSCI-UA 101", "Intro to CS", sections);
        expect([...grouped.components.keys()]).toEqual(["LEC"]);
        expect(grouped.components.get("LEC")).toHaveLength(2);
        expect(grouped.title).toBe("Intro to CS");
    });

    it("multi-component course (CHEM-UA 125 shape) → one group per distinct schd", () => {
        const sections = [
            sec("CHEM-UA 125", "L1", "LEC", [MON]),
            sec("CHEM-UA 125", "R1", "RCT", [TUE]),
            sec("CHEM-UA 125", "R2", "RCT", [WED]),
            sec("CHEM-UA 125", "B1", "LAB", [THU]),
            sec("CHEM-UA 125", "T1", "TUT", [{ day: "F", startMin: 540, endMin: 600 }]),
        ];
        const grouped = groupByComponent("CHEM-UA 125", "Gen Chem I", sections);
        expect(new Set(grouped.components.keys())).toEqual(new Set(["LEC", "RCT", "LAB", "TUT"]));
        expect(grouped.components.get("RCT")).toHaveLength(2);
    });

    it("normalizes case and defaults a missing schd to LEC", () => {
        const sections = [
            sec("X", "x1", "lec", [MON]),
            sec("X", "x2", undefined, [TUE]),
        ];
        const grouped = groupByComponent("X", "X", sections);
        // "lec" normalizes to "LEC"; undefined defaults to "LEC" → one merged group.
        expect([...grouped.components.keys()]).toEqual(["LEC"]);
        expect(grouped.components.get("LEC")).toHaveLength(2);
    });
});

describe("enumerateCourseSelections", () => {
    it("lecture-only → one selection per lecture section", () => {
        const grouped = groupByComponent("CSCI-UA 101", "Intro", [
            sec("CSCI-UA 101", "1", "LEC", [MON]),
            sec("CSCI-UA 101", "2", "LEC", [TUE]),
        ]);
        const selections = enumerateCourseSelections(grouped);
        expect(selections).toHaveLength(2);
        expect(selections[0]!.sections).toHaveLength(1);
        expect(selections.map(s => s.sections[0]!.crn).sort()).toEqual(["1", "2"]);
    });

    it("LEC × RCT → cartesian product, each selection carries one of each component", () => {
        const grouped = groupByComponent("CHEM-UA 125", "Chem", [
            sec("CHEM-UA 125", "L1", "LEC", [MON]),
            sec("CHEM-UA 125", "L2", "LEC", [TUE]),
            sec("CHEM-UA 125", "R1", "RCT", [WED]),
            sec("CHEM-UA 125", "R2", "RCT", [THU]),
        ]);
        const selections = enumerateCourseSelections(grouped);
        // 2 LEC × 2 RCT = 4 selections, each with a LEC + an RCT.
        expect(selections).toHaveLength(4);
        for (const s of selections) {
            const schds = s.sections.map(x => x.schd).sort();
            expect(schds).toEqual(["LEC", "RCT"]);
        }
    });

    it("drops a selection whose own components overlap in time (LEC clashes with its RCT)", () => {
        const grouped = groupByComponent("Y", "Y", [
            sec("Y", "L1", "LEC", [MON]),                                   // M 9–10
            sec("Y", "R-clash", "RCT", [{ day: "M", startMin: 570, endMin: 630 }]), // M 9:30–10:30 (clashes L1)
            sec("Y", "R-ok", "RCT", [TUE]),                                 // Tu 9–10 (no clash)
        ]);
        const selections = enumerateCourseSelections(grouped);
        // Only (L1, R-ok) survives; (L1, R-clash) is internally conflicting.
        expect(selections).toHaveLength(1);
        expect(selections[0]!.sections.map(s => s.crn).sort()).toEqual(["L1", "R-ok"]);
    });
});
