// ============================================================
// Unit Tests — Prerequisite Graph
// ============================================================
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Prerequisite } from "@nyupath/shared";
import { PrereqGraph } from "../../src/graph/prereqGraph.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../../src/data");

const prereqs: Prerequisite[] = JSON.parse(
    readFileSync(join(DATA_DIR, "prereqs.json"), "utf-8")
);

describe("PrereqGraph", () => {
    const graph = new PrereqGraph(prereqs);

    it("detects no cycles in valid data", () => {
        const cycles = graph.detectCycles();
        expect(cycles).toHaveLength(0);
    });

    it("detects cycles in bad data", () => {
        const badPrereqs: Prerequisite[] = [
            { course: "A", prereqGroups: [{ type: "AND", courses: ["B"] }], coreqs: [] },
            { course: "B", prereqGroups: [{ type: "AND", courses: ["A"] }], coreqs: [] },
        ];
        const badGraph = new PrereqGraph(badPrereqs);
        const cycles = badGraph.detectCycles();
        expect(cycles.length).toBeGreaterThan(0);
    });

    it("CSCI-UA 102 requires 101 OR 110", () => {
        const with101 = new Set(["CSCI-UA 101"]);
        const with110 = new Set(["CSCI-UA 110"]);
        const withNeither = new Set<string>();

        expect(graph.hasPrerequisitesMet("CSCI-UA 102", with101)).toBe(true);
        expect(graph.hasPrerequisitesMet("CSCI-UA 102", with110)).toBe(true);
        expect(graph.hasPrerequisitesMet("CSCI-UA 102", withNeither)).toBe(false);
    });

    it("CSCI-UA 310 requires 102 AND MATH-UA 120", () => {
        const onlyCS = new Set(["CSCI-UA 102"]);
        const onlyMath = new Set(["MATH-UA 120"]);
        const both = new Set(["CSCI-UA 102", "MATH-UA 120"]);

        expect(graph.hasPrerequisitesMet("CSCI-UA 310", onlyCS)).toBe(false);
        expect(graph.hasPrerequisitesMet("CSCI-UA 310", onlyMath)).toBe(false);
        expect(graph.hasPrerequisitesMet("CSCI-UA 310", both)).toBe(true);
    });

    it("courses without prereqs are always unlocked", () => {
        const empty = new Set<string>();
        // CSCI-UA 101 now has prereqs, so we check a MATH course and a missing/hypothetical one
        expect(graph.hasPrerequisitesMet("MATH-UA 121", empty)).toBe(true);
        expect(graph.hasPrerequisitesMet("UNKNOWN_101", empty)).toBe(true);
    });

    it("getUnlockedCourses returns correct set", () => {
        const completed = new Set(["CSCI-UA 101", "MATH-UA 121"]);
        const allIds = ["CSCI-UA 102", "CSCI-UA 201", "MATH-UA 140", "MATH-UA 122"];
        const unlocked = graph.getUnlockedCourses(completed, allIds);

        expect(unlocked).toContain("CSCI-UA 102");   // 101 done → 102 unlocked
        expect(unlocked).toContain("MATH-UA 140");   // 121 done → 140 unlocked
        expect(unlocked).toContain("MATH-UA 122");   // 121 done → 122 unlocked
        expect(unlocked).not.toContain("CSCI-UA 201"); // needs 102
    });

    it("countTransitivelyBlocked gives higher values for earlier courses", () => {
        const blocked102 = graph.countTransitivelyBlocked("CSCI-UA 102");
        const blocked310 = graph.countTransitivelyBlocked("CSCI-UA 310");
        // 102 unlocks more courses transitively than 310
        expect(blocked102).toBeGreaterThan(blocked310);
    });

    it("getDependents returns direct dependencies", () => {
        const deps = graph.getDependents("CSCI-UA 102");
        expect(deps).toContain("CSCI-UA 201");
        expect(deps).toContain("CSCI-UA 310");
    });

    // ---- Edge Case Tests ----

    it("cross-listed prereq: prereqGraph is ID-literal (does not resolve cross-listings)", () => {
        // CSCI-UA 471 requires CSCI-UA 310, MATH-UA 140, and MATH-UA 233|235.
        // If someone completed DS-UA 301 (cross-listed with CSCI-UA 471), the prereq graph
        // doesn't know about the cross-listing — it only checks literal course IDs.
        // This test documents that cross-listing resolution is handled by the equivalence layer, not here.
        const with310And140And233 = new Set(["CSCI-UA 310", "MATH-UA 140", "MATH-UA 233"]);
        expect(graph.hasPrerequisitesMet("CSCI-UA 471", with310And140And233)).toBe(true);
        // Missing MATH-UA 140 → should fail
        const without140 = new Set(["CSCI-UA 310", "MATH-UA 233"]);
        expect(graph.hasPrerequisitesMet("CSCI-UA 471", without140)).toBe(false);
    });

    it("getCoreqs returns empty array for courses without corequisites", () => {
        const coreqs = graph.getCoreqs("CSCI-UA 102");
        expect(coreqs).toEqual([]);
    });

    it("getCoreqs returns empty array for unknown courses", () => {
        const coreqs = graph.getCoreqs("UNKNOWN-999");
        expect(coreqs).toEqual([]);
    });

    it("corequisites work with synthetic data", () => {
        const withCoreqs: Prerequisite[] = [
            {
                course: "PHYS-UA 91",
                prereqGroups: [],
                coreqs: ["PHYS-UA 93"],
            },
        ];
        const coreqGraph = new PrereqGraph(withCoreqs);
        expect(coreqGraph.getCoreqs("PHYS-UA 91")).toEqual(["PHYS-UA 93"]);
        expect(coreqGraph.getCoreqs("PHYS-UA 93")).toEqual([]);
    });

    it("deep chain: 3-level transitive blocking (101→102→201→202)", () => {
        // CSCI-UA 202 → needs 201 → needs 102 → needs 101
        // So 101 transitively blocks 102, 201, 202, 310, and all their dependents
        const blocked101 = graph.countTransitivelyBlocked("CSCI-UA 101");
        const blocked201 = graph.countTransitivelyBlocked("CSCI-UA 201");
        const blocked202 = graph.countTransitivelyBlocked("CSCI-UA 202");
        // 101 → 102 → 201, 310 → ... many more
        // 201 → 202, 480, 473, etc.
        // 202 → fewer
        expect(blocked101).toBeGreaterThan(blocked201);
        expect(blocked201).toBeGreaterThan(blocked202);
    });
});
