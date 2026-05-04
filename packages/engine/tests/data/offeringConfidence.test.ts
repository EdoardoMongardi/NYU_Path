// ============================================================
// Phase 12.9.5 Task 4 — offering confidence regression suite
// ============================================================
//
// Locks the four invariants for courses-offerings.json after
// the Task 1-3 pipeline (sparse-history cap + confidence tier
// assignment) has been applied:
//
//   1. Every entry has a confidence tier from the valid set.
//   2. A handful of canonical intro courses are historically_likely.
//   3. Tier distribution is semantically sane: likely + partial
//      together cover > 40% of the catalogue, and no single tier
//      dominates 95% of all entries.
//   4. No entries have "confirmed" — that tier is Phase 15's job
//      (FOSE materializer at run-time, not static data).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OFFERINGS = JSON.parse(
    readFileSync(
        join(__dirname, "../../src/data/courses-offerings.json"),
        "utf-8",
    ),
);

describe("Phase 12.9.5 — offering confidence", () => {
    it("every entry has a confidence tier", () => {
        const valid = new Set([
            "historically_likely", "historically_partial", "irregular",
            "permission_only", "restricted", "confirmed",
        ]);
        for (const [courseId, entry] of Object.entries(OFFERINGS) as [string, any][]) {
            expect(valid.has(entry.confidence), `${courseId} has invalid confidence: ${entry.confidence}`).toBe(true);
        }
    });

    it("intro CS courses are historically_likely", () => {
        for (const courseId of ["CSCI-UA 101", "CSCI-UA 102", "MATH-UA 121", "EXPOS-UA 1"]) {
            const entry = OFFERINGS[courseId];
            expect(entry, `${courseId} not in offerings`).toBeDefined();
            expect(entry.confidence).toBe("historically_likely");
        }
    });

    it("tier distribution is sane (no tier dominates 100%)", () => {
        // "likely + partial > 40%" captures the semantic intent: most courses
        // have enough historical signal to schedule against. The sparse-history
        // cap (Task 2, commit b00b067b) correctly reclassified many courses from
        // likely → partial/irregular when fewer than 2 semesters of data were
        // present, so "likely" alone is no longer a reliable absolute threshold.
        const counts: Record<string, number> = {};
        for (const entry of Object.values(OFFERINGS) as any[]) {
            counts[entry.confidence] = (counts[entry.confidence] ?? 0) + 1;
        }
        const total = Object.values(counts).reduce((a: number, b: number) => a + b, 0);
        const likelyPlusPartial =
            (counts.historically_likely ?? 0) + (counts.historically_partial ?? 0);
        expect(likelyPlusPartial).toBeGreaterThan(total * 0.4);
        expect(Math.max(...Object.values(counts) as number[])).toBeLessThan(total * 0.95);
    });

    it("no entries have 'confirmed' tier (confirmed is set at runtime by Phase 15)", () => {
        // Phase 12.9.5 should NEVER write "confirmed" — that's Phase 15's FOSE materializer's job.
        for (const [courseId, entry] of Object.entries(OFFERINGS) as [string, any][]) {
            expect(entry.confidence, `${courseId} has confirmed tier set at static-data time`).not.toBe("confirmed");
        }
    });
});
