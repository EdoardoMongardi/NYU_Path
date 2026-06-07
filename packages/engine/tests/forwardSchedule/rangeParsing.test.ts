import { describe, it, expect } from "vitest";
import { extractCandidatesAndPool } from "../../src/agent/forwardSchedule/buildSolverInput.js";

describe("extractCandidatesAndPool — ranges become pool descriptors, never phantom courses", () => {
    it("a CSCI-UA 400-499 range yields a pool descriptor and NO phantom CSCI-UA 400", () => {
        const r = extractCandidatesAndPool({ title: "Computer Science: Elective Courses", statusText: "Complete 2 courses from: CSCI-UA 400-499", description: "" });
        expect(r.pool).toEqual({ dept: "CSCI-UA", levelMin: 400, levelMax: 499 });
        expect(r.candidateCourses).not.toContain("CSCI-UA 400");
    });
    it("an en-dash range is recognized", () => {
        const r = extractCandidatesAndPool({ title: "X", statusText: "Complete 1 course from CORE-UA 400–499.", description: "" });
        expect(r.pool).toEqual({ dept: "CORE-UA", levelMin: 400, levelMax: 499 });
        expect(r.candidateCourses).not.toContain("CORE-UA 400");
    });
    it("an explicit course list still enumerates individual ids and no pool", () => {
        const r = extractCandidatesAndPool({ title: "Math Core", statusText: "", description: "Take MATH-UA 120 and MATH-UA 121." });
        expect(r.candidateCourses).toEqual(expect.arrayContaining(["MATH-UA 120", "MATH-UA 121"]));
        expect(r.pool).toBeUndefined();
    });
    it("a single course (no range) is unchanged", () => {
        const r = extractCandidatesAndPool({ title: "X", statusText: "", description: "CSCI-UA 101" });
        expect(r.candidateCourses).toEqual(["CSCI-UA 101"]);
        expect(r.pool).toBeUndefined();
    });
    it("a mixed requirement (explicit course + a range) emits BOTH", () => {
        const r = extractCandidatesAndPool({ title: "X", statusText: "Complete CSCI-UA 101 or one of CSCI-UA 400-499.", description: "" });
        expect(r.candidateCourses).toContain("CSCI-UA 101");
        expect(r.candidateCourses).not.toContain("CSCI-UA 400");
        expect(r.pool).toEqual({ dept: "CSCI-UA", levelMin: 400, levelMax: 499 });
    });
});
