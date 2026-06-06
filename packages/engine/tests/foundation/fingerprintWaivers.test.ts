// ============================================================
// Task 1.3 — DPR-3: advisor waivers in fingerprint + profile (TDD)
// ============================================================
// Asserts two properties:
//   1. A re-uploaded DPR that adds a new advisor waiver produces a
//      DIFFERENT fingerprint (so the re-plan is NOT short-circuited).
//   2. buildStudentProfileFromDpr carries advisorNotations onto the
//      returned StudentProfile when they are present on the report.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDpr } from "../../src/dpr/parser.js";
import { computeDprFingerprint } from "../../src/dpr/fingerprint.js";
import { mkDpr } from "../helpers/mkDpr.js";
import { buildStudentProfileFromDpr } from "../../../../apps/web/lib/buildSession.js";

// ---- fixture ----

const FIXTURE_PATH = join(__dirname, "..", "fixtures", "dpr_sample.redacted.txt");
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf-8");

function parseFixture() {
    const r = parseDpr(FIXTURE_TEXT, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error(`DPR parse failed: ${r.error}`);
    return r.report;
}

// ============================================================
// Suite 1 — fingerprint changes when a waiver is added/removed
// ============================================================

describe("Task 1.3 — DPR-3: fingerprint includes advisorNotations", () => {
    it("fixture: baseline fingerprint is a 64-char hex string", () => {
        const report = parseFixture();
        const fp = computeDprFingerprint(report);
        expect(fp).toMatch(/^[a-f0-9]{64}$/);
    });

    it("fixture: adding a new advisorNotation produces a different fingerprint", () => {
        const base = parseFixture();
        const baseFp = computeDprFingerprint(base);

        // Clone and append one extra waiver.
        const withExtra = {
            ...base,
            advisorNotations: [
                ...base.advisorNotations,
                { note: "NEW waiver: substitute X for Y" },
            ],
        };
        const withExtraFp = computeDprFingerprint(withExtra);

        expect(withExtraFp).not.toBe(baseFp);
    });

    it("mkDpr helper: fingerprint changes when advisorNotations differ", () => {
        const without = mkDpr({
            courseHistory: [],
            advisorNotations: [],
        });
        const with1 = mkDpr({
            courseHistory: [],
            advisorNotations: [{ note: "Waiver: apply AP credits to Science requirement" }],
        });
        expect(computeDprFingerprint(without)).not.toBe(computeDprFingerprint(with1));
    });

    it("mkDpr helper: fingerprint is stable when advisorNotations are identical", () => {
        const a = mkDpr({ advisorNotations: [{ requestId: "0000013777", note: "AP waiver" }] });
        const b = mkDpr({ advisorNotations: [{ requestId: "0000013777", note: "AP waiver" }] });
        expect(computeDprFingerprint(a)).toBe(computeDprFingerprint(b));
    });
});

// ============================================================
// Suite 2 — buildStudentProfileFromDpr carries advisorNotations
// ============================================================

describe("Task 1.3 — DPR-3: profile carries advisorNotations", () => {
    it("advisorNotations are present on the profile when the DPR has them", () => {
        const report = mkDpr({
            advisorNotations: [
                { requestId: "0000013777", note: "Test Credit. Permission to apply 32 credits from AP Exam.", advisor: "T. Gurstel", date: "09/17/2024" },
            ],
        });
        const profile = buildStudentProfileFromDpr(report);
        expect(profile.advisorNotations).toBeDefined();
        expect(profile.advisorNotations).toHaveLength(1);
        expect(profile.advisorNotations?.[0]?.note).toContain("AP Exam");
        expect(profile.advisorNotations?.[0]?.requestId).toBe("0000013777");
    });

    it("advisorNotations are absent (or empty) on the profile when the DPR has none", () => {
        const report = mkDpr({ advisorNotations: [] });
        const profile = buildStudentProfileFromDpr(report);
        // Either undefined or an empty array — both are acceptable for a clean DPR.
        expect(!profile.advisorNotations || profile.advisorNotations.length === 0).toBe(true);
    });

    it("fixture: profile advisorNotations match the parsed DPR notations count", () => {
        const report = parseFixture();
        const profile = buildStudentProfileFromDpr(report);
        // If the fixture has notations they should all be present; if none, profile has none.
        const dprCount = report.advisorNotations.length;
        if (dprCount > 0) {
            expect(profile.advisorNotations).toHaveLength(dprCount);
        } else {
            expect(!profile.advisorNotations || profile.advisorNotations.length === 0).toBe(true);
        }
    });
});
