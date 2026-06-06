import { describe, it, expect } from "vitest";
import type { CourseTaken, StudentProfile, SchoolConfig } from "@nyupath/shared";
import { REQUIREMENT_KINDS, KIND_WEIGHT, type RequirementKind } from "../../src/agent/forwardSchedule/requirementKind.js";

describe("Phase-1 additive type contracts", () => {
  it("CourseTaken carries isInProgress + repeatCode", () => {
    const c: CourseTaken = { courseId: "MATH-UA 251", grade: "A", semester: "2026-fall", isInProgress: true, repeatCode: "RI" };
    expect(c.isInProgress).toBe(true);
    expect(c.repeatCode).toBe("RI");
  });
  it("StudentProfile carries advisorNotations", () => {
    const p = { advisorNotations: [{ note: "Permission to apply 32 AP credits" }] } as Partial<StudentProfile>;
    expect(p.advisorNotations?.[0]?.note).toContain("AP");
  });
  it("SchoolConfig carries per-semester credit target + part-time floor", () => {
    const s = { creditTargetPerSemester: 16, domesticPartTimeFloor: 8 } as Partial<SchoolConfig>;
    expect(s.creditTargetPerSemester).toBe(16);
  });
  it("RequirementKind enumerates five structural kinds + unknown, with weights", () => {
    const all: RequirementKind[] = [...REQUIREMENT_KINDS];
    expect(all).toContain("major-required");
    expect(all).toContain("free-elective");
    expect(all).toContain("unknown");
    expect(KIND_WEIGHT["major-required"]).toBe(1.0);
    expect(KIND_WEIGHT["free-elective"]).toBe(0.5);
  });
});
