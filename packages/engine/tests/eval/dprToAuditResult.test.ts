// ============================================================
// Phase 7-E W1.5 — dprToAuditResult adapter tests
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr } from "../../src/dpr/parser.js";
import {
    dprToAuditResults,
    dprToPrimaryAuditResult,
} from "../../src/dpr/dprToAuditResult.js";

const SAMPLE_TEXT = readFileSync(
    join(__dirname, "..", "fixtures", "dpr_sample.redacted.txt"),
    "utf-8",
);

function loadDpr() {
    const r = parseDpr(SAMPLE_TEXT, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("parse failed");
    return r.report;
}

describe("dprToAuditResults", () => {
    it("emits one AuditResult per declared program", () => {
        const dpr = loadDpr();
        const audits = dprToAuditResults(dpr, { timestamp: "2026-04-27T00:00:00Z" });
        expect(audits).toHaveLength(3);
        expect(audits.map((a) => a.programName)).toEqual([
            "Undergraduate Career (Program)",
            "UA-Coll of Arts & Sci (Program)",
            "Computer Science/Math (Major Approved)",
        ]);
    });

    it("populates totalCredits* from the DPR's cumulative block", () => {
        const dpr = loadDpr();
        const audits = dprToAuditResults(dpr, { timestamp: "2026-04-27T00:00:00Z" });
        for (const a of audits) {
            expect(a.totalCreditsCompleted).toBe(138);
            expect(a.totalCreditsRequired).toBe(128);
        }
    });

    it("flattens every leaf Requirement into rules[]", () => {
        const dpr = loadDpr();
        const audits = dprToAuditResults(dpr, { timestamp: "2026-04-27T00:00:00Z" });
        const major = audits[2]!; // CS/Math
        const ruleIds = major.rules.map((r) => r.ruleId);
        expect(ruleIds).toContain("R1142/20"); // CS Required
        expect(ruleIds).toContain("R1142/75"); // Major GPA
    });

    it("converts DPR status to RuleStatus correctly", () => {
        const dpr = loadDpr();
        const major = dprToAuditResults(dpr, { timestamp: "2026-04-27T00:00:00Z" })[2]!;
        const r1142_20 = major.rules.find((r) => r.ruleId === "R1142/20")!;
        expect(r1142_20.status).toBe("in_progress"); // not_satisfied + has applied courses
        const r1001_10 = major.rules.find((r) => r.ruleId === "R1001/10")!;
        expect(r1001_10.status).toBe("satisfied");
    });

    it("renders applied courses as `<subject> <catalogNbr>` strings", () => {
        const dpr = loadDpr();
        const major = dprToAuditResults(dpr, { timestamp: "2026-04-27T00:00:00Z" })[2]!;
        const r1142_20 = major.rules.find((r) => r.ruleId === "R1142/20")!;
        expect(r1142_20.coursesSatisfying).toContain("CSCI-UA 102");
        expect(r1142_20.coursesSatisfying).toContain("CSCI-UA 310");
    });

    it("computes remaining counts from the DPR counter when present", () => {
        const dpr = loadDpr();
        const major = dprToAuditResults(dpr, { timestamp: "2026-04-27T00:00:00Z" })[2]!;
        const r1142_20 = major.rules.find((r) => r.ruleId === "R1142/20")!;
        expect(r1142_20.remaining).toBe(1); // CSCI-UA 421 is the missing one
    });
});

describe("dprToPrimaryAuditResult", () => {
    it("returns the AuditResult tagged with a Major-style programType", () => {
        const dpr = loadDpr();
        const a = dprToPrimaryAuditResult(dpr, { timestamp: "2026-04-27T00:00:00Z" });
        expect(a).not.toBeNull();
        expect(a!.programName).toContain("Major");
    });

    it("returns null when the DPR has no programs", () => {
        const dpr = loadDpr();
        const empty = { ...dpr, programs: [] };
        expect(dprToPrimaryAuditResult(empty)).toBeNull();
    });
});
