// ============================================================
// materialize.test.ts — Phase 15 Task 6 tests
// ============================================================
// Tests for the section-materializer orchestrator.
// All tests inject `searchFn` + `cache` to avoid real FOSE I/O.
// Raw FOSE rows are built with the verified schema:
// `meets`, `meetingTimes`, `schd`, `no`, `crn`, `code`, `stat`,
// `title`, `credits`, `instr`.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    materializeSections,
    mapFoseToSectionView,
    bucketSectionsByCourse,
    scoreCombination,
    rankCombinationsByScore,
    type MaterializeArgs,
} from "../../src/agent/sectionMaterialization/materialize.js";
import { FoseCache } from "../../src/agent/sectionMaterialization/foseCache.js";
import { MAX_COMBINATIONS } from "../../src/agent/sectionMaterialization/conflictDetection.js";
import type { SectionView } from "../../src/agent/sectionMaterialization/types.js";
import type { SchedulingPreferences } from "@nyupath/shared";

// ---- Raw-fixture helpers ----

interface RawRow {
    code: string;
    title: string;
    crn: string;
    no: string;
    schd: string;
    stat: string;
    credits: string;
    instr: string;
    meets: string;
    meetingTimes: string;
}

function row(
    code: string,
    crn: string,
    meets: string,
    meetingTimes: string,
    overrides: Partial<RawRow> = {},
): RawRow {
    return {
        code,
        title: code,
        crn,
        no: "001",
        schd: "LEC",
        stat: "O",
        credits: "4",
        instr: "Staff",
        meets,
        meetingTimes,
        ...overrides,
    };
}

// MeetingTimes JSON helpers — meet_day: "0"=M, "1"=Tu, "2"=W, "3"=Th, "4"=F.
const TR_8_915_JSON = JSON.stringify([
    { meet_day: "1", start_time: "800", end_time: "915" },
    { meet_day: "3", start_time: "800", end_time: "915" },
]);
const MW_9_1015_JSON = JSON.stringify([
    { meet_day: "0", start_time: "900", end_time: "1015" },
    { meet_day: "2", start_time: "900", end_time: "1015" },
]);
const MW_2_315_JSON = JSON.stringify([
    { meet_day: "0", start_time: "1400", end_time: "1515" },
    { meet_day: "2", start_time: "1400", end_time: "1515" },
]);
const F_10_1115_JSON = JSON.stringify([
    { meet_day: "4", start_time: "1000", end_time: "1115" },
]);
const TR_1_215_JSON = JSON.stringify([
    { meet_day: "1", start_time: "1300", end_time: "1415" },
    { meet_day: "3", start_time: "1300", end_time: "1415" },
]);

// ---- Search-fn factory: returns a function reading from a static map ----

function searchFromMap(map: Record<string, RawRow[]>): {
    fn: (termCode: string, keyword: string) => Promise<unknown[]>;
    counts: Map<string, number>;
} {
    const counts = new Map<string, number>();
    return {
        fn: async (_termCode: string, keyword: string) => {
            counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
            return map[keyword] ?? [];
        },
        counts,
    };
}

// ---- Pure-helper tests ----

describe("mapFoseToSectionView", () => {
    it("maps verified FOSE shape to SectionView", () => {
        const r = row("CSCI-UA 101", "8918", "TR 8-9:15a", TR_8_915_JSON, {
            no: "002", schd: "LEC", credits: "4", instr: "Staff", title: "Intro to CS",
        });
        const sv = mapFoseToSectionView("CSCI-UA 101", r);
        expect(sv.courseId).toBe("CSCI-UA 101");
        expect(sv.title).toBe("Intro to CS");
        expect(sv.crn).toBe("8918");
        expect(sv.section).toBe("002");
        expect(sv.schd).toBe("LEC");
        expect(sv.rawMeets).toBe("TR 8-9:15a");
        expect(sv.meetingPatterns).toHaveLength(2);
        expect(sv.isAsynchronous).toBe(false);
        expect(sv.meetingTimes).toBe(TR_8_915_JSON);
    });

    it("flags asynchronous when meetingTimes is empty + meets is 'Does Not Meet'", () => {
        const r = row("X", "x1", "Does Not Meet", "[]");
        const sv = mapFoseToSectionView("X", r);
        expect(sv.isAsynchronous).toBe(true);
        expect(sv.meetingPatterns).toHaveLength(0);
    });

    it("falls back to courseId when title is missing", () => {
        const r: Partial<RawRow> = { code: "X", crn: "x1", meets: "", meetingTimes: "[]" };
        const sv = mapFoseToSectionView("X", r as RawRow);
        expect(sv.title).toBe("X");
    });
});

describe("bucketSectionsByCourse", () => {
    it("groups sections by their courseId, preserving courseIds order", () => {
        const sections: SectionView[] = [
            { courseId: "A", title: "A", crn: "a1", credits: "4", instructor: "", status: "O", meetingPatterns: [], isAsynchronous: false, rawMeets: "" },
            { courseId: "B", title: "B", crn: "b1", credits: "4", instructor: "", status: "O", meetingPatterns: [], isAsynchronous: false, rawMeets: "" },
            { courseId: "A", title: "A", crn: "a2", credits: "4", instructor: "", status: "O", meetingPatterns: [], isAsynchronous: false, rawMeets: "" },
        ];
        const buckets = bucketSectionsByCourse(["A", "B"], sections);
        expect(buckets.get("A")?.map(s => s.crn)).toEqual(["a1", "a2"]);
        expect(buckets.get("B")?.map(s => s.crn)).toEqual(["b1"]);
    });

    it("creates empty buckets for courseIds with zero matching sections", () => {
        const buckets = bucketSectionsByCourse(["A", "B"], []);
        expect(buckets.get("A")).toEqual([]);
        expect(buckets.get("B")).toEqual([]);
    });
});

describe("scoreCombination", () => {
    it("returns 1 when all sections have default weight (omitted from Map)", () => {
        const s1 = { crn: "a", meetingPatterns: [] } as unknown as SectionView;
        const s2 = { crn: "b", meetingPatterns: [] } as unknown as SectionView;
        expect(scoreCombination([s1, s2], new Map())).toBe(1);
    });

    it("multiplies weights from rerankWeights", () => {
        const s1 = { crn: "a", meetingPatterns: [] } as unknown as SectionView;
        const s2 = { crn: "b", meetingPatterns: [] } as unknown as SectionView;
        const w = new Map([["a", 1.5], ["b", 0.7]]);
        expect(scoreCombination([s1, s2], w)).toBeCloseTo(1.05, 6);
    });
});

describe("rankCombinationsByScore", () => {
    it("sorts DESC by score; preserves enumeration order on ties", () => {
        const a = { sections: [{ crn: "a" } as SectionView] };
        const b = { sections: [{ crn: "b" } as SectionView] };
        const c = { sections: [{ crn: "c" } as SectionView] };
        const w = new Map([["a", 1.0], ["b", 1.5], ["c", 1.0]]);
        const ranked = rankCombinationsByScore([a, b, c], w);
        // b first (1.5 > 1.0); a + c tie at 1.0 → enumeration order (a then c).
        expect(ranked).toEqual([b, a, c]);
    });
});

// ---- (a) Unavailable state ----

describe("materializeSections — (a) unavailable state", () => {
    it("returns state=unavailable + termCode in message when searchFn returns [] for both courses", async () => {
        const { fn } = searchFromMap({});
        const args: MaterializeArgs = {
            termCode: "1268",
            courseIds: ["X", "Y"],
            swapHook: async () => null,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        };
        const r = await materializeSections(args);
        expect(r.state).toBe("unavailable");
        expect(r.message).toContain("1268");
        expect(r.semester).toBeUndefined();
        expect(r.schedulingPreferenceCheck).toEqual({ kind: "absent" });
    });
});

// ---- (b) Partial state ----

describe("materializeSections — (b) partial state", () => {
    it("returns state=partial when ≥50% of sections have empty meeting data", async () => {
        // 4 total: 1 parseable, 3 unparseable (25% parseable → partial).
        // "TBA" matches the async pattern → counts as parseable, so we use
        // non-async meets strings ("MW 9-10:15a") with EMPTY meetingTimes
        // to make them genuinely unparseable.
        const map: Record<string, RawRow[]> = {
            "X": [
                row("X", "x1", "MW 9-10:15a", MW_9_1015_JSON),
                row("X", "x2", "MW 9-10:15a", ""),
                row("X", "x3", "TR 11a-12:15p", ""),
            ],
            "Y": [row("Y", "y1", "F 2-4:30p", "")],
        };
        const { fn } = searchFromMap(map);
        const r = await materializeSections({
            termCode: "1278",
            courseIds: ["X", "Y"],
            swapHook: async () => null,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.state).toBe("partial");
        expect(r.partialCourses).toBeDefined();
        expect(r.partialCourses).toHaveLength(2);
        expect(r.message).toContain("1278");
        expect(r.schedulingPreferenceCheck).toEqual({ kind: "absent" });
    });
});

// ---- (c) Full happy path ----

describe("materializeSections — (c) full state happy path", () => {
    it("2 courses × 2 sections each, no conflicts → 4 combinations", async () => {
        const map: Record<string, RawRow[]> = {
            "A": [
                row("A", "a1", "MW 9-10:15a", MW_9_1015_JSON),
                row("A", "a2", "MW 2-3:15p", MW_2_315_JSON),
            ],
            "B": [
                row("B", "b1", "TR 8-9:15a", TR_8_915_JSON),
                row("B", "b2", "TR 1-2:15p", TR_1_215_JSON),
            ],
        };
        const { fn } = searchFromMap(map);
        const r = await materializeSections({
            termCode: "1268",
            courseIds: ["A", "B"],
            swapHook: async () => null,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.state).toBe("full");
        expect(r.semester?.combinations).toHaveLength(4);
        expect(r.semester?.courses).toHaveLength(2);
        expect(r.semester?.combinationsTruncated).toBe(false);
        expect(r.schedulingPreferenceCheck).toEqual({ kind: "absent" });
    });
});

// ---- (d) Conflict pruning ----

describe("materializeSections — (d) conflict pruning", () => {
    it("a single mutual conflict reduces the cross-product", async () => {
        // A has TR 8-9:15a + TR 1-2:15p. B has TR 8-9:15a (only — conflicts with A's first).
        // Cross-product = 2; valid = 1 (A.a2 with B.b1).
        const map: Record<string, RawRow[]> = {
            "A": [
                row("A", "a1", "TR 8-9:15a", TR_8_915_JSON),
                row("A", "a2", "TR 1-2:15p", TR_1_215_JSON),
            ],
            "B": [row("B", "b1", "TR 8-9:15a", TR_8_915_JSON)],
        };
        const { fn } = searchFromMap(map);
        const r = await materializeSections({
            termCode: "1268",
            courseIds: ["A", "B"],
            swapHook: async () => null,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.state).toBe("full");
        expect(r.semester?.combinations).toHaveLength(1);
        expect(r.semester?.combinations[0]?.sections.map(s => s.crn).sort()).toEqual(["a2", "b1"]);
    });
});

// ---- (e) Swap on unavailable ----

describe("materializeSections — (e) swap on unavailable", () => {
    it("course A has zero open sections; swap returns B; final bundle uses B", async () => {
        const map: Record<string, RawRow[]> = {
            // A returns one section but it's CLOSED → no open sections
            "A": [row("A", "a1", "MW 9-10:15a", MW_9_1015_JSON, { stat: "C" })],
            "B": [
                row("B", "b1", "TR 8-9:15a", TR_8_915_JSON),
                row("B", "b2", "TR 1-2:15p", TR_1_215_JSON),
            ],
            // Provide a sibling course so availability is "full" (≥50% parseable).
            "Z": [row("Z", "z1", "MW 9-10:15a", MW_9_1015_JSON)],
        };
        const { fn } = searchFromMap(map);
        const swapCalls: Array<{ courseId: string; reason: string }> = [];
        const r = await materializeSections({
            termCode: "1268",
            courseIds: ["A", "Z"],
            swapHook: async (courseId, reason) => {
                swapCalls.push({ courseId, reason });
                return courseId === "A" ? "B" : null;
            },
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.state).toBe("full");
        expect(swapCalls).toEqual([{ courseId: "A", reason: "unavailable" }]);
        const courseIds = r.semester?.courses.map(c => c.courseId) ?? [];
        expect(courseIds).toContain("B");
        expect(courseIds).not.toContain("A");
    });
});

// ---- (f) Swap exhaustion ----

describe("materializeSections — (f) swap exhaustion", () => {
    it("A unavailable + swapHook returns null → A dropped; result still surfaces other courses", async () => {
        const map: Record<string, RawRow[]> = {
            // A — closed, swap returns null
            "A": [row("A", "a1", "MW 9-10:15a", MW_9_1015_JSON, { stat: "C" })],
            "B": [row("B", "b1", "TR 8-9:15a", TR_8_915_JSON)],
        };
        const { fn } = searchFromMap(map);
        const r = await materializeSections({
            termCode: "1268",
            courseIds: ["A", "B"],
            swapHook: async () => null,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.state).toBe("full");
        const courseIds = r.semester?.courses.map(c => c.courseId) ?? [];
        expect(courseIds).toEqual(["B"]);
        expect(r.message).toContain("A");
    });
});

// ---- (g) Strict scheduling pref wipes a course → triggers swap with prefs reason ----

describe("materializeSections — (g) scheduling-prefs strict wipes course → swap", () => {
    it("strict avoidDays Friday wipes A's only section; swap to C succeeds; reason='scheduling-prefs-eliminated'", async () => {
        const map: Record<string, RawRow[]> = {
            "A": [row("A", "a1", "F 10-11:15a", F_10_1115_JSON)],
            "C": [row("C", "c1", "MW 9-10:15a", MW_9_1015_JSON)],
            "Z": [row("Z", "z1", "TR 8-9:15a", TR_8_915_JSON)],
        };
        const { fn } = searchFromMap(map);
        const swapCalls: Array<{ courseId: string; reason: string }> = [];
        const prefs: SchedulingPreferences = {
            avoidDays: [{ day: "F", strict: true }],
        };
        const r = await materializeSections({
            termCode: "1268",
            courseIds: ["A", "Z"],
            swapHook: async (courseId, reason) => {
                swapCalls.push({ courseId, reason });
                return courseId === "A" ? "C" : null;
            },
            schedulingPreferences: prefs,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.state).toBe("full");
        expect(swapCalls).toEqual([{ courseId: "A", reason: "scheduling-prefs-eliminated" }]);
        const courseIds = r.semester?.courses.map(c => c.courseId) ?? [];
        expect(courseIds).toContain("C");
        expect(courseIds).not.toContain("A");
        expect(r.schedulingPreferenceCheck).toEqual({ kind: "satisfied" });
    });
});

// ---- (h) Soft preference reranks combinations ----

describe("materializeSections — (h) soft preference reranks combinations", () => {
    it("preferTimeWindows pulls the matching combo to rankedCombos[0]", async () => {
        // A has a morning + an afternoon section. B has a single morning section.
        // 2 combinations possible: {A.am, B.am} and {A.pm, B.am}. Both conflict-free.
        // preferTimeWindows for MW morning → {A.am, B.am} should rank first.
        const map: Record<string, RawRow[]> = {
            "A": [
                row("A", "a-am", "MW 9-10:15a", MW_9_1015_JSON),
                row("A", "a-pm", "MW 2-3:15p", MW_2_315_JSON),
            ],
            "B": [row("B", "b1", "TR 8-9:15a", TR_8_915_JSON)],
        };
        const { fn } = searchFromMap(map);
        const prefs: SchedulingPreferences = {
            preferTimeWindows: [
                { days: ["M", "W"], startMin: 540, endMin: 720, weight: 1.0 },
            ],
        };
        const r = await materializeSections({
            termCode: "1268",
            courseIds: ["A", "B"],
            swapHook: async () => null,
            schedulingPreferences: prefs,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.state).toBe("full");
        const top = r.semester?.combinations[0]?.sections.map(s => s.crn).sort() ?? [];
        expect(top).toEqual(["a-am", "b1"].sort());
    });
});

// ---- (i) schedulingPreferenceCheck output ----

describe("materializeSections — (i) schedulingPreferenceCheck output", () => {
    it("undefined prefs → kind: absent", async () => {
        const map: Record<string, RawRow[]> = {
            "A": [row("A", "a1", "MW 9-10:15a", MW_9_1015_JSON)],
            "B": [row("B", "b1", "TR 8-9:15a", TR_8_915_JSON)],
        };
        const { fn } = searchFromMap(map);
        const r = await materializeSections({
            termCode: "1268",
            courseIds: ["A", "B"],
            swapHook: async () => null,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.schedulingPreferenceCheck).toEqual({ kind: "absent" });
    });

    it("prefs supplied + satisfiable → kind: satisfied", async () => {
        const map: Record<string, RawRow[]> = {
            "A": [row("A", "a1", "MW 9-10:15a", MW_9_1015_JSON)],
            "B": [row("B", "b1", "TR 8-9:15a", TR_8_915_JSON)],
        };
        const { fn } = searchFromMap(map);
        const prefs: SchedulingPreferences = {
            avoidDays: [{ day: "F", strict: true }],
        };
        const r = await materializeSections({
            termCode: "1268",
            courseIds: ["A", "B"],
            swapHook: async () => null,
            schedulingPreferences: prefs,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.schedulingPreferenceCheck).toEqual({ kind: "satisfied" });
    });

    it("prefs supplied + course-wipe with no swap → kind: violated with concrete reason", async () => {
        const map: Record<string, RawRow[]> = {
            // A: only a Friday section; strict avoidDays Friday wipes it.
            "A": [row("A", "a1", "F 10-11:15a", F_10_1115_JSON)],
            "B": [row("B", "b1", "TR 8-9:15a", TR_8_915_JSON)],
        };
        const { fn } = searchFromMap(map);
        const prefs: SchedulingPreferences = {
            avoidDays: [{ day: "F", strict: true }],
        };
        const r = await materializeSections({
            termCode: "1268",
            courseIds: ["A", "B"],
            swapHook: async () => null,
            schedulingPreferences: prefs,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.schedulingPreferenceCheck?.kind).toBe("violated");
        if (r.schedulingPreferenceCheck?.kind === "violated") {
            expect(r.schedulingPreferenceCheck.reason).toContain("A");
            expect(r.schedulingPreferenceCheck.reason.toLowerCase()).toContain("strict");
        }
    });
});

// ---- (j) Cache integration ----

describe("materializeSections — (j) cache integration", () => {
    it("first call populates cache; second call hits cache (searchFn not invoked twice for same key)", async () => {
        const map: Record<string, RawRow[]> = {
            "A": [row("A", "a1", "MW 9-10:15a", MW_9_1015_JSON)],
            "B": [row("B", "b1", "TR 8-9:15a", TR_8_915_JSON)],
        };
        const { fn, counts } = searchFromMap(map);
        const cache = new FoseCache<unknown[]>();
        const baseArgs: MaterializeArgs = {
            termCode: "1268",
            courseIds: ["A", "B"],
            swapHook: async () => null,
            searchFn: fn,
            cache,
        };
        await materializeSections(baseArgs);
        await materializeSections(baseArgs);
        expect(counts.get("A")).toBe(1);
        expect(counts.get("B")).toBe(1);
    });
});

// ---- (k) MAX_COMBINATIONS cap ----

describe("materializeSections — (k) MAX_COMBINATIONS cap", () => {
    it("4×4×4 = 64 conflict-free combos triggers truncated:true and caps at MAX_COMBINATIONS", async () => {
        // Each course has 4 conflict-free sections (different M/Tu/W/Th slots).
        // Cross-product = 64 > MAX_COMBINATIONS (50) → truncated.
        // Choose patterns that never overlap each other:
        //   course A:  M 9-10, M 11-12, M 1-2, M 3-4   (4 distinct M slots)
        //   course B:  Tu 9-10, Tu 11-12, Tu 1-2, Tu 3-4
        //   course C:  W 9-10, W 11-12, W 1-2, W 3-4
        // Different days entirely → all 64 are conflict-free.
        function singleDayJson(day: string, startHHMM: string, endHHMM: string): string {
            return JSON.stringify([{ meet_day: day, start_time: startHHMM, end_time: endHHMM }]);
        }
        function fourSlots(course: string, day: string): RawRow[] {
            return [
                row(course, `${course}-1`, `placeholder`, singleDayJson(day, "900", "1000")),
                row(course, `${course}-2`, `placeholder`, singleDayJson(day, "1100", "1200")),
                row(course, `${course}-3`, `placeholder`, singleDayJson(day, "1300", "1400")),
                row(course, `${course}-4`, `placeholder`, singleDayJson(day, "1500", "1600")),
            ];
        }
        const map: Record<string, RawRow[]> = {
            "A": fourSlots("A", "0"),
            "B": fourSlots("B", "1"),
            "C": fourSlots("C", "2"),
        };
        const { fn } = searchFromMap(map);
        const r = await materializeSections({
            termCode: "1268",
            courseIds: ["A", "B", "C"],
            swapHook: async () => null,
            searchFn: fn,
            cache: new FoseCache<unknown[]>(),
        });
        expect(r.state).toBe("full");
        expect(r.semester?.combinations.length).toBe(MAX_COMBINATIONS);
        expect(r.semester?.combinationsTruncated).toBe(true);
    });
});
