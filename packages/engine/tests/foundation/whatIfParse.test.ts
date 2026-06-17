import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseDpr } from "../../src/dpr/parser.js";
import { notSatisfiedRequirements } from "../../src/dpr/schema.js";

const TEXT = readFileSync(join(__dirname, "..", "fixtures", "dpr_whatif_sample.redacted.txt"), "utf-8");

describe("What-If report parses as a DPR", () => {
  it("parses successfully and surfaces the hypothetical Economics requirements + candidates", () => {
    const r = parseDpr(TEXT, { pageCount: 8, nowIso: "2026-06-05T00:00:00Z" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.reportKind).toBe("what_if");
    const blob = JSON.stringify(r.report.requirementGroups).toLowerCase();
    expect(blob).toContain("economics");
    expect(JSON.stringify(r.report).toUpperCase()).toContain("ECON-UA");
    const ip = r.report.courseHistory.filter((c) => c.type === "IP");
    expect(ip.length).toBeGreaterThan(0);
    expect(notSatisfiedRequirements(r.report.requirementGroups).length).toBeGreaterThan(0);
  });
});
