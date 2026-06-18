import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseDpr } from "../../src/dpr/parser.js";
import {
  notSatisfiedRequirements,
  type DPRRequirement,
  type DPRRequirementGroup,
} from "../../src/dpr/schema.js";

const TEXT = readFileSync(join(__dirname, "..", "fixtures", "dpr_whatif_sample.redacted.txt"), "utf-8");

/** Collect every node title (groups + leaves) in the requirement tree. */
function allTitles(groups: DPRRequirementGroup[]): string[] {
  const out: string[] = [];
  const visit = (node: DPRRequirementGroup | DPRRequirement): void => {
    out.push(node.title);
    if (!("rId" in node)) for (const c of node.children) visit(c);
  };
  for (const g of groups) visit(g);
  return out;
}

function countLeaves(groups: DPRRequirementGroup[]): number {
  let n = 0;
  const visit = (node: DPRRequirementGroup | DPRRequirement): void => {
    if ("rId" in node) { n++; return; }
    for (const c of node.children) visit(c);
  };
  for (const g of groups) visit(g);
  return n;
}

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

  // G4.3 — real What-If PDFs leak a `Page N of M` page-runner prefix into
  // some SECTION-HEADER titles (the page-number runner shares a y-coordinate
  // with the section title). E.g. the `R1103 Policy Concentration` group
  // parsed as "Page 7 of 8Policy Concentration", which mis-defaults the
  // parent group to "satisfied" while its leaves are fine. The header parser
  // must strip the leading `Page N of M` prefix — the same prefix the
  // DPR-title detection already strips — without losing any requirement data.
  it("strips the `Page N of M` runner prefix from section-header titles (no data lost)", () => {
    const r = parseDpr(TEXT, { pageCount: 8, nowIso: "2026-06-05T00:00:00Z" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // No requirement-group or leaf title may still carry a `Page N of M`
    // prefix (the Policy Concentration group title is clean).
    const titles = allTitles(r.report.requirementGroups);
    const leaked = titles.filter((t) => /Page\s+\d+\s+of\s+\d+/i.test(t));
    expect(leaked).toEqual([]);
    // The previously-corrupted group is present with its CLEAN title.
    expect(titles).toContain("Policy Concentration");

    // COUNTS unchanged vs. the pre-fix baseline — the strip must not drop or
    // merge any requirement / course-history rows.
    expect(r.report.requirementGroups.length).toBe(12);
    expect(countLeaves(r.report.requirementGroups)).toBe(38);
    expect(r.report.courseHistory.length).toBe(38);
  });
});
