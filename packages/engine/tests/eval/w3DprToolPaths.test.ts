// ============================================================
// Phase 7-E W3 — DPR-driven tool paths integration tests
// ============================================================
// Each tool now has two paths: DPR primary (when
// session.degreeProgressReport is loaded) and authored-rules
// fallback (legacy). These tests exercise the DPR primary
// path end-to-end against the redacted sample DPR.
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    parseDpr,
    type DegreeProgressReport,
    type ToolSession,
} from "../../src/index.js";
import { runFullAuditTool } from "../../src/agent/tools/runFullAudit.js";
import { planSemesterTool } from "../../src/agent/tools/planSemester.js";
import { whatIfAuditTool } from "../../src/agent/tools/whatIfAudit.js";

const SAMPLE_TEXT = readFileSync(
    join(__dirname, "..", "fixtures", "dpr_sample.redacted.txt"),
    "utf-8",
);

function buildDprSession(): { session: ToolSession; report: DegreeProgressReport } {
    const r = parseDpr(SAMPLE_TEXT, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error(`parse failed: ${r.error}`);
    const report = r.report;
    const session: ToolSession = {
        student: {
            id: "sample_student",
            catalogYear: "2024-2025",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science_math", programType: "major" }],
            coursesTaken: [],
        },
        degreeProgressReport: report,
    };
    return { session, report };
}

const ABORT = new AbortController().signal;

describe("W3.1 — run_full_audit DPR-primary path", () => {
    it("returns audits sourced from the DPR (source=dpr) with the prepared date attached", async () => {
        const { session } = buildDprSession();
        const out = await runFullAuditTool.call(
            {},
            { signal: ABORT, session },
        );
        expect(out.source).toBe("dpr");
        expect(out.dprPreparedDate).toBe("04/27/2026");
        expect(out.audits.length).toBeGreaterThan(0);
    });

    it("standing reads cumulative GPA + credits straight from the DPR cumulative block", async () => {
        const { session } = buildDprSession();
        const out = await runFullAuditTool.call(
            {},
            { signal: ABORT, session },
        );
        expect(out.standing.cumulativeGPA).toBe(3.402);
        // completionRate is capped at 1.0 (the student earned 138 of 128
        // required credits — over 100% — but the rate is clamped for
        // display sanity; raw count lives in the audits[] entries).
        expect(out.standing.completionRate).toBe(1);
        expect(out.standing.inGoodStanding).toBe(true);
        expect(out.standing.level).toBe("good_standing");
    });

    it("verbatim disclosure pins the GPA value with DPR provenance", async () => {
        const { session } = buildDprSession();
        const out = await runFullAuditTool.call(
            {},
            { signal: ABORT, session },
        );
        const verbatim = runFullAuditTool.extractVerbatim?.(out);
        expect(verbatim).toBe("Cumulative GPA: 3.402 (from your Degree Progress Report).");
    });

    it("filters audits by programId when supplied; returns empty when no match (no silent fallback)", async () => {
        const { session } = buildDprSession();
        const matched = await runFullAuditTool.call(
            { programId: "computer_science" },
            { signal: ABORT, session },
        );
        expect(matched.audits.length).toBeGreaterThan(0);
        for (const a of matched.audits) {
            expect(a.programId).toContain("computer_science");
        }

        const unmatched = await runFullAuditTool.call(
            { programId: "stern_finance_bs" },
            { signal: ABORT, session },
        );
        expect(unmatched.audits).toHaveLength(0);
    });

    it("summarizer mentions DPR provenance instead of authored rules", async () => {
        const { session } = buildDprSession();
        const out = await runFullAuditTool.call(
            {},
            { signal: ABORT, session },
        );
        const summary = runFullAuditTool.summarizeResult(out);
        expect(summary).toContain("from your Degree Progress Report");
        // STANDING line uses lowercase "cumulative GPA" with no colon.
        expect(summary).toContain("cumulative GPA 3.402");
    });
});

describe("W3.2 — plan_semester DPR-primary path", () => {
    it("emits suggestions from the DPR not-satisfied requirements (source=dpr)", async () => {
        const { session } = buildDprSession();
        const out = await planSemesterTool.call(
            { targetSemester: "2027-spring" },
            { signal: ABORT, session },
        );
        expect(out.source).toBe("dpr");
        expect(out.suggestions.length).toBeGreaterThan(0);
        // The R1142/20 unsatisfied requirement should surface CSCI-UA 421 as a suggestion.
        const ids = out.suggestions.map((s) => s.courseId);
        expect(ids).toContain("CSCI-UA 421");
    });

    it("estimatedSemestersLeft is non-negative and uses DPR credit totals", async () => {
        const { session } = buildDprSession();
        const out = await planSemesterTool.call(
            { targetSemester: "2027-spring", maxCredits: 16 },
            { signal: ABORT, session },
        );
        expect(out.estimatedSemestersLeft).toBeGreaterThanOrEqual(1);
    });

    it("respects maxCourses cap", async () => {
        const { session } = buildDprSession();
        const out = await planSemesterTool.call(
            { targetSemester: "2027-spring", maxCourses: 2 },
            { signal: ABORT, session },
        );
        expect(out.suggestions.length).toBeLessThanOrEqual(2);
    });

    it("validates input under DPR-only sessions (no programs/courses required)", async () => {
        const { session } = buildDprSession();
        const v = await planSemesterTool.validateInput!(
            { targetSemester: "2027-spring" },
            { signal: ABORT, session },
        );
        expect(v.ok).toBe(true);
    });
});

describe("W3.3 — what_if_audit unauthored-program path", () => {
    it("returns an estimate envelope with the verbatim disclaimer when programs are not in the catalog", async () => {
        const { session } = buildDprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["stern_finance_bs"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        // Discriminator branch
        if (!("kind" in out)) throw new Error("expected unauthored_program_estimate");
        expect(out.kind).toBe("unauthored_program_estimate");
        expect(out.requestedProgramIds).toContain("stern_finance_bs");
        expect(out.disclaimer).toMatch(/Verify with an academic adviser/);
    });

    it("extractVerbatim returns the disclaimer for unauthored estimates", async () => {
        const { session } = buildDprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["unknown_program"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const verbatim = whatIfAuditTool.extractVerbatim?.(out);
        expect(verbatim).toMatch(/Verify with an academic adviser/);
        expect(verbatim).toMatch(/AI-extracted requirements/);
    });

    it("summarizer surfaces guidance + disclaimer for unauthored estimates", async () => {
        const { session } = buildDprSession();
        const out = await whatIfAuditTool.call(
            { hypotheticalPrograms: ["nonexistent_program_id"], compareWithCurrent: true },
            { signal: ABORT, session },
        );
        const summary = whatIfAuditTool.summarizeResult(out);
        expect(summary).toContain("estimate, no structured rules available");
        expect(summary).toContain("REQUIRED DISCLAIMER");
    });

    it("extractVerbatim returns null for authored-path results (no disclaimer needed)", async () => {
        // Provide a synthetic authored result by mocking the shape.
        const fakeAuthored = {
            hypothetical: { programs: [] },
            comparison: undefined,
            warnings: [],
        };
        const verbatim = whatIfAuditTool.extractVerbatim?.(fakeAuthored as never);
        expect(verbatim).toBeNull();
    });
});
