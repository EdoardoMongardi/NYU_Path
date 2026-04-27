// ============================================================
// Phase 6.1 WS8 — T2 program-extraction pipeline tests
// ============================================================
// Pins the §12.6 row-6 acceptance #2: "T2 extraction produces a
// schema-valid JSON for one new program; spot-check passes."
// The pilot program is cas_philosophy_ba; the candidate at
// data/programs/_candidates/cas_philosophy_ba.json was hand-authored
// from the bulletin (Phase 6.1 WS8 spot-check by author) under the
// same shape the extract.ts pipeline produces.
// ============================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateFileWithMeta } from "../../src/provenance/schema.js";
import { validateProgramBody } from "../../src/provenance/configSchema.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CANDIDATE_PATH = join(REPO_ROOT, "data/programs/_candidates/cas_philosophy_ba.json");

describe("T2 pilot — cas_philosophy_ba (Phase 6.1 WS8)", () => {
    const raw = JSON.parse(readFileSync(CANDIDATE_PATH, "utf-8"));

    it("the candidate file's _meta passes provenance validation", () => {
        const r = validateFileWithMeta(raw);
        expect(r.ok, r.ok ? "" : r.errors.join("; ")).toBe(true);
    });

    it("_meta.extractedBy === 'llm-assisted' (T2 marker per §11.6.4)", () => {
        expect(raw._meta.extractedBy).toBe("llm-assisted");
    });

    it("the candidate body passes the program body validator", () => {
        const r = validateProgramBody(raw);
        expect(r.ok, r.ok ? "" : r.errors.join("; ")).toBe(true);
    });

    it("totalCreditsRequired === 128 (degree total, NOT major-only)", () => {
        // Per the bulletin's 'Total Credits' row (line 157). The major
        // is 40 credits but the degree is 128.
        expect(raw.totalCreditsRequired).toBe(128);
    });

    it("encodes the 9 major rules from the bulletin", () => {
        const ids = raw.rules.map((r: { ruleId: string }) => r.ruleId).sort();
        expect(ids).toEqual([
            "phil_ancient",
            "phil_early_modern",
            "phil_electives",
            "phil_epist",
            "phil_ethics",
            "phil_intro",
            "phil_logic",
            "phil_mind_lang",
            "phil_topics",
        ]);
    });

    it("every rule has a corresponding _provenance entry", () => {
        const ruleIds = new Set(raw.rules.map((r: { ruleId: string }) => r.ruleId));
        const provenancePaths = raw._provenance.map((p: { path: string }) => p.path);
        for (const id of ruleIds) {
            const found = provenancePaths.some((p: string) => p === `rules[${id}]`);
            expect(found, `no _provenance entry for rules[${id}]`).toBe(true);
        }
    });

    it("every choose_n rule has fromPool[] with at least 1 entry", () => {
        const chooseN = raw.rules.filter((r: { type: string }) => r.type === "choose_n");
        expect(chooseN.length).toBeGreaterThan(0);
        for (const r of chooseN) {
            const pool = (r as { fromPool: string[] }).fromPool;
            expect(pool).toBeDefined();
            expect(pool.length).toBeGreaterThanOrEqual(1);
        }
    });

    it("the major's intra-credits sum to 40 (8 single-course rules × 4cr + 2 elective × 4cr)", () => {
        // Cross-check against the bulletin's claim "ten 4-credit
        // courses (40 credits)" (line 99). The schema doesn't carry
        // per-rule credit counts (must_take + choose_n derive
        // credits from the chosen course), so we verify count
        // matches: 8 single-pick rules + 2 electives = 10 courses.
        let courseCount = 0;
        for (const r of raw.rules) {
            if (r.type === "must_take") courseCount += 1;
            else if (r.type === "choose_n") courseCount += (r as { n: number }).n;
        }
        expect(courseCount).toBe(10);
    });
});
