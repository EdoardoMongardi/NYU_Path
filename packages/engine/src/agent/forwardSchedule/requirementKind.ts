export const REQUIREMENT_KINDS = [
  "major-required", "major-elective", "school-core",
  "general-elective", "free-elective", "unknown",
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/** Heavy-vs-easy weight per kind (mirrors workloadTier BASE_WEIGHT). */
export const KIND_WEIGHT: Record<RequirementKind, number> = {
  "major-required": 1.0, "major-elective": 1.0, "school-core": 1.0,
  "general-elective": 0.6, "free-elective": 0.5, "unknown": 0.6,
};
