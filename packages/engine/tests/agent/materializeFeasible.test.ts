// ============================================================
// materializeFeasible.test.ts — Phase 38 Task 0.3 (orchestrator)
// ============================================================
// The deterministic `materializeFeasible` orchestrator — the
// agent's ONLY source of verified section candidates (§2 ①, §2.5).
// Returns the UI-complete candidate set, schema-validated, with a
// cheap deterministic pre-rank. No invalid candidate can be emitted.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    materializeFeasible,
    materializeFeasibleResultSchema,
} from "../../src/agent/sectionMaterialization/materializeFeasible.js";
import { FoseCache } from "../../src/agent/sectionMaterialization/foseCache.js";
import { conflicts } from "../../src/agent/sectionMaterialization/conflictDetection.js";

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
    total?: string;
}

function row(
    code: string,
    crn: string,
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
        meets: "meets",
        meetingTimes,
        ...overrides,
    };
}

const MON_9_10 = JSON.stringify([{ meet_day: "0", start_time: "900", end_time: "1000" }]);
const TUE_9_10 = JSON.stringify([{ meet_day: "1", start_time: "900", end_time: "1000" }]);
const WED_9_10 = JSON.stringify([{ meet_day: "2", start_time: "900", end_time: "1000" }]);

function searchFromMap(map: Record<string, RawRow[]>) {
    return async (_t: string, keyword: string) => map[keyword] ?? [];
}

describe("materializeFeasible — 0.3 orchestrator", () => {
    it("full state: returns schema-valid candidates; every candidate is conflict-free", async () => {
        const map: Record<string, RawRow[]> = {
            A: [row("A", "a1", MON_9_10, { total: "30" })],
            B: [row("B", "b1", TUE_9_10, { total: "25" })],
        };
        const result = await materializeFeasible({
            termCode: "1268",
            courseIds: ["A", "B"],
            searchFn: searchFromMap(map),
            cache: new FoseCache<unknown[]>(),
        });
        expect(result.state).toBe("full");
        expect(materializeFeasibleResultSchema.safeParse(result).success).toBe(true);
        expect(result.candidates).toHaveLength(1);
        const cand = result.candidates[0]!;
        expect(cand.candidateId).toMatch(/^cand_/);
        // capacity threaded from FOSE `total`
        const aComp = cand.courses.find(c => c.code === "A")!.components[0]!;
        expect(aComp.capacity).toBe("30");
        expect(aComp.status).toBe("O");
        expect(aComp.meetingBlocks).toHaveLength(1);
        // Every candidate's blocks are mutually conflict-free.
        for (const c of result.candidates) {
            const blocks = c.courses.flatMap(cc => cc.components.map(comp => comp.meetingBlocks));
            for (let i = 0; i < blocks.length; i++)
                for (let j = i + 1; j < blocks.length; j++)
                    expect(conflicts(blocks[i]!, blocks[j]!)).toBe(false);
        }
    });

    it("multi-component course surfaces both components + the free-pairing hedge", async () => {
        const map: Record<string, RawRow[]> = {
            CHEM: [
                row("CHEM", "lec1", MON_9_10, { schd: "LEC", no: "001" }),
                row("CHEM", "rct1", TUE_9_10, { schd: "RCT", no: "002" }),
            ],
        };
        const result = await materializeFeasible({
            termCode: "1268",
            courseIds: ["CHEM"],
            searchFn: searchFromMap(map),
            cache: new FoseCache<unknown[]>(),
        });
        expect(result.state).toBe("full");
        const comps = result.candidates[0]!.courses[0]!.components.map(c => c.schd).sort();
        expect(comps).toEqual(["LEC", "RCT"]);
        expect(result.hedges.some(h => /pair|recitation|albert/i.test(h))).toBe(true);
    });

    it("waitlist candidate: tagged, fallback recorded, waitlist hedge present, ranked below open", async () => {
        // A has an open section (a-open, Wed) and a waitlist section (a-wl, Mon)
        // plus an open same-course backup for the waitlist (a-bk, Tue).
        // B is a single open lecture (Wed) that clashes with a-open? No —
        // keep them all distinct days so multiple candidates exist.
        const map: Record<string, RawRow[]> = {
            A: [
                row("A", "a-open", WED_9_10, { stat: "O" }),
                row("A", "a-wl", MON_9_10, { stat: "W" }),
                row("A", "a-bk", TUE_9_10, { stat: "O" }),
            ],
            B: [row("B", "b1", JSON.stringify([{ meet_day: "4", start_time: "900", end_time: "1000" }]), { stat: "O" })], // Fri
        };
        const result = await materializeFeasible({
            termCode: "1268",
            courseIds: ["A", "B"],
            searchFn: searchFromMap(map),
            cache: new FoseCache<unknown[]>(),
        });
        expect(result.state).toBe("full");
        // The top candidate must be all-open (open ≻ waitlist).
        expect(result.candidates[0]!.hasWaitlist).toBe(false);
        // A waitlist candidate exists, tagged + with a recorded backup.
        const wl = result.candidates.find(c => c.hasWaitlist);
        expect(wl).toBeDefined();
        expect(wl!.waitlistCrns).toContain("a-wl");
        expect(wl!.openFallbacks.some(f => f.forCrn === "a-wl")).toBe(true);
        // Waitlist queue-length hedge present.
        expect(result.hedges.some(h => /waitlist/i.test(h))).toBe(true);
    });

    it("a required course with no open/waitlist section is flagged (unavailableCourses + hedge), never silently dropped", async () => {
        // A has an open section; B exists but is CLOSED (no O/W). The union still
        // classifies "full". B must NOT be silently omitted from a clean result.
        const map: Record<string, RawRow[]> = {
            A: [row("A", "a1", MON_9_10, { stat: "O" })],
            B: [row("B", "b1", TUE_9_10, { stat: "C" })],
        };
        const result = await materializeFeasible({
            termCode: "1268",
            courseIds: ["A", "B"],
            searchFn: searchFromMap(map),
            cache: new FoseCache<unknown[]>(),
        });
        expect(result.unavailableCourses).toContain("B");
        expect(result.hedges.some(h => h.includes("B"))).toBe(true);
        // Schema still validates with the new field present.
        expect(materializeFeasibleResultSchema.safeParse(result).success).toBe(true);
    });

    it("unavailable state: searchFn returns nothing → no candidates", async () => {
        const result = await materializeFeasible({
            termCode: "1268",
            courseIds: ["X"],
            searchFn: searchFromMap({}),
            cache: new FoseCache<unknown[]>(),
        });
        expect(result.state).toBe("unavailable");
        expect(result.candidates).toEqual([]);
        expect(materializeFeasibleResultSchema.safeParse(result).success).toBe(true);
    });
});
