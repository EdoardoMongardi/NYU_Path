// ============================================================
// ipSections.test.ts — Phase 38 #2 (already-registered IP sections)
// ============================================================
// resolveIpSectionsToBlocks turns the student-supplied sections of
// their ALREADY-REGISTERED (IP) courses into fixed occupied time
// blocks, so materialize_feasible can avoid time-conflicting the
// remaining courses against them. The DPR doesn't carry the section,
// so the student supplies a CRN (looked up live) or the times.
// ============================================================

import { describe, it, expect } from "vitest";
import { resolveIpSectionsToBlocks } from "../../src/agent/sectionMaterialization/ipSections.js";
import { FoseCache } from "../../src/agent/sectionMaterialization/foseCache.js";

const MON_9_10 = JSON.stringify([{ meet_day: "0", start_time: "900", end_time: "1000" }]);
const TUE_9_10 = JSON.stringify([{ meet_day: "1", start_time: "900", end_time: "1000" }]);

function searchFn(_t: string, keyword: string): Promise<unknown[]> {
    const map: Record<string, unknown[]> = {
        "CSCI-UA 101": [
            { code: "CSCI-UA 101", title: "Intro", crn: "8919", no: "001", schd: "LEC", stat: "A", credits: "4", instr: "Staff", meets: "MON", meetingTimes: MON_9_10 },
            { code: "CSCI-UA 101", title: "Intro", crn: "8920", no: "002", schd: "LEC", stat: "A", credits: "4", instr: "Staff", meets: "TUE", meetingTimes: TUE_9_10 },
        ],
    };
    return Promise.resolve(map[keyword] ?? []);
}

describe("resolveIpSectionsToBlocks — #2", () => {
    it("resolves a CRN to that section's meeting blocks via live FOSE", async () => {
        const { blocks, unresolved } = await resolveIpSectionsToBlocks(
            [{ courseId: "CSCI-UA 101", crn: "8920" }],
            "1268",
            { searchFn, cache: new FoseCache<unknown[]>() },
        );
        expect(unresolved).toEqual([]);
        expect(blocks).toEqual([{ day: "Tu", startMin: 540, endMin: 600 }]); // crn 8920 = Tue 9-10
    });

    it("parses student-supplied meetingTimes directly (no FOSE call needed)", async () => {
        const { blocks, unresolved } = await resolveIpSectionsToBlocks(
            [{ courseId: "MATH-UA 121", meetingTimes: MON_9_10 }],
            "1268",
            { searchFn },
        );
        expect(unresolved).toEqual([]);
        expect(blocks).toEqual([{ day: "M", startMin: 540, endMin: 600 }]);
    });

    it("reports a course as unresolved when neither a CRN match nor times are available", async () => {
        const { blocks, unresolved } = await resolveIpSectionsToBlocks(
            [{ courseId: "CSCI-UA 101", crn: "99999" }, { courseId: "PHYS-UA 11" }],
            "1268",
            { searchFn },
        );
        expect(blocks).toEqual([]);
        expect(unresolved.sort()).toEqual(["CSCI-UA 101", "PHYS-UA 11"]);
    });

    it("an empty/blank meets with no meetingTimes and no CRN is UNRESOLVED (not silently async) — avoids a conflict blind spot", async () => {
        const { blocks, unresolved } = await resolveIpSectionsToBlocks(
            [{ courseId: "X", meets: "" }, { courseId: "Y", meets: "   " }],
            "1268",
            { searchFn },
        );
        expect(blocks).toEqual([]);
        expect(unresolved.sort()).toEqual(["X", "Y"]);
    });

    it("a genuine async token (Does Not Meet) IS resolved (no block, not hedged)", async () => {
        const { blocks, unresolved } = await resolveIpSectionsToBlocks(
            [{ courseId: "Z", meets: "Does Not Meet" }],
            "1268",
            { searchFn },
        );
        expect(blocks).toEqual([]);
        expect(unresolved).toEqual([]);
    });

    it("accumulates blocks across multiple resolved IP courses", async () => {
        const { blocks } = await resolveIpSectionsToBlocks(
            [{ courseId: "CSCI-UA 101", crn: "8919" }, { courseId: "X", meetingTimes: TUE_9_10 }],
            "1268",
            { searchFn },
        );
        expect(blocks).toContainEqual({ day: "M", startMin: 540, endMin: 600 }); // 8919 Mon
        expect(blocks).toContainEqual({ day: "Tu", startMin: 540, endMin: 600 }); // X Tue
    });
});
