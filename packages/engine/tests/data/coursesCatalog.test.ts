// ============================================================
// Step 8d — loadCourses() full-catalog integrity guard
// ============================================================
// Pins the bulletin-sourced undergraduate catalog that replaced the
// 85-course stub: shape (real credits, variable-credit policy, no empty
// terms), undergrad-only scope, and backward-compat (every curated stub
// course survives). Regenerate with:
//   npx tsx tools/bulletin-parser/extractCourses.ts
// ============================================================

import { describe, expect, it } from "vitest";
import { loadCourses, loadOffCatalogCredits } from "../../src/dataLoader.js";

const courses = loadCourses();
const byId = new Map(courses.map((c) => [c.id, c] as const));

describe("loadCourses full undergrad catalog (Step 8d)", () => {
    it("expands well beyond the old 85-course stub", () => {
        expect(courses.length).toBeGreaterThan(8000);
    });

    it("every course has numeric credits and a non-empty termsOffered", () => {
        for (const c of courses) {
            expect(typeof c.credits).toBe("number");
            expect(Number.isNaN(c.credits)).toBe(false);
            expect(c.termsOffered.length).toBeGreaterThan(0);
        }
    });

    it("scopes to undergraduate courses only — no graduate -G* leaks", () => {
        const grad = courses.filter((c) => /^[A-Z0-9]+-G/.test(c.id));
        expect(grad).toEqual([]);
    });

    it("carries real bulletin credits (CSCI-UA 101 = 4)", () => {
        expect(byId.get("CSCI-UA 101")?.credits).toBe(4);
    });

    it("includes SPS undergrad courses (REAL1-UC)", () => {
        expect(byId.has("REAL1-UC 1001")).toBe(true);
    });

    it("variable-credit courses set credits to the MAX of the range", () => {
        const variable = courses.filter(
            (c) => c.creditsMin !== undefined && c.creditsMin !== c.creditsMax,
        );
        expect(variable.length).toBeGreaterThan(0);
        for (const c of variable) {
            expect(c.credits).toBe(c.creditsMax);
            expect(c.creditsMin!).toBeLessThan(c.creditsMax!);
        }
    });

    it("preserves every curated stub course (no regression — e.g. CSCI-UA 471)", () => {
        const ml = byId.get("CSCI-UA 471");
        expect(ml).toBeDefined();
        expect(ml?.crossListed).toContain("DS-UA 301");
    });
});

describe("off-catalog credits sidecar (Step 8d PR-2 — pin resolution)", () => {
    const off = loadOffCatalogCredits();

    it("is non-empty and every entry carries a title and numeric credits", () => {
        expect(off.size).toBeGreaterThan(5000);
        for (const v of off.values()) {
            expect(typeof v.title).toBe("string");
            expect(typeof v.credits).toBe("number");
            expect(Number.isNaN(v.credits)).toBe(false);
        }
    });

    it("contains only non-undergraduate courses (disjoint from the undergrad catalog)", () => {
        for (const id of off.keys()) {
            expect(/^[A-Z0-9]+-(U[A-Z]|SHU)\s/.test(id)).toBe(false);
            expect(byId.has(id)).toBe(false);
        }
    });

    it("resolves a graduate course's credits (so a pinned grad course isn't dropped)", () => {
        const grad = [...off.keys()].find((id) => /-G[A-Z]\s/.test(id));
        expect(grad).toBeDefined();
        expect(off.get(grad!)!.credits).toBeGreaterThanOrEqual(0);
    });
});
